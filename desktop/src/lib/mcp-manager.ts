/**
 * Universal MCP Server Manager
 * Supports stdio (via sh -c wrapper), http, sse, json-rpc transports.
 * Stdio transport uses MCP initialize handshake; HTTP skips it (optional for most servers).
 */

import { Command } from '@tauri-apps/plugin-shell'
import type { MCPServer } from './config'

// ── Public types ──────────────────────────────────────────────────────────────

export interface MCPToolAnnotations {
  /** MCP spec 2024-11-05: true = tool only reads data, never writes/deletes */
  readOnlyHint?: boolean
  /** MCP spec: true = tool may cause destructive side effects */
  destructiveHint?: boolean
}

export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: MCPToolAnnotations
}

export interface MCPResourceDefinition {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface MCPPromptArgument {
  name: string
  description?: string
  required?: boolean
}

export interface MCPPromptDefinition {
  name: string
  description?: string
  arguments?: MCPPromptArgument[]
}

export interface MCPServerInstance {
  serverId: string
  serverName: string
  type: MCPServer['type']
  tools: MCPToolDefinition[]
  resources?: MCPResourceDefinition[]
  prompts?: MCPPromptDefinition[]
  isReady: boolean
}

export interface MCPTestResult {
  ok: boolean
  toolCount: number
  error?: string
}

// ── Stdio transport ───────────────────────────────────────────────────────────

interface StdioInstance {
  type: 'stdio'
  child: { write: (s: string) => Promise<void>; kill: () => Promise<void> }
  msgId: number
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
  timeoutMs: number
  isReady: boolean
  pingTimer?: any
}

// Detect Windows once at module load
const IS_WINDOWS = typeof navigator !== 'undefined' && /win/i.test(navigator.platform)

// Shell-quote for POSIX sh (single-quote style)
function shellQuote(s: string): string {
  if (!s) return "''"
  if (/^[a-zA-Z0-9@%+:,./_-]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// Shell-quote for Windows cmd.exe (double-quote style)
function cmdQuote(s: string): string {
  if (!s) return '""'
  if (/^[a-zA-Z0-9@%+:,./\\_ -]+$/.test(s)) return s
  return '"' + s.replace(/"/g, '""') + '"'
}

function buildShellCmd(server: MCPServer): string {
  if (IS_WINDOWS) {
    // On Windows, env vars are passed via Tauri options; just quote the command + args
    return [server.command!, ...(server.args ?? [])].map(cmdQuote).join(' ')
  }
  const envParts = Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`)
  const cmdParts = [server.command!, ...(server.args ?? [])].map(shellQuote)
  return [...envParts, ...cmdParts].join(' ')
}

async function spawnStdioInstance(server: MCPServer, manager?: MCPManager): Promise<StdioInstance> {
  const shellCmd = buildShellCmd(server)
  const envOpts = IS_WINDOWS && Object.keys(server.env ?? {}).length > 0
    ? { env: server.env as Record<string, string> }
    : undefined

  const [shellBin, shellFlag] = IS_WINDOWS ? ['cmd', '/C'] : ['sh', '-c']
  console.log(`[MCP ${server.name}] spawn: ${shellBin} ${shellFlag} ${shellCmd}`)

  const cmd = IS_WINDOWS
    ? Command.create('cmd', ['/C', shellCmd], envOpts)
    : Command.create('sh', ['-c', shellCmd])

  // npx -y downloads the package on first run — allow up to 60s for cold starts
  const timeoutMs = (server.timeout ?? 60) * 1000

  const instance: StdioInstance = {
    type: 'stdio',
    child: null as any,
    msgId: 0,
    pending: new Map(),
    timeoutMs,
    isReady: false
  }

  const stderrLines: string[] = []
  let lineBuf = ''

  cmd.stdout.on('data', (chunk: string) => {
    lineBuf += chunk
    const lines = lineBuf.split('\n')
    lineBuf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        const msg = JSON.parse(t)
        if (manager) {
          handleIncomingJsonRpc(instance, msg, server.name, manager)
        } else {
          // Fallback minimal processing for tests / testMCPServer
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const handler = instance.pending.get(msg.id)
            if (handler) {
              instance.pending.delete(msg.id)
              if (msg.error) handler.reject(new Error(msg.error.message ?? 'MCP error'))
              else handler.resolve(msg)
            }
          }
        }
      } catch { /* non-JSON diagnostic line from server */ }
    }
  })

  cmd.stderr.on('data', (line: string) => {
    stderrLines.push(line)
    console.warn(`[MCP ${server.name}] stderr: ${line}`)
  })

  cmd.on('close', (data: { code: number; signal: number | null }) => {
    console.warn(`[MCP ${server.name}] process closed with code ${data.code} (signal: ${data.signal})`)
    instance.isReady = false
    for (const [id, handler] of instance.pending.entries()) {
      handler.reject(new Error(`MCP server process terminated with code ${data.code}`))
    }
    instance.pending.clear()
  })

  cmd.on('error', (err: any) => {
    console.error(`[MCP ${server.name}] process error:`, err)
    instance.isReady = false
    for (const [id, handler] of instance.pending.entries()) {
      handler.reject(new Error(`MCP server process error: ${err}`))
    }
    instance.pending.clear()
  })

  try {
    const child = await cmd.spawn()
    instance.child = child
    return instance
  } catch (err) {
    const hint = stderrLines.slice(-5).join('\n')
    throw new Error(`[MCP ${server.name}] spawn failed: ${err}${hint ? `\nstderr: ${hint}` : ''}`)
  }
}

async function stdioRpc(inst: StdioInstance, method: string, params: unknown, customTimeoutMs?: number): Promise<any> {
  const id = ++inst.msgId
  const timeoutMs = customTimeoutMs ?? inst.timeoutMs
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inst.pending.delete(id)
      reject(new Error(`MCP "${method}" timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    inst.pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v) },
      reject: e => { clearTimeout(timer); reject(e) },
    })

    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    inst.child.write(msg).catch(reject)
  })
}

