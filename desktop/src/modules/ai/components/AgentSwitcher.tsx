import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useAgentsStore } from '@/store/agentsStore'
import { BUILTIN_AGENTS } from '@/lib/agents'
import { AgentIcon } from './AgentIcons'

const DROPDOWN_WIDTH = 280

export function AgentSwitcher({ openDown = false }: { openDown?: boolean }) {
  const customAgents = useAgentsStore(s => s.customAgents)
  const activeId     = useAgentsStore(s => s.activeId)
  const setActiveId  = useAgentsStore(s => s.setActiveId)

  const all     = useMemo(() => [...BUILTIN_AGENTS, ...customAgents], [customAgents])
  const active  = useMemo(() => all.find(a => a.id === activeId) ?? all[0], [all, activeId])
  const builtIn = useMemo(() => all.filter(a => a.builtIn), [all])
  const custom  = useMemo(() => all.filter(a => !a.builtIn), [all])

  const [open, setOpen] = useState(false)
  const [pos, setPos]   = useState({ top: 0, left: 0, width: DROPDOWN_WIDTH })
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const calcPos = useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const effectiveWidth = Math.min(DROPDOWN_WIDTH, vw - 16)
    let left = r.left
    if (left + effectiveWidth > vw - 8) left = vw - effectiveWidth - 8
    if (left < 8) left = 8
    setPos({ top: r.top - 8, left, width: effectiveWidth })
  }, [])

  useEffect(() => {
    if (!open || openDown) return
    calcPos()
    const close = (e: MouseEvent) => {
      if (!dropRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node))
        setOpen(false)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('resize', calcPos)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('resize', calcPos) }
  }, [open, openDown, calcPos])

  if (openDown) {
    const renderItem = (a: typeof all[0]) => (
      <button key={a.id}
        className={'agent-switcher-inline-opt' + (a.id === activeId ? ' active' : '')}
        onClick={() => setActiveId(a.id)}>
        <AgentIcon icon={a.icon} size={12} />
        <span>{a.name}</span>
        {a.id === activeId && (
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ marginLeft: 'auto', flexShrink: 0 }}>
            <polyline points="2,6 5,9 10,3" />
          </svg>
        )}
      </button>
    )

    return (
      <div className="agent-switcher-inline">
        {builtIn.map(renderItem)}
        {custom.length > 0 && (
          <>
            <div className="agent-dropdown-divider" style={{ margin: '3px 0' }} />
            {custom.map(renderItem)}
          </>
        )}
      </div>
    )
  }

  const dropdown = open ? (
    <div
      ref={dropRef}
      className="agent-dropdown"
      style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateY(-100%)', width: pos.width }}
      onClick={e => e.stopPropagation()}
    >
      <div className="agent-dropdown-section">Built-in</div>
      {builtIn.map(a => (
        <button key={a.id}
          className={`agent-dropdown-item${a.id === activeId ? ' active' : ''}`}
          onClick={() => { setActiveId(a.id); setOpen(false) }}>
          <AgentIcon icon={a.icon} size={13} />
          <span className="agent-dropdown-item-text">
            <span className="agent-dropdown-item-name">{a.name}</span>
            <span className="agent-dropdown-item-desc">{a.description}</span>
          </span>
          {a.id === activeId && <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="2,6 5,9 10,3" /></svg>}
        </button>
      ))}

      {custom.length > 0 && (
        <>
          <div className="agent-dropdown-divider" />
          <div className="agent-dropdown-section">Custom</div>
          {custom.map(a => (
            <button key={a.id}
              className={`agent-dropdown-item${a.id === activeId ? ' active' : ''}`}
              onClick={() => { setActiveId(a.id); setOpen(false) }}>
              <AgentIcon icon={a.icon} size={13} />
              <span className="agent-dropdown-item-text">
                <span className="agent-dropdown-item-name">{a.name}</span>
                {a.description && <span className="agent-dropdown-item-desc">{a.description}</span>}
              </span>
              {a.id === activeId && <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="2,6 5,9 10,3" /></svg>}
            </button>
          ))}
        </>
      )}

      <div className="agent-dropdown-divider" />
      <button className="agent-dropdown-item agent-dropdown-manage" onClick={() => setOpen(false)}>
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="7" cy="7" r="5.5" /><line x1="7" y1="4.5" x2="7" y2="9.5" /><line x1="4.5" y1="7" x2="9.5" y2="7" />
        </svg>
        <span>Manage agents in Settings → Agents</span>
      </button>
    </div>
  ) : null

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button ref={btnRef} className="agent-switcher-btn" onClick={() => setOpen(o => !o)} title={`Agent: ${active.name}`}>
        <AgentIcon icon={active.icon} size={11} />
        <span>{active.name}</span>
        <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="2,3.5 5,6.5 8,3.5" />
        </svg>
      </button>
      {createPortal(dropdown, document.body)}
    </div>
  )
}
