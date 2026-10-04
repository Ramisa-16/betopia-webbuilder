import { useEffect, useRef } from 'react'
import { useAgentStore } from '../../../store/agentStore'
import { routeAgentNotification } from '../../../lib/agentNotify'
import type { AgentStatus } from '../../../lib/agentTypes'

const AGENT = 'Betopia'

export type AgentRunStatus = 'idle' | 'thinking' | 'streaming' | 'awaiting-approval' | 'error'

function isBusy(s: AgentRunStatus): boolean {
  return s === 'thinking' || s === 'streaming' || s === 'awaiting-approval'
}

function liveStatus(s: AgentRunStatus): AgentStatus | null {
  if (s === 'awaiting-approval') return 'waiting'
  if (s === 'thinking' || s === 'streaming') return 'working'
  return null
}

type Props = {
  status: AgentRunStatus
  error?: string | null
  visible: boolean
  focused: boolean
  onActivate: () => void
}

export function LocalAgentNotificationsBridge({ status, error, visible, focused, onActivate }: Props) {
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const prev = useRef<AgentRunStatus>(status)

  useEffect(() => {
    // Keep localAgent state in sync
    const live = liveStatus(status)
    useAgentStore.getState().setLocalAgent(live ? { agent: AGENT, status: live } : null)

    const was = prev.current
    prev.current = status
    if (was === status) return

    const fire = (kind: 'attention' | 'finished' | 'error', title: string, body?: string) =>
      routeAgentNotification({
        source: 'local',
        agent: AGENT,
        kind,
        title,
        body,
        focused: focusedRef.current,
        visible: visibleRef.current,
        allowToast: true,
        onActivate,
      })

    if (status === 'awaiting-approval') {
      fire('attention', 'Betopia needs your approval', 'Approve a tool to continue')
    } else if (status === 'error') {
      fire('error', 'Betopia run failed', error ?? undefined)
    } else if (status === 'idle' && isBusy(was)) {
      fire('finished', 'Betopia finished', 'Your task is ready')
    }
  }, [status, error, onActivate])

  return null
}