async function stdioNotify(inst: StdioInstance, method: string, params?: unknown): Promise<void> {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n'
  await inst.child.write(msg)
}

async function initializeStdio(inst: StdioInstance): Promise<void> {
  await stdioRpc(inst, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {
      roots: { listChanged: true },
      sampling: {},
      prompts: { listChanged: true }
    },
    clientInfo: { name: 'betopia', version: '1.0.0' },
  })
  // Notification — no response expected.
  await stdioNotify(inst, 'notifications/initialized')
}

async function listStdioTools(inst: StdioInstance): Promise<MCPToolDefinition[]> {
  const resp = await stdioRpc(inst, 'tools/list', {})
  return normalizeTools(resp.result?.tools ?? [])
}

async function callStdioTool(inst: StdioInstance, toolName: string, args: unknown): Promise<string> {
  // Tool calls can take longer; use 2× the configured timeout.
  const saved = inst.timeoutMs
  inst.timeoutMs = saved * 2
  try {
    const resp = await stdioRpc(inst, 'tools/call', { name: toolName, arguments: args })
    return extractMcpContent(resp.result)
  } finally {
    inst.timeoutMs = saved
  }
}

function toDataUrl(mimeType: string | undefined, data: string): string {
  const mime = mimeType?.trim() || 'image/png'
  if (data.startsWith('data:')) return data
  return `data:${mime};base64,${data}`
}

