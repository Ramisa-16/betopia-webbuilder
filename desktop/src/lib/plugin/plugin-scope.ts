export class PluginScope {
  private cleanupFns: Array<() => void> = []
  private disposed = false

  add<T extends () => void>(disposer: T): T {
    if (this.disposed) {
      disposer()
      return disposer
    }
    this.cleanupFns.push(disposer)
    return disposer
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.cleanupFns.reverse()) {
      try {
        dispose()
      } catch (e) {
        console.error('[plugin-scope] cleanup error:', e)
      }
    }
    this.cleanupFns = []
  }
}
