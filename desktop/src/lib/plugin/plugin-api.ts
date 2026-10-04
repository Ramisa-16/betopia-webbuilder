import type { ComponentType, LazyExoticComponent } from 'react'
import type { Message, MessagePart, Session } from '../../types'
import type { ToolSchema } from '../agent-tools'

// ── Identity ────────────────────────────────────────────────────────────────────

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  license?: string
  /** Permissions this plugin requires at runtime. */
  permissions?: PluginPermissionManifest
  /** JSON Schema for plugin-specific user settings. */
  configSchema?: Record<string, unknown>
  defaultConfig?: Record<string, unknown>
}

// ── Permissions ─────────────────────────────────────────────────────────────────

export interface PluginPermissionManifest {
  network?: {
    origins: string[]
  }
  filesystem?: {
    read?: string[]
    write?: string[]
  }
  shell?: boolean
  userMessages?: boolean
}

// ── Hooks ───────────────────────────────────────────────────────────────────────

export interface BeforeToolCallContext {
  toolName: string
  toolArgs: string
  parsedArgs: Record<string, unknown>
}

export type BeforeToolCallResult =
  | { type: 'pass'; toolCall: BeforeToolCallContext }
  | { type: 'block'; reason: string }
  | { type: 'modify'; toolCall: BeforeToolCallContext }

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

export interface HookContext {
  sessionId: string | null
  projectPath: string | null
  pluginId: string
}

export interface StreamEvent {
  type: 'text_delta' | 'reasoning_delta' | 'tool_call_delta' | 'tool_result' | 'step_start' | 'step_end' | 'error'
  data: unknown
}

export interface SessionEvent {
  type: 'message_created' | 'message_updated' | 'session_switched' | 'session_created'
  message?: Message
  sessionId: string
}

export interface FileChangeEvent {
  path: string
  type: 'created' | 'modified' | 'deleted'
  content?: string
}

export interface PluginHooks {
  beforeToolCall?: (toolCall: BeforeToolCallContext, ctx: HookContext) => Promise<BeforeToolCallResult | null>
  afterToolCall?: (result: AfterToolCallContext, ctx: HookContext) => Promise<AfterToolCallResult>
  transformContext?: (messages: unknown[], ctx: HookContext) => Promise<unknown[]>
  onToolStream?: (event: StreamEvent, ctx: HookContext) => void
  onSessionEvent?: (event: SessionEvent) => void
  onFileChange?: (change: FileChangeEvent) => void
}

// ── Declarative contributions ───────────────────────────────────────────────────

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolSchema
  execute: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolResult>
  globalName?: boolean
}

export interface ToolExecutionContext {
  sessionId: string | null
  projectPath: string | null
  signal?: AbortSignal
}

export interface ToolResult {
  content: string
  isError?: boolean
  modelContent?: string
}

export interface AgentDefinition {
  id: string
  name: string
  description: string
  instructions: string
  icon: string
  allowedTools?: string[]
  model?: string
}

export interface SubagentDefinition {
  id: string
  label: string
  description: string
  systemPrompt: string
  writable: boolean
  tools?: string[]
  model?: string
}

export interface ProviderDefinition {
  id: string
  name: string
  baseUrl: string
  apiKeyEnv?: string
  models?: string[]
}

export interface PanelDefinition {
  id: string
  title: string
  icon?: ComponentType<{ size?: number }>
  area: 'sidebar' | 'bottom' | 'modal' | 'tab'
  defaultOpen?: boolean
  component: LazyExoticComponent<ComponentType<PanelProps>>
}

export interface PanelProps {
  pluginId: string
  config: Record<string, unknown>
}

export interface ComponentDefinition {
  id: string
  slot: string
  component: LazyExoticComponent<ComponentType<unknown>>
}

export interface SlashCommand {
  id: string
  label: string
  description: string
  execute: (args: string) => string | Promise<string>
}

export interface Keybinding {
  key: string
  command: string
  when?: string
}

export interface ThemeDefinition {
  id: string
  name: string
  colors: Record<string, string>
}