function extractTextFromContentBlocks(content: any[]): string {
  return content
    .map((block: any) => {
      if (typeof block === 'string') return block
      if (block?.text !== undefined) return String(block.text)
      if (block?.type === 'text' && block?.text !== undefined) return String(block.text)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractImageDataFromContentBlocks(content: any[]): string[] {
  const images: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const mimeType = block.mimeType ?? block.mime_type
    if (typeof block.blob === 'string') {
      images.push(`__IMAGE_DATA__:${toDataUrl(mimeType, block.blob)}`)
      continue
    }
    if (typeof block.image === 'string') {
      images.push(`__IMAGE_DATA__:${toDataUrl(mimeType, block.image)}`)
      continue
    }
    if (typeof block.data === 'string' && (block.type === 'image' || block.type === 'image_url')) {
      images.push(`__IMAGE_DATA__:${toDataUrl(mimeType, block.data)}`)
      continue
    }
    if (typeof block.url === 'string' && (block.type === 'image' || block.type === 'image_url')) {
      images.push(`__IMAGE_DATA__:${block.url}`)
    }
  }
  return images
}

function extractMcpContent(result: any): string {
  if (Array.isArray(result?.content)) {
    const text = extractTextFromContentBlocks(result.content)
    const images = extractImageDataFromContentBlocks(result.content)
    const parts = [...images, ...(text ? [text] : [])]
    return parts.join('\n') || 'OK'
  }
  if (typeof result === 'string') return result
  return JSON.stringify(result ?? 'OK')
}

export const __test__ = {
  extractMcpContent,
  extractResourceContent,
}

async function listStdioResources(inst: StdioInstance): Promise<MCPResourceDefinition[]> {
  const resp = await stdioRpc(inst, 'resources/list', {})
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return resp.result?.resources ?? []
}

async function readStdioResource(inst: StdioInstance, uri: string): Promise<string> {
  const resp = await stdioRpc(inst, 'resources/read', { uri })
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return extractResourceContent(resp.result)
}

async function listStdioPrompts(inst: StdioInstance): Promise<MCPPromptDefinition[]> {
  const resp = await stdioRpc(inst, 'prompts/list', {})
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return resp.result?.prompts ?? []
}

async function getStdioPrompt(inst: StdioInstance, name: string, args?: Record<string, string>): Promise<any> {
  const resp = await stdioRpc(inst, 'prompts/get', { name, arguments: args })
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return resp.result
}

// ── HTTP / JSON-RPC transport ──────────────────────────────────────────────────

interface HttpInstance {
  type: 'http' | 'json'
  url: string
  headers: Record<string, string>
  timeoutMs: number
  isReady: boolean
  pingTimer?: any
}

async function httpRpc(inst: HttpInstance, method: string, params: unknown): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), inst.timeoutMs)
  try {
    const resp = await fetch(inst.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...inst.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
    return await resp.json()
  } finally {
    clearTimeout(timer)
  }
}

async function listHttpTools(inst: HttpInstance): Promise<MCPToolDefinition[]> {
  const resp = await httpRpc(inst, 'tools/list', {})
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return normalizeTools(resp.result?.tools ?? [])
}

async function callHttpTool(inst: HttpInstance, toolName: string, args: unknown): Promise<string> {
  const resp = await httpRpc(inst, 'tools/call', { name: toolName, arguments: args })
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return extractMcpContent(resp.result)
}

async function listHttpResources(inst: HttpInstance): Promise<MCPResourceDefinition[]> {
  const resp = await httpRpc(inst, 'resources/list', {})
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return resp.result?.resources ?? []
}

async function readHttpResource(inst: HttpInstance, uri: string): Promise<string> {
  const resp = await httpRpc(inst, 'resources/read', { uri })
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return extractResourceContent(resp.result)
}

async function listHttpPrompts(inst: HttpInstance): Promise<MCPPromptDefinition[]> {
  const resp = await httpRpc(inst, 'prompts/list', {})
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return resp.result?.prompts ?? []
}

async function getHttpPrompt(inst: HttpInstance, name: string, args?: Record<string, string>): Promise<any> {
  const resp = await httpRpc(inst, 'prompts/get', { name, arguments: args })
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return resp.result
}

// ── SSE streaming transport ─────────────────────────────────────────────────────

interface SseInstance {
  type: 'sse'
  url: string
  postUrl: string | null
  headers: Record<string, string>
  abortCtrl: AbortController | null
  msgId: number
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
  timeoutMs: number
  isReady: boolean
  pingTimer?: any
}

