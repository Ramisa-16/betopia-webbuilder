// Shared types, interfaces, and zero-dependency utilities used across all agent modules.

import type { Message, MessagePart } from '../types'

// ── OAI wire types ────────────────────────────────────────────────────────────

export interface OAIContentBlock {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OAIContentBlock[] | null
  tool_calls?: OAIToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface StreamToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  lastInputTokens: number
}

// ── Tool middleware hooks ──────────────────────────────────────────────────────

export interface BeforeToolCallContext {
  toolName: string
  toolArgs: string
  parsedArgs: Record<string, unknown>
}

export interface BeforeToolCallResult {
  block?: boolean
  reason?: string
  args?: string
}

export interface AfterToolCallContext {
  toolName: string
  toolArgs: string
  result: string
  isError: boolean
}

export interface AfterToolCallResult {
  result?: string
  isError?: boolean
  terminate?: boolean
}

// ── Audit types ───────────────────────────────────────────────────────────────

export type AgentAuditStatus = 'success' | 'error' | 'denied' | 'blocked' | 'invalid' | 'aborted'
export type AgentAuditApproval = 'not_required' | 'requested' | 'approved' | 'rejected' | 'auto_approved'

export interface AgentAuditEvent {
  id: string
  timestamp: number
  toolName: string
  argsSummary: Record<string, unknown>
  touchedFiles: string[]
  approval: AgentAuditApproval
  status: AgentAuditStatus
  errorCategory?: string
  durationMs: number
  parentCallId?: string
}

// ── Context transform ─────────────────────────────────────────────────────────

export type ContextTransformFn = (messages: OAIMessage[]) => OAIMessage[] | Promise<OAIMessage[]>

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_AGENT_MAX_ROUNDS = 200

export type ToolExecutionOrder = 'parallel' | 'sequential'

// ── Agent callbacks ───────────────────────────────────────────────────────────

export interface AgentCallbacks {
  onPartsUpdate: (parts: MessagePart[]) => void
  onFilesChanged: () => Promise<void>
  onToolStart?: (name: string, input: string) => void
  onToolEnd?: () => void
  onUsage?: (usage: AgentUsage) => void
  onPermissionRequest?: (tool: string, args: string) => Promise<boolean>
  onApprovalRequired?: (approvalId: string, toolName: string) => Promise<boolean | string>
  onServerStarted?: (url: string) => void
  onCompactionDone?: (compactionMsg: Message, keptMessages: Message[]) => void
  agentPersona?: { name: string; instructions: string } | null
  agentAllowedTools?: string[] | null
  customInstructions?: string
  getSessionId?: () => string | null
  spawnAgentInTerminal?: (prompt: string) => Promise<{ sessionId: string } | null>
  sendToTerminal?: (sessionId: string, text: string) => Promise<boolean>
  readTerminalOutput?: (sessionId: string, lines?: number) => string | null
  permissionMode?: 'default' | 'auto_review' | 'plan_mode' | 'full_access'
  effortLevel?: 'low' | 'medium' | 'high'
  modelOverride?: string
  beforeToolCall?: (ctx: BeforeToolCallContext) => BeforeToolCallResult | Promise<BeforeToolCallResult>
  afterToolCall?: (ctx: AfterToolCallContext) => AfterToolCallResult | Promise<AfterToolCallResult>
  onAuditEvent?: (event: AgentAuditEvent) => void
  transformContext?: ContextTransformFn
  onSubagentPart?: (subagentType: string, part: MessagePart) => void
  maxRounds?: number
  toolExecutionOrder?: ToolExecutionOrder
  /** Plugin hook registry for dispatching plugin hooks during agent loop. */
  pluginHookRegistry?: import('./plugin/hooks').PluginHookRegistry
  /** Plugin manager ref for getting plugin tool definitions and execution map. */
  pluginManagerRef?: import('./plugin/plugin-manager').PluginManager | null
}

// ── Zero-dependency utilities ─────────────────────────────────────────────────

export function makeId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(36).padStart(2, '0')).join('')
}

export const FILE_OP_TIMEOUT_MS = 30_000

export function raceTimeout<T>(promise: Promise<T>, label: string, ms = FILE_OP_TIMEOUT_MS): Promise<T> {
  // The underlying operation (Tauri invoke) cannot be cancelled from JS.
  // We clear the timer if the original promise settles first to avoid a lingering setTimeout.
  let timerId: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  })
  return Promise.race([
    promise.finally(() => clearTimeout(timerId!)),
    timeout,
  ])
}
