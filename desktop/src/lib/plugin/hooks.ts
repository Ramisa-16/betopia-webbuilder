import type { BeforeToolCallContext, BeforeToolCallResult, AfterToolCallContext, AfterToolCallResult, HookContext, StreamEvent, SessionEvent, FileChangeEvent } from './plugin-api'

export interface HookEntry<T> {
  pluginId: string
  handler: T
}

export interface HookTimeoutConfig {
  enabled: boolean
  defaultTimeoutMs: number
}

export class PluginHookRegistry {
  private beforeToolCallHandlers: Array<HookEntry<(toolCall: BeforeToolCallContext, ctx: HookContext) => Promise<BeforeToolCallResult | null>>> = []
  private afterToolCallHandlers: Array<HookEntry<(result: AfterToolCallContext, ctx: HookContext) => Promise<AfterToolCallResult>>> = []
  private transformContextHandlers: Array<HookEntry<(messages: unknown[], ctx: HookContext) => Promise<unknown[]>>> = []
  private streamHandlers: Array<HookEntry<(event: StreamEvent, ctx: HookContext) => void>> = []
  private sessionEventHandlers: Array<HookEntry<(event: SessionEvent) => void>> = []
  private fileChangeHandlers: Array<HookEntry<(change: FileChangeEvent) => void>> = []

  timeoutConfig: HookTimeoutConfig = { enabled: false, defaultTimeoutMs: 5000 }

  registerBeforeToolCall(pluginId: string, handler: (toolCall: BeforeToolCallContext, ctx: HookContext) => Promise<BeforeToolCallResult | null>): () => void {
    const entry: HookEntry<typeof handler> = { pluginId, handler }
    this.beforeToolCallHandlers.push(entry)
    return () => {
      const idx = this.beforeToolCallHandlers.indexOf(entry)
      if (idx >= 0) this.beforeToolCallHandlers.splice(idx, 1)
    }
  }

  registerAfterToolCall(pluginId: string, handler: (result: AfterToolCallContext, ctx: HookContext) => Promise<AfterToolCallResult>): () => void {
    const entry: HookEntry<typeof handler> = { pluginId, handler }
    this.afterToolCallHandlers.push(entry)
    return () => {
      const idx = this.afterToolCallHandlers.indexOf(entry)
      if (idx >= 0) this.afterToolCallHandlers.splice(idx, 1)
    }
  }

  registerTransformContext(pluginId: string, handler: (messages: unknown[], ctx: HookContext) => Promise<unknown[]>): () => void {
    const entry: HookEntry<typeof handler> = { pluginId, handler }
    this.transformContextHandlers.push(entry)
    return () => {
      const idx = this.transformContextHandlers.indexOf(entry)
      if (idx >= 0) this.transformContextHandlers.splice(idx, 1)
    }
  }

  registerStreamHandler(pluginId: string, handler: (event: StreamEvent, ctx: HookContext) => void): () => void {
    const entry: HookEntry<typeof handler> = { pluginId, handler }
    this.streamHandlers.push(entry)
    return () => {
      const idx = this.streamHandlers.indexOf(entry)
      if (idx >= 0) this.streamHandlers.splice(idx, 1)
    }
  }

  registerSessionEventHandler(pluginId: string, handler: (event: SessionEvent) => void): () => void {
    const entry: HookEntry<typeof handler> = { pluginId, handler }
    this.sessionEventHandlers.push(entry)
    return () => {
      const idx = this.sessionEventHandlers.indexOf(entry)
      if (idx >= 0) this.sessionEventHandlers.splice(idx, 1)
    }
  }

  registerFileChangeHandler(pluginId: string, handler: (change: FileChangeEvent) => void): () => void {
    const entry: HookEntry<typeof handler> = { pluginId, handler }
    this.fileChangeHandlers.push(entry)
    return () => {
      const idx = this.fileChangeHandlers.indexOf(entry)
      if (idx >= 0) this.fileChangeHandlers.splice(idx, 1)
    }
  }