async function sseRpc(inst: SseInstance, method: string, params: unknown, customTimeoutMs?: number): Promise<any> {
  if (!inst.postUrl) {
    throw new Error('SSE postUrl not established')
  }
  const id = ++inst.msgId
  const timeoutMs = customTimeoutMs ?? inst.timeoutMs

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inst.pending.delete(id)
      reject(new Error(`MCP SSE "${method}" timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    inst.pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v) },
      reject: e => { clearTimeout(timer); reject(e) }
    })

    fetch(inst.postUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...inst.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    }).catch(err => {
      clearTimeout(timer)
      inst.pending.delete(id)
      reject(err)
    })
  })
}

async function readSseStream(inst: SseInstance, response: Response, serverName: string, manager: MCPManager) {
  if (!response.body) {
    console.error(`[MCP SSE ${serverName}] No response body from SSE endpoint`)
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        handleSseBlock(inst, block, serverName, manager)
      }
    }
  } catch (err) {
    console.error(`[MCP SSE ${serverName}] stream error:`, err)
  } finally {
    reader.releaseLock()
    inst.isReady = false
    for (const [id, handler] of inst.pending.entries()) {
      handler.reject(new Error(`MCP SSE server stream disconnected`))
    }
    inst.pending.clear()
  }
}

function handleSseBlock(inst: SseInstance, block: string, serverName: string, manager: MCPManager) {
  const lines = block.split('\n')
  let eventType = 'message'
  let dataBuffer = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    const field = trimmed.slice(0, colonIdx).trim()
    const value = trimmed.slice(colonIdx + 1).trim()

    if (field === 'event') {
      eventType = value
    } else if (field === 'data') {
      dataBuffer += (dataBuffer ? '\n' : '') + value
    }
  }

  if (eventType === 'endpoint') {
    let postUrl = dataBuffer.trim()
    if (!postUrl.startsWith('http://') && !postUrl.startsWith('https://')) {
      const base = new URL(inst.url)
      const resolved = new URL(postUrl, base.href)
      postUrl = resolved.href
    }
    inst.postUrl = postUrl
    const sseInst = inst as any
    if (sseInst.onEndpointResolved) {
      sseInst.onEndpointResolved(postUrl)
    }
  } else if (eventType === 'message') {
    try {
      const msg = JSON.parse(dataBuffer)
      handleIncomingJsonRpc(inst, msg, serverName, manager)
    } catch (err) {
      console.error(`[MCP SSE ${serverName}] failed to parse message:`, err)
    }
  }
}

async function listSseTools(inst: SseInstance): Promise<MCPToolDefinition[]> {
  const resp = await sseRpc(inst, 'tools/list', {})
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return normalizeTools(resp.result?.tools ?? [])
}

async function callSseTool(inst: SseInstance, toolName: string, args: unknown): Promise<string> {
  const saved = inst.timeoutMs
  inst.timeoutMs = saved * 2
  try {
    const resp = await sseRpc(inst, 'tools/call', { name: toolName, arguments: args })
    if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
    return extractMcpContent(resp.result)
  } finally {
    inst.timeoutMs = saved
  }
}

async function listSseResources(inst: SseInstance): Promise<MCPResourceDefinition[]> {
  const resp = await sseRpc(inst, 'resources/list', {})
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return resp.result?.resources ?? []
}

async function readSseResource(inst: SseInstance, uri: string): Promise<string> {
  const resp = await sseRpc(inst, 'resources/read', { uri })
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return extractResourceContent(resp.result)
}

async function listSsePrompts(inst: SseInstance): Promise<MCPPromptDefinition[]> {
  const resp = await sseRpc(inst, 'prompts/list', {})
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return resp.result?.prompts ?? []
}

async function getSsePrompt(inst: SseInstance, name: string, args?: Record<string, string>): Promise<any> {
  const resp = await sseRpc(inst, 'prompts/get', { name, arguments: args })
  if (resp.error) throw new Error(resp.error.message ?? 'MCP error')
  return resp.result
}

// ── Bidirectional JSON-RPC support ─────────────────────────────────────────────

function handleIncomingJsonRpc(inst: StdioInstance | SseInstance, msg: any, serverName: string, manager: MCPManager) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    if (!('pending' in inst)) return
    const handler = inst.pending.get(msg.id)
    if (handler) {
      inst.pending.delete(msg.id)
      if (msg.error) handler.reject(new Error(msg.error.message ?? 'MCP error'))
      else handler.resolve(msg)
    }
  } else if (msg.id !== undefined && msg.method !== undefined) {
    handleServerRequest(inst, msg, serverName, manager)
  } else if (msg.method !== undefined) {
    handleServerNotification(inst, msg, serverName)
  }
}

async function sendStdioResponse(inst: StdioInstance, id: number, result?: any, error?: any) {
  const resp = JSON.stringify({
    jsonrpc: '2.0',
    id,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {})
  }) + '\n'
  await inst.child.write(resp).catch(err => console.error('Failed to write stdio response:', err))
}

async function sendSseResponse(inst: SseInstance, id: number, result?: any, error?: any) {
  if (!inst.postUrl) {
    console.error('Cannot send SSE response: postUrl not resolved')
    return
  }
  try {
    const resp = await fetch(inst.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...inst.headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {})
      })
    })
    if (!resp.ok) {
      console.error(`Failed to post SSE response: HTTP ${resp.status}`)
    }
  } catch (err) {
    console.error('Failed to send SSE response:', err)
  }
}

async function handleServerRequest(inst: AnyInstance, msg: any, serverName: string, manager: MCPManager) {
  const { method, id } = msg
  if (method === 'roots/list') {
    const roots = manager.projectPath ? [
      {
        uri: `file://${manager.projectPath}`,
        name: 'project-root'
      }
    ] : []

    if (inst.type === 'stdio') {
      await sendStdioResponse(inst as StdioInstance, id, { roots })
    } else if (inst.type === 'sse') {
      await sendSseResponse(inst as SseInstance, id, { roots })
    }
  } else {
    const error = { code: -32601, message: `Method not found: ${method}` }
    if (inst.type === 'stdio') {
      await sendStdioResponse(inst as StdioInstance, id, undefined, error)
    } else if (inst.type === 'sse') {
      await sendSseResponse(inst as SseInstance, id, undefined, error)
    }
  }
}

