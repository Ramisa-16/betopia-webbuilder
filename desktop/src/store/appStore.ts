import { create } from 'zustand'

export type Status = 'picking' | 'opening' | 'ready'
export type AgentMode = 'backend' | 'inline'
export type PermissionMode = 'default' | 'auto_review' | 'plan_mode' | 'full_access'
export type EffortLevel = 'low' | 'medium' | 'high'

interface AppState {
  status: Status
  projectPath: string | null
  agentMode: AgentMode
  permissionMode: PermissionMode
  effortLevel: EffortLevel

  setStatus: (s: Status) => void
  setProjectPath: (p: string | null) => void
  setAgentMode: (m: AgentMode) => void
  setPermissionMode: (m: PermissionMode) => void
  setEffortLevel: (l: EffortLevel) => void
}

export const useAppStore = create<AppState>((set) => ({
  status: 'picking',
  projectPath: null,
  agentMode: 'inline',
  permissionMode: (() => {
    try {
      const stored = window.localStorage.getItem('betopia:permission-mode')
      if (stored === 'default' || stored === 'auto_review' || stored === 'plan_mode' || stored === 'full_access') return stored as PermissionMode
    } catch {}
    return 'default'
  })(),
  effortLevel: (() => {
    try {
      const s = window.localStorage.getItem('betopia:effort-level')
      if (s === 'low' || s === 'medium' || s === 'high') return s as EffortLevel
    } catch {}
    return 'high'
  })(),

  setStatus: (status) => set({ status }),
  setProjectPath: (projectPath) => set({ projectPath }),
  setAgentMode: (agentMode) => set({ agentMode }),
  setPermissionMode: (permissionMode) => {
    try { window.localStorage.setItem('betopia:permission-mode', permissionMode) } catch {}
    set({ permissionMode })
  },
  setEffortLevel: (effortLevel) => {
    try { window.localStorage.setItem('betopia:effort-level', effortLevel) } catch {}
    set({ effortLevel })
  },
}))
