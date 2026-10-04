import { create } from 'zustand'

export const DEFAULT_MAX_ROUNDS = 3

export type ManagedPhase = 'spawning' | 'working' | 'reviewing' | 'done'

export type ManagedAgent = {
  /** Chat session ID this agent was spawned from */
  sessionId: string
  /** PTY terminal session ID */
  terminalSessionId: string
  task: string
  rounds: number
  maxRounds: number
  phase: ManagedPhase
  reviewedAtRound: number
  pendingReview: boolean
}

type ManagedAgentsState = {
  agents: Record<string, ManagedAgent>
  register: (a: {
    sessionId: string
    terminalSessionId: string
    task: string
    maxRounds?: number
  }) => void
  setPhase: (sessionId: string, phase: ManagedPhase) => void
  markReviewed: (sessionId: string) => void
  setPendingReview: (sessionId: string, pending: boolean) => void
  bumpRound: (sessionId: string) => void
  remove: (sessionId: string) => void
  get: (sessionId: string) => ManagedAgent | undefined
  getBySessionId: (sessionId: string) => ManagedAgent | undefined
  getByTerminalSessionId: (terminalSessionId: string) => ManagedAgent | undefined
}

export const useManagedAgentsStore = create<ManagedAgentsState>((set, get) => ({
  agents: {},

  register: ({ sessionId, terminalSessionId, task, maxRounds }) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [sessionId]: {
          sessionId,
          terminalSessionId,
          task,
          rounds: 0,
          maxRounds: maxRounds ?? DEFAULT_MAX_ROUNDS,
          phase: 'spawning',
          reviewedAtRound: -1,
          pendingReview: false,
        },
      },
    })),

  setPhase: (sessionId, phase) =>
    set((s) => {
      const a = s.agents[sessionId]
      if (!a || a.phase === phase) return s
      return { agents: { ...s.agents, [sessionId]: { ...a, phase } } }
    }),

  markReviewed: (sessionId) =>
    set((s) => {
      const a = s.agents[sessionId]
      if (!a) return s
      return {
        agents: {
          ...s.agents,
          [sessionId]: { ...a, reviewedAtRound: a.rounds, pendingReview: false },
        },
      }
    }),

  setPendingReview: (sessionId, pending) =>
    set((s) => {
      const a = s.agents[sessionId]
      if (!a || a.pendingReview === pending) return s
      return { agents: { ...s.agents, [sessionId]: { ...a, pendingReview: pending } } }
    }),

  bumpRound: (sessionId) =>
    set((s) => {
      const a = s.agents[sessionId]
      if (!a) return s
      return {
        agents: {
          ...s.agents,
          [sessionId]: { ...a, rounds: a.rounds + 1, phase: 'working' },
        },
      }
    }),

  remove: (sessionId) =>
    set((s) => {
      if (!s.agents[sessionId]) return s
      const next = { ...s.agents }
      delete next[sessionId]
      return { agents: next }
    }),

  get: (sessionId) => get().agents[sessionId],
  getBySessionId: (sessionId) => get().agents[sessionId],
  getByTerminalSessionId: (terminalSessionId) =>
    Object.values(get().agents).find((a) => a.terminalSessionId === terminalSessionId),
}))
