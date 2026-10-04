import { create } from 'zustand'

export type Status = 'picking' | 'opening' | 'ready'
export type AgentMode = 'backend' | 'inline'
export type PermissionMode = 'default' | 'auto_review' | 'full_access'

interface AppState {
  status: Status
  projectPath: string | null
  agentMode: AgentMode
  permissionMode: PermissionMode

  setStatus: (s: Status) => void
  setProjectPath: (p: string | null) => void
  setAgentMode: (m: AgentMode) => void
  setPermissionMode: (m: PermissionMode) => void
}

export const useAppStore = create<AppState>((set) => ({
  status: 'picking',
  projectPath: null,
  agentMode: 'inline',
  permissionMode: (() => {
    try {
      const stored = window.localStorage.getItem('betopia:permission-mode')
      if (stored === 'default' || stored === 'auto_review' || stored === 'full_access') return stored
    } catch {}
    return 'default'
  })(),

  setStatus: (status) => set({ status }),
  setProjectPath: (projectPath) => set({ projectPath }),
  setAgentMode: (agentMode) => set({ agentMode }),
  setPermissionMode: (permissionMode) => {
    try { window.localStorage.setItem('betopia:permission-mode', permissionMode) } catch {}
    set({ permissionMode })
  },
}))