  // ── Dispatchers ──────────────────────────────────────────────────────────────

  async dispatchBeforeToolCall(toolCall: BeforeToolCallContext, ctx: HookContext): Promise<BeforeToolCallResult | null> {
    let current = toolCall
    for (const { pluginId, handler } of this.beforeToolCallHandlers) {
      const pluginCtx: HookContext = { ...ctx, pluginId }
      let result: BeforeToolCallResult | null = null
      try {
        result = await this.runWithTimeout(() => handler(current, pluginCtx), pluginId, 'beforeToolCall')
      } catch (e) {
        console.error(`[plugin] beforeToolCall handler error in "${pluginId}":`, e)
        continue
      }
      if (result === null) continue
      if (result.type === 'block') return result
      if (result.type === 'modify') current = result.toolCall
    }
    return { type: 'pass', toolCall: current }
  }

  async dispatchAfterToolCall(result: AfterToolCallContext, ctx: HookContext): Promise<AfterToolCallResult> {
    let current: AfterToolCallResult = {}
    for (const { pluginId, handler } of this.afterToolCallHandlers) {
      const pluginCtx: HookContext = { ...ctx, pluginId }
      const r = await this.runWithTimeout(() => handler(result, pluginCtx), pluginId, 'afterToolCall')
      if (r.terminate) current.terminate = true
      if (r.isError !== undefined) current.isError = r.isError
      if (r.result !== undefined) current.result = r.result
    }
    return current
  }

  async dispatchTransformContext(messages: unknown[], ctx: HookContext): Promise<unknown[]> {
    let current = messages
    for (const { pluginId, handler } of this.transformContextHandlers) {
      const pluginCtx: HookContext = { ...ctx, pluginId }
      current = await this.runWithTimeout(() => handler(current, pluginCtx), pluginId, 'transformContext')
    }
    return current
  }

  dispatchStreamEvent(event: StreamEvent, ctx: HookContext): void {
    for (const { pluginId, handler } of this.streamHandlers) {
      try {
        handler(event, { ...ctx, pluginId })
      } catch (e) {
        console.error(`[plugin] stream handler error in "${pluginId}":`, e)
      }
    }
  }

  dispatchSessionEvent(event: SessionEvent): void {
    for (const { pluginId, handler } of this.sessionEventHandlers) {
      try {
        handler(event)
      } catch (e) {
        console.error(`[plugin] session event handler error in "${pluginId}":`, e)
      }
    }
  }

  dispatchFileChange(change: FileChangeEvent): void {
    for (const { pluginId, handler } of this.fileChangeHandlers) {
      try {
        handler(change)
      } catch (e) {
        console.error(`[plugin] file change handler error in "${pluginId}":`, e)
      }
    }
  }

  removeAllForPlugin(pluginId: string): void {
    const filter = <T>(entries: Array<HookEntry<T>>) => entries.filter(e => e.pluginId !== pluginId)
    this.beforeToolCallHandlers = filter(this.beforeToolCallHandlers)
    this.afterToolCallHandlers = filter(this.afterToolCallHandlers)
    this.transformContextHandlers = filter(this.transformContextHandlers)
    this.streamHandlers = filter(this.streamHandlers)
    this.sessionEventHandlers = filter(this.sessionEventHandlers)
    this.fileChangeHandlers = filter(this.fileChangeHandlers)
  }

  private async runWithTimeout<T>(fn: () => Promise<T>, pluginId: string, hookName: string): Promise<T> {
    if (!this.timeoutConfig.enabled) return fn()
    const timeoutMs = this.timeoutConfig.defaultTimeoutMs
    let timer: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Plugin "${pluginId}" hook "${hookName}" timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    return Promise.race([fn().finally(() => clearTimeout(timer!)), timeoutPromise])
  }
}