function handleServerNotification(inst: AnyInstance, msg: any, serverName: string) {
  const { method, params } = msg
  if (method === 'notifications/message') {
    console.log(`[MCP ${serverName} Log] [${params?.level ?? 'info'}]`, params?.data ?? params?.message)
  } else if (method === 'notifications/prompts/list_changed') {
    console.log(`[MCP ${serverName}] prompts list changed`)
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function normalizeTools(raw: any[]): MCPToolDefinition[] {
  return raw.map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations ?? undefined,
  }))
}


function extractResourceContent(result: any): string {
  if (Array.isArray(result?.contents)) {
    return result.contents.map((c: any) => {
      if (c.text !== undefined) return c.text
      if (c.blob !== undefined) {
        const mime = c.mimeType ?? c.mime_type ?? 'application/octet-stream'
        return `__IMAGE_DATA__:${toDataUrl(mime, c.blob)}`
      }
      if (c.data !== undefined && (c.type === 'image' || c.type === 'image_url')) {
        const mime = c.mimeType ?? c.mime_type ?? 'image/png'
        return `__IMAGE_DATA__:${toDataUrl(mime, c.data)}`
      }
      return ''
    }).join('\n')
  }
  return JSON.stringify(result ?? 'OK')
}

function startKeepalive(inst: StdioInstance | SseInstance, serverName: string, manager: MCPManager) {
  if (inst.pingTimer) {
    clearInterval(inst.pingTimer)
  }

  inst.pingTimer = setInterval(async () => {
    if (!inst.isReady) return

    try {
      if (inst.type === 'stdio') {
        await stdioRpc(inst, 'ping', {}, 5000)
      } else if (inst.type === 'sse') {
        await sseRpc(inst, 'ping', {}, 5000)
      }
    } catch (err) {
      console.warn(`[MCP ${serverName}] Keepalive ping failed:`, err)
      inst.isReady = false

      if (inst.type === 'stdio') {
        try { await inst.child.kill() } catch {}
      } else if (inst.type === 'sse') {
        try { inst.abortCtrl?.abort() } catch {}
      }
    }
  }, 30000)
}

// ── MCPManager class ──────────────────────────────────────────────────────────

type AnyInstance = StdioInstance | HttpInstance | SseInstance

