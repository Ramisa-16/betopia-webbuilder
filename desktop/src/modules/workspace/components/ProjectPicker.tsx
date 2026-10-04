import { useState, useEffect, useRef, useCallback, KeyboardEvent } from 'react'
import { normalizeDialogPath } from '@/lib/path'
import { WindowControls } from '@/components/WindowControls'

interface Props {
  onOpen: (path: string) => void
  onCreate?: () => void
  onPromptCreate?: (prompt: string) => void
}

// ── Recent project storage ───────────────────────────────────────────────────

interface RecentProject {
  path: string
  name: string
  timestamp: number
}

const STORAGE_KEY = 'betopia_recent_projects_v2'
const LEGACY_KEY  = 'betopia_recent_paths'
const MAX_RECENTS = 30

function getRecents(): RecentProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as RecentProject[]
    // Migrate from legacy format
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]') as string[]
    return legacy.map(p => ({ path: p, name: p.split(/[/\\]/).pop() ?? p, timestamp: Date.now() }))
  } catch { return [] }
}

export function addRecent(path: string) {
  const name = path.split(/[/\\]/).pop() ?? path
  const existing = getRecents().filter(r => r.path !== path)
  existing.unshift({ path, name, timestamp: Date.now() })
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(existing.slice(0, MAX_RECENTS))) } catch {}
}

function groupRecents(recents: RecentProject[]): Array<{ label: string; items: RecentProject[] }> {
  const now = Date.now()
  const day = 86400000
  const groups: { [k: string]: RecentProject[] } = {
    'Last 30 days': [],
    'This year': [],
    'Older': [],
  }
  for (const r of recents) {
    const age = now - r.timestamp
    if (age < 30 * day) groups['Last 30 days'].push(r)
    else if (new Date(r.timestamp).getFullYear() === new Date().getFullYear()) groups['This year'].push(r)
    else groups['Older'].push(r)
  }
  return Object.entries(groups).filter(([, items]) => items.length > 0).map(([label, items]) => ({ label, items }))
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Agents ────────────────────────────────────────────────────────────────────

const AGENTS = [
  {
    name: 'Coder',
    desc: 'General-purpose coding assistant. Writes, edits, and runs.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 8 2 12 6 16"/><polyline points="14 8 18 12 14 16"/><line x1="11" y1="4" x2="9" y2="20"/>
      </svg>
    ),
  },
  {
    name: 'Architect',
    desc: 'Design and tradeoffs. Plans before code.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="7" height="7" rx="1"/><rect x="11" y="2" width="7" height="7" rx="1"/>
        <rect x="2" y="11" width="7" height="7" rx="1"/><rect x="11" y="11" width="7" height="7" rx="1"/>
      </svg>
    ),
  },
  {
    name: 'Code Reviewer',
    desc: 'Reviews diffs for correctness, perf, security.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="8"/><polyline points="7 10 9 12 13 8"/>
      </svg>
    ),
  },
  {
    name: 'Security',
    desc: 'Threat-models changes and flags vulns.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2L3 5v5c0 4.4 3 8 7 9 4-1 7-4.6 7-9V5L10 2z"/>
      </svg>
    ),
  },
  {
    name: 'Designer',
    desc: 'UI/UX critique and refinement.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="13" cy="7" r="4"/><path d="M9.5 10.5L2 18"/><path d="M11 13l2 2"/>
      </svg>
    ),
  },
  {
    name: 'Orchestrator',
    desc: 'Runs Architect → Designer → Coder → Reviewer → Security in sequence.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="3" r="2"/>
        <circle cx="3" cy="17" r="2"/>
        <circle cx="17" cy="17" r="2"/>
        <line x1="10" y1="5" x2="3" y2="15"/>
        <line x1="10" y1="5" x2="17" y2="15"/>
        <line x1="3" y1="17" x2="17" y2="17"/>
      </svg>
    ),
  },
]

// ── Component ────────────────────────────────────────────────────────────────

function getProjectsFolder(): string {
  try { return JSON.parse(localStorage.getItem('betopia:general-prefs') ?? '{}').projectsFolder ?? '' }
  catch { return '' }
}

function sanitizeFolderName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-').slice(0, 50).replace(/-+$/, '') || 'new-project'
}

function removeRecent(path: string): RecentProject[] {
  const updated = getRecents().filter(r => r.path !== path)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)) } catch {}
  return updated
}

const SIDEBAR_WIDTH_KEY = 'betopia:picker-sidebar-width'
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 248

