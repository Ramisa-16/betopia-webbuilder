import { Fragment, useState, useEffect, useRef, useCallback, KeyboardEvent, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { normalizeDialogPath } from '@/lib/path'
import { WindowControls } from '@/components/WindowControls'
import { allSlashOptions, isCustomSkillPath, type SlashSkillOption } from '@/lib/builtin-skills'
import { resolveSkillDirective } from '@/lib/skill-routing'
import { getConfig, type CustomSubagentDef } from '@/lib/config'
import { loadCustomSkillsForSettings, type Skill } from '@/lib/agent'
import { SKILLS_CHANGED_EVENT } from '@/lib/skill-events'
import SkillIcon from '@/modules/chat/components/SkillIcon'
import type { Attachment } from '@/types'
import {
  CHAT_FILE_ACCEPT,
  MAX_IMAGES,
  bytesToBase64,
  extractAttachmentPathsFromText,
  getAttachmentKind,
  getAttachmentName,
  getMimeTypeFromPath,
  readClipboardImageAttachment,
  resolveAttachmentMimeType,
} from '@/lib/attachments'

interface Props {
  onOpen: (path: string) => void
  onCreate?: () => void
  onPromptCreate?: (prompt: string, attachments?: Attachment[], skill?: SlashSkillOption | null) => void
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
    name: 'Launch Web',
    prompt: 'Launch a new web builder project with a modern landing page for ',
    desc: 'Kick off a web build with a clear starting point.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 14l-2 5 5-2"/><path d="M9 13 3 7l6-4 8 8-4 6-4-4"/><path d="M12 4l4 4"/>
      </svg>
    ),
  },
  {
    name: 'Build UI',
    prompt: 'Build the UI for ',
    desc: 'Create layouts, sections, and reusable blocks.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="7" height="7" rx="2"/><rect x="11" y="2" width="7" height="7" rx="2"/>
        <rect x="2" y="11" width="7" height="7" rx="2"/><rect x="11" y="11" width="7" height="7" rx="2"/>
      </svg>
    ),
  },
  {
    name: 'Edit Code',
    prompt: 'Edit the code for ',
    desc: 'Refine components, logic, and interactions.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 8 2 12 6 16"/><polyline points="14 8 18 12 14 16"/><line x1="11" y1="4" x2="9" y2="20"/>
      </svg>
    ),
  },
  {
    name: 'Theme Studio',
    prompt: 'Design a theme for ',
    desc: 'Tune colors, spacing, and visual polish.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2L3 5v5c0 4.4 3 8 7 9 4-1 7-4.6 7-9V5L10 2z"/>
      </svg>
    ),
  },
  {
    name: 'Publish Site',
    prompt: 'Prepare this web builder project for deployment: ',
    desc: 'Ready the site for launch and handoff.',
    icon: (
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="8"/><path d="M6.5 10h7"/><path d="M10 6.5v7"/>
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
  const [slashQuery, setSlashQuery]   = useState<string | null>(null)
  const [slashActiveIdx, setSlashActiveIdx] = useState(0)
  const [activeSkill, setActiveSkill] = useState<SlashSkillOption | null>(null)
  const [personalSkills, setPersonalSkills] = useState<Skill[]>([])
  const [customSubagents, setCustomSubagents] = useState<CustomSubagentDef[]>(() => getConfig().customSubagents ?? [])
  const [loading, setLoading]         = useState(false)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newName, setNewName]         = useState('')
  const [newNameError, setNewNameError] = useState('')
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || SIDEBAR_DEFAULT } catch { return SIDEBAR_DEFAULT }
  })
  const isResizingRef = useRef(false)
  const [ctxMenu, setCtxMenu]         = useState<{ x: number; y: number } | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [previewImg, setPreviewImg]   = useState<string | null>(null)
  const [isDragging, setIsDragging]   = useState(false)
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
    const refreshPersonalSkills = () => {
      loadCustomSkillsForSettings('', recents.map(recent => recent.path))
        .then(skills => setPersonalSkills(skills.filter(skill => isCustomSkillPath(skill.path))))
        .catch(() => setPersonalSkills([]))
    }
    refreshPersonalSkills()
    window.addEventListener(SKILLS_CHANGED_EVENT, refreshPersonalSkills)
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, refreshPersonalSkills)
  }, [recents])

  useEffect(() => {
    const syncSubagents = () => setCustomSubagents(getConfig().customSubagents ?? [])
    syncSubagents()
    window.addEventListener('betopia:config-changed', syncSubagents)
    return () => window.removeEventListener('betopia:config-changed', syncSubagents)
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

  const slashOptions = useMemo(() => allSlashOptions(personalSkills, customSubagents), [personalSkills, customSubagents])
  const slashResults = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    if (q === '/') return slashOptions
    return slashOptions.filter(o => o.slash.toLowerCase().startsWith(q) || o.name.toLowerCase().includes(q.slice(1)))
  }, [slashQuery, slashOptions])
  const slashResultGroups = useMemo(() => {
    const system = slashResults.filter(option => option.source === 'system')
    const custom = slashResults.filter(option => option.source === 'custom')
    const subagents = slashResults.filter(option => option.source === 'subagent')
    return [
      { key: 'system', title: 'System skills', options: system },
      { key: 'custom', title: 'Custom skills', options: custom },
      { key: 'subagent', title: 'Sub-agents', options: subagents },
    ].filter(group => group.options.length > 0)
  }, [slashResults])
  const slashOptionIndex = (option: SlashSkillOption) => slashResults.findIndex(item => item.slash === option.slash)

  useEffect(() => { setSlashActiveIdx(0) }, [slashResults])

  const clearCurrentSlashToken = useCallback(() => {
    const ta = textareaRef.current
    const pos = ta?.selectionStart ?? prompt.length
    const before = prompt.slice(0, pos)
    const after = prompt.slice(pos)
    const replaced = before.replace(/(^|\s)(\/[\w-]*)$/, (_m, lead) => lead)
    setPrompt(`${replaced}${after}`)
    setSlashQuery(null)
    return replaced.length
  }, [prompt])

  const activateSlashSkill = useCallback((skill: SlashSkillOption) => {
    const caretPos = clearCurrentSlashToken()
    setActiveSkill(skill)
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (!t) return
      t.focus()
      t.selectionStart = t.selectionEnd = caretPos
    })
  }, [clearCurrentSlashToken])

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

  const appendAttachment = useCallback((attachment: Attachment) => {
    setAttachments(prev => {
      if (attachment.type === 'image' && prev.filter(a => a.type === 'image').length >= MAX_IMAGES) {
        return prev
      }
      return [...prev, attachment]
    })
  }, [])

  const addPathAttachment = useCallback(async (path: string, idPrefix: 'drop' | 'paste') => {
    const mimeType = getMimeTypeFromPath(path)
    if (!mimeType) return false
    try {
      const { readFile } = await import('@tauri-apps/plugin-fs')
      const bytes = await readFile(path)
      appendAttachment({
        id: `${idPrefix}-${Date.now()}`,
        type: getAttachmentKind(mimeType),
        name: getAttachmentName(path),
        data: bytesToBase64(bytes),
        mimeType,
        size: bytes.length,
      })
      return true
    } catch {
      return false
    }
  }, [appendAttachment])

  const addBrowserFileAttachment = useCallback((file: File, idPrefix: 'drop' | 'paste' | 'file') => {
    const mimeType = resolveAttachmentMimeType(file.name, file.type)
    if (!mimeType) return false
    const reader = new FileReader()
    reader.onload = event => {
      const data = (event.target?.result as string) ?? ''
      appendAttachment({
        id: `${idPrefix}-${Date.now()}`,
        type: getAttachmentKind(mimeType),
        name: file.name || 'attachment',
        data: data.split(',')[1] || data,
        mimeType,
        size: file.size,
      })
    }
    reader.readAsDataURL(file)
    return true
  }, [appendAttachment])

  const execInsert = useCallback((text: string) => {
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    if (!document.execCommand('insertText', false, text)) {
      const start = ta.selectionStart ?? ta.value.length
      const end = ta.selectionEnd ?? ta.value.length
      setPrompt(ta.value.slice(0, start) + text + ta.value.slice(end))
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + text.length
        }
      })
    }
  }, [])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const attachmentFiles = Array.from(e.clipboardData?.items ?? [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file && !!resolveAttachmentMimeType(file.name, file.type))

    if (attachmentFiles.length > 0) {
      e.preventDefault()
      attachmentFiles.forEach(file => addBrowserFileAttachment(file, 'paste'))
      return
    }

    const uriList = e.clipboardData?.getData('text/uri-list') ?? ''
    const plain = e.clipboardData?.getData('text/plain') ?? ''
    const types = Array.from(e.clipboardData?.types ?? [])
    const plainTrimmed = plain.trim().replace(/\r$/, '')

    const attachmentPaths = [
      ...extractAttachmentPathsFromText(uriList),
      ...extractAttachmentPathsFromText(plainTrimmed),
    ].filter((path, index, all) => all.indexOf(path) === index)

    if (attachmentPaths.length > 0 || (types.includes('text/uri-list') && getMimeTypeFromPath(plainTrimmed))) {
      e.preventDefault()
      ;(async () => {
        let attached = false
        for (const path of attachmentPaths) {
          attached = await addPathAttachment(path, 'paste') || attached
        }
        if (!attached && plainTrimmed) execInsert(plainTrimmed)
      })()
    }
  }, [addBrowserFileAttachment, addPathAttachment, execInsert])

  const handleClipboardPaste = useCallback(async () => {
    try {
      const imageAttachment = await readClipboardImageAttachment('paste')
      if (imageAttachment) {
        appendAttachment(imageAttachment)
        return
      }
    } catch { /* clipboard image unavailable — fall through */ }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const typesResult = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
        command: '(command -v wl-paste >/dev/null 2>&1 && wl-paste --list-types 2>/dev/null) || (command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t TARGETS -o 2>/dev/null)',
        cwd: null,
      })
      const availTypes = typesResult.stdout

      if (availTypes.includes('image/png')) {
        const imgResult = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
          command: '(command -v wl-paste >/dev/null 2>&1 && wl-paste -t image/png 2>/dev/null | base64 -w0) || (command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t image/png -o 2>/dev/null | base64 -w0)',
          cwd: null,
        })
        if (imgResult.exit_code === 0 && imgResult.stdout.trim()) {
          appendAttachment({ id: `paste-${Date.now()}`, type: 'image', name: 'pasted-image.png', data: imgResult.stdout.trim(), mimeType: 'image/png', size: 0 })
          return
        }
      }

      if (availTypes.includes('text/uri-list')) {
        const uriResult = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
          command: '(command -v wl-paste >/dev/null 2>&1 && wl-paste -t text/uri-list 2>/dev/null) || (command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t text/uri-list -o 2>/dev/null)',
          cwd: null,
        })
        const uris = uriResult.stdout.split('\n').map(line => line.trim().replace(/\r$/, '')).filter(line => line.startsWith('file://'))
        let attachedFile = false
        for (const uri of uris) {
          const path = decodeURIComponent(uri.slice(7))
          attachedFile = await addPathAttachment(path, 'paste') || attachedFile
        }
        if (attachedFile) return
      }

      const textResult = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
        command: '(command -v wl-paste >/dev/null 2>&1 && wl-paste --no-newline 2>/dev/null) || (command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -o 2>/dev/null)',
        cwd: null,
      })
      if (textResult.exit_code === 0 && textResult.stdout) {
        execInsert(textResult.stdout)
        return
      }
    } catch { /* shell unavailable — fall through to web API */ }

    try {
      const text = await navigator.clipboard.readText()
      if (text) execInsert(text)
    } catch { /* blocked */ }
  }, [appendAttachment, addPathAttachment, execInsert])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (e.dataTransfer.files?.length > 0) {
      Array.from(e.dataTransfer.files).forEach(file => {
        addBrowserFileAttachment(file, 'drop')
      })
      return
    }
    const uriList = e.dataTransfer.getData('text/uri-list')
    if (!uriList) return
    ;(async () => {
      for (const line of uriList.split('\n').map(l => l.trim().replace(/\r$/, '')).filter(l => l.startsWith('file://'))) {
        await addPathAttachment(decodeURIComponent(line.slice(7)), 'drop')
      }
    })()
  }, [addBrowserFileAttachment, addPathAttachment])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
      getCurrentWebviewWindow().onDragDropEvent(async (event) => {
        const payload = event.payload as { type: string; paths?: string[] }
        if (payload.type === 'drop' && payload.paths?.length) {
          setIsDragging(false)
          for (const path of payload.paths) {
            await addPathAttachment(path, 'drop')
          }
        }
      }).then(fn => { unlisten = fn }).catch(() => {})
    }).catch(() => {})
    return () => { unlisten?.() }
  }, [addPathAttachment])

  const submit = useCallback(() => {
    const text = prompt.trim()
    const route = activeSkill ? { option: activeSkill, task: text } : resolveSkillDirective(text, slashOptions, { allowAuto: true })
    const skill = route?.option ?? null
    const promptForProject = route ? route.task : text
    if (!promptForProject && !skill) { openDialog(); return }
    onPromptCreate?.(
      promptForProject,
      attachments.length > 0 ? attachments : undefined,
      skill,
    )
    setPrompt('')
    setAttachments([])
    setSlashQuery(null)
    setActiveSkill(null)
  }, [prompt, attachments, activeSkill, slashOptions, openDialog, onPromptCreate])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashQuery !== null && slashResults.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashActiveIdx(i => Math.min(i + 1, slashResults.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashActiveIdx(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter') { e.preventDefault(); activateSlashSkill(slashResults[slashActiveIdx] ?? slashResults[0]); return }
      if (e.key === 'Escape') { e.preventDefault(); setSlashQuery(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
  }

  const filteredRecents = search.trim()
    ? recents.filter(r => r.name.toLowerCase().includes(search.toLowerCase()) || r.path.toLowerCase().includes(search.toLowerCase()))
    : recents

  const groups = groupRecents(filteredRecents)

  return (
    <>
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
          <div
            className={"home-prompt-card" + (isDragging ? ' drag-over' : '') + (activeSkill ? ' has-active-skill' : '')}
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false) }}
            onDrop={handleDrop}
            style={{ position: 'relative' }}
          >
            {slashQuery !== null && slashResults.length > 0 && (
              <div className="chat-at-picker" style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6, zIndex: 10, maxHeight: 220, overflowY: 'auto' }}>
                {slashResultGroups.map(group => (
                  <Fragment key={group.key}>
                    <div className="chat-at-section-label">{group.title}</div>
                    {group.options.map(opt => {
                      const i = slashOptionIndex(opt)
                      return (
                        <button
                          key={opt.slash}
                          className={'chat-at-item' + (i === slashActiveIdx ? ' active' : '')}
                          onMouseEnter={() => setSlashActiveIdx(i)}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => activateSlashSkill(opt)}
                        >
                          <span style={{ fontSize: 10, flexShrink: 0 }}>◆</span>
                          <span className="chat-skill-picker-icon" aria-hidden="true">
                            <SkillIcon slash={opt.slash} size={13} />
                          </span>
                          <span className="chat-at-name" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{opt.slash}</span>
                          <span className="chat-at-path">{opt.description}</span>
                          {opt.source === 'custom' && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 'auto', flexShrink: 0 }}>custom</span>}
                        </button>
                      )
                    })}
                  </Fragment>
                ))}
              </div>
            )}
            {activeSkill && (
              <div className="chat-active-skill-chip" title={activeSkill.description} style={{ top: 10 }}>
                <span className="chat-active-skill-icon" aria-hidden="true">
                  <SkillIcon slash={activeSkill.slash} size={12} />
                </span>
                <span className="chat-active-skill-name">{activeSkill.name}</span>
                <span className="chat-active-skill-dot" aria-label="Active skill" />
                <button
                  className="chat-active-skill-remove"
                  onClick={() => setActiveSkill(null)}
                  title="Remove active skill"
                  aria-label="Remove active skill"
                  type="button"
                >
                  x
                </button>
              </div>
            )}
            {isDragging && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'rgba(99,102,241,0.10)', border: '2px dashed #6366f1', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <span style={{ color: '#6366f1', fontWeight: 600, fontSize: 14 }}>Drop files here</span>
              </div>
            )}
            {attachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 12px 0' }}>
                {attachments.map(att => (
                  <div key={att.id} style={{ position: 'relative', minWidth: att.type === 'image' ? 64 : 180, height: 64 }}>
                    {att.type === 'image' ? (
                      <img
                        src={`data:${att.mimeType};base64,${att.data}`}
                        alt={att.name}
                        style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, cursor: 'zoom-in' }}
                        onClick={() => setPreviewImg(`data:${att.mimeType};base64,${att.data}`)}
                      />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 64, padding: '0 12px', borderRadius: 10, border: '1px solid var(--border-2)', background: 'var(--surface-3)', minWidth: 180, maxWidth: 260 }}>
                        <div style={{ width: 28, height: 28, borderRadius: 8, background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 11, fontWeight: 700 }}>
                          FILE
                        </div>
                        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <div style={{ fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{att.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{(att.size / 1024).toFixed(1)} KB</div>
                        </div>
                      </div>
                    )}
                    <button onClick={() => setAttachments(p => p.filter(a => a.id !== att.id))} style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: '#ef4444', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className="home-prompt-textarea"
              placeholder="Type your message here..."
              value={prompt}
              onChange={e => {
                const next = e.target.value
                setPrompt(next)
                const pos = e.target.selectionStart ?? next.length
                const m = next.slice(0, pos).match(/(^|\s)(\/[\w-]*)$/)
                setSlashQuery(m ? m[2] : null)
              }}
              onKeyDown={onKeyDown}
              onPaste={handlePaste}
              onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }) }}
              rows={1}
            />
            <div className="home-prompt-toolbar">
              <div className="home-prompt-tools">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={CHAT_FILE_ACCEPT}
                  style={{ display: 'none' }}
                  onChange={e => {
                    const files = e.target.files
                    if (!files) return
                    Array.from(files).forEach(file => addBrowserFileAttachment(file, 'file'))
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

          {/* Quick access pills */}
          <div className="quick-access-wrap">
            <div className="qa-row qa-row-1">
              {AGENTS.slice(0, 3).map(a => (
                <button
                  key={a.name}
                  className="qpill"
                  onClick={() => { setPrompt(a.prompt); textareaRef.current?.focus() }}
                >
                  <span className="qicon-badge">{a.icon}</span>
                  <span className="qlabel">{a.name}</span>
                </button>
              ))}
            </div>
            <div className="qa-row qa-row-2">
              {AGENTS.slice(3, 5).map(a => (
                <button
                  key={a.name}
                  className="qpill"
                  onClick={() => { setPrompt(a.prompt); textareaRef.current?.focus() }}
                >
                  <span className="qicon-badge">{a.icon}</span>
                  <span className="qlabel">{a.name}</span>
                </button>
              ))}
            </div>
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
    {previewImg && createPortal(
      <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }} onClick={() => setPreviewImg(null)}>
        <img src={previewImg} alt="Preview" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.6)', objectFit: 'contain' }} onClick={e => e.stopPropagation()} />
        <button style={{ position: 'absolute', top: 16, right: 20, background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', fontSize: 22, width: 36, height: 36, borderRadius: '50%', cursor: 'pointer' }} onClick={() => setPreviewImg(null)}>×</button>
      </div>,
      document.body
    )}
    {ctxMenu && createPortal(
      <>
        <div style={{ position: 'fixed', inset: 0, zIndex: 99998 }} onClick={() => setCtxMenu(null)} />
        <div style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 99999, background: 'var(--bg-elevated,#1e1e2e)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '4px 0', minWidth: 140, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', fontSize: 13 }}>
          {([
            { label: 'Paste', icon: '⌘V', action: () => { setCtxMenu(null); textareaRef.current?.focus(); handleClipboardPaste() } },
            { label: 'Copy',  icon: '⌘C', action: () => { setCtxMenu(null); const ta = textareaRef.current; if (ta) { const s = ta.value.slice(ta.selectionStart??0, ta.selectionEnd??ta.value.length); if (s) navigator.clipboard.writeText(s).catch(()=>{}) } } },
            { label: 'Cut',   icon: '⌘X', action: () => { setCtxMenu(null); const ta = textareaRef.current; if (!ta) return; ta.focus(); const sel = ta.value.slice(ta.selectionStart??0, ta.selectionEnd??ta.value.length); if (sel) { navigator.clipboard.writeText(sel).catch(()=>{}); document.execCommand('delete') } } },
          ] as const).map(item => (
            <button key={item.label} onClick={item.action} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',padding:'6px 14px',background:'none',border:'none',color:'var(--text-primary,#e2e8f0)',cursor:'pointer',gap:24 }}
              onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,0.08)')} onMouseLeave={e=>(e.currentTarget.style.background='none')}>
              <span>{item.label}</span><span style={{opacity:0.45,fontSize:11}}>{item.icon}</span>
            </button>
          ))}
        </div>
      </>,
      document.body
    )}
    </>
  )
}