function hasPendingAndTimer(inst: AnyInstance): inst is (StdioInstance | SseInstance) {
  return 'pending' in inst && 'pingTimer' in inst
}

export class MCPManager {
  public projectPath?: string
  private instances = new Map<string, AnyInstance>()
  private serverConfigs = new Map<string, MCPServer>()
  private toolMap = new Map<string, { serverId: string; toolName: string }>()

  constructor(projectPath?: string) {
    this.projectPath = projectPath
  }

  async initServer(server: MCPServer, signal?: AbortSignal): Promise<MCPServerInstance | null> {
    let instance: AnyInstance
    let tools: MCPToolDefinition[]
    let spawnedInst: StdioInstance | null = null
    let spawnedSseCtrl: AbortController | null = null

    this.serverConfigs.set(server.id, server)

    try {
      if (signal?.aborted) return null

      if (server.type === 'stdio') {
        const inst = await spawnStdioInstance(server, this)
        spawnedInst = inst
        if (signal?.aborted) {
          try { await inst.child.kill() } catch { /* ignore */ }
          return null
        }
        await initializeStdio(inst)
        tools = await listStdioTools(inst)
        inst.isReady = true
        startKeepalive(inst, server.name, this)
        instance = inst
      } else if (server.type === 'sse') {
        const inst: SseInstance = {
          type: 'sse',
          url: server.url!,
          postUrl: null,
          headers: server.headers ?? {},
          abortCtrl: new AbortController(),
          msgId: 0,
          pending: new Map(),
          timeoutMs: (server.timeout ?? 15) * 1000,
          isReady: false
        }
        spawnedSseCtrl = inst.abortCtrl

        const response = await fetch(server.url!, {
          headers: server.headers,
          signal: inst.abortCtrl!.signal
        })
        if (!response.ok) {
          throw new Error(`SSE connection failed: HTTP ${response.status} ${response.statusText}`)
        }

        let resolvePostUrl: (url: string) => void
        let rejectPostUrl: (err: Error) => void
        const endpointPromise = new Promise<string>((resolve, reject) => {
          resolvePostUrl = resolve
          rejectPostUrl = reject
        })

        const sseInst = inst as any
        sseInst.onEndpointResolved = (url: string) => resolvePostUrl(url)

        readSseStream(inst, response, server.name, this).catch(err => {
          rejectPostUrl(err)
        })

        const postUrlTimeout = setTimeout(() => {
          rejectPostUrl(new Error('Timed out waiting for SSE endpoint event'))
        }, 10000)

        try {
          await endpointPromise
        } finally {
          clearTimeout(postUrlTimeout)
        }

        await sseRpc(inst, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {
            roots: { listChanged: true },
            sampling: {},
            prompts: { listChanged: true }
          },
          clientInfo: { name: 'betopia', version: '1.0.0' }
        })

        await fetch(inst.postUrl!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...inst.headers },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
        }).catch(err => console.error('Failed to send initialized notification:', err))

