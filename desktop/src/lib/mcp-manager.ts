/**
 * Universal MCP Server Manager
 * Supports stdio (via sh -c wrapper), http, sse, json-rpc transports.
 * Stdio transport uses MCP initialize handshake; HTTP skips it (optional for most servers).
 */

import { Command } from '@tauri-apps/plugin-shell'
import type { MCPServer } from './config'

// ── Public types ──────────────────────────────────────────────────────────────

export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface MCPServerInstance {
  serverId: string
  serverName: string
  type: MCPServer['type']
  tools: MCPToolDefinition[]
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

async function spawnStdioInstance(server: MCPServer): Promise<StdioInstance> {
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
  }

  const stderrLines: string[] = []
  let lineBuf = ''
  cmd.stdout.on('data', (chunk: string) => {
    lineBuf += chunk + '\n'
    const lines = lineBuf.split('\n')
    lineBuf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        const msg = JSON.parse(t) as {
          id?: number
          result?: unknown
          error?: { message: string }
        }
        if (msg.id !== undefined) {
          const handler = instance.pending.get(msg.id)
          if (handler) {
            instance.pending.delete(msg.id)
            if (msg.error) handler.reject(new Error(msg.error.message ?? 'MCP error'))
            else handler.resolve(msg)
          }
        }
      } catch { /* non-JSON diagnostic line from server */ }
    }
  })

  cmd.stderr.on('data', (line: string) => {
    stderrLines.push(line)
    console.warn(`[MCP ${server.name}] stderr: ${line}`)
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

async function stdioRpc(inst: StdioInstance, method: string, params: unknown): Promise<any> {
  const id = ++inst.msgId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inst.pending.delete(id)
      reject(new Error(`MCP "${method}" timed out after ${inst.timeoutMs / 1000}s`))
    }, inst.timeoutMs)

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
    capabilities: {},
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
    return extractContent(resp.result)
  } finally {
    inst.timeoutMs = saved
  }
}

// ── HTTP / SSE / JSON-RPC transport ────────────────────────────────────────────

interface HttpInstance {
  type: 'http' | 'sse' | 'json'
  url: string
  headers: Record<string, string>
  timeoutMs: number
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
  return extractContent(resp.result)
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function normalizeTools(raw: any[]): MCPToolDefinition[] {
  return raw.map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

function extractContent(result: any): string {
  if (Array.isArray(result?.content)) {
    const text = result.content.map((c: any) => c.text ?? '').filter(Boolean).join('\n')
    return text || 'OK'
  }
  if (typeof result === 'string') return result
  return JSON.stringify(result ?? 'OK')
}

// ── MCPManager class ──────────────────────────────────────────────────────────

type AnyInstance = StdioInstance | HttpInstance

export class MCPManager {
  private instances = new Map<string, AnyInstance>()
  private toolMap = new Map<string, { serverId: string; toolName: string }>()

  async initServer(server: MCPServer): Promise<MCPServerInstance | null> {
    let instance: AnyInstance
    let tools: MCPToolDefinition[]

    try {
      if (server.type === 'stdio') {
        const inst = await spawnStdioInstance(server)
        await initializeStdio(inst)
        tools = await listStdioTools(inst)
        instance = inst
      } else {
        const inst: HttpInstance = {
          type: server.type,
          url: server.url!,
          headers: server.headers ?? {},
          timeoutMs: (server.timeout ?? 15) * 1000,
        }
        tools = await listHttpTools(inst)
        instance = inst
      }
    } catch (err) {
      console.error(`MCP "${server.name}" (${server.type}) init failed:`, err)
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

  async callTool(toolId: string, args: unknown): Promise<string> {
    const entry = this.toolMap.get(toolId)
    if (!entry) return `Error: Tool not found: ${toolId}`

    const instance = this.instances.get(entry.serverId)
    if (!instance) return `Error: Server not initialized`

    try {
      if (instance.type === 'stdio') {
        return await callStdioTool(instance as StdioInstance, entry.toolName, args)
      } else {
        return await callHttpTool(instance as HttpInstance, entry.toolName, args)
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async shutdown(serverId: string): Promise<void> {
    const instance = this.instances.get(serverId)
    if (instance?.type === 'stdio') {
      try { await (instance as StdioInstance).child.kill() } catch { /* ignore */ }
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
    } else {
      const inst: HttpInstance = {
        type: server.type,
        url: server.url!,
        headers: server.headers ?? {},
        timeoutMs: (server.timeout ?? 15) * 1000,
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
