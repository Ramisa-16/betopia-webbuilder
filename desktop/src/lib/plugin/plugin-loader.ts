import type { BetopiaPlugin, PluginSourceType, PluginConfigEntry } from './plugin-api'
import { PluginLoadError } from './errors'

export class PluginLoader {
  private moduleCache = new Map<string, BetopiaPlugin>()

  async loadPlugin(entry: PluginConfigEntry): Promise<BetopiaPlugin> {
    const sourceType = this.detectSourceType(entry)
    try {
      switch (sourceType) {
        case 'built-in':
          return this.loadBuiltin(entry)
        case 'local':
          return this.loadLocal(entry)
        case 'npm':
          return this.loadNpm(entry)
      }
    } catch (e) {
      throw new PluginLoadError(entry.id, `Failed to load plugin from source "${entry.source ?? entry.id}"`, e)
    }
  }

  private detectSourceType(entry: PluginConfigEntry): PluginSourceType {
    if (entry.id.startsWith('builtin:')) return 'built-in'
    if (entry.id.startsWith('npm:') || entry.source === 'npm') return 'npm'
    return 'local'
  }

  private async loadBuiltin(entry: PluginConfigEntry): Promise<BetopiaPlugin> {
    const moduleId = entry.source ?? entry.id.replace('builtin:', '')
    const mod = await import(
      /* @vite-ignore */
      `../../plugins/${moduleId}/index.ts`
    )
    return this.extractPlugin(mod, entry)
  }

  private async loadLocal(entry: PluginConfigEntry): Promise<BetopiaPlugin> {
    const sourcePath = entry.source ?? entry.id
    const mod = await import(
      /* @vite-ignore */
      sourcePath
    )
    return this.extractPlugin(mod, entry)
  }

  private async loadNpm(entry: PluginConfigEntry): Promise<BetopiaPlugin> {
    const packageName = entry.id.replace('npm:', '')
    const mod = await import(
      /* @vite-ignore */
      packageName
    )
    return this.extractPlugin(mod, entry)
  }

  private extractPlugin(mod: Record<string, unknown>, entry: PluginConfigEntry): BetopiaPlugin {
    const plugin = (mod.default ?? mod) as BetopiaPlugin
    if (!plugin?.manifest?.id) {
      throw new PluginLoadError(entry.id, 'Plugin must have a manifest with an id')
    }
    return plugin
  }

  invalidateCache(pluginId: string): void {
    this.moduleCache.delete(pluginId)
    if (import.meta.hot && typeof import.meta.hot === 'object' && 'invalidate' in import.meta.hot) {
      ;(import.meta.hot as { invalidate?: () => void }).invalidate?.()
    }
  }
}
