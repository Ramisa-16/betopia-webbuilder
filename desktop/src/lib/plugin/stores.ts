import { create } from 'zustand'
import type { PluginState, PanelDefinition } from './plugin-api'

// ── Plugin state store ──────────────────────────────────────────────────────────

interface PluginStoreState {
  plugins: Map<string, PluginState>
  setPlugin: (state: PluginState) => void
  removePlugin: (id: string) => void
  setPluginError: (id: string, error: string) => void
  setPluginEnabled: (id: string, enabled: boolean) => void
  getAll: () => PluginState[]
}

export const usePluginStore = create<PluginStoreState>((set, get) => ({
  plugins: new Map(),

  setPlugin: (state: PluginState) => {
    set(s => {
      const next = new Map(s.plugins)
      next.set(state.id, state)
      return { plugins: next }
    })
  },

  removePlugin: (id: string) => {
    set(s => {
      const next = new Map(s.plugins)
      next.delete(id)
      return { plugins: next }
    })
  },

  setPluginError: (id: string, error: string) => {
    set(s => {
      const next = new Map(s.plugins)
      const existing = next.get(id)
      if (existing) {
        next.set(id, { ...existing, error })
      }
      return { plugins: next }
    })
  },

  setPluginEnabled: (id: string, enabled: boolean) => {
    set(s => {
      const next = new Map(s.plugins)
      const existing = next.get(id)
      if (existing) {
        next.set(id, { ...existing, enabled })
      }
      return { plugins: next }
    })
  },

  getAll: () => Array.from(get().plugins.values()),
}))

// ── Panel store ─────────────────────────────────────────────────────────────────

interface PanelStoreState {
  panels: PanelDefinition[]
  openPanels: Set<string>
  registerPanel: (def: PanelDefinition) => void
  unregisterPanel: (id: string) => void
  togglePanel: (id: string) => void
  openPanel: (id: string) => void
  closePanel: (id: string) => void
  isOpen: (id: string) => boolean
}

export const usePanelStore = create<PanelStoreState>((set, get) => ({
  panels: [],
  openPanels: new Set(),

  registerPanel: (def: PanelDefinition) => {
    set(s => {
      const existing = s.panels.findIndex(p => p.id === def.id)
      if (existing >= 0) {
        const next = [...s.panels]
        next[existing] = def
        return { panels: next }
      }
      return { panels: [...s.panels, def] }
    })
    if (def.defaultOpen) {
      get().openPanel(def.id)
    }
  },

  unregisterPanel: (id: string) => {
    set(s => ({
      panels: s.panels.filter(p => p.id !== id),
    }))
    set(s => {
      const next = new Set(s.openPanels)
      next.delete(id)
      return { openPanels: next }
    })
  },

  togglePanel: (id: string) => {
    set(s => {
      const next = new Set(s.openPanels)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return { openPanels: next }
    })
  },

  openPanel: (id: string) => {
    set(s => {
      const next = new Set(s.openPanels)
      next.add(id)
      return { openPanels: next }
    })
  },

  closePanel: (id: string) => {
    set(s => {
      const next = new Set(s.openPanels)
      next.delete(id)
      return { openPanels: next }
    })
  },

  isOpen: (id: string) => get().openPanels.has(id),
}))
