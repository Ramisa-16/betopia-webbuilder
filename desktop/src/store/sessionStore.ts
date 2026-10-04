import { create } from 'zustand'
import type { Message, SessionCompactionData } from '@/types'
import { persistWrite, persistRead, writeSessionJsonl, readSessionJsonl, deleteSessionJsonl } from '@/lib/persist'

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  compaction?: SessionCompactionData
  parentId?: string  // set when branched from another session
}

const LS_KEY = (projectPath: string) => `betopia:sessions:${projectPath.replace(/[/\\:]/g, '_')}`
const FILE_KEY = (projectPath: string) => `sessions_${projectPath.replace(/[/\\: ]/g, '_').slice(-60)}.json`

function genId() { return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }

function loadSessions(projectPath: string): ChatSession[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY(projectPath)) ?? '[]') } catch { return [] }
}

// Strip messages from sessions before writing to localStorage — JSONL is the source of truth for full history.
// This keeps localStorage usage tiny (just metadata) and avoids QuotaExceededError on large chat histories.
function sessionMeta(s: ChatSession): ChatSession { return { ...s, messages: [] } }

function saveSessions(projectPath: string, sessions: ChatSession[]) {
  const data = sessions.slice(0, 20)
  try { localStorage.setItem(LS_KEY(projectPath), JSON.stringify(data.map(sessionMeta))) } catch {}
  persistWrite(FILE_KEY(projectPath), data).catch(() => {})
}

/** Restore sessions from file into localStorage if localStorage has nothing for this project. */
export async function restoreSessionsFromFile(projectPath: string): Promise<void> {
  if (localStorage.getItem(LS_KEY(projectPath))) return
  const saved = await persistRead<ChatSession[]>(FILE_KEY(projectPath))
  if (saved?.length) {
    // Store only metadata to avoid quota issues
    try { localStorage.setItem(LS_KEY(projectPath), JSON.stringify(saved.map(sessionMeta))) } catch {}
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
  syncCompaction: (compaction?: SessionCompactionData) => void
  hydrateMessages: (sessionId: string, messages: Message[]) => void
  loadMessagesFromDisk: (sessionId: string) => Promise<Message[]>
  branchSession: (atMessageIndex?: number) => string
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
    deleteSessionJsonl(id).catch(() => {})
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
    // Also write per-session JSONL — source of truth for full message history
    writeSessionJsonl(activeId, messages).catch(() => {})
    set({ sessions: next })
  },

  syncCompaction: (compaction) => {
    const { sessions, activeId, projectPath } = get()
    if (!activeId) return
    const next = sessions.map(s => s.id === activeId
      ? { ...s, compaction, updatedAt: Date.now() }
      : s)
    if (projectPath) saveSessions(projectPath, next)
    set({ sessions: next })
  },

  hydrateMessages: (sessionId, messages) => {
    const { sessions } = get()
    const next = sessions.map(s => s.id === sessionId ? { ...s, messages } : s)
    set({ sessions: next })
  },

  loadMessagesFromDisk: async (sessionId) => {
    const messages = await readSessionJsonl<Message>(sessionId)
    return messages ?? []
  },

  branchSession: (atMessageIndex) => {
    const { sessions, activeId, projectPath } = get()
    const current = sessions.find(s => s.id === activeId)
    if (!current) return activeId ?? ''
    const msgs = atMessageIndex !== undefined
      ? current.messages.slice(0, atMessageIndex + 1)
      : [...current.messages]
    const parentTitle = current.title.replace(/ \(branch \d+\)$/, '')
    const branchNum = sessions.filter(s => s.parentId === activeId).length + 1
    const newId = genId()
    const branch: ChatSession = {
      id: newId,
      title: `${parentTitle} (branch ${branchNum})`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: msgs,
      compaction: current.compaction && msgs.some(m => m.id === current.compaction?.compactedThroughMessageId)
        ? current.compaction
        : undefined,
      parentId: activeId ?? undefined,
    }
    const next = [branch, ...sessions]
    if (projectPath) saveSessions(projectPath, next)
    writeSessionJsonl(newId, msgs).catch(() => {})
    set({ sessions: next, activeId: newId })
    return newId
  },

  reset: () => set({ projectPath: null, sessions: [], activeId: null }),
}))

export function getActiveMessages(): Message[] {
  const { sessions, activeId } = useSessionStore.getState()
  return sessions.find(s => s.id === activeId)?.messages ?? []
}
