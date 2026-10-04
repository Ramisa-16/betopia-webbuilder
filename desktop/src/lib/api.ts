import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import type { Message, MessagePart, FileEntry } from '../types'
import type { LspDiagnostic } from './lsp/types'

export const BASE = 'http://127.0.0.1:7878/v1'

// ── Generic request ───────────────────────────────────────────────────────────

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await tauriFetch(`${BASE}${path}`, init as Parameters<typeof tauriFetch>[1])
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let message = text || `HTTP ${r.status}`
    try {
      const parsed = JSON.parse(text)
      if (parsed?.message) message = parsed.message
    } catch { /* ignore */ }
    throw new Error(message)
  }
  return r.json() as Promise<T>
}

// ── Health ────────────────────────────────────────────────────────────────────

export async function checkHealth(): Promise<boolean> {
  try {
    const r = await tauriFetch(`${BASE}/health`)
    return r.ok
  } catch {
    return false
  }
}

export async function waitForHealth(maxMs = 10000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (await checkHealth()) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

// ── Workspace ─────────────────────────────────────────────────────────────────

export interface BackendWorkspace {
  id: string
  path: string
  yolo?: boolean
  data_dir?: string
  config?: {
    providers?: Record<string, BackendProvider>
    models?: { large?: BackendModelRef; small?: BackendModelRef }
  }
}

export interface BackendProvider {
  id: string
  name: string
  base_url: string
  models?: BackendProviderModel[]
}

export interface BackendProviderModel {
  id: string
  name: string
  context_window?: number
  can_reason?: boolean
}

export interface BackendModelRef {
  model: string
  provider: string
}

export async function createWorkspace(path: string, yolo = false): Promise<BackendWorkspace> {
  return req('/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, yolo }),
  })
}

export async function deleteWorkspace(id: string): Promise<void> {
  await tauriFetch(`${BASE}/workspaces/${id}`, { method: 'DELETE' })
}

export async function getWorkspace(id: string): Promise<BackendWorkspace> {
  return req(`/workspaces/${id}`)
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface BackendSession {
  id: string
  title?: string
  message_count?: number
  created_at?: number
  updated_at?: number
}

export async function createSession(workspaceId: string, title = 'Website'): Promise<BackendSession> {
  return req(`/workspaces/${workspaceId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

export async function listSessions(workspaceId: string): Promise<BackendSession[]> {
  return req(`/workspaces/${workspaceId}/sessions`)
}

export async function deleteSession(workspaceId: string, sessionId: string): Promise<void> {
  await tauriFetch(`${BASE}/workspaces/${workspaceId}/sessions/${sessionId}`, { method: 'DELETE' })
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function getMessages(workspaceId: string, sessionId: string): Promise<BackendMessage[]> {
  return req(`/workspaces/${workspaceId}/sessions/${sessionId}/messages`)
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export interface BackendAgentInfo {
  is_busy: boolean
  is_ready: boolean
  model?: { id?: string; name?: string }
  model_cfg?: BackendModelRef
}

export type AgentExecutionMode = 'agentic' | 'planning' | 'auto'

export async function initAgent(workspaceId: string): Promise<void> {
  await req(`/workspaces/${workspaceId}/agent/init`, { method: 'POST' })
}

export async function sendAgentMessage(
  workspaceId: string,
  sessionId: string,
  prompt: string,
  mode?: AgentExecutionMode,
): Promise<void> {
  await tauriFetch(`${BASE}/workspaces/${workspaceId}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, prompt, ...(mode ? { mode } : {}) }),
  })
}

export async function cancelAgent(workspaceId: string, sessionId: string): Promise<void> {
  await tauriFetch(`${BASE}/workspaces/${workspaceId}/agent/sessions/${sessionId}/cancel`, { method: 'POST' })
}

export async function getAgentInfo(workspaceId: string): Promise<BackendAgentInfo> {
  return req(`/workspaces/${workspaceId}/agent`)
}

// ── Permissions ───────────────────────────────────────────────────────────────

export type PermissionAction = 'allow' | 'allow_session' | 'deny'

export interface BackendPermissionRequest {
  id: string
  session_id: string
  tool_call_id: string
  tool_name: string
  description?: string
  action?: string
  path?: string
  params?: string[]
}

export async function grantPermission(
  workspaceId: string,
  permission: BackendPermissionRequest,
  action: PermissionAction,
): Promise<void> {
  await tauriFetch(`${BASE}/workspaces/${workspaceId}/permissions/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission, action }),
  })
}

export async function setPermissionSkip(workspaceId: string, skip: boolean): Promise<void> {
  await tauriFetch(`${BASE}/workspaces/${workspaceId}/permissions/skip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skip }),
  })
}

// ── Files ─────────────────────────────────────────────────────────────────────

export async function getFiles(workspaceId: string): Promise<FileEntry[]> {
  try {
    return await req(`/workspaces/${workspaceId}/files`)
  } catch {
    return []
  }
}

export async function getFileContent(workspaceId: string, path: string): Promise<string> {
  const r = await tauriFetch(`${BASE}/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`)
  if (!r.ok) throw new Error('File not found')
  return r.text()
}

export function previewUrl(workspaceId: string, entryFile = 'index.html'): string {
  if (entryFile === 'index.html') {
    return `${BASE}/workspaces/${workspaceId}/preview/`
  }
  return `${BASE}/workspaces/${workspaceId}/preview/${entryFile}`
}

