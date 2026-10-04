export type AgentStatus = 'working' | 'waiting'

export type AgentSource = 'terminal' | 'local'

export type AgentSignalKind = 'started' | 'working' | 'attention' | 'finished' | 'exited'

export type AgentSignal = {
  session_id: string
  kind: AgentSignalKind
  agent: string | null
}

export type AgentSession = {
  sessionId: string
  agent: string
  status: AgentStatus
  startedAt: number
  lastActivityAt: number
  attentionSince: number | null
}

export type NotificationKind = 'attention' | 'finished' | 'error'

export type AgentNotification = {
  id: string
  source: AgentSource
  sessionId: string
  agent: string
  kind: NotificationKind
  at: number
  read: boolean
}

export type LocalAgentState = {
  agent: string
  status: AgentStatus
} | null