        inst.isReady = true
        tools = await listSseTools(inst)
        startKeepalive(inst, server.name, this)
        instance = inst
      } else {
        const inst: HttpInstance = {
          type: server.type,
          url: server.url!,
          headers: server.headers ?? {},
          timeoutMs: (server.timeout ?? 15) * 1000,
          isReady: true
        }
        tools = await listHttpTools(inst)
        instance = inst
      }
    } catch (err) {
      if (spawnedInst) {
        try { await spawnedInst.child.kill() } catch { /* ignore */ }
      }
      if (spawnedSseCtrl) {
        try { spawnedSseCtrl.abort() } catch { /* ignore */ }
      }
      console.error(`MCP "${server.name}" (${server.type}) init failed, registering as failed/disconnected:`, err)
      
      const failedInst: AnyInstance = server.type === 'stdio'
        ? { type: 'stdio', child: null as any, msgId: 0, pending: new Map(), timeoutMs: (server.timeout ?? 60) * 1000, isReady: false }
        : server.type === 'sse'
        ? { type: 'sse', url: server.url!, postUrl: null, headers: server.headers ?? {}, abortCtrl: null, msgId: 0, pending: new Map(), timeoutMs: (server.timeout ?? 15) * 1000, isReady: false }
        : { type: 'http', url: server.url!, headers: server.headers ?? {}, timeoutMs: (server.timeout ?? 15) * 1000, isReady: false } as any
      
      this.instances.set(server.id, failedInst)
      return null
    }

    // Respect per-server tool blocklist.
    const blocked = new Set(server.disabledTools ?? [])
    tools = tools.filter(t => !blocked.has(t.name))

    this.instances.set(server.id, instance)
    for (const tool of tools) {
      this.toolMap.set(`${server.name}__${tool.name}`, { serverId: server.id, toolName: tool.name })
    }

    return { serverId: server.id, serverName: server.name, type: server.type, tools, isReady: true }
  }

  async reconnectServer(serverId: string): Promise<boolean> {
    const server = this.serverConfigs.get(serverId)
    if (!server) return false

    console.log(`[MCP ${server.name}] Attempting reconnection...`)
    await this.shutdown(serverId)
    const res = await this.initServer(server)
    return res !== null && res.isReady
  }

  async callTool(toolId: string, args: unknown): Promise<string> {
    const entry = this.toolMap.get(toolId)
    if (!entry) return `Error: Tool not found: ${toolId}`

    let instance = this.instances.get(entry.serverId)
    if (!instance) return `Error: Server not initialized`

    if (!instance.isReady && instance.type !== 'http' && instance.type !== 'json') {
      const ok = await this.reconnectServer(entry.serverId)
      if (!ok) return `Error: Server is disconnected and reconnection failed`
      instance = this.instances.get(entry.serverId)!
    }

    try {
      if (instance.type === 'stdio') {
        return await callStdioTool(instance as StdioInstance, entry.toolName, args)
      } else if (instance.type === 'sse') {
        return await callSseTool(instance as SseInstance, entry.toolName, args)
      } else {
        return await callHttpTool(instance as HttpInstance, entry.toolName, args)
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async listResources(serverId: string): Promise<MCPResourceDefinition[]> {
    let instance = this.instances.get(serverId)
    if (!instance) throw new Error(`Server not initialized: ${serverId}`)

    if (!instance.isReady && instance.type !== 'http' && instance.type !== 'json') {
      const ok = await this.reconnectServer(serverId)
      if (!ok) throw new Error(`Server is disconnected and reconnection failed`)
      instance = this.instances.get(serverId)!
    }

    if (instance.type === 'stdio') {
      return await listStdioResources(instance as StdioInstance)
    } else if (instance.type === 'sse') {
      return await listSseResources(instance as SseInstance)
    } else {
      return await listHttpResources(instance as HttpInstance)
    }
  }

  async readResource(serverId: string, uri: string): Promise<string> {
    let instance = this.instances.get(serverId)
    if (!instance) throw new Error(`Server not initialized: ${serverId}`)

    if (!instance.isReady && instance.type !== 'http' && instance.type !== 'json') {
      const ok = await this.reconnectServer(serverId)
      if (!ok) throw new Error(`Server is disconnected and reconnection failed`)
      instance = this.instances.get(serverId)!
    }

    if (instance.type === 'stdio') {
      return await readStdioResource(instance as StdioInstance, uri)
    } else if (instance.type === 'sse') {
      return await readSseResource(instance as SseInstance, uri)
    } else {
      return await readHttpResource(instance as HttpInstance, uri)
    }
  }

  async listPrompts(serverId: string): Promise<MCPPromptDefinition[]> {
    let instance = this.instances.get(serverId)
    if (!instance) throw new Error(`Server not initialized: ${serverId}`)

    if (!instance.isReady && instance.type !== 'http' && instance.type !== 'json') {
      const ok = await this.reconnectServer(serverId)
      if (!ok) throw new Error(`Server is disconnected and reconnection failed`)
      instance = this.instances.get(serverId)!
    }

    if (instance.type === 'stdio') {
      return await listStdioPrompts(instance as StdioInstance)
    } else if (instance.type === 'sse') {
      return await listSsePrompts(instance as SseInstance)
    } else {
      return await listHttpPrompts(instance as HttpInstance)
    }
  }

  async getPrompt(serverId: string, name: string, args?: Record<string, string>): Promise<any> {
    let instance = this.instances.get(serverId)
    if (!instance) throw new Error(`Server not initialized: ${serverId}`)

    if (!instance.isReady && instance.type !== 'http' && instance.type !== 'json') {
      const ok = await this.reconnectServer(serverId)
      if (!ok) throw new Error(`Server is disconnected and reconnection failed`)
      instance = this.instances.get(serverId)!
    }

    if (instance.type === 'stdio') {
      return await getStdioPrompt(instance as StdioInstance, name, args)
    } else if (instance.type === 'sse') {
      return await getSsePrompt(instance as SseInstance, name, args)
    } else {
      return await getHttpPrompt(instance as HttpInstance, name, args)
    }
  }

  async shutdown(serverId: string): Promise<void> {
    const instance = this.instances.get(serverId)
    if (!instance) return

    if (hasPendingAndTimer(instance) && instance.pingTimer) {
      clearInterval(instance.pingTimer)
    }

    if (instance.type === 'stdio') {
      try { await (instance as StdioInstance).child.kill() } catch { /* ignore */ }
    } else if (instance.type === 'sse') {
      try { (instance as SseInstance).abortCtrl?.abort() } catch { /* ignore */ }
    }
    this.instances.delete(serverId)
  }

  async shutdownAll(): Promise<void> {
    for (const serverId of [...this.instances.keys()]) {
      await this.shutdown(serverId)
    }
  }
}

// ── Standalone connectivity test ─────────────────────────────────────────────

export async function testMCPServer(server: MCPServer): Promise<MCPTestResult> {
  try {
    if (server.type === 'stdio') {
      const inst = await spawnStdioInstance(server)
      try {
        await initializeStdio(inst)
        const tools = await listStdioTools(inst)
        return { ok: true, toolCount: tools.length }
      } finally {
        try { await inst.child.kill() } catch { /* ignore */ }
      }
    } else if (server.type === 'sse') {
      const inst: SseInstance = {
        type: 'sse',
        url: server.url!,
        postUrl: null,
        headers: server.headers ?? {},
        abortCtrl: new AbortController(),
        msgId: 0,
        pending: new Map(),
        timeoutMs: (server.timeout ?? 15) * 1000,
        isReady: false
      }
      try {
        const response = await fetch(server.url!, {
          headers: server.headers,
          signal: inst.abortCtrl!.signal
        })
        if (!response.ok) {
          throw new Error(`SSE connection failed: HTTP ${response.status} ${response.statusText}`)
        }

        let resolvePostUrl: (url: string) => void
        let rejectPostUrl: (err: Error) => void
        const endpointPromise = new Promise<string>((resolve, reject) => {
          resolvePostUrl = resolve
          rejectPostUrl = reject
        })

        const sseInst = inst as any
        sseInst.onEndpointResolved = (url: string) => resolvePostUrl(url)

        const dummyManager = new MCPManager()
        readSseStream(inst, response, server.name, dummyManager).catch(rejectPostUrl)

        const postUrlTimeout = setTimeout(() => {
          rejectPostUrl(new Error('Timed out waiting for SSE endpoint event'))
        }, 10000)

        try {
          await endpointPromise
        } finally {
          clearTimeout(postUrlTimeout)
        }

        await sseRpc(inst, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'betopia-test', version: '1.0.0' }
        })

        const tools = await listSseTools(inst)
        return { ok: true, toolCount: tools.length }
      } finally {
        try { inst.abortCtrl?.abort() } catch { /* ignore */ }
      }
    } else {
      const inst: HttpInstance = {
        type: server.type,
        url: server.url!,
        headers: server.headers ?? {},
        timeoutMs: (server.timeout ?? 15) * 1000,
        isReady: true
      }
      const tools = await listHttpTools(inst)
      return { ok: true, toolCount: tools.length }
    }
  } catch (err) {
    return { ok: false, toolCount: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

// Re-export shellQuote for tests.
export { shellQuote, buildShellCmd }
