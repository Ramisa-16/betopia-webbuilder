/**
 * Header.tsx - Manus-style 6-tab toolbar
 * [B][ProjectName] | [preview][code][dashboard][database][storage][settings] | [...][github][Share][Publish][x]
 */

import { useMemo, useState, useEffect, useRef, type ReactNode } from 'react'
import type { ViewMode } from '@/types'
import type { TabEntry } from '@/types'
import type { PublishVisibility } from '@/lib/publish'
import { WindowControls } from '@/components/WindowControls'
import { loadCodeHistory, formatHistoryDate } from '@/lib/codeHistory'

// ── SVG Icon library ──────────────────────────────────────────────────────────
const Icons = {
  preview: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="9" y1="21" x2="9" y2="9"/>
    </svg>
  ),
  code: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/>
      <polyline points="8 6 2 12 8 18"/>
    </svg>
  ),
  dashboard: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  ),
  database: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M21 12c0 1.66-4.03 3-9 3S3 13.66 3 12"/>
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
    </svg>
  ),
  storage: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <rect x="8" y="13" width="8" height="7" rx="1"/>
      <path d="M10 13v-2a2 2 0 1 1 4 0v2"/>
    </svg>
  ),
  settings: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V22a2 2 0 0 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.57 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H2a2 2 0 0 1 0-4h.09a1.7 1.7 0 0 0 1.57-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.02a1.7 1.7 0 0 0 1.03-1.56V2a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 1.04 1.56h.02a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.02a1.7 1.7 0 0 0 1.56 1.03H22a2 2 0 0 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.04z" />
    </svg>
  ),
  more: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="5" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="19" cy="12" r="1.5" fill="currentColor"/>
    </svg>
  ),
  github: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  ),
  gitlab: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="#E24329" d="M12 21.98L7.8 9H3l9 12.98z"/>
      <path fill="#FC6D26" d="M12 21.98L16.2 9H7.8L12 21.98z"/>
      <path fill="#FCA326" d="M12 21.98L21 9h-4.8L12 21.98z"/>
      <path fill="#E24329" d="M3 9l2.2-6.54a.64.64 0 0 1 1.21 0L7.8 9H3z"/>
      <path fill="#FCA326" d="M21 9l-2.2-6.54a.64.64 0 0 0-1.21 0L16.2 9H21z"/>
    </svg>
  ),
  share: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/>
      <polyline points="16 6 12 2 8 6"/>
      <line x1="12" y1="2" x2="12" y2="15"/>
    </svg>
  ),
  publish: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14"/>
      <path d="M5 12l7-7 7 7"/>
    </svg>
  ),
  blocked: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M7 7l10 10" />
    </svg>
  ),
  close: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  download: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>
    </svg>
  ),
  history: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7"/>
      <path d="M3 3v6h6"/>
      <path d="M12 7v5l3 2"/>
    </svg>
  ),
  copy: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2"/>
      <rect x="2" y="2" width="13" height="13" rx="2"/>
    </svg>
  ),
  docs: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
    </svg>
  ),
  folder: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    </svg>
  ),
  external: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  ),
  check: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  link: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
    </svg>
  ),
  twitter: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  ),
  linkedin: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/>
      <rect x="2" y="9" width="4" height="12"/>
      <circle cx="4" cy="4" r="2"/>
    </svg>
  ),
  facebook: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
    </svg>
  ),
  reddit: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10"/>
      <path fill="var(--bg,#0a0a0b)" d="M20 12c0-1.1-.9-2-2-2-.5 0-1 .2-1.3.5-1.3-.9-3-1.4-4.9-1.5l.8-3.9 2.7.6c0 .7.6 1.3 1.3 1.3s1.3-.6 1.3-1.3-.6-1.3-1.3-1.3c-.5 0-1 .3-1.2.8l-3-.6c-.2 0-.3.1-.4.3l-.9 4.2c-1.8.1-3.5.6-4.8 1.5-.3-.3-.8-.5-1.3-.5-1.1 0-2 .9-2 2 0 .8.5 1.5 1.1 1.8 0 .2-.1.4-.1.6 0 2.8 3.1 5 7 5s7-2.2 7-5c0-.2 0-.4-.1-.6.7-.3 1.1-1 1.1-1.8z"/>
      <circle cx="9" cy="13" r="1" fill="var(--bg,#0a0a0b)"/>
      <circle cx="15" cy="13" r="1" fill="var(--bg,#0a0a0b)"/>
      <path fill="var(--bg,#0a0a0b)" d="M9.5 16c.8.8 4.2.8 5 0"/>
    </svg>
  ),
  seo: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  globe: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  ),
  terminal: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
    </svg>
  ),
  home: (
    <svg viewBox="0 0 54 42" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="bai-a" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#E8716B" />
          <stop offset="100%" stopColor="#F4A261" />
        </linearGradient>
      </defs>
      <text x="1" y="38" fontSize="38" fontFamily="'Arial Black', 'Arial Bold', Impact, sans-serif" fontWeight="900" fill="#111111">B</text>
      <text x="17" y="38" fontSize="38" fontFamily="'Arial Black', 'Arial Bold', Impact, sans-serif" fontWeight="900" fill="url(#bai-a)">A</text>
      <text x="41" y="38" fontSize="38" fontFamily="'Arial Black', 'Arial Bold', Impact, sans-serif" fontWeight="900" fill="#C5AADB">I</text>
    </svg>
  ),
  sidebar: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  ),
  sidebarOpen: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  ),
}

