import { create } from 'zustand'
import type { Message } from '@/types'

export type PlanBuildPhase = 'idle' | 'awaiting_plan' | 'awaiting_confirmation' | 'building'
export type PlanSource = 'orchestration' | 'architect' | 'designer'

export interface PlanFlow {
  phase: PlanBuildPhase
  originalPrompt: string
  planText: string
  source: PlanSource
}

const PLAN_FLOW_EMPTY: PlanFlow = { phase: 'idle', originalPrompt: '', planText: '', source: 'orchestration' }

export interface AgentUsageState {
  sessionInputTokens: number
  sessionOutputTokens: number
  sessionCachedTokens: number
  lastInputTokens: number
}

const EMPTY_USAGE: AgentUsageState = {
  sessionInputTokens: 0,
  sessionOutputTokens: 0,
  sessionCachedTokens: 0,
  lastInputTokens: 0,
}

interface ChatState {
  messages: Message[]
  isAgentBusy: boolean
  currentTool: string | null
  planFlow: PlanFlow
  isFixing: boolean
  autoFixAttempts: number
  pendingFileReference: { id: string; path: string } | null
  queuedPrompt: string | null
  queuedAttachments: any[]
  agentUsage: AgentUsageState

  setMessages: (msgs: Message[] | ((prev: Message[]) => Message[])) => void
  addMessage: (msg: Message) => void
  updateMessage: (id: string, msg: Message) => void
  setIsAgentBusy: (busy: boolean) => void
  setCurrentTool: (tool: string | null) => void
  setPlanFlow: (flow: PlanFlow | ((prev: PlanFlow) => PlanFlow)) => void
  resetPlanFlow: () => void
  setIsFixing: (v: boolean) => void
  setAutoFixAttempts: (v: number | ((prev: number) => number)) => void
  setPendingFileReference: (ref: { id: string; path: string } | null) => void
  setQueuedPrompt: (prompt: string | null, attachments?: any[]) => void
  updateUsage: (u: { inputTokens: number; outputTokens: number; cachedInputTokens: number; lastInputTokens: number }) => void
  reset: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isAgentBusy: false,
  currentTool: null,
  planFlow: { ...PLAN_FLOW_EMPTY },
  isFixing: false,
  autoFixAttempts: 0,
  pendingFileReference: null,
  queuedPrompt: null,
  queuedAttachments: [],
  agentUsage: { ...EMPTY_USAGE },

  setMessages: (msgs) =>
    set((s) => ({ messages: typeof msgs === 'function' ? msgs(s.messages) : msgs })),

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  updateMessage: (id, msg) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? msg : m)) })),

  setIsAgentBusy: (isAgentBusy) => set({ isAgentBusy }),
  setCurrentTool: (currentTool) => set({ currentTool }),

  setPlanFlow: (flow) =>
    set((s) => ({ planFlow: typeof flow === 'function' ? flow(s.planFlow) : flow })),

  resetPlanFlow: () => set({ planFlow: { ...PLAN_FLOW_EMPTY } }),
  setIsFixing: (isFixing) => set({ isFixing }),

  setAutoFixAttempts: (v) =>
    set((s) => ({ autoFixAttempts: typeof v === 'function' ? v(s.autoFixAttempts) : v })),

  setPendingFileReference: (pendingFileReference) => set({ pendingFileReference }),

  setQueuedPrompt: (prompt, attachments = []) => set({ queuedPrompt: prompt, queuedAttachments: attachments }),

  updateUsage: (u) => set((s) => ({
    agentUsage: {
      sessionInputTokens: s.agentUsage.sessionInputTokens + u.inputTokens,
      sessionOutputTokens: s.agentUsage.sessionOutputTokens + u.outputTokens,
      sessionCachedTokens: s.agentUsage.sessionCachedTokens + u.cachedInputTokens,
      lastInputTokens: u.lastInputTokens,
    }
  })),

  reset: () =>
    set({
      messages: [],
      isAgentBusy: false,
      currentTool: null,
      planFlow: { ...PLAN_FLOW_EMPTY },
      isFixing: false,
      autoFixAttempts: 0,
      pendingFileReference: null,
      queuedPrompt: null,
      queuedAttachments: [],
      agentUsage: { ...EMPTY_USAGE },
    }),
}))
