import type { BetopiaPlugin, PluginConfigEntry, PluginState, PluginLifecycle, PluginActivationContext } from './plugin-api'
import { PluginHookRegistry } from './hooks'
import { PluginRegistry } from './plugin-registry'
import { PluginScope } from './plugin-scope'
import { PluginLoader } from './plugin-loader'
import { createPluginContext } from './plugin-context'
import type { Message, Session } from '../../types'
import type { ToolDefinition } from './plugin-api'

interface PubSub {
  channels: Map<string, Array<(data: unknown) => void>>
}

function createPubSub(): PubSub {
  return { channels: new Map() }
}

function pubsubPublish(pubsub: PubSub, channel: string, data: unknown): void {
  const handlers = pubsub.channels.get(channel)
  if (handlers) {
    for (const handler of handlers) {
      try { handler(data) } catch (e) { console.error('[plugin:pubsub] handler error:', e) }
    }
  }
}

function pubsubSubscribe(pubsub: PubSub, channel: string, handler: (data: unknown) => void): () => void {
  if (!pubsub.channels.has(channel)) {
    pubsub.channels.set(channel, [])
  }
  pubsub.channels.get(channel)!.push(handler)
  return () => {
    const handlers = pubsub.channels.get(channel)
    if (handlers) {
      const idx = handlers.indexOf(handler)
      if (idx >= 0) handlers.splice(idx, 1)
    }
  }
}

export interface StoreBridge {
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

export type PluginManagerEvent = 'plugin:activated' | 'plugin:deactivated' | 'plugin:error'

type PluginManagerListener = (data: { pluginId: string; error?: string }) => void

export class PluginManager {
  readonly hooks: PluginHookRegistry
  readonly registry: PluginRegistry
  readonly loader: PluginLoader

  private plugins = new Map<string, { plugin: BetopiaPlugin; scope: PluginScope; state: PluginState }>()
  private configEntries = new Map<string, PluginConfigEntry>()
  private pubsub: PubSub
  private stores: StoreBridge
  private listeners: Array<PluginManagerListener> = []
  private dataDir: string

  constructor(stores: StoreBridge, dataDir: string = '') {
    this.hooks = new PluginHookRegistry()
    this.registry = new PluginRegistry()
    this.loader = new PluginLoader()
    this.pubsub = createPubSub()
    this.stores = stores
    this.dataDir = dataDir
  }

