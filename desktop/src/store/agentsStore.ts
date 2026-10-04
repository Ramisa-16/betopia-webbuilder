import { create } from 'zustand'
import { BUILTIN_AGENTS, findAgent, newAgentId, type Agent } from '@/lib/agents'

const LS_CUSTOM = 'betopia:agents:custom'
const LS_ACTIVE = 'betopia:agents:active'

function loadCustom(): Agent[] {
  try { return JSON.parse(localStorage.getItem(LS_CUSTOM) ?? '[]') } catch { return [] }
}
function loadActive(): string {
  return localStorage.getItem(LS_ACTIVE) ?? BUILTIN_AGENTS[0].id
}
function saveCustom(agents: Agent[]) {
  try { localStorage.setItem(LS_CUSTOM, JSON.stringify(agents)) } catch {}
}
function saveActive(id: string) {
  try { localStorage.setItem(LS_ACTIVE, id) } catch {}
}

type AgentsState = {
  customAgents: Agent[]
  activeId: string
  all: () => Agent[]
  setActiveId: (id: string) => void
  upsert: (agent: Agent) => void
  remove: (id: string) => void
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  customAgents: loadCustom(),
  activeId: loadActive(),

  all: () => [...BUILTIN_AGENTS, ...get().customAgents],

  setActiveId: (id) => {
    set({ activeId: id })
    saveActive(id)
  },

  upsert: (agent) => {
    if (agent.builtIn) return
    const list = get().customAgents
    const idx = list.findIndex(a => a.id === agent.id)
    const next = idx === -1 ? [...list, agent] : list.map(a => a.id === agent.id ? agent : a)
    set({ customAgents: next })
    saveCustom(next)
  },

  remove: (id) => {
    const next = get().customAgents.filter(a => a.id !== id)
    set({ customAgents: next })
    saveCustom(next)
    if (get().activeId === id) {
      set({ activeId: BUILTIN_AGENTS[0].id })
      saveActive(BUILTIN_AGENTS[0].id)
    }
  },
}))

export { newAgentId, findAgent }
export type { Agent }