export default function ProjectPicker({ onOpen, onCreate, onPromptCreate }: Props) {
  const [recents, setRecents]         = useState<RecentProject[]>([])
  const [search, setSearch]           = useState('')
  const [prompt, setPrompt]           = useState('')
  const [loading, setLoading]         = useState(false)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newName, setNewName]         = useState('')
  const [newNameError, setNewNameError] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || SIDEBAR_DEFAULT } catch { return SIDEBAR_DEFAULT }
  })
  const isResizingRef = useRef(false)
  const textareaRef                   = useRef<HTMLTextAreaElement>(null)
  const fileInputRef                  = useRef<HTMLInputElement>(null)
  const newNameRef                    = useRef<HTMLInputElement>(null)

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizingRef.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, ev.clientX))
      setSidebarWidth(w)
    }
    const onUp = (ev: MouseEvent) => {
      isResizingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, ev.clientX))
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w)) } catch {}
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    setRecents(getRecents())
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    if (showNewDialog) setTimeout(() => newNameRef.current?.focus(), 50)
  }, [showNewDialog])

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }, [prompt])

  const openProject = async (path: string) => {
    setLoading(true)
    try { addRecent(path); await onOpen(path) }
    catch { setLoading(false) }
  }

  const openDialog = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false })
      const path = normalizeDialogPath(selected)
      if (path) await openProject(path)
    } catch {}
  }

  const handleCreateNewProject = async () => {
    const name = newName.trim()
    if (!name) { setNewNameError('Enter a project name'); return }
    const base = getProjectsFolder()
    setShowNewDialog(false)
    setNewName('')
    setNewNameError('')

    if (!base) { openDialog(); return }

    try {
      const { mkdir, exists } = await import('@tauri-apps/plugin-fs')
      const sep = base.includes('\\') ? '\\' : '/'
      const safe = sanitizeFolderName(name)
      let final = safe
      let i = 1
      while (await exists(`${base}${sep}${final}`)) final = `${safe}-${i++}`
      const newPath = `${base}${sep}${final}`
      await mkdir(newPath, { recursive: true })
      await openProject(newPath)
    } catch { openDialog() }
  }

  const submit = useCallback(() => {
    const text = prompt.trim()
    if (!text) { openDialog(); return }
    onPromptCreate?.(text)
    setPrompt('')
  }, [prompt, openDialog, onPromptCreate])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }

  const filteredRecents = search.trim()
    ? recents.filter(r => r.name.toLowerCase().includes(search.toLowerCase()) || r.path.toLowerCase().includes(search.toLowerCase()))
    : recents

  const groups = groupRecents(filteredRecents)

  return (
    <div className="home-layout">
      {/* Drag strip + window controls */}
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 40, zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }} data-tauri-drag-region>
        <WindowControls />
      </div>

      {/* ── Left Sidebar ── */}
      <aside className="home-sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
        {/* Brand */}
        <div className="home-sidebar-brand">
          <span className="home-sidebar-brand-name">Betopia Coder</span>
          <span className="home-sidebar-brand-badge">beta</span>
        </div>

        <div className="home-sidebar-card">
        <div className="home-sidebar-top">
          <div className="home-tabs">
            <button className="home-tab active">
              <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="1" width="5" height="5" rx="1"/><rect x="8" y="1" width="5" height="5" rx="1"/><rect x="1" y="8" width="5" height="5" rx="1"/><rect x="8" y="8" width="5" height="5" rx="1"/></svg>
              My Projects
            </button>
            <button className="home-tab home-tab--new" onClick={() => { setShowNewDialog(true); setNewName(''); setNewNameError('') }}>
              <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="7" y1="2" x2="7" y2="12"/><line x1="2" y1="7" x2="12" y2="7"/></svg>
              New Project
            </button>
          </div>
          <div className="home-search-wrap">
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="6" cy="6" r="4"/><line x1="9.5" y1="9.5" x2="13" y2="13"/>
            </svg>
            <input className="home-search" placeholder="Search projects" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        <div className="home-sidebar-list">
          {recents.length === 0 ? (
            <div className="home-sidebar-empty">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ marginBottom: 10, opacity: 0.35 }}>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
              </svg>
              <p>No recent projects</p>
              <p>Open a folder to get started</p>
            </div>
          ) : groups.length === 0 ? (
            <div className="home-sidebar-empty">No matches found.</div>
          ) : (
            groups.map(g => (
              <div key={g.label} className="home-group">
                <div className="home-group-label">{g.label}</div>
                {g.items.map(r => (
                  <div key={r.path} className="home-project-row-wrap">
                    <button
                      className="home-project-row"
                      onClick={() => openProject(r.path)}
                      disabled={loading}
                      title={r.path}
                    >
                      <div className="home-project-thumb">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
                        </svg>
                      </div>
                      <div className="home-project-info">
                        <span className="home-project-name">{r.name}</span>
                        <span className="home-project-date">
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" style={{ flexShrink: 0 }}>
                            <rect x="1" y="2" width="10" height="9" rx="1.5"/><line x1="4" y1="1" x2="4" y2="3"/><line x1="8" y1="1" x2="8" y2="3"/><line x1="1" y1="5" x2="11" y2="5"/>
                          </svg>
                          {formatDate(r.timestamp)}
                        </span>
                      </div>
                    </button>
                    <button
                      className="home-project-delete"
                      title="Remove from list"
                      onClick={e => { e.stopPropagation(); setRecents(removeRecent(r.path)) }}
                    >
                      <svg viewBox="0 0 14 14" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="2,4 12,4"/><path d="M5 4V2h4v2"/><path d="M3 4l.8 8h6.4L11 4"/>
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="home-sidebar-footer">
          <button className="home-open-btn" onClick={openDialog} disabled={loading}>
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M1 4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4z"/>
            </svg>
            Open Folder
          </button>
        </div>
        </div>{/* end home-sidebar-card */}
      </aside>

      {/* Resize handle */}
      <div className="home-sidebar-resizer" onMouseDown={startResize} />

      {/* ── Main Content ── */}
      <main className="home-main">
        <div className="home-main-inner">

          {/* Heading */}
          <h1 className="home-prompt-heading">What can I help you ship?</h1>

          {/* Prompt card */}
          <div className="home-prompt-card">
            <textarea
              ref={textareaRef}
              className="home-prompt-textarea"
              placeholder="Type your message here..."
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
            />
            <div className="home-prompt-toolbar">
              <div className="home-prompt-tools">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={e => {
                    const files = e.target.files
                    if (files && files.length > 0) {
                      const names = Array.from(files).map(f => f.name).join(', ')
                      setPrompt(p => p ? `${p} [${names}]` : `[${names}]`)
                    }
                    e.target.value = ''
                  }}
                />
                <button className="home-prompt-tool" title="Add files" onClick={() => fileInputRef.current?.click()}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
                <button className="home-prompt-tool" title="Open folder" onClick={openDialog} disabled={loading}>
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
                  </svg>
                </button>
              </div>
              <button className="home-prompt-mic" onClick={submit} disabled={loading} title="Send">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9l20-7z"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Agent cards */}
          <div className="home-agents">
            {AGENTS.map(a => (
              <button
                key={a.name}
                className="home-agent-card"
                onClick={() => { setPrompt(`Use ${a.name} agent: `); textareaRef.current?.focus() }}
              >
                <span className="home-agent-icon">{a.icon}</span>
                <span className="home-agent-name">{a.name}</span>
                <span className="home-agent-desc">{a.desc}</span>
              </button>
            ))}
          </div>

        </div>
      </main>

      {/* New Project dialog */}
      {showNewDialog && (
        <div className="home-new-overlay" onClick={() => setShowNewDialog(false)}>
          <div className="home-new-dialog" onClick={e => e.stopPropagation()}>
            <div className="home-new-dialog-title">New Project</div>
            {getProjectsFolder() ? (
              <div className="home-new-dialog-folder">
                <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M1 4a1 1 0 0 1 1-1h3l1 1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4z"/></svg>
                <span>{getProjectsFolder()}</span>
              </div>
            ) : (
              <div className="home-new-dialog-folder home-new-dialog-folder--unset">No projects folder set — you'll be asked to pick a location.</div>
            )}
            <input
              ref={newNameRef}
              className="home-new-dialog-input"
              type="text"
              placeholder="Project name"
              value={newName}
              onChange={e => { setNewName(e.target.value); setNewNameError('') }}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateNewProject(); if (e.key === 'Escape') setShowNewDialog(false) }}
            />
            {newNameError && <div className="home-new-dialog-error">{newNameError}</div>}
            <div className="home-new-dialog-actions">
              <button className="home-new-dialog-btn home-new-dialog-btn--cancel" onClick={() => setShowNewDialog(false)}>Cancel</button>
              <button className="home-new-dialog-btn home-new-dialog-btn--create" onClick={handleCreateNewProject} disabled={loading}>Create</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
