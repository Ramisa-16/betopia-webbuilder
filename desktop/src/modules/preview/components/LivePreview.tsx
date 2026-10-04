/**
 * LivePreview.tsx - Manus-style sandbox preview
 * Desktop/Mobile viewport toggle, URL breadcrumb bar, error detection.
 */

import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { parseRuntimeError, makeLogEntry } from '@/lib/error-detector'
import type { DetectedError, LogEntry } from '@/types'

interface Props {
  projectPath: string
  entryFile: string | null
  refreshKey: number
  onChangeEntry: () => void
  overrideSrc?: string
  serverUrl?: string | null
  serverMode?: 'build' | 'static' | 'runtime' | null
  onError?: (error: DetectedError) => void
  onLog?: (log: LogEntry) => void
  onSwitchToCode?: () => void
  onStopServer?: () => void
  hideBuilderBadge?: boolean
}

type PreviewState    = 'idle' | 'loading' | 'ready' | 'error'
type ViewportDevice  = 'desktop' | 'tablet' | 'mobile'

const DEVICE_SIZES: Record<ViewportDevice, { w: string; label: string }> = {
  desktop: { w: '100%',  label: 'Desktop' },
  tablet:  { w: '768px', label: 'Tablet'  },
  mobile:  { w: '390px', label: 'Mobile'  },
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeEntryPath(value: string): string {
  return value.replace(/^\/+/, '').replace(/\\/g, '/')
}

export default function LivePreview({
  projectPath, entryFile, refreshKey, onChangeEntry,
  overrideSrc, serverUrl, serverMode, onError, onLog, onSwitchToCode, onStopServer,
  hideBuilderBadge = false,
}: Props) {
  const iframeRef                       = useRef<HTMLIFrameElement>(null)
  const [state, setState]               = useState<PreviewState>('idle')
  const [errorMsg, setErrorMsg]         = useState<string | null>(null)
  const [errorCount, setErrorCount]     = useState(0)
  const [showConsole, setShowConsole]   = useState(false)
  const [consoleLogs, setConsoleLogs]   = useState<string[]>([])
  const [iframeKey, setIframeKey]       = useState(0)
  const [device, setDevice]             = useState<ViewportDevice>('desktop')
  const [urlPath, setUrlPath]           = useState('/')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [editingUrl, setEditingUrl]     = useState(false)
  const [urlInput, setUrlInput]         = useState('')
  const [customUrl, setCustomUrl]       = useState<string | null>(null)
  const urlInputRef                     = useRef<HTMLInputElement>(null)

  // Stable URL — custom URL (typed in bar) takes highest priority
  const url = useMemo(() => {
    if (customUrl) return customUrl
    if (serverUrl) {
      const base = trimTrailingSlash(serverUrl)
      if (serverMode === 'build' || serverMode === 'runtime') return base
      if (!entryFile) return base
      const path = normalizeEntryPath(entryFile)
      return path ? `${base}/${path}` : base
    }
    if (overrideSrc) return overrideSrc
    if (projectPath && entryFile) return convertFileSrc(projectPath + '/' + entryFile)
    return ''
  }, [customUrl, serverUrl, serverMode, entryFile, overrideSrc, projectPath])

  const startEditingUrl = useCallback(() => {
    setUrlInput(url || 'http://localhost:5173')
    setEditingUrl(true)
    requestAnimationFrame(() => { urlInputRef.current?.select() })
  }, [url])

  const commitUrl = useCallback(() => {
    const u = urlInput.trim()
    if (u) setCustomUrl(u.startsWith('http') ? u : `http://${u}`)
    setEditingUrl(false)
  }, [urlInput])

  const buildUrlWithBust = useCallback(() => {
    if (!url) return ''
    const sep = url.includes('?') ? '&' : '?'
    return url + sep + '_t=' + Date.now()
  }, [url])

  // Load on URL/refresh change and hard refresh.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !url) { setState('idle'); return }
    setState('loading')
    setErrorMsg(null)
    iframe.src = buildUrlWithBust()
  }, [url, refreshKey, iframeKey, buildUrlWithBust])

  const handleManualRefresh = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe || !url) return
    setState('loading'); setErrorMsg(null)
    iframe.src = buildUrlWithBust()
    onLog?.(makeLogEntry('info', 'Preview refreshed', 'preview'))
  }, [url, buildUrlWithBust, onLog])

  const handleLoad = useCallback(() => {
    setState('ready'); setErrorMsg(null)
    const iframe = iframeRef.current
    if (!iframe || !url) return

    // Track URL path for breadcrumb
    try {
      const loc = iframe.contentWindow?.location
      if (loc) setUrlPath(loc.pathname || '/')
    } catch {}

    try {
      const win = iframe.contentWindow as (Window & { console: Console; onerror: any; onunhandledrejection: any }) | null
      if (!win) return

      // Inject base tag for local files
      if (!serverUrl) {
        const doc = iframe.contentDocument || win.document
        doc?.querySelectorAll('base').forEach(b => b.remove())
        const base = doc?.createElement('base')
        if (base && doc?.head) { base.href = convertFileSrc(projectPath) + '/'; doc.head.prepend(base) }
      }

      // Force square corners inside the previewed document so the web view
      // itself stays sharp, even if the app uses rounded cards by default.
      try {
        const doc = iframe.contentDocument || win.document
        if (doc?.head) {
          let style = doc.getElementById('betopia-preview-square-corners') as HTMLStyleElement | null
          if (!style) {
            style = doc.createElement('style')
            style.id = 'betopia-preview-square-corners'
            doc.head.appendChild(style)
          } else if (style.parentElement !== doc.head) {
            doc.head.appendChild(style)
          }
          style.textContent = [
            'html, body, #root, #app, [data-root] { border-radius: 0 !important; overflow: auto !important; margin: 0 !important; width: 100% !important; height: 100% !important; background: transparent !important; }',
            '*, *::before, *::after { border-radius: 0 !important; }',
            'iframe { border-radius: 0 !important; }',
            'html, body, * { scrollbar-width: none !important; -ms-overflow-style: none !important; }',
            'html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }',
          ].join('\n')

          const rootTargets = [doc.documentElement, doc.body].filter(Boolean) as HTMLElement[]
          for (const el of rootTargets) {
            el.style.setProperty('border-radius', '0', 'important')
            el.style.setProperty('overflow', 'auto', 'important')
          }

          const forceSquareCorners = () => {
            const nodes = [doc.documentElement, doc.body, ...Array.from(doc.querySelectorAll('*'))]
            for (const node of nodes) {
              const el = node as HTMLElement | null
              if (!el || !el.style) continue
              el.style.setProperty('border-radius', '0', 'important')
              el.style.setProperty('clip-path', 'none', 'important')
              el.style.setProperty('mask', 'none', 'important')
              el.style.setProperty('border-top-left-radius', '0', 'important')
              el.style.setProperty('border-top-right-radius', '0', 'important')
              el.style.setProperty('border-bottom-left-radius', '0', 'important')
              el.style.setProperty('border-bottom-right-radius', '0', 'important')
            }
          }

          forceSquareCorners()
          const observer = new MutationObserver(() => forceSquareCorners())
          observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
          win.addEventListener('pagehide', () => observer.disconnect(), { once: true })
        }
      } catch {}

      const origError = win.console.error.bind(win.console)
      win.console.error = function(...args: unknown[]) {
        origError(...args)
        const msg = args.map(function(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a) }).join(' ')
        setConsoleLogs(function(prev) { return [...prev.slice(-99), '[error] ' + msg] })
        const err = parseRuntimeError(msg)
        setErrorCount(function(c) { return c + 1 })
        onError?.(err)
        onLog?.(makeLogEntry('error', msg, 'runtime', undefined, true))
      }

      const origWarn = win.console.warn.bind(win.console)
      win.console.warn = function(...args: unknown[]) {
        origWarn(...args)
        const msg = args.map(function(a) { return String(a) }).join(' ')
        setConsoleLogs(function(prev) { return [...prev.slice(-99), '[warn] ' + msg] })
        onLog?.(makeLogEntry('warn', msg, 'runtime'))
      }

      const origLog = win.console.log.bind(win.console)
      win.console.log = function(...args: unknown[]) {
        origLog(...args)
        const msg = args.map(function(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a) }).join(' ')
        setConsoleLogs(function(prev) { return [...prev.slice(-99), msg] })
      }

      win.onerror = function(message, _src, lineno, colno) {
        const msg = typeof message === 'string' ? message : 'Unknown error'
        const err = parseRuntimeError(msg + ' (line ' + lineno + ':' + colno + ')')
        setErrorCount(function(c) { return c + 1 })
        onError?.(err); onLog?.(makeLogEntry('error', msg, 'runtime', 'line ' + lineno + ':' + colno, true))
        return false
      }

      win.onunhandledrejection = function(ev: PromiseRejectionEvent) {
        const msg = (ev.reason && ev.reason.message) ? ev.reason.message : String(ev.reason) || 'Unhandled promise rejection'
        const err = parseRuntimeError(msg)
        setErrorCount(function(c) { return c + 1 })
        onError?.(err); onLog?.(makeLogEntry('error', msg, 'runtime', undefined, true))
      }
    } catch { /* cross-origin — ignore */ }
  }, [serverUrl, projectPath, onError, onLog, url])

  const handleIframeError = useCallback(() => {
    setState('error'); setErrorMsg('Preview failed to load')
    onLog?.(makeLogEntry('error', 'Preview failed to load', 'preview'))
  }, [onLog])

  // Visibility recovery
  useEffect(() => {
    const h = () => {
      if (document.visibilityState !== 'visible') return
      const iframe = iframeRef.current
      if (!iframe || !url) return
      try { iframe.contentWindow?.location.reload() } catch { iframe.src = buildUrlWithBust() }
    }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [url, buildUrlWithBust])


  const clearErrors = () => { setErrorCount(0); setErrorMsg(null); setConsoleLogs([]) }

  const handleForceRefresh = () => {
    setIframeKey(k => k + 1); clearErrors()
    onLog?.(makeLogEntry('info', 'Hard refresh', 'preview'))
  }

  const openInNewTab = () => url && window.open(url, '_blank')

  useEffect(() => {
    if (!isFullscreen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isFullscreen])

  return (
    <div className={`manus-preview${isFullscreen ? ' manus-preview--fullscreen' : ''}`}>
      {/* ── Top toolbar ── */}
      <div className="manus-preview-toolbar">
        {/* Viewport toggle */}
        <div className="manus-viewport-toggle">
          <button
            className={'manus-viewport-btn' + (device === 'desktop' ? ' active' : '')}
            onClick={() => setDevice('desktop')}
            title="Desktop view"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="14" rx="2"/><line x1="8" y1="22" x2="16" y2="22"/><line x1="12" y1="18" x2="12" y2="22"/>
            </svg>
          </button>
          <button
            className={'manus-viewport-btn' + (device === 'tablet' ? ' active' : '')}
            onClick={() => setDevice('tablet')}
            title="Tablet view"
          >
            <svg width="12" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="1" width="18" height="22" rx="2"/>
              <circle cx="12" cy="18.5" r="1.2" fill="currentColor" stroke="none"/>
            </svg>
          </button>
          <button
            className={'manus-viewport-btn' + (device === 'mobile' ? ' active' : '')}
            onClick={() => setDevice('mobile')}
            title="Mobile view"
          >
            <svg width="13" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>
            </svg>
          </button>
        </div>

        {/* URL breadcrumb */}
        <div className="manus-url-bar">
          <button className="manus-url-nav" onClick={handleManualRefresh} title="Reload">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5"/>
            </svg>
          </button>
          {editingUrl ? (
            <input
              ref={urlInputRef}
              className="manus-url-input"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitUrl() }
                if (e.key === 'Escape') { setEditingUrl(false) }
              }}
              onBlur={commitUrl}
              placeholder="http://localhost:5173"
            />
          ) : (
            <div className="manus-url-breadcrumb" onClick={startEditingUrl} title="Click to edit URL">
              <span className="manus-url-origin">
                {customUrl
                  ? customUrl.replace(/^https?:\/\//, '')
                  : serverUrl ? serverUrl.replace(/^https?:\/\//, '') : (entryFile ? entryFile.split('/').pop() : 'preview')}
              </span>
              {urlPath && urlPath !== '/' && !customUrl && (
                <>
                  <span className="manus-url-sep">/</span>
                  <span className="manus-url-path">{urlPath.replace(/^\//, '')}</span>
                </>
              )}
              <svg className="manus-url-edit-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </div>
          )}
          <div className="manus-url-actions">
            {url && (
              <button className="manus-url-btn" onClick={openInNewTab} title="Open in browser">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Right actions */}
        <div className="manus-preview-actions">
          {errorCount > 0 && (
            <button className="manus-error-pill" onClick={clearErrors} title="Clear errors">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              {errorCount} error{errorCount !== 1 ? 's' : ''}
            </button>
          )}
          <button
            className={'manus-console-btn' + (showConsole ? ' active' : '')}
            onClick={() => setShowConsole(s => !s)}
            title="Console"
          >
            Console
          </button>
          <button className="manus-preview-icon-btn" onClick={handleForceRefresh} title="Hard refresh">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
          </button>
          <button
            className={'manus-preview-icon-btn' + (isFullscreen ? ' active' : '')}
            onClick={() => setIsFullscreen(f => !f)}
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/>
                <path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>
                <path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
              </svg>
            )}
          </button>
          {onStopServer && serverMode === 'runtime' && (
            <button className="manus-stop-server-btn" onClick={onStopServer} title="Stop dev server">
              <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
                <rect x="1" y="1" width="8" height="8" rx="1"/>
              </svg>
              Stop
            </button>
          )}
          {onSwitchToCode && !isFullscreen && (
            <button className="manus-edit-btn" onClick={onSwitchToCode} title="Edit code">
              Edit
            </button>
          )}
        </div>
      </div>
      {isFullscreen && (
        <div className="preview-fullscreen-esc-hint">Press Esc to exit fullscreen</div>
      )}

      {/* ── Console strip ── */}
      {showConsole && (
        <div className="manus-console">
          <div className="manus-console-header">
            <span>Console</span>
            <button onClick={() => setConsoleLogs([])} className="manus-console-clear">Clear</button>
          </div>
          <div className="manus-console-body">
            {consoleLogs.length === 0
              ? <span style={{ color: 'var(--text-3)', fontSize: 11 }}>No output</span>
              : consoleLogs.map((l, i) => (
                  <div key={i} className={'manus-console-line' + (l.startsWith('[error]') ? ' error' : l.startsWith('[warn]') ? ' warn' : '')}>
                    {l}
                  </div>
                ))
            }
          </div>
        </div>
      )}

      {/* ── Preview frame ── */}
      <div className={`manus-preview-stage${device === 'mobile' ? ' manus-preview-mobile' : device === 'tablet' ? ' manus-preview-tablet' : ' manus-preview-desktop'}`}>
        <div className={`manus-phone-frame${device === 'desktop' ? ' desktop-flat' : ''}`}>
          {device === 'mobile' && <div className="manus-phone-notch" />}
          <div className="manus-phone-screen">
            {renderIframe()}
          </div>
          {device === 'mobile' && <div className="manus-phone-home" />}
        </div>
      </div>
    </div>
  )

  function renderIframe() {
    if (state === 'error' && errorMsg) {
      return (
        <div className="manus-preview-error">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p className="manus-preview-error-title">Preview Error</p>
          <p className="manus-preview-error-msg">{errorMsg}</p>
          <button className="manus-preview-retry-btn" onClick={handleManualRefresh}>Retry</button>
        </div>
      )
    }
    if (!url) {
      return <PreviewUrlInput onLoad={(u) => { iframeRef.current && (iframeRef.current.src = u); setState('loading') }} onSwitchToCode={onSwitchToCode} />
    }
    return (
      <iframe
        key={iframeKey}
        ref={iframeRef}
        title="Live Preview"
        loading="eager"
        onLoad={handleLoad}
        onError={handleIframeError}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-pointer-lock"
        style={{ width: '100%', height: '100%', border: 'none', display: 'block', background: 'transparent' }}
      />
    )
  }
}

function PreviewUrlInput({ onLoad, onSwitchToCode }: { onLoad: (url: string) => void; onSwitchToCode?: () => void }) {
  const [input, setInput] = useState('http://localhost:5173')
  const submit = () => {
    const u = input.trim()
    if (u) onLoad(u.startsWith('http') ? u : `http://${u}`)
  }
  return (
    <div className="manus-preview-empty">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--text-3)', marginBottom: 12 }}>
        <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
      <p className="manus-preview-empty-title">Enter Preview URL</p>
      <p className="manus-preview-empty-sub">Paste your dev server URL (e.g. http://localhost:5173)</p>
      <div style={{ display: 'flex', gap: 6, marginTop: 12, width: '100%', maxWidth: 340 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="http://localhost:5173"
          style={{
            flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)',
            background: 'var(--bg-2)', color: 'var(--text-1)', fontSize: 13, outline: 'none',
          }}
          autoFocus
        />
        <button className="manus-preview-retry-btn" onClick={submit} style={{ whiteSpace: 'nowrap' }}>
          Load
        </button>
      </div>
      {onSwitchToCode && (
        <button className="manus-preview-retry-btn" onClick={onSwitchToCode} style={{ marginTop: 8, opacity: 0.6 }}>
          Back to Code
        </button>
      )}
    </div>
  )
}
