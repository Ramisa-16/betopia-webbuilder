import { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react'
import { invoke, Channel } from '@tauri-apps/api/core'

interface Props {
  sessionId: string
  cwd?: string
  shell?: string
  shellArgs?: string[]
  onCwd?: (cwd: string) => void
}

export interface TerminalHandle {
  fit: () => void
  freeze: () => void   // call before collapsing the panel to save good dims
}

interface PtyEvent {
  data: string
  session_id: string
}

interface CtxMenu {
  x: number
  y: number
  hasSelection: boolean
}

const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ sessionId, cwd, shell, shellArgs, onCwd }, ref) {
  const containerRef   = useRef<HTMLDivElement>(null)
  const termRef        = useRef<any>(null)
  const fitRef         = useRef<any>(null)
  const openedRef      = useRef(false)
  const savedDimsRef        = useRef<{ cols: number; rows: number } | null>(null)
  // Dims just before collapse — kept alive until the settle timer fires so we
  // can decide whether the post-expand size change is layout rounding (skip
  // pty_resize) or a genuine user resize (allow pty_resize).
  const preCollapseDimsRef  = useRef<{ cols: number; rows: number } | null>(null)
  // When true, all pty_resize calls are deferred to the settle timer below.
  // Prevents ResizePseudoConsole from firing during the hide→show layout cycle,
  // which on Windows triggers a full ConPTY screen repaint that overwrites
  // xterm's scrollback with only the last N visible rows.
  const ptyResizeLockRef    = useRef(false)
  const ptyResizeLockTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Last dimensions actually sent to PTY.
  const lastPtyDimsRef      = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const doFitRef            = useRef<() => void>(() => {})
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)

  useImperativeHandle(ref, () => ({
    fit: () => doFitRef.current(),
    freeze: () => {
      const term = termRef.current
      if (!term) return
      const dims = { cols: term.cols, rows: term.rows }
      savedDimsRef.current       = dims  // warmup resize on next expand
      preCollapseDimsRef.current = dims  // settle-check baseline
      ptyResizeLockRef.current   = true  // block pty_resize until settled
    },
  }), [])

  const write = useCallback((data: string) => {
    invoke('pty_write', { sessionId, data }).catch(() => {})
  }, [sessionId])

  const copySelection = useCallback(() => {
    const sel: string = termRef.current?.getSelection?.() ?? ''
    if (sel) navigator.clipboard.writeText(sel).catch(() => {})
    setCtxMenu(null)
  }, [])

  const pasteClipboard = useCallback(() => {
    navigator.clipboard.readText().then(text => {
      if (text) write(text)
    }).catch(() => {})
    setCtxMenu(null)
  }, [write])

  const selectAll = useCallback(() => {
    termRef.current?.selectAll?.()
    setCtxMenu(null)
  }, [])

  // close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [ctxMenu])

  useEffect(() => {
    if (!containerRef.current || openedRef.current) return
    openedRef.current = true

    let term: any
    let disposed = false

    const init = async () => {
      const { Terminal: XTerm } = await import('@xterm/xterm')
      const { FitAddon }        = await import('@xterm/addon-fit')
      const { WebLinksAddon }   = await import('@xterm/addon-web-links')

      if (disposed || !containerRef.current) return

      term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
        theme: {
          background:          getComputedStyle(document.documentElement).getPropertyValue('--code-bg').trim() || '#0f0f11',
          foreground:          getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#ececed',
          cursor:              getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#da7756',
          selectionBackground: 'rgba(218,119,86,0.25)',
          black:   '#1e1e1e', red:    '#f87171', green:  '#4ade80', yellow:  '#fbbf24',
          blue:    '#60a5fa', magenta:'#c084fc', cyan:   '#22d3ee', white:   '#e5e7eb',
          brightBlack:  '#4b5563', brightRed:    '#ef4444', brightGreen:  '#22c55e',
          brightYellow: '#f59e0b', brightBlue:   '#3b82f6', brightMagenta:'#a855f7',
          brightCyan:   '#06b6d4', brightWhite:  '#f9fafb',
        },
        scrollback: 5000,
        allowProposedApi: true,
        rightClickSelectsWord: false,
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(new WebLinksAddon())
      term.open(containerRef.current!)
      fitAddon.fit()

      termRef.current = term
      fitRef.current  = fitAddon

      // Key input → PTY
      term.onData((data: string) => write(data))

      // Keyboard shortcuts: copy / paste / select-all
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== 'keydown') return true
        const ctrl = e.ctrlKey || e.metaKey
        const key  = e.key.toLowerCase()

        // Ctrl+C with an active selection → copy instead of sending SIGINT
        if (ctrl && key === 'c' && !e.shiftKey && (term.getSelection?.() ?? '').length > 0) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {})
          term.clearSelection?.()
          return false
        }

        // Ctrl+Shift+C → copy selection
        if (ctrl && e.shiftKey && key === 'c') {
          const sel: string = term.getSelection?.() ?? ''
          if (sel) navigator.clipboard.writeText(sel).catch(() => {})
          return false
        }

        // Ctrl+Shift+V → paste
        if (ctrl && e.shiftKey && key === 'v') {
          navigator.clipboard.readText().then(t => { if (t) write(t) }).catch(() => {})
          return false
        }

        // Ctrl+Insert → copy  (common Windows shortcut)
        if (ctrl && e.key === 'Insert') {
          const sel: string = term.getSelection?.() ?? ''
          if (sel) navigator.clipboard.writeText(sel).catch(() => {})
          return false
        }

        // Shift+Insert → paste  (common Windows shortcut)
        if (e.shiftKey && e.key === 'Insert') {
          navigator.clipboard.readText().then(t => { if (t) write(t) }).catch(() => {})
          return false
        }

        // Ctrl+Shift+A → select all
        if (ctrl && e.shiftKey && key === 'a') {
          term.selectAll?.()
          return false
        }

        return true
      })

      // OSC 7 — cwd tracking
      term.parser.registerOscHandler(7, (data: string) => {
        try {
          const url = new URL(data)
          onCwd?.(decodeURIComponent(url.pathname))
        } catch {}
        return false
      })

      // Open PTY — camelCase params for Tauri v2
      const channel = new Channel<PtyEvent>()
      channel.onmessage = (evt) => {
        if (!disposed) term.write(evt.data)
      }

      await invoke('pty_open', {
        sessionId,
        cwd:       cwd ?? null,
        cols:      term.cols,
        rows:      term.rows,
        shell:     shell ?? null,
        shellArgs: shellArgs ?? null,
        onData:    channel,
      })
      // Record initial PTY size so doFit skips pty_resize on same-size refit
      lastPtyDimsRef.current = { cols: term.cols, rows: term.rows }
    }

    init().catch(err => {
      console.error('[Terminal] init failed:', err)
      termRef.current?.write(`\r\n\x1b[31mFailed to start terminal: ${err}\x1b[0m\r\n`)
    })

    return () => {
      disposed = true
      openedRef.current = false
      if (ptyResizeLockTimer.current) clearTimeout(ptyResizeLockTimer.current)
      ptyResizeLockRef.current = false
      invoke('pty_close', { sessionId }).catch(() => {})
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current  = null
    }
  }, [sessionId, cwd, shell, shellArgs, write, onCwd])

  // Shared fit logic — used by ResizeObserver and imperative handle.
  // Restores pre-collapse dims first so FitAddon can measure correctly, then
  // fits the DOM. While hidden/showing, keep the PTY size frozen.
  useEffect(() => {
    doFitRef.current = () => {
      const el = containerRef.current
      if (!el || el.offsetWidth < 10 || el.offsetHeight < 10) return
      const term = termRef.current
      if (!term || !fitRef.current) return

      const saved = savedDimsRef.current
      if (saved) {
        savedDimsRef.current = null
        try {
          if (term.cols !== saved.cols || term.rows !== saved.rows) {
            term.resize(saved.cols, saved.rows)
          }
          const core = (term as any)._core
          if (core?._charSizeService?.hasValidSize === false) {
            core._charSizeService.measure?.()
          }
        } catch {}
      }

      fitRef.current.fit()
      term.scrollToBottom()

      if (ptyResizeLockRef.current) {
        if (ptyResizeLockTimer.current) clearTimeout(ptyResizeLockTimer.current)
        ptyResizeLockTimer.current = setTimeout(() => {
          ptyResizeLockRef.current = false
          preCollapseDimsRef.current = null
          const t = termRef.current, f = fitRef.current
          if (!t || !f) return
          f.fit()
          t.scrollToBottom()
        }, 500)
        return
      }

      const { cols, rows } = term
      const last = lastPtyDimsRef.current
      if (cols !== last.cols || rows !== last.rows) {
        lastPtyDimsRef.current = { cols, rows }
        invoke('pty_resize', { sessionId, cols, rows }).catch(() => {})
      }
    }
  }, [sessionId])

  // Resize observer — rAF-batched so rapid width changes during animation
  // are coalesced; guard skips fits while the panel is at 0 width.
  useEffect(() => {
    if (!containerRef.current) return
    let rafId = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => doFitRef.current())
    })
    ro.observe(containerRef.current)
    return () => { ro.disconnect(); cancelAnimationFrame(rafId) }
  }, [sessionId])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const sel: string = termRef.current?.getSelection?.() ?? ''
    setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection: sel.length > 0 })
  }, [])

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      onMouseDown={e => e.stopPropagation()}
      onContextMenu={handleContextMenu}
    >
      {ctxMenu && (
        <div
          className="term-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button
            className={`term-ctx-item${!ctxMenu.hasSelection ? ' term-ctx-item--disabled' : ''}`}
            onClick={ctxMenu.hasSelection ? copySelection : undefined}
          >
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <rect x="4" y="1" width="9" height="11" rx="1.5"/>
              <path d="M4 3H2.5A1.5 1.5 0 0 0 1 4.5v8A1.5 1.5 0 0 0 2.5 14H9a1.5 1.5 0 0 0 1.5-1.5V11"/>
            </svg>
            Copy
            <span className="term-ctx-shortcut">Ctrl+Shift+C</span>
          </button>
          <button className="term-ctx-item" onClick={pasteClipboard}>
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <rect x="3" y="3" width="9" height="10" rx="1.5"/>
              <path d="M5 3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1"/>
            </svg>
            Paste
            <span className="term-ctx-shortcut">Ctrl+Shift+V</span>
          </button>
          <div className="term-ctx-separator" />
          <button className="term-ctx-item" onClick={selectAll}>
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <rect x="1" y="1" width="12" height="12" rx="1.5" strokeDasharray="2 1.5"/>
            </svg>
            Select All
            <span className="term-ctx-shortcut">Ctrl+Shift+A</span>
          </button>
        </div>
      )}
    </div>
  )
})

export default Terminal