// ── Props ─────────────────────────────────────────────────────────────────────
export interface HeaderProps {
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  onAskAI?: (msg: string) => void
  publishedUrl?: string | null
  isPublished?: boolean
  publishVisibility: PublishVisibility
  isPublishing?: boolean
  hasStarted?: boolean
  projectPath: string
  liveServerUrl?: string | null
  onGoHome: () => void
  onOpenProject: () => void
  onOpenFile?: () => void
  onNewFile?: () => void
  onOpenRecent: (path: string) => void
  onOpenSettings: () => void
  onRequestPreview: () => void
  onToggleChatSidebar?: () => void
  chatSidebarVisible?: boolean
  codeVisible?: boolean
  previewVisible?: boolean
  canPreview?: boolean
  onToggleCodeVisible?: () => void
  onTogglePreviewVisible?: () => void
  terminalVisible?: boolean
  onToggleTerminalVisible?: () => void
  onOpenSpotlight?: () => void
  onResetProject?: () => void
  onDownloadAsZip?: () => void
  onOpenVersionHistory?: () => void
  onRestoreHistory?: (snapshotId: string) => void
  onMakeCopy?: () => void
  onViewDocs?: () => void
  onChangePublishVisibility: (v: PublishVisibility) => void
  onPublishNow?: () => void
  onOpenPublishSettings?: () => void
  extraActions?: ReactNode
}

type SpaceTreeNode = {
  kind: 'folder'
  name: string
  path: string
  children: SpaceTreeEntry[]
}

type SpaceFileNode = {
  kind: 'file'
  label: string
  path: string
  tab: TabEntry
}

type SpaceTreeEntry = SpaceTreeNode | SpaceFileNode

