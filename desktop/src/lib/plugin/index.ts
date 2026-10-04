export { PluginManager } from './plugin-manager'
export type { StoreBridge, PluginManagerEvent } from './plugin-manager'
export { PluginHookRegistry } from './hooks'
export { PluginRegistry } from './plugin-registry'
export { PluginScope } from './plugin-scope'
export { PluginLoader } from './plugin-loader'
export { createPluginContext } from './plugin-context'

export { checkNetworkPermission, checkFilesystemPermission, checkShellPermission } from './plugin-permissions'

export { usePluginStore, usePanelStore } from './stores'

export { PluginError, PluginLoadError, PluginPermissionDenied, PluginTimeoutError } from './errors'

export type { ToolSchema } from '../agent-tools'

export type {
  BetopiaPlugin,
  PluginManifest,
  PluginLifecycle,
  PluginActivationContext,
  PluginContributions,
  PluginConfigEntry,
  PluginState,
  PluginSourceType,
  PluginPermissionManifest,
  PluginHooks,

  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  AgentDefinition,
  SubagentDefinition,
  ProviderDefinition,
  PanelDefinition,
  PanelProps,
  ComponentDefinition,
  SlashCommand,
  Keybinding,
  ThemeDefinition,
  SkillDefinition,
  MCPServerConfig,
  PluginDirEntry,

  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  HookContext,
  StreamEvent,
  SessionEvent,
  FileChangeEvent,

} from './plugin-api'
