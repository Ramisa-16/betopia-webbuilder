import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Message, Session } from '../../types'
import type { PluginActivationContext, ToolDefinition, PanelDefinition, SlashCommand, Keybinding, ThemeDefinition, BeforeToolCallContext, BeforeToolCallResult, AfterToolCallContext, AfterToolCallResult, SessionEvent, FileChangeEvent, PluginDirEntry } from './plugin-api'
import type { PluginHookRegistry } from './hooks'
import type { PluginRegistry } from './plugin-registry'
import type { PluginScope } from './plugin-scope'

interface StoreAccess {
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

interface PubSub {
  publish: (channel: string, data: unknown) => void
  subscribe: (channel: string, handler: (data: unknown) => void) => () => void
}

export function createPluginContext(
  pluginId: string,
  config: Record<string, unknown>,
  dataDir: string,
  hooks: PluginHookRegistry,
  registry: PluginRegistry,
  scope: PluginScope,
  stores: StoreAccess,
  pubsub: PubSub,
): PluginActivationContext {
  return {
    id: pluginId,
    config,
    dataDir,

    registerTool: (tool: ToolDefinition) => {
      const disposer = registry.registerTool(pluginId, tool)
      scope.add(disposer)
      return disposer
    },

    unregisterTool: (name: string) => {
      registry.unregisterTool(name)
    },

    onBeforeToolCall: (handler: (toolCall: BeforeToolCallContext, ctx: { sessionId: string | null; projectPath: string | null; pluginId: string }) => Promise<BeforeToolCallResult | null>) => {
      const disposer = hooks.registerBeforeToolCall(pluginId, handler)
      scope.add(disposer)
      return disposer
    },

    onAfterToolCall: (handler: (result: AfterToolCallContext, ctx: { sessionId: string | null; projectPath: string | null; pluginId: string }) => Promise<AfterToolCallResult>) => {
      const disposer = hooks.registerAfterToolCall(pluginId, handler)
      scope.add(disposer)
      return disposer
    },

    onTransformContext: (handler: (messages: unknown[], ctx: { sessionId: string | null; projectPath: string | null; pluginId: string }) => Promise<unknown[]>) => {
      const disposer = hooks.registerTransformContext(pluginId, handler)
      scope.add(disposer)
      return disposer
    },

    onSessionEvent: (handler: (event: SessionEvent) => void) => {
      const disposer = hooks.registerSessionEventHandler(pluginId, handler)
      scope.add(disposer)
      return disposer
    },

    onFileChange: (handler: (change: FileChangeEvent) => void) => {
      const disposer = hooks.registerFileChangeHandler(pluginId, handler)
      scope.add(disposer)
      return disposer
    },

    registerPanel: (panel: PanelDefinition) => {
      const disposer = registry.registerPanel(pluginId, panel)
      scope.add(disposer)
      return disposer
    },

    registerCommand: (cmd: SlashCommand) => {
      const disposer = registry.registerCommand(pluginId, cmd)
      scope.add(disposer)
      return disposer
    },

    registerKeybinding: (kb: Keybinding) => {
      const disposer = registry.registerKeybinding(pluginId, kb)
      scope.add(disposer)
      return disposer
    },

    registerTheme: (theme: ThemeDefinition) => {
      const disposer = registry.registerTheme(pluginId, theme)
      scope.add(disposer)
      return disposer
    },

    stores,

    tauri: {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args),
      listen: (event: string, handler: (payload: unknown) => void) => listen(event, handler),
    },

    fs: {
      readFile: async (path: string) => {
        if (path.startsWith('..') || path.includes('~')) {
          throw new Error(`Plugin "${pluginId}" denied: path traversal detected`)
        }
        const result = await invoke<string>('plugin_read_file', { pluginDataDir: dataDir, relativePath: path })
        return result
      },
      writeFile: async (path: string, content: string) => {
        if (path.startsWith('..') || path.includes('~')) {
          throw new Error(`Plugin "${pluginId}" denied: path traversal detected`)
        }
        await invoke('plugin_write_file', { pluginDataDir: dataDir, relativePath: path, content })
      },
      listDir: async (path: string): Promise<PluginDirEntry[]> => {
        if (path.startsWith('..') || path.includes('~')) {
          throw new Error(`Plugin "${pluginId}" denied: path traversal detected`)
        }
        const result = await invoke<PluginDirEntry[]>('plugin_list_dir', { pluginDataDir: dataDir, relativePath: path })
        return result
      },
      deleteFile: async (path: string) => {
        if (path.startsWith('..') || path.includes('~')) {
          throw new Error(`Plugin "${pluginId}" denied: path traversal detected`)
        }
        await invoke('plugin_delete_file', { pluginDataDir: dataDir, relativePath: path })
      },
    },

    log: {
      info: (msg: string, ...args: unknown[]) => console.log(`[plugin:${pluginId}]`, msg, ...args),
      warn: (msg: string, ...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, msg, ...args),
      error: (msg: string, ...args: unknown[]) => console.error(`[plugin:${pluginId}]`, msg, ...args),
    },

    pubsub,
  }
}
