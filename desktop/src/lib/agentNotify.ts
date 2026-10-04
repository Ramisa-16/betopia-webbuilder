import { useAgentStore } from '../store/agentStore'
import type { AgentSource, NotificationKind } from './agentTypes'

type RouteArgs = {
  source: AgentSource
  agent: string
  kind: NotificationKind
  title: string
  body?: string
  focused: boolean
  visible: boolean
  allowToast: boolean
  sessionId?: string
  onActivate: () => void
}

export function routeAgentNotification({
  source,
  agent,
  kind,
  focused,
  visible,
  allowToast,
  sessionId = '',
  onActivate,
}: RouteArgs): void {
  if (focused && visible) return

  useAgentStore.getState().pushNotification({ source, agent, kind, sessionId })

  if (allowToast && focused && !visible) {
    showAgentToast({ agent, kind, onActivate })
  }
}

// ── In-app toast ──────────────────────────────────────────────────────────────

const TOAST_DURATION_MS = 5000

const TOAST_LABELS: Record<NotificationKind, string> = {
  attention: 'needs your input',
  finished: 'finished',
  error: 'failed',
}

type ToastArgs = {
  agent: string
  kind: NotificationKind
  onActivate: () => void
}

export function showAgentToast({ agent, kind, onActivate }: ToastArgs): void {
  const container = getOrCreateToastContainer()
  const el = document.createElement('div')
  el.className = 'betopia-agent-toast'
  el.innerHTML = `
    <span class="betopia-agent-toast-agent">${escapeHtml(agent)}</span>
    <span class="betopia-agent-toast-label">${TOAST_LABELS[kind]}</span>
    <button class="betopia-agent-toast-btn">Open</button>
  `
  el.querySelector('.betopia-agent-toast-btn')?.addEventListener('click', () => {
    onActivate()
    remove()
  })
  const remove = () => {
    el.classList.add('betopia-agent-toast-out')
    setTimeout(() => el.remove(), 250)
  }
  container.appendChild(el)
  setTimeout(remove, TOAST_DURATION_MS)
}

function getOrCreateToastContainer(): HTMLElement {
  let c = document.getElementById('betopia-agent-toasts')
  if (!c) {
    c = document.createElement('div')
    c.id = 'betopia-agent-toasts'
    document.body.appendChild(c)
  }
  return c
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