// ── Component ─────────────────────────────────────────────────────────────────
export default function Header({
  projectPath, onGoHome, onOpenProject, onOpenFile, onNewFile, onOpenRecent,
  onOpenSettings,
  onToggleChatSidebar, chatSidebarVisible = true,
  codeVisible = true, previewVisible = false, canPreview = true,
  onToggleCodeVisible, onTogglePreviewVisible,
  terminalVisible = false, onToggleTerminalVisible,
  liveServerUrl, isPublishing, hasStarted = false,
  publishVisibility, isPublished = false, onChangePublishVisibility,
  onPublishNow, onOpenPublishSettings,
  onDownloadAsZip, onOpenVersionHistory, onRestoreHistory, onMakeCopy, onViewDocs,
  publishedUrl, extraActions, onOpenSpotlight,
}: HeaderProps) {
  const projectName = projectPath ? (projectPath.split(/[/\\]/).pop() || 'Project') : 'Betopia'
  const [showShare,       setShowShare]        = useState(false)
  const [copiedLink,      setCopiedLink]       = useState(false)
  const [showFile,        setShowFile]         = useState(false)
  const [showEdit,        setShowEdit]         = useState(false)
  const [showRecent,      setShowRecent]       = useState(false)
  const [recentProjects,  setRecentProjects]   = useState<Array<{ path: string; name: string }>>([])
  const [showHistory,     setShowHistory]      = useState(false)

  const fileRef          = useRef<HTMLDivElement>(null)
  const editRef          = useRef<HTMLDivElement>(null)
  const historyRef       = useRef<HTMLDivElement>(null)
  const recentTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Close dropdowns on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (fileRef.current    && !fileRef.current.contains(e.target as Node))    setShowFile(false)
      if (editRef.current    && !editRef.current.contains(e.target as Node))    setShowEdit(false)
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setShowHistory(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const closeAll = () => {
    setShowShare(false)
    setShowFile(false); setShowEdit(false); setShowRecent(false)
    setShowHistory(false)
  }

  // Load ALL recents when File menu opens (display will slice to 10)
  useEffect(() => {
    if (!showFile) return
    try {
      const v2 = localStorage.getItem('betopia_recent_projects_v2')
      if (v2) { setRecentProjects(JSON.parse(v2) as Array<{ path: string; name: string }>); return }
      const legacy = JSON.parse(localStorage.getItem('betopia_recent_paths') ?? '[]') as string[]
      setRecentProjects(legacy.map(p => ({ path: p, name: p.split(/[/\\]/).pop() ?? p })))
    } catch {}
  }, [showFile])

  const openRecentFlyout = () => {
    if (recentTimerRef.current) clearTimeout(recentTimerRef.current)
    setShowRecent(true)
  }
  const closeRecentFlyout = (delay = 120) => {
    recentTimerRef.current = setTimeout(() => setShowRecent(false), delay)
  }

  const handleNewWindow = async () => {
    closeAll()
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('create_window')
    } catch {}
  }

  const handleExit = async () => {
    closeAll()
    try { const { getCurrentWindow } = await import('@tauri-apps/api/window'); await getCurrentWindow().close() } catch {}
  }

  const dispatchKey = (key: string, ctrl = false, shift = false) => {
    setTimeout(() => {
      const cm = document.querySelector('.cm-content') as HTMLElement | null
      const target = cm ?? document.querySelector('.cm-editor') as HTMLElement | null
      if (target) {
        target.focus()
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey: ctrl, shiftKey: shift }))
      }
    }, 60)
  }

  const shareUrl = publishedUrl || liveServerUrl || ''
  void publishVisibility
  void isPublished
  void isPublishing
  void onChangePublishVisibility
  void onOpenPublishSettings

  const handleCopyLink = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 1800)
    } catch { /* ignore */ }
  }

  const openShareTarget = (url: string) => {
    try { window.open(url, '_blank', 'noopener,noreferrer') } catch {}
  }

  const encodedUrl  = encodeURIComponent(shareUrl)
  const encodedName = encodeURIComponent(projectName)

  return (
    <header className="manus-header">
      {/* ── LEFT: logo + File/Edit menus + project name ──────────────── */}
      <div className="manus-header-left">
        <div className="manus-logo-group" onClick={onGoHome} title="Home" aria-label="Home">
          <div className="manus-logo">
            {Icons.home}
          </div>
          <span className="manus-beta-badge">beta</span>
        </div>

        {/* File menu */}
        <div className="manus-more-wrap" ref={fileRef}>
          <button className="manus-menu-btn" onClick={() => { const next = !showFile; closeAll(); setShowFile(next) }}>File</button>
          {showFile && (
            <div className="manus-dropdown manus-dropdown--menu" onMouseLeave={() => closeRecentFlyout(0)}>
              <button className="manus-dropdown-item" onClick={() => { closeAll(); onNewFile?.() }} onMouseEnter={() => setShowRecent(false)}>
                New File <span className="manus-shortcut">Ctrl+N</span>
              </button>
              <button className="manus-dropdown-item" onClick={handleNewWindow} onMouseEnter={() => setShowRecent(false)}>
                New Window <span className="manus-shortcut">Ctrl+Shift+N</span>
              </button>
              <div className="manus-dropdown-sep" />
              <button className="manus-dropdown-item" onClick={() => { closeAll(); onOpenFile?.() }} onMouseEnter={() => setShowRecent(false)}>
                Open File
              </button>
              <button className="manus-dropdown-item" onClick={() => { closeAll(); onOpenProject() }} onMouseEnter={() => setShowRecent(false)}>
                Open Folder <span className="manus-shortcut">Ctrl+O</span>
              </button>

              {/* Open Recent — flyout submenu */}
              <div
                className={'manus-dropdown-item manus-dropdown-item--flyout' + (showRecent ? ' manus-dropdown-item--flyout-open' : '')}
                onMouseEnter={openRecentFlyout}
                onMouseLeave={() => closeRecentFlyout()}
              >
                <span>Open Recent</span>
                <span className="manus-flyout-arrow">›</span>
                {showRecent && (
                  <div
                    className="manus-flyout-menu"
                    onMouseEnter={openRecentFlyout}
                    onMouseLeave={() => closeRecentFlyout()}
                  >
                    {recentProjects.length === 0 ? (
                      <div className="manus-flyout-empty">No recent projects</div>
                    ) : (
                      <>
                        {recentProjects.slice(0, 10).map(r => (
                          <button
                            key={r.path}
                            className="manus-dropdown-item manus-flyout-item"
                            onClick={() => { closeAll(); onOpenRecent(r.path) }}
                            title={r.path}
                          >
                            <span className="manus-recent-name">{r.name}</span>
                            <span className="manus-recent-path">{r.path}</span>
                          </button>
                        ))}
                        {recentProjects.length > 10 && (
                          <button className="manus-dropdown-item manus-flyout-more" onClick={() => { closeAll(); onOpenProject() }}>
                            See more…
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="manus-dropdown-sep" />
              <button className="manus-dropdown-item" onClick={() => { closeAll(); dispatchKey('s', true) }} onMouseEnter={() => setShowRecent(false)}>
                Save <span className="manus-shortcut">Ctrl+S</span>
              </button>
              <button className="manus-dropdown-item" onClick={() => { closeAll(); dispatchKey('s', true, true) }} onMouseEnter={() => setShowRecent(false)}>
                Save As <span className="manus-shortcut">Ctrl+Shift+S</span>
              </button>
              <div className="manus-dropdown-sep" />
              <button className="manus-dropdown-item" onClick={() => { closeAll(); onDownloadAsZip?.() }} onMouseEnter={() => setShowRecent(false)}>
                Download as ZIP
              </button>
              <button className="manus-dropdown-item" onClick={() => { closeAll(); onOpenVersionHistory?.() }} onMouseEnter={() => setShowRecent(false)}>
                Version history
              </button>
              <button className="manus-dropdown-item" onClick={() => { closeAll(); onMakeCopy?.() }} onMouseEnter={() => setShowRecent(false)}>
                Make a copy
              </button>
              <button className="manus-dropdown-item manus-dropdown-item--trailing" onClick={() => { closeAll(); onViewDocs?.() }} onMouseEnter={() => { setShowRecent(false); setShowShare(false) }}>
                <span>View docs</span>
                <span className="manus-dropdown-item-tail-icon">{Icons.external}</span>
              </button>
              <div className="manus-dropdown-sep" />

              {/* Share — flyout submenu */}
              <div
                className={'manus-dropdown-item manus-dropdown-item--flyout' + (showShare ? ' manus-dropdown-item--flyout-open' : '')}
                onMouseEnter={() => { setShowRecent(false); setShowShare(true) }}
                onMouseLeave={() => setShowShare(false)}
              >
                <span>Share</span>
                <span className="manus-flyout-arrow">›</span>
                {showShare && (
                  <div
                    className="manus-flyout-menu manus-share-flyout"
                    onMouseEnter={() => setShowShare(true)}
                    onMouseLeave={() => setShowShare(false)}
                  >
                    <div className="manus-share-header">Share project</div>
                    {shareUrl ? (
                      <>
                        <div className="manus-share-url-row">
                          <span className="manus-share-url-text">{shareUrl.replace(/^https?:\/\//, '')}</span>
                          <button className="manus-share-copy-mini" onClick={handleCopyLink} title="Copy link">
                            {copiedLink ? Icons.check : Icons.link}
                          </button>
                        </div>
                        <div className="manus-share-socials">
                          <button className="manus-share-social-btn" title="Share on X/Twitter" onClick={() => openShareTarget(`https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedName}`)}>
                            {Icons.twitter}
                          </button>
                          <button className="manus-share-social-btn" title="Share on LinkedIn" onClick={() => openShareTarget(`https://linkedin.com/sharing/share-offsite/?url=${encodedUrl}`)}>
                            {Icons.linkedin}
                          </button>
                          <button className="manus-share-social-btn" title="Share on Facebook" onClick={() => openShareTarget(`https://facebook.com/sharer/sharer.php?u=${encodedUrl}`)}>
                            {Icons.facebook}
                          </button>
                          <button className="manus-share-social-btn" title="Share on Reddit" onClick={() => openShareTarget(`https://reddit.com/submit?url=${encodedUrl}&title=${encodedName}`)}>
                            {Icons.reddit}
                          </button>
                        </div>
                        <button className="manus-share-copy-btn" onClick={handleCopyLink}>
                          {copiedLink ? <>{Icons.check} Copied!</> : <>{Icons.link} Copy link</>}
                        </button>
                      </>
                    ) : (
                      <div className="manus-share-empty">
                        <p>Publish your project first to get a shareable link.</p>
                        <button className="manus-share-publish-btn" onClick={() => { closeAll(); onPublishNow?.() }}>
                          {Icons.publish} Publish now
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="manus-dropdown-sep" />
              <button className="manus-dropdown-item" onClick={() => { closeAll(); onOpenSettings() }} onMouseEnter={() => { setShowRecent(false); setShowShare(false) }}>
                Settings
              </button>
              <div className="manus-dropdown-sep" />
              <button className="manus-dropdown-item manus-dropdown-danger" onClick={handleExit} onMouseEnter={() => { setShowRecent(false); setShowShare(false) }}>
                Exit
              </button>
            </div>
          )}
        </div>

        {/* Edit menu */}
        <div className="manus-more-wrap" ref={editRef}>
          <button className="manus-menu-btn" onClick={() => { const next = !showEdit; closeAll(); setShowEdit(next) }}>Edit</button>
          {showEdit && (
            <div className="manus-dropdown manus-dropdown--menu">
              <button className="manus-dropdown-item" onClick={() => { closeAll(); dispatchKey('z', true) }}>
                Undo <span className="manus-shortcut">Ctrl+Z</span>
              </button>
              <button className="manus-dropdown-item" onClick={() => { closeAll(); dispatchKey('y', true) }}>
                Redo <span className="manus-shortcut">Ctrl+Y</span>
              </button>
              <div className="manus-dropdown-sep" />
              <button className="manus-dropdown-item" onClick={() => { closeAll(); dispatchKey('x', true) }}>
                Cut <span className="manus-shortcut">Ctrl+X</span>
              </button>
              <button className="manus-dropdown-item" onClick={() => { closeAll(); dispatchKey('c', true) }}>
                Copy <span className="manus-shortcut">Ctrl+C</span>
              </button>
              <button className="manus-dropdown-item" onClick={() => { closeAll(); dispatchKey('v', true) }}>
                Paste <span className="manus-shortcut">Ctrl+V</span>
              </button>
              <div className="manus-dropdown-sep" />
              <button className="manus-dropdown-item" onClick={() => { closeAll(); dispatchKey('f', true) }}>
                Find <span className="manus-shortcut">Ctrl+F</span>
              </button>
              <button className="manus-dropdown-item" onClick={() => { closeAll(); dispatchKey('h', true) }}>
                Replace <span className="manus-shortcut">Ctrl+H</span>
              </button>
            </div>
          )}
        </div>

      </div>

      {/* ── CENTER: Spotlight search ──────────────────────────────────── */}
      <div className="manus-header-center">
        {hasStarted ? (
          <button className="spotlight-btn" onClick={onOpenSpotlight} title="Search (Ctrl+K)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <span className="spotlight-placeholder">Search...</span>
            <kbd className="spotlight-kbd">Ctrl+K</kbd>
          </button>
        ) : (
          <span className="manus-brand-label">Betopia WebBuilder</span>
        )}
      </div>

      {/* Drag region — fills empty space, allows dragging the window */}
      <div className="manus-header-drag" data-tauri-drag-region />

      {/* ── RIGHT: action buttons ─────────────────────────────────────── */}
      <div className="manus-header-right">
        {hasStarted && (
          <>
            {/* History */}
            <div className="manus-more-wrap" ref={historyRef}>
              <button
                className={'manus-icon-btn history-btn' + (showHistory ? ' active' : '')}
                onClick={() => { const next = !showHistory; closeAll(); setShowHistory(next) }}
                title="Code change history"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="12 8 12 12 14 14"/>
                  <path d="M3.05 11a9 9 0 1 1 .5 4"/>
                  <polyline points="3 7 3 11 7 11"/>
                </svg>
              </button>
              {showHistory && (() => {
                const entries = projectPath ? loadCodeHistory(projectPath) : []
                return (
                  <div className="manus-dropdown manus-dropdown--right history-panel">
                    <div className="history-panel-header">
                      <span className="history-panel-title">Code History</span>
                      <span className="history-panel-sub">Last {Math.min(entries.length, 10)} changes</span>
                    </div>
                    {entries.length === 0 ? (
                      <div className="history-empty">No changes recorded yet</div>
                    ) : (
                      <div className="history-list">
                        {entries.map((entry, i) => {
                          const canRestore = Boolean(entry.snapshotId && onRestoreHistory)
                          return (
                            <button
                              key={entry.id}
                              className={'history-entry' + (canRestore ? ' history-entry--clickable' : '')}
                              disabled={!canRestore}
                              title={canRestore ? 'Click to restore this version' : undefined}
                              onClick={() => {
                                if (!canRestore) return
                                setShowHistory(false)
                                onRestoreHistory!(entry.snapshotId!)
                              }}
                            >
                              <div className="history-entry-meta">
                                <span className="history-entry-num">#{entries.length - i}</span>
                                <span className="history-entry-time">{formatHistoryDate(entry.timestamp)}</span>
                                {canRestore && <span className="history-entry-restore-hint">Restore</span>}
                              </div>
                              <p className="history-entry-prompt">
                                {entry.prompt.length > 120
                                  ? entry.prompt.slice(0, 120) + '…'
                                  : entry.prompt}
                              </p>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>

            {/* Publish */}
            <div className="manus-more-wrap manus-publish-wrap">
              <button
                type="button"
                className="manus-publish-btn manus-publish-btn--coming-soon"
                aria-disabled="true"
                title="This feature is coming soon"
                data-tip="This feature is coming soon"
                onClick={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  closeAll()
                }}
              >
                {Icons.blocked}
                <span>Publish</span>
              </button>
            </div>
          </>
        )}

        {/* Chat sidebar toggle — always visible when project started */}
        {hasStarted && (
          <button
            className={'manus-icon-btn chat-sidebar-toggle-btn' + (chatSidebarVisible ? ' active' : '')}
            onClick={onToggleChatSidebar}
            title={chatSidebarVisible ? 'Hide chat (Ctrl+I)' : 'Show chat (Ctrl+I)'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="1" width="12" height="12" rx="2" />
              <line x1="5" y1="1" x2="5" y2="13" />
            </svg>
          </button>
        )}

        {extraActions}
        <WindowControls />
      </div>
    </header>
  )
}

function buildSpaceTree(tabs: TabEntry[]): SpaceTreeEntry[] {
  const root: SpaceTreeNode = {
    kind: 'folder',
    name: '',
    path: '',
    children: [],
  }

  const folderMap = new Map<string, SpaceTreeNode>()
  folderMap.set('', root)

  const ensureFolder = (path: string, name: string): SpaceTreeNode => {
    const existing = folderMap.get(path)
    if (existing) return existing
    const parentPath = path.split('/').slice(0, -1).join('/')
    const parent = folderMap.get(parentPath) ?? root
    const node: SpaceTreeNode = {
      kind: 'folder',
      name,
      path,
      children: [],
    }
    parent.children.push(node)
    folderMap.set(path, node)
    return node
  }

  const sortedTabs = [...tabs].sort((a, b) => a.path.localeCompare(b.path))
  for (const tab of sortedTabs) {
    const parts = tab.path.split(/[\\/]/).filter(Boolean)
    if (parts.length === 0) continue
    let parent = root
    let currentPath = ''
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i]
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      parent = ensureFolder(currentPath, segment)
    }
    parent.children.push({
      kind: 'file',
      label: tab.label,
      path: tab.path,
      tab,
    })
  }

  return root.children
}

function SpaceTreeRow({
  entry,
  activeTab,
  onSelectTab,
  closeAll,
  depth = 0,
}: {
  entry: SpaceTreeEntry
  activeTab: string | null | undefined
  onSelectTab?: (path: string) => void
  closeAll: () => void
  depth?: number
}) {
  if (entry.kind === 'file') {
    const isActive = entry.path === activeTab
    return (
      <button
        type="button"
        className={'manus-space-file' + (isActive ? ' active' : '')}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        onClick={() => { closeAll(); onSelectTab?.(entry.path) }}
        title={entry.path}
        role="treeitem"
        aria-level={depth + 1}
      >
        <span className="manus-space-file-icon">{Icons.docs}</span>
        <span className="manus-space-file-text">{entry.label}</span>
      </button>
    )
  }

  return (
    <div className="manus-space-folder-wrap" role="group" aria-label={entry.name || 'Open files'}>
      {entry.name && (
        <div
          className="manus-space-folder"
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded="true"
        >
          <span className="manus-space-folder-icon">{Icons.folder}</span>
          <span className="manus-space-folder-text">{entry.name}</span>
        </div>
      )}
      <div className="manus-space-children">
        {entry.children.map((child) => (
          <SpaceTreeRow
            key={child.path}
            entry={child}
            activeTab={activeTab}
            onSelectTab={onSelectTab}
            closeAll={closeAll}
            depth={entry.name ? depth + 1 : depth}
          />
        ))}
      </div>
    </div>
  )
}
