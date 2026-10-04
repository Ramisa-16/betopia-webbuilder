import { useState, useEffect, useRef, useMemo } from 'react'
import { useAgentStore } from '../../../store/agentStore'
import type { AgentNotification, AgentStatus } from '../../../lib/agentTypes'

type Props = {
  onActivateLocal: () => void
}

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const NOTIF_LABEL: Record<AgentNotification['kind'], string> = {
  attention: 'needs input',
  finished: 'finished',
  error: 'failed',
}

function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: status === 'waiting' ? 'var(--accent, #7c6af7)' : 'var(--text-muted, #888)',
        flexShrink: 0,
      }}
    />
  )
}

export function NotificationBell({ onActivateLocal }: Props) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const ref = useRef<HTMLDivElement>(null)

  const sessions = useAgentStore((s) => s.sessions)
  const localAgent = useAgentStore((s) => s.localAgent)
  const notifications = useAgentStore((s) => s.notifications)
  const markAllRead = useAgentStore((s) => s.markAllRead)

  const active = useMemo(() => Object.values(sessions), [sessions])
  const activeCount = active.length + (localAgent ? 1 : 0)
  const waitingCount =
    active.filter((s) => s.status === 'waiting').length +
    (localAgent?.status === 'waiting' ? 1 : 0)
  const unreadDone = notifications.filter((n) => !n.read && n.kind !== 'attention').length
  const badge = waitingCount + unreadDone

  // Refresh relative timestamps every 30s
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const handleOpen = (next: boolean) => {
    setOpen(next)
    if (next) markAllRead()
  }

  const empty = activeCount === 0 && notifications.length === 0

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="icon-btn"
        title="Agent notifications"
        onClick={() => handleOpen(!open)}
        style={{ position: 'relative' }}
      >
        {/* Bell SVG */}
        <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 1.5a5.25 5.25 0 0 1 5.25 5.25c0 3.15 1.05 4.2 1.75 5.25H2c.7-1.05 1.75-2.1 1.75-5.25A5.25 5.25 0 0 1 9 1.5Z" />
          <path d="M6.75 12v.75a2.25 2.25 0 0 0 4.5 0V12" />
        </svg>
        {badge > 0 && (
          <span style={{
            position: 'absolute',
            top: -2,
            right: -2,
            minWidth: 14,
            height: 14,
            borderRadius: 7,
            background: 'var(--accent, #7c6af7)',
            color: '#fff',
            fontSize: 9,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 3px',
            lineHeight: 1,
          }}>
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </button>

      {open && (
        <div className="agent-notification-popover" style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: 6,
          width: 300,
          background: 'var(--bg-panel, #1e1e2e)',
          border: '1px solid var(--border, #333)',
          borderRadius: 8,
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          zIndex: 1000,
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border, #333)' }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text, #e0e0e0)' }}>Agent Notifications</span>
            {activeCount > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted, #888)', background: 'var(--bg-hover, #2a2a3a)', borderRadius: 10, padding: '1px 6px' }}>
                {activeCount} active
              </span>
            )}
          </div>

          {/* Body */}
          {empty ? (
            <div style={{ padding: '16px 12px', textAlign: 'center', fontSize: 11, color: 'var(--text-muted, #888)', lineHeight: 1.6 }}>
              No agent activity yet.<br />
              Run Betopia agent or Claude Code to track it here.
            </div>
          ) : (
            <div style={{ maxHeight: 280, overflowY: 'auto', padding: 4 }}>
              {localAgent && (
                <button
                  className="agent-notif-row"
                  onClick={() => { onActivateLocal(); setOpen(false) }}
                >
                  <StatusDot status={localAgent.status} />
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text, #e0e0e0)', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {localAgent.agent}
                  </span>
                  <span style={{ fontSize: 10, color: localAgent.status === 'waiting' ? 'var(--accent, #7c6af7)' : 'var(--text-muted, #888)', flexShrink: 0 }}>
                    {localAgent.status}
                  </span>
                </button>
              )}
              {active.map((sess) => (
                <div key={sess.sessionId} className="agent-notif-row" style={{ cursor: 'default' }}>
                  <StatusDot status={sess.status} />
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text, #e0e0e0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sess.agent}
                  </span>
                  <span style={{ fontSize: 10, color: sess.status === 'waiting' ? 'var(--accent, #7c6af7)' : 'var(--text-muted, #888)', flexShrink: 0 }}>
                    {sess.status}
                  </span>
                </div>
              ))}
              {activeCount > 0 && notifications.length > 0 && (
                <div style={{ margin: '2px 8px', height: 1, background: 'var(--border, #333)' }} />
              )}
              {notifications.map((n) => (
                <div key={n.id} className="agent-notif-row" style={{ cursor: 'default' }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: n.kind === 'error' ? 'var(--error, #e05c5c)' : n.kind === 'finished' ? 'transparent' : 'var(--accent, #7c6af7)',
                    border: n.kind === 'finished' ? '1.5px solid var(--text-muted, #888)' : 'none',
                  }} />
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text, #e0e0e0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {n.agent}{' '}
                    <span style={{ color: 'var(--text-muted, #888)' }}>{NOTIF_LABEL[n.kind]}</span>
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted, #888)', flexShrink: 0 }}>
                    {relativeTime(n.at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