export async function clearWorkspaceFiles(workspaceId: string): Promise<void> {
  await tauriFetch(`${BASE}/workspaces/${workspaceId}/files/clear`, { method: 'POST' })
}

// ── SSE Events ────────────────────────────────────────────────────────────────

export type SseEventType =
  | 'message'
  | 'session'
  | 'file'
  | 'agent_event'
  | 'permission_request'
  | 'permission_notification'
  | 'lsp_event'
  | 'mcp_event'

export interface SseEnvelope {
  type: SseEventType
  payload: SseInnerEvent<unknown>
}

export interface SseInnerEvent<T> {
  type: 'created' | 'updated' | 'deleted'
  payload: T
}

// Message as received from backend SSE
export interface BackendMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  parts: Array<{ type: string; data: Record<string, unknown> }>
  model?: string
  provider?: string
  created_at: number
  updated_at: number
}

export interface BackendAgentEvent {
  session_id: string
  session_title?: string
  type: 'thinking' | 'running' | 'finished' | 'error' | 'canceled'
}

export interface BackendLspEvent {
  workspace_id?: string
  path?: string
  diagnostics?: LspDiagnostic[]
  status?: 'ready' | 'diagnostics' | 'error'
  message?: string
}

/** Convert a backend message's parts to frontend MessagePart format */
export function backendPartsToFrontend(backendParts: Array<{ type: string; data: Record<string, unknown> }>): MessagePart[] {
  return backendParts
    .filter(p => p && p.type)
    .map(p => {
      switch (p.type) {
        case 'text':
          return { type: 'text' as const, data: { text: String((p.data as { text?: unknown })?.text ?? '') } }
        case 'reasoning':
          return { type: 'reasoning' as const, data: { thinking: String((p.data as { thinking?: unknown })?.thinking ?? '') } }
        case 'tool_call':
          return {
            type: 'tool_call' as const,
            data: {
              id: String((p.data as { id?: unknown })?.id ?? ''),
              name: String((p.data as { name?: unknown })?.name ?? ''),
              input: String((p.data as { input?: unknown })?.input ?? ''),
              finished: Boolean((p.data as { finished?: unknown })?.finished),
            },
          }
        case 'tool_result':
          return {
            type: 'tool_result' as const,
            data: {
              tool_call_id: String((p.data as { tool_call_id?: unknown })?.tool_call_id ?? ''),
              name: String((p.data as { name?: unknown })?.name ?? ''),
              content: String((p.data as { content?: unknown })?.content ?? ''),
              is_error: Boolean((p.data as { is_error?: unknown })?.is_error),
              modelContent: typeof (p.data as { modelContent?: unknown })?.modelContent === 'string'
                ? (p.data as { modelContent: string }).modelContent
                : undefined,
            },
          }
        case 'finish':
          return {
            type: 'finish' as const,
            data: {
              reason: String((p.data as { reason?: unknown })?.reason ?? 'end_turn'),
              time: Number((p.data as { time?: unknown })?.time ?? Date.now()),
            },
          }
        default:
          return { type: 'text' as const, data: { text: '' } }
      }
    })
    .filter(p => {
      if (p.type === 'text' && !(p.data as { text: string }).text) return false
      return true
    })
}

/** Convert a backend message to a frontend Message */
export function backendMessageToFrontend(msg: BackendMessage): Message {
  return {
    id: msg.id,
    session_id: msg.session_id,
    role: msg.role,
    parts: backendPartsToFrontend(msg.parts ?? []),
    model: msg.model,
    provider: msg.provider,
    created_at: msg.created_at,
    updated_at: msg.updated_at,
  }
}

/** Subscribe to SSE events for a workspace. Returns unsubscribe function. */
export function subscribeBackendEvents(
  workspaceId: string,
  onMessage: (msg: BackendMessage) => void,
  onPermission: (perm: BackendPermissionRequest) => void,
  onAgentEvent: (ev: BackendAgentEvent) => void,
  onFileChange: () => void,
  onError?: (err: Event) => void,
  onLspEvent?: (ev: BackendLspEvent) => void,
): () => void {
  const es = new EventSource(`${BASE}/workspaces/${workspaceId}/events`)

  es.onmessage = (e: MessageEvent) => {
    try {
      const envelope = JSON.parse(e.data as string) as SseEnvelope

      if (envelope.type === 'message') {
        const inner = envelope.payload as SseInnerEvent<BackendMessage>
        if (inner?.payload) onMessage(inner.payload)
      } else if (envelope.type === 'permission_request') {
        const inner = envelope.payload as SseInnerEvent<BackendPermissionRequest>
        if (inner?.payload) onPermission(inner.payload)
      } else if (envelope.type === 'agent_event') {
        const inner = envelope.payload as SseInnerEvent<BackendAgentEvent>
        if (inner?.payload) onAgentEvent(inner.payload)
      } else if (envelope.type === 'file') {
        onFileChange()
      } else if (envelope.type === 'lsp_event') {
        const inner = envelope.payload as SseInnerEvent<BackendLspEvent>
        if (inner?.payload) onLspEvent?.(inner.payload)
      }
    } catch { /* ignore parse errors */ }
  }

  if (onError) es.onerror = onError

  return () => es.close()
}
