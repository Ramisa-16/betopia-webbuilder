import { useState, useEffect, useMemo } from 'react'
import {
  SHORTCUTS, SHORTCUT_GROUPS, getBindingTokens,
  loadUserShortcuts, saveUserShortcuts,
  type ShortcutId, type KeyBinding, type Shortcut,
} from '@/lib/shortcuts'

export default function ShortcutsSection({ onDirty }: { onDirty?: () => void }) {
  const [userShortcuts, setUserShortcuts] = useState<Partial<Record<ShortcutId, KeyBinding[]>>>(loadUserShortcuts)
  const [search, setSearch]               = useState('')
  const [recordingId, setRecordingId]     = useState<ShortcutId | null>(null)
  const [confirmReset, setConfirmReset]   = useState(false)

  const filtered = useMemo(() => {
    if (!search) return SHORTCUTS
    const lower = search.toLowerCase()
    return SHORTCUTS.filter(s => s.label.toLowerCase().includes(lower) || s.group.toLowerCase().includes(lower))
  }, [search])

  const setBinding = (id: ShortcutId, bindings: KeyBinding[]) => {
    const next = { ...userShortcuts, [id]: bindings }
    setUserShortcuts(next); saveUserShortcuts(next); onDirty?.()
  }

  const resetOne = (id: ShortcutId) => {
    const next = { ...userShortcuts }; delete next[id]
    setUserShortcuts(next); saveUserShortcuts(next); onDirty?.()
  }

  const resetAll = () => {
    setUserShortcuts({}); saveUserShortcuts({}); onDirty?.()
    setConfirmReset(false)
  }

  return (
    <div className="shortcuts-section">
      {/* Header */}
      <div className="shortcuts-header">
        <div>
          <div className="shortcuts-title">Keyboard Shortcuts</div>
          <div className="shortcuts-sub">Click a shortcut to rebind it.</div>
        </div>
        <button className="shortcuts-reset-all" onClick={() => setConfirmReset(true)}>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2 7a5 5 0 1 0 1-3M2 2v3h3" />
          </svg>
          Reset All
        </button>
      </div>

      {/* Search */}
      <div className="shortcuts-search-wrap">
        <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="6" cy="6" r="4" /><line x1="9.5" y1="9.5" x2="13" y2="13" />
        </svg>
        <input
          className="shortcuts-search"
          placeholder="Search shortcuts..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button onClick={() => setSearch('')} className="shortcuts-search-clear">✕</button>
        )}
      </div>

      {/* Groups */}
      <div className="shortcuts-groups">
        {SHORTCUT_GROUPS.map(group => {
          const items = filtered.filter(s => s.group === group)
          if (!items.length) return null
          return (
            <div key={group} className="shortcuts-group">
              <div className="shortcuts-group-label">{group}</div>
              <div className="shortcuts-list">
                {items.map(s => (
                  <ShortcutRow
                    key={s.id}
                    shortcut={s}
                    isRecording={recordingId === s.id}
                    userBindings={userShortcuts[s.id]}
                    onStartRecord={() => setRecordingId(s.id)}
                    onStopRecord={() => setRecordingId(null)}
                    onRecord={b => { setBinding(s.id, [b]); setRecordingId(null) }}
                    onClear={() => setBinding(s.id, [])}
                    onReset={() => resetOne(s.id)}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Reset confirm */}
      {confirmReset && (
        <div className="shortcuts-confirm-overlay" onClick={() => setConfirmReset(false)}>
          <div className="shortcuts-confirm" onClick={e => e.stopPropagation()}>
            <div className="shortcuts-confirm-title">Reset all shortcuts?</div>
            <div className="shortcuts-confirm-desc">Reverts all custom bindings to factory defaults. Cannot be undone.</div>
            <div className="shortcuts-confirm-btns">
              <button className="shortcuts-confirm-cancel" onClick={() => setConfirmReset(false)}>Cancel</button>
              <button className="shortcuts-confirm-ok" onClick={resetAll}>Reset All</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ShortcutRow({
  shortcut, isRecording, userBindings,
  onStartRecord, onStopRecord, onRecord, onClear, onReset,
}: {
  shortcut: Shortcut; isRecording: boolean; userBindings?: KeyBinding[]
  onStartRecord: () => void; onStopRecord: () => void
  onRecord: (b: KeyBinding) => void; onClear: () => void; onReset: () => void
}) {
  const bindings   = userBindings !== undefined ? userBindings : shortcut.defaultBindings
  const isModified = userBindings !== undefined
  const has        = bindings && bindings.length > 0

  return (
    <div className="shortcut-row">
      <span className="shortcut-label">{shortcut.label}</span>
      <div className="shortcut-right">
        {isRecording ? (
          <Recorder onRecord={onRecord} onCancel={onStopRecord} />
        ) : (
          <>
            <div className="shortcut-kbd-wrap" onClick={onStartRecord} title="Click to rebind">
              {has ? (
                <div className="shortcut-kbd-group">
                  {getBindingTokens(bindings[0]).map((t, i) => (
                    <kbd key={i} className="shortcut-kbd">{t}</kbd>
                  ))}
                </div>
              ) : (
                <span className="shortcut-unassigned">Unassigned</span>
              )}
            </div>
            <div className="shortcut-actions">
              {isModified && (
                <button className="shortcut-action-btn" title="Reset to default" onClick={onReset}>
                  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M1.5 6a4.5 4.5 0 1 0 .9-2.7M1.5 1.5v3h3" />
                  </svg>
                </button>
              )}
              <button className="shortcut-action-btn danger" title="Clear shortcut" onClick={onClear}>
                <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="3" y1="3" x2="9" y2="9" /><line x1="9" y1="3" x2="3" y2="9" />
                </svg>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Recorder({ onRecord, onCancel }: { onRecord: (b: KeyBinding) => void; onCancel: () => void }) {
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Escape') { onCancel(); return }
      if (['Control','Shift','Alt','Meta'].includes(e.key)) return
      const hasMod = e.ctrlKey || e.altKey || e.metaKey
      if (!hasMod && e.shiftKey && e.key.length === 1) return
      if (!hasMod && !e.shiftKey && e.key !== 'Enter' && e.key !== 'Tab') return
      onRecord({ key: e.key, ctrl: e.ctrlKey || undefined, shift: e.shiftKey || undefined, alt: e.altKey || undefined, meta: e.metaKey || undefined })
    }
    window.addEventListener('keydown', onDown, { capture: true })
    return () => window.removeEventListener('keydown', onDown, { capture: true })
  }, [onRecord, onCancel])

  return (
    <div className="shortcut-recording">
      <span className="shortcut-recording-pulse">●</span>
      Recording… <span className="shortcut-recording-hint">(Esc to cancel)</span>
    </div>
  )
}
