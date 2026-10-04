import { create } from 'zustand'
import type { Message } from '@/types'
import { persistWrite, persistRead } from '@/lib/persist'

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

const LS_KEY = (projectPath: string) => `betopia:sessions:${projectPath.replace(/[/\\:]/g, '_')}`
const FILE_KEY = (projectPath: string) => `sessions_${projectPath.replace(/[/\\: ]/g, '_').slice(-60)}.json`

function genId() { return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }

function loadSessions(projectPath: string): ChatSession[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY(projectPath)) ?? '[]') } catch { return [] }
}

function saveSessions(projectPath: string, sessions: ChatSession[]) {
  const data = sessions.slice(0, 20)
  try { localStorage.setItem(LS_KEY(projectPath), JSON.stringify(data)) } catch {}
  persistWrite(FILE_KEY(projectPath), data).catch(() => {})
}

/** Restore sessions from file into localStorage if localStorage has nothing for this project. */
export async function restoreSessionsFromFile(projectPath: string): Promise<void> {
  if (localStorage.getItem(LS_KEY(projectPath))) return
  const saved = await persistRead<ChatSession[]>(FILE_KEY(projectPath))
  if (saved?.length) {
    try { localStorage.setItem(LS_KEY(projectPath), JSON.stringify(saved)) } catch {}
  }
}

type SessionState = {
  projectPath: string | null
  sessions: ChatSession[]
  activeId: string | null
  init: (projectPath: string, initialMessages: Message[]) => void
  setActiveId: (id: string) => void
  createSession: (title?: string) => string
  deleteSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  syncMessages: (messages: Message[]) => void
  reset: () => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  projectPath: null,
  sessions: [],
  activeId: null,

  init: (projectPath, initialMessages) => {
    const stored = loadSessions(projectPath)
    let sessions = stored
    let activeId: string

    if (sessions.length === 0) {
      const s: ChatSession = { id: genId(), title: 'Session 1', createdAt: Date.now(), updatedAt: Date.now(), messages: initialMessages }
      sessions = [s]
      activeId = s.id
    } else {
      // Merge initial messages into most recent session
      activeId = sessions[0].id
      if (initialMessages.length > 0 && sessions[0].messages.length === 0) {
        sessions[0] = { ...sessions[0], messages: initialMessages }
      }
    }

    saveSessions(projectPath, sessions)
    set({ projectPath, sessions, activeId })
  },

  setActiveId: (id) => set({ activeId: id }),

  createSession: (title) => {
    const { sessions, projectPath } = get()
    const n = sessions.length + 1
    const s: ChatSession = { id: genId(), title: title ?? `Session ${n}`, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }
    const next = [s, ...sessions]
    if (projectPath) saveSessions(projectPath, next)
    set({ sessions: next, activeId: s.id })
    return s.id
  },

  deleteSession: (id) => {
    const { sessions, activeId, projectPath } = get()
    const next = sessions.filter(s => s.id !== id)
    if (next.length === 0) {
      const s: ChatSession = { id: genId(), title: 'Session 1', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }
      const final = [s]
      if (projectPath) saveSessions(projectPath, final)
      set({ sessions: final, activeId: s.id })
      return
    }
    const newActive = id === activeId ? (next[0]?.id ?? null) : activeId
    if (projectPath) saveSessions(projectPath, next)
    set({ sessions: next, activeId: newActive })
  },

  renameSession: (id, title) => {
    const { sessions, projectPath } = get()
    const next = sessions.map(s => s.id === id ? { ...s, title } : s)
    if (projectPath) saveSessions(projectPath, next)
    set({ sessions: next })
  },

  syncMessages: (messages) => {
    const { sessions, activeId, projectPath } = get()
    if (!activeId) return
    const next = sessions.map(s => s.id === activeId
      ? { ...s, messages, updatedAt: Date.now() }
      : s)
    if (projectPath) saveSessions(projectPath, next)
    set({ sessions: next })
  },

  reset: () => set({ projectPath: null, sessions: [], activeId: null }),
}))

export function getActiveMessages(): Message[] {
  const { sessions, activeId } = useSessionStore.getState()
  return sessions.find(s => s.id === activeId)?.messages ?? []
}