export interface SkillDefinition {
  name: string
  description: string
  location: string
  disableModelInvocation?: boolean
}

export interface PluginContributions {
  tools?: ToolDefinition[]
  agents?: AgentDefinition[]
  subagents?: SubagentDefinition[]
  providers?: ProviderDefinition[]
  panels?: PanelDefinition[]
  components?: ComponentDefinition[]
  commands?: SlashCommand[]
  keybindings?: Keybinding[]
  themes?: ThemeDefinition[]
  skills?: SkillDefinition[]
  customInstructions?: string
  mcpServers?: MCPServerConfig[]
}

export interface MCPServerConfig {
  id: string
  name: string
  type: 'stdio' | 'sse' | 'http' | 'json'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
  disabledTools?: string[]
  timeout?: number
}

// ── Plugin lifecycle ───────────────────────────────────────────────────────────

export interface PluginLifecycle {
  hooks?: PluginHooks
  teardown?: Array<() => void>
}

export interface PluginActivationContext {
  id: string
  config: Record<string, unknown>
  dataDir: string

  // Tool registration
  registerTool: (tool: ToolDefinition) => () => void
  unregisterTool: (name: string) => void

  // Hook registration
  onBeforeToolCall: (handler: (toolCall: BeforeToolCallContext, ctx: HookContext) => Promise<BeforeToolCallResult | null>) => () => void
  onAfterToolCall: (handler: (result: AfterToolCallContext, ctx: HookContext) => Promise<AfterToolCallResult>) => () => void
  onTransformContext: (handler: (messages: unknown[], ctx: HookContext) => Promise<unknown[]>) => () => void
  onSessionEvent: (handler: (event: SessionEvent) => void) => () => void
  onFileChange: (handler: (change: FileChangeEvent) => void) => () => void

  // UI registration
  registerPanel: (panel: PanelDefinition) => () => void
  registerCommand: (cmd: SlashCommand) => () => void
  registerKeybinding: (kb: Keybinding) => () => void
  registerTheme: (theme: ThemeDefinition) => () => void

  // Store access
  stores: {
    chat: {
      getMessages: () => Message[]
      sendMessage: (text: string) => void
    }
    session: {
      getActiveSession: () => Session | null
    }
    app: {
      getPermissionMode: () => string
    }
  }

  // Tauri bridge
  tauri: {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
    listen: (event: string, handler: (payload: unknown) => void) => Promise<() => void>
  }

  // Scoped filesystem
  fs: {
    readFile: (path: string) => Promise<string>
    writeFile: (path: string, content: string) => Promise<void>
    listDir: (path: string) => Promise<PluginDirEntry[]>
    deleteFile: (path: string) => Promise<void>
  }

  // Logging
  log: {
    info: (msg: string, ...args: unknown[]) => void
    warn: (msg: string, ...args: unknown[]) => void
    error: (msg: string, ...args: unknown[]) => void
  }

  // Plugin-to-plugin communication
  pubsub: {
    publish: (channel: string, data: unknown) => void
    subscribe: (channel: string, handler: (data: unknown) => void) => () => void
  }
}

// ── Plugin interface ────────────────────────────────────────────────────────────

export interface BetopiaPlugin {
  manifest: PluginManifest

  onActivate?: (ctx: PluginActivationContext) => PluginLifecycle | Promise<PluginLifecycle>
  onDeactivate?: () => void | Promise<void>

  contributions?: PluginContributions
}

// ── Plugin filesystem entry ──────────────────────────────────────────────────────

export interface PluginDirEntry {
  name: string
  isFile: boolean
  isDir: boolean
  size: number
}

// ── Plugin source types ─────────────────────────────────────────────────────────

export type PluginSourceType = 'built-in' | 'local' | 'npm'

export interface PluginConfigEntry {
  id: string
  enabled: boolean
  source?: string
  config?: Record<string, unknown>
}

// ── Plugin state ────────────────────────────────────────────────────────────────

export interface PluginState {
  id: string
  name: string
  version: string
  enabled: boolean
  sourceType: PluginSourceType
  error?: string
}
