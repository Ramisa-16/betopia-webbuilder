import { create } from 'zustand'
import type { AgentNotification, AgentSession, AgentStatus, LocalAgentState, NotificationKind } from '../lib/agentTypes'

const MAX_NOTIFICATIONS = 50
let notifSeq = 0

type AgentStoreState = {
  sessions: Record<string, AgentSession>
  localAgent: LocalAgentState
  notifications: AgentNotification[]
  start: (sessionId: string, agent: string) => void
  setStatus: (sessionId: string, status: AgentStatus) => void
  finish: (sessionId: string) => void
  setLocalAgent: (state: LocalAgentState) => void
  pushNotification: (n: { source: AgentSession['sessionId'] extends string ? 'terminal' | 'local' : never; sessionId: string; agent: string; kind: NotificationKind }) => void
  markAllRead: () => void
  clearNotifications: () => void
}

export const useAgentStore = create<AgentStoreState>((set) => ({
  sessions: {},
  localAgent: null,
  notifications: [],

  start: (sessionId, agent) =>
    set((s) => {
      const now = Date.now()
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            sessionId,
            agent,
            status: 'working',
            startedAt: now,
            lastActivityAt: now,
            attentionSince: null,
          },
        },
      }
    }),

  setStatus: (sessionId, status) =>
    set((s) => {
      const prev = s.sessions[sessionId]
      if (!prev || prev.status === status) return s
      const now = Date.now()
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...prev,
            status,
            lastActivityAt: now,
            attentionSince: status === 'waiting' ? now : null,
          },
        },
      }
    }),

  finish: (sessionId) =>
    set((s) => {
      if (!s.sessions[sessionId]) return s
      const next = { ...s.sessions }
      delete next[sessionId]
      return { sessions: next }
    }),

  setLocalAgent: (state) =>
    set((s) => {
      const a = s.localAgent
      if (a === state) return s
      if (a && state && a.status === state.status && a.agent === state.agent) return s
      return { localAgent: state }
    }),

  pushNotification: ({ source, sessionId, agent, kind }) =>
    set((s) => ({
      notifications: [
        { id: `n${++notifSeq}`, source, sessionId, agent, kind, at: Date.now(), read: false },
        ...s.notifications,
      ].slice(0, MAX_NOTIFICATIONS),
    })),

  markAllRead: () =>
    set((s) => {
      if (!s.notifications.some((n) => !n.read)) return s
      return { notifications: s.notifications.map((n) => ({ ...n, read: true })) }
    }),

  clearNotifications: () => set({ notifications: [] }),
}))