  on(event: PluginManagerEvent, listener: PluginManagerListener): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) this.listeners.splice(idx, 1)
    }
  }

  private emit(event: PluginManagerEvent, data: { pluginId: string; error?: string }): void {
    for (const listener of this.listeners) {
      try { listener(data) } catch (e) { console.error('[plugin:manager] listener error:', e) }
    }
  }

  getPluginState(pluginId: string): PluginState | undefined {
    return this.plugins.get(pluginId)?.state
  }

  getAllPluginStates(): PluginState[] {
    return Array.from(this.plugins.values()).map(p => p.state)
  }

  async configure(entries: PluginConfigEntry[]): Promise<void> {
    this.configEntries.clear()
    for (const entry of entries) {
      this.configEntries.set(entry.id, entry)
    }
  }

  async loadAndActivateAll(): Promise<void> {
    for (const [id, entry] of this.configEntries) {
      if (!entry.enabled) continue
      await this.activatePlugin(id)
    }
  }

  async activatePlugin(pluginId: string): Promise<void> {
    const entry = this.configEntries.get(pluginId)
    if (!entry) {
      console.warn(`[plugin:manager] No config entry for "${pluginId}"`)
      return
    }

    const existing = this.plugins.get(pluginId)
    if (existing) {
      await this.deactivatePlugin(pluginId)
    }

    const scope = new PluginScope()
    try {
      const plugin = await this.loader.loadPlugin(entry)
      const dataDir = this.dataDir ? `${this.dataDir}/${pluginId}` : `/tmp/betopia/plugins/${pluginId}`

      const ctx = createPluginContext(
        pluginId,
        entry.config ?? {},
        dataDir,
        this.hooks,
        this.registry,
        scope,
        this.stores,
        {
          publish: (channel, data) => pubsubPublish(this.pubsub, channel, data),
          subscribe: (channel, handler) => pubsubSubscribe(this.pubsub, channel, handler),
        },
      )

      // Register declarative contributions
      if (plugin.contributions) {
        this.registerContributions(pluginId, plugin.contributions, ctx, scope)
      }

      // Activate (dynamic subscriptions)
      let lifecycle: PluginLifecycle | undefined
      if (plugin.onActivate) {
        lifecycle = await plugin.onActivate(ctx)
      }

      if (lifecycle?.hooks) {
        this.registerHookContributions(pluginId, lifecycle.hooks, scope)
      }

      if (lifecycle?.teardown) {
        for (const fn of lifecycle.teardown) {
          scope.add(fn)
        }
      }

      const state: PluginState = {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        enabled: true,
        sourceType: this.loader['detectSourceType'](entry),
      }

      this.plugins.set(pluginId, { plugin, scope, state })
      this.emit('plugin:activated', { pluginId })
      console.log(`[plugin:manager] Activated "${pluginId}"`)
    } catch (e) {
      scope.dispose()
      const errorMsg = e instanceof Error ? e.message : String(e)
      this.plugins.set(pluginId, {
        plugin: { manifest: { id: pluginId, name: pluginId, version: '0.0.0' } },
        scope,
        state: { id: pluginId, name: pluginId, version: '0.0.0', enabled: false, sourceType: 'local', error: errorMsg },
      })
      this.emit('plugin:error', { pluginId, error: errorMsg })
      console.error(`[plugin:manager] Failed to activate "${pluginId}":`, e)
    }
  }

  async deactivatePlugin(pluginId: string): Promise<void> {
    const existing = this.plugins.get(pluginId)
    if (!existing) return

    try {
      if (existing.plugin.onDeactivate) {
        await existing.plugin.onDeactivate()
      }
    } catch (e) {
      console.error(`[plugin:manager] Error deactivating "${pluginId}":`, e)
    }

    existing.scope.dispose()
    this.hooks.removeAllForPlugin(pluginId)
    this.registry.removeAllForPlugin(pluginId)
    this.plugins.delete(pluginId)
    this.emit('plugin:deactivated', { pluginId })
  }

  async reloadPlugin(pluginId: string): Promise<void> {
    this.loader.invalidateCache(pluginId)
    await this.activatePlugin(pluginId)
  }

  async deactivateAll(): Promise<void> {
    const ids = Array.from(this.plugins.keys())
    await Promise.all(ids.map(id => this.deactivatePlugin(id)))
  }

  getPluginToolDefinitions(): ToolDefinition[] {
    return this.registry.getAllTools().map(r => ({
      ...r.definition,
      name: r.definition.globalName ? r.definition.name : `${r.pluginId}__${r.definition.name}`,
    }))
  }

  getPluginToolExecutionMap(): Map<string, (args: Record<string, unknown>, ctx: import('./plugin-api').ToolExecutionContext) => Promise<import('./plugin-api').ToolResult>> {
    const map = new Map<string, (args: Record<string, unknown>, ctx: import('./plugin-api').ToolExecutionContext) => Promise<import('./plugin-api').ToolResult>>()
    for (const r of this.registry.getAllTools()) {
      const name = r.definition.globalName ? r.definition.name : `${r.pluginId}__${r.definition.name}`
      map.set(name, r.definition.execute)
    }
    return map
  }

  private registerContributions(
    pluginId: string,
    contributions: NonNullable<BetopiaPlugin['contributions']>,
    ctx: PluginActivationContext,
    scope: PluginScope,
  ): void {
    // Tools
    if (contributions.tools) {
      for (const tool of contributions.tools) {
        const disposer = ctx.registerTool(tool)
        scope.add(disposer)
      }
    }

    // Agents
    if (contributions.agents) {
      for (const agent of contributions.agents) {
        const disposer = this.registry.registerAgent(pluginId, agent)
        scope.add(disposer)
      }
    }

    // Subagents
    if (contributions.subagents) {
      for (const subagent of contributions.subagents) {
        const disposer = this.registry.registerSubagent(pluginId, subagent)
        scope.add(disposer)
      }
    }

    // Providers
    if (contributions.providers) {
      for (const provider of contributions.providers) {
        const disposer = this.registry.registerProvider(pluginId, provider)
        scope.add(disposer)
      }
    }

    // Panels
    if (contributions.panels) {
      for (const panel of contributions.panels) {
        const disposer = ctx.registerPanel(panel)
        scope.add(disposer)
      }
    }

    // Commands
    if (contributions.commands) {
      for (const cmd of contributions.commands) {
        const disposer = ctx.registerCommand(cmd)
        scope.add(disposer)
      }
    }

    // Keybindings
    if (contributions.keybindings) {
      for (const kb of contributions.keybindings) {
        const disposer = ctx.registerKeybinding(kb)
        scope.add(disposer)
      }
    }

    // Themes
    if (contributions.themes) {
      for (const theme of contributions.themes) {
        const disposer = ctx.registerTheme(theme)
        scope.add(disposer)
      }
    }

    // MCP servers (delegated to config)
    if (contributions.mcpServers) {
      console.log(`[plugin] "${pluginId}" declares MCP servers — add to config for activation`)
    }
  }

  private registerHookContributions(pluginId: string, hooks: NonNullable<PluginLifecycle['hooks']>, scope: PluginScope): void {
    if (hooks.beforeToolCall) {
      const disposer = this.hooks.registerBeforeToolCall(pluginId, hooks.beforeToolCall)
      scope.add(disposer)
    }
    if (hooks.afterToolCall) {
      const disposer = this.hooks.registerAfterToolCall(pluginId, hooks.afterToolCall)
      scope.add(disposer)
    }
    if (hooks.transformContext) {
      const disposer = this.hooks.registerTransformContext(pluginId, hooks.transformContext)
      scope.add(disposer)
    }
    if (hooks.onToolStream) {
      const disposer = this.hooks.registerStreamHandler(pluginId, hooks.onToolStream)
      scope.add(disposer)
    }
    if (hooks.onSessionEvent) {
      const disposer = this.hooks.registerSessionEventHandler(pluginId, hooks.onSessionEvent)
      scope.add(disposer)
    }
    if (hooks.onFileChange) {
      const disposer = this.hooks.registerFileChangeHandler(pluginId, hooks.onFileChange)
      scope.add(disposer)
    }
  }
}
