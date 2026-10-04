/**
 * LogsPanel.tsx
 * Collapsible bottom panel showing runtime errors, build errors,
 * console output, AI agent logs, and auto-fix suggestions.
 * Inspired by open-lovable's error handling approach.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { LogEntry, DetectedError } from '@/types'

interface LogsPanelProps {
  logs: LogEntry[]
  errors: DetectedError[]
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
  onAutoFix: (error: DetectedError) => void
  onClearLogs: () => void
  isFixing: boolean
}

const LEVEL_CONFIG = {
  info:    { icon: 'ℹ',  color: '#60a5fa', label: 'Info'    },
  warn:    { icon: '⚠',  color: '#fbbf24', label: 'Warning' },
  error:   { icon: '✕',  color: '#f87171', label: 'Error'   },
  success: { icon: '✓',  color: '#4ade80', label: 'Success' },
  debug:   { icon: '○',  color: '#9ca3af', label: 'Debug'   },
}

type FilterTab = 'all' | 'errors' | 'warnings' | 'logs'

const PREFS_KEY = 'betopia:general-prefs'
const FALLBACK_FONT = '"JetBrains Mono", "Fira Code", monospace'

interface LogFontStyle {
  fontFamily: string
  fontSize: number
  fontWeight: string
  letterSpacing: number
}

function loadLogFont(): LogFontStyle {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return {
      fontFamily: p.termFontFamily ? `"${p.termFontFamily}", ${FALLBACK_FONT}` : FALLBACK_FONT,
      fontSize: p.termFontSize ? Number(p.termFontSize) : 13,
      fontWeight: p.termFontWeight || 'normal',
      letterSpacing: p.termLetterSpacing !== undefined ? Number(p.termLetterSpacing) : 0,
    }
  } catch {
    return { fontFamily: FALLBACK_FONT, fontSize: 13, fontWeight: 'normal', letterSpacing: 0 }
  }
}

export default function LogsPanel({
  logs,
  errors,
  isOpen,
  onToggle,
  onClose,
  onAutoFix,
  onClearLogs,
  isFixing,
}: LogsPanelProps) {
  const [filter, setFilter] = useState<FilterTab>('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const [logFont, setLogFont] = useState<LogFontStyle>(loadLogFont)

  useEffect(() => {
    const handler = (e: Event) => {
      const p = (e as CustomEvent).detail ?? {}
      setLogFont({
        fontFamily: p.termFontFamily ? `"${p.termFontFamily}", ${FALLBACK_FONT}` : FALLBACK_FONT,
        fontSize: p.termFontSize ? Number(p.termFontSize) : 13,
        fontWeight: p.termFontWeight || 'normal',
        letterSpacing: p.termLetterSpacing !== undefined ? Number(p.termLetterSpacing) : 0,
      })
    }
    window.addEventListener('betopia:term-prefs-change', handler)
    return () => window.removeEventListener('betopia:term-prefs-change', handler)
  }, [])
  const [panelHeight, setPanelHeight] = useState(() => {
    try { return Number(localStorage.getItem('betopia:logs-panel-height')) || 200 } catch { return 200 }
  })
  const isDraggingRef = useRef(false)
  const [isDragging, setIsDragging] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    setIsDragging(true)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return
      const h = Math.max(80, Math.min(window.innerHeight * 0.7, window.innerHeight - ev.clientY))
      setPanelHeight(h)
    }
    const onUp = (ev: MouseEvent) => {
      isDraggingRef.current = false
      setIsDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const h = Math.max(80, Math.min(window.innerHeight * 0.7, window.innerHeight - ev.clientY))
      try { localStorage.setItem('betopia:logs-panel-height', String(Math.round(h))) } catch {}
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const panelStyle = useMemo(() => isOpen ? { height: panelHeight, transition: isDragging ? 'none' : undefined } : undefined, [isOpen, panelHeight, isDragging])

  const errorCount = logs.filter(l => l.level === 'error').length + errors.length
  const warnCount  = logs.filter(l => l.level === 'warn').length

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && isOpen && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, isOpen, autoScroll])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    setAutoScroll(atBottom)
  }, [])

  const filteredLogs = logs.filter(log => {
    if (filter === 'errors')   return log.level === 'error'
    if (filter === 'warnings') return log.level === 'warn'
    if (filter === 'logs')     return log.level === 'info' || log.level === 'debug' || log.level === 'success'
    return true
  })

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
  }

  // Latest unfixed error for the quick-fix button
  const latestError = errors.length > 0 ? errors[errors.length - 1] : null

  return (
    <div className={`logs-panel${isOpen ? ' logs-panel-open' : ' logs-panel-closed'}`} style={panelStyle ?? undefined}>
      {/* Drag handle — only visible when open */}
      {isOpen && <div className="logs-panel-resizer" onMouseDown={startResize} />}
      {/* Panel header / toggle bar */}
      <div className="logs-panel-header" onClick={onToggle}>
        <div className="logs-panel-header-left">
          <button className="logs-toggle-btn" title={isOpen ? 'Collapse panel' : 'Expand panel'}>
            {isOpen ? '▾' : '▴'}
          </button>
          <span className="logs-panel-title">Terminal & Logs</span>

          {errorCount > 0 && (
            <span className="logs-badge logs-badge-error" title={`${errorCount} error(s)`}>
              {errorCount} error{errorCount !== 1 ? 's' : ''}
            </span>
          )}
          {warnCount > 0 && (
            <span className="logs-badge logs-badge-warn" title={`${warnCount} warning(s)`}>
              {warnCount} warn{warnCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="logs-panel-header-right" onClick={e => e.stopPropagation()}>
          {isOpen && latestError && !isFixing && (
            <button
              className="logs-autofix-btn"
              onClick={() => onAutoFix(latestError)}
              title="Ask AI to fix this error automatically"
            >
              ✨ Auto Fix
            </button>
          )}
          {isFixing && (
            <span className="logs-fixing-indicator">
              <span className="logs-spinner" /> Fixing…
            </span>
          )}
          {isOpen && (
            <>
              <button
                className="logs-close-btn"
                onClick={onClose}
                title="Close terminal and logs"
                aria-label="Close terminal and logs"
              >
                ×
              </button>
              <button
                className="logs-action-btn"
                onClick={onClearLogs}
                title="Clear logs"
              >
                🗑 Clear
              </button>
              <button
                className="logs-action-btn"
                onClick={() => setAutoScroll(a => !a)}
                title={autoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
                style={{ opacity: autoScroll ? 1 : 0.5 }}
              >
                ↓
              </button>
            </>
          )}
        </div>
      </div>

      {isOpen && (
        <>
          {/* Filter tabs */}
          <div className="logs-filter-tabs">
            {(['all', 'errors', 'warnings', 'logs'] as FilterTab[]).map(tab => (
              <button
                key={tab}
                className={`logs-filter-tab${filter === tab ? ' active' : ''}`}
                onClick={() => setFilter(tab)}
              >
                {tab === 'all' && '≡ All'}
                {tab === 'errors' && `✕ Errors${errorCount > 0 ? ` (${errorCount})` : ''}`}
                {tab === 'warnings' && `⚠ Warnings${warnCount > 0 ? ` (${warnCount})` : ''}`}
                {tab === 'logs' && 'ℹ Logs'}
              </button>
            ))}
          </div>

          {/* Log content */}
          <div
            className="logs-content"
            ref={scrollRef}
            onScroll={handleScroll}
            style={{ fontFamily: logFont.fontFamily, fontSize: logFont.fontSize, fontWeight: logFont.fontWeight, letterSpacing: logFont.letterSpacing }}
          >
            {/* Detected errors (from iframe / sandbox) */}
            {(filter === 'all' || filter === 'errors') && errors.map(err => (
              <div key={err.id} className="log-row log-row-error log-row-fixable">
                <span className="log-time">{formatTime(err.timestamp)}</span>
                <span className="log-level-icon" style={{ color: '#f87171' }}>✕</span>
                <span className="log-source log-source-runtime">runtime</span>
                <span className="log-message">{err.message}</span>
                {err.file && (
                  <span className="log-location">
                    {err.file}{err.line ? `:${err.line}` : ''}
                  </span>
                )}
                <button
                  className="log-fix-btn"
                  onClick={() => onAutoFix(err)}
                  disabled={isFixing}
                  title="Fix this error with AI"
                >
                  ✨ Fix
                </button>
              </div>
            ))}

            {/* Regular log entries */}
            {filteredLogs.map(log => {
              const cfg = LEVEL_CONFIG[log.level]
              return (
                <div key={log.id} className={`log-row log-row-${log.level}`}>
                  <span className="log-time">{formatTime(log.timestamp)}</span>
                  <span className="log-level-icon" style={{ color: cfg.color }}>{cfg.icon}</span>
                  {log.source && (
                    <span className={`log-source log-source-${log.source}`}>{log.source}</span>
                  )}
                  <span className="log-message">{log.message}</span>
                  {log.details && (
                    <span className="log-location">{log.details}</span>
                  )}
                  {log.fixable && log.level === 'error' && (
                    <button
                      className="log-fix-btn"
                      onClick={() => {
                        // Create a synthetic DetectedError for the log
                        const syntheticError = {
                          id: log.id,
                          category: 'unknown' as const,
                          message: log.message,
                          timestamp: log.timestamp,
                          fixPrompt: `Fix this error: ${log.message}${log.details ? ` (${log.details})` : ''}`,
                        }
                        onAutoFix(syntheticError)
                      }}
                      disabled={isFixing}
                    >
                      ✨ Fix
                    </button>
                  )}
                </div>
              )
            })}

            {filteredLogs.length === 0 && errors.length === 0 && (
              <div className="logs-empty">
                <span>No {filter === 'all' ? '' : filter} logs yet</span>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </>
      )}
    </div>
  )
}
