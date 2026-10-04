import React, { useState, useRef, useEffect, useMemo, KeyboardEvent, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { Message } from '@/types'
import MessageBubble from './MessageBubble'
import { getConfig, saveConfig, getModelInfo } from '@/lib/config'
import { useConfig, useBetopiaModels } from '@/lib/useConfig'
import { getProvider } from '@/lib/providers'
import { AgentSwitcher } from '@/modules/ai/components/AgentSwitcher'
import { SnippetPicker, getSnippetQuery } from '@/modules/ai/components/SnippetPicker'
import type { FileEntry } from '@/types'
import { flattenFiles } from '@/lib/project-scaffold'
import { fuzzyFilter } from '@/lib/fuzzy'
import { getFileIcon } from '@/lib/file-icons'
import { useSessionStore } from '@/store/sessionStore'
import { useChatStore } from '@/store/chatStore'
import { estimateMessagesTokens } from '@/lib/tokenCounter'

type PermissionMode = 'default' | 'auto_review' | 'full_access'
type PlanBuildPhase = 'idle' | 'awaiting_plan' | 'awaiting_confirmation' | 'building'

const TOOL_BUSY_LABELS: Record<string, string> = {
  write_file: 'Writing file…',
  edit: 'Editing file…',
  read_file: 'Reading file…',
  view_file: 'Reading file…',
  list_dir: 'Listing directory…',
  list_files: 'Listing files…',
  grep_search: 'Searching…',
  bash: 'Running command…',
  web_fetch: 'Fetching URL…',
  delete_file: 'Deleting file…',
  rename_file: 'Renaming file…',
  run_subagent: 'Running subagent…',
  spawn_coding_agent: 'Spawning agent…',
  send_to_agent: 'Sending to agent…',
  read_agent_output: 'Reading agent output…',
}

function formatToolLabel(name: string | null | undefined): string {
  if (!name) return 'Thinking…'
  if (name.includes('__')) {
    const [server, tool] = name.split('__')
    const isFigma = server.toLowerCase().includes('figma')
    if (isFigma) return `Figma — ${tool.replace(/_/g, ' ')}…`
    return `${server}: ${tool.replace(/_/g, ' ')}…`
  }
  return TOOL_BUSY_LABELS[name] ?? `${name.replace(/_/g, ' ')}…`
}

function AgentBusyIndicator({ currentTool }: { currentTool?: string | null }) {
  const isFigma = currentTool?.toLowerCase().includes('figma')
  const toolStartedAt = useChatStore(s => s.toolStartedAt)
  const lastRoundOutput = useChatStore(s => s.lastRoundOutput)
  const [elapsedSec, setElapsedSec] = React.useState(0)
  React.useEffect(() => {
    const start = toolStartedAt ?? Date.now()
    setElapsedSec(Math.floor((Date.now() - start) / 1000))
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(id)
  }, [toolStartedAt])
  const metaParts: string[] = []
  if (elapsedSec > 0) metaParts.push(`${elapsedSec}s`)
  if (lastRoundOutput > 0) metaParts.push(`↓ ${lastRoundOutput >= 1000 ? `${(lastRoundOutput/1000).toFixed(1).replace(/\.0$/,'')}k` : lastRoundOutput}`)
  return (
    <div className="agent-busy-indicator">
      <span className="agent-busy-dot" />
      {isFigma && (
        <svg width="12" height="12" viewBox="0 0 38 57" fill="none" style={{ marginRight: 4 }} aria-hidden="true">
          <path d="M19 28.5A9.5 9.5 0 1 1 28.5 19 9.5 9.5 0 0 1 19 28.5z" fill="#1ABCFE"/>
          <path d="M9.5 47.5A9.5 9.5 0 0 1 19 38h9.5v9.5A9.5 9.5 0 1 1 9.5 47.5z" fill="#0ACF83"/>
          <path d="M19 0H9.5A9.5 9.5 0 0 0 9.5 19H19z" fill="#FF7262"/>
          <path d="M28.5 0H19v19h9.5a9.5 9.5 0 0 0 0-19z" fill="#F24E1E"/>
          <path d="M19 19H9.5a9.5 9.5 0 0 0 0 19H19z" fill="#A259FF"/>
        </svg>
      )}
      <span className="agent-busy-label">{formatToolLabel(currentTool)}</span>
      {metaParts.length > 0 && <span className="agent-status-meta">{metaParts.join(' · ')}</span>}
    </div>
  )
}

function formatTokensBar(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

function TaskDoneBar({ durationMs, inputTokens, outputTokens, onDismiss }: {
  durationMs: number; inputTokens: number; outputTokens: number; onDismiss: () => void
}) {
  const parts: string[] = [formatDuration(durationMs)]
  if (inputTokens > 0) parts.push(`↑ ${formatTokensBar(inputTokens)}`)
  if (outputTokens > 0) parts.push(`↓ ${formatTokensBar(outputTokens)}`)
  return (
    <div className="agent-task-done">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="agent-task-done-icon">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span className="agent-task-done-label">Task complete</span>
      <span className="agent-task-done-meta">{parts.join(' · ')}</span>
      <button className="agent-task-done-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  )
}

function PermissionModeControl({
  mode,
  onChange,
  onBeforeToggle,
}: {
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
  onBeforeToggle?: () => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (containerRef.current && !containerRef.current.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [])

  const options: Array<{ id: PermissionMode; label: string }> = [
    { id: 'default', label: 'Default permissions' },
    { id: 'auto_review', label: 'Auto-review' },
    { id: 'full_access', label: 'Full access' },
  ]

  return (
    <div className="chat-controls-item chat-permission-item" ref={containerRef}>
      <button
        className={'chat-controls-btn chat-controls-btn-secondary' + (open ? ' active' : '')}
        onClick={() => {
          onBeforeToggle?.()
          setOpen(prev => !prev)
        }}
        title="Permission"
        aria-label="Permission"
      >
        <span className="chat-controls-icon" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 11V5a1 1 0 1 1 2 0v6" />
            <path d="M10 11V4a1 1 0 1 1 2 0v7" />
            <path d="M14 11V6a1 1 0 1 1 2 0v5" />
            <path d="M18 11.5V9a1 1 0 1 1 2 0v6.5a6.5 6.5 0 0 1-6.5 6.5h-1A6.5 6.5 0 0 1 6 15.5V11" />
          </svg>
        </span>
        <span>Permission</span>
        <span className="chat-controls-chevron">▾</span>
      </button>
      {open && (
        <div className="chat-controls-dropdown chat-permission-dropdown">
          {options.map((option) => (
            <button
              key={option.id}
              className={'chat-controls-option' + (mode === option.id ? ' selected' : '')}
              onClick={() => {
                onChange(option.id)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              <span className="chat-controls-check" aria-hidden={mode !== option.id}>
                {mode === option.id ? '✓' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Combined toolbar pill ─────────────────────────────────────────────────────

const PERM_ICONS: Record<PermissionMode, JSX.Element> = {
  default: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L4 6v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V6L12 2z" />
    </svg>
  ),
  auto_review: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L4 6v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V6L12 2z" />
      <polyline points="9,12 11,14 15,10" />
    </svg>
  ),
  full_access: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L4 6v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V6L12 2z" />
      <line x1="9" y1="9" x2="15" y2="15" /><line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  ),
}
const PERM_COLOR: Record<PermissionMode, string> = {
  default: 'var(--text-3)',
  auto_review: '#fbbf24',
  full_access: 'var(--accent)',
}
const PERM_LABEL: Record<PermissionMode, string> = {
  default: 'Default permissions',
  auto_review: 'Auto-review',
  full_access: 'Full access (Yolo)',
}

const DROPDOWN_WIDTH = 220

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function ContextWindowPanel({
  tokenEstimate, ctxPct, ctxColor, ctxLimit,
  isCompacting, onCompact, isAgentBusy, agentUsage,
}: {
  tokenEstimate: number; ctxPct: number; ctxColor: string; ctxLimit: number
  isCompacting?: boolean; onCompact?: () => void; isAgentBusy: boolean
  agentUsage: { sessionInputTokens: number; sessionOutputTokens: number; sessionCachedTokens: number; lastInputTokens: number }
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const usedTokens = agentUsage.lastInputTokens > 0 ? agentUsage.lastInputTokens : tokenEstimate
  const pct = Math.min(1, usedTokens / ctxLimit)
  const displayPct = `${Math.round(pct * 100)}%`
  const hasSession = agentUsage.sessionInputTokens > 0
  const cacheRate = agentUsage.sessionInputTokens > 0
    ? Math.round((agentUsage.sessionCachedTokens / agentUsage.sessionInputTokens) * 100)
    : 0

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  return (
    <div className="ctx-window-wrap" ref={ref}>
      <button
        className={'toolbar-pill-btn ctx-window-trigger' + (open ? ' active' : '')}
        onClick={() => setOpen(o => !o)}
        disabled={isCompacting}
        title="Context window"
      >
        {isCompacting ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={ctxColor} strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/>
            </path>
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 18 18" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="9" cy="9" r="6.5" fill="none" stroke="var(--border-2)" strokeWidth="2.5" />
            <circle cx="9" cy="9" r="6.5" fill="none" stroke={ctxColor} strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${pct * 40.8} 40.8`}
              style={{ transition: 'stroke-dasharray 0.4s, stroke 0.4s' }} />
          </svg>
        )}
        <span className="ctx-window-pct" style={{ color: ctxColor }}>{displayPct}</span>
      </button>

      {open && (
        <div className="ctx-window-panel">
          {/* Header — bar + pct */}
          <div className="ctx-window-header">
            <div className="ctx-window-header-row">
              <span className="ctx-window-pct-label" style={{ color: ctxColor }}>{displayPct}</span>
              <span className="ctx-window-token-label">
                {fmtTokens(usedTokens)} / {fmtTokens(ctxLimit)}
              </span>
            </div>
            <div className="ctx-progress-track">
              <div className="ctx-progress-fill" style={{ width: `${Math.min(100, pct * 100)}%`, background: ctxColor, transition: 'width 0.4s, background 0.4s' }} />
            </div>
          </div>

          {/* Body — breakdown */}
          <div className="ctx-window-body">
            <div className="ctx-window-row">
              <span className="ctx-row-label">{agentUsage.lastInputTokens > 0 ? 'Last request' : 'Estimated context'}</span>
              <span className="ctx-row-val">{fmtTokens(usedTokens)}</span>
            </div>
            {hasSession && (
              <>
                <div className="ctx-window-row">
                  <span className="ctx-row-label">Session input</span>
                  <span className="ctx-row-val">{fmtTokens(agentUsage.sessionInputTokens)}</span>
                </div>
                <div className="ctx-window-row">
                  <span className="ctx-row-label">Session output</span>
                  <span className="ctx-row-val">{fmtTokens(agentUsage.sessionOutputTokens)}</span>
                </div>
                {cacheRate > 0 && (
                  <div className="ctx-window-row">
                    <span className="ctx-row-label">Cache hit</span>
                    <span className="ctx-row-val">{cacheRate}%</span>
                  </div>
                )}
              </>
            )}
            <div className="ctx-window-row">
              <span className="ctx-row-label">Window</span>
              <span className="ctx-row-val">{fmtTokens(ctxLimit)}</span>
            </div>
          </div>

          {/* Footer — compact action */}
          <div className="ctx-window-footer">
            {agentUsage.lastInputTokens > 0 && (
              <span className="ctx-window-note">Last request reflects current context size.</span>
            )}
            <button
              className="ctx-compact-btn"
              onClick={() => { setOpen(false); onCompact?.() }}
              disabled={isAgentBusy || isCompacting}
            >
              {isCompacting ? 'Compacting…' : 'Compact now'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ToolbarPill({
  permissionMode, onPermissionChange,
  tokenEstimate, ctxPct, ctxColor, ctxLimit,
  isAgentBusy, onComputerClick, computerActive, onBeforeToggle,
  computerDropdown, openDown = false, onCompact, isCompacting, agentUsage,
}: {
  permissionMode: PermissionMode; onPermissionChange: (m: PermissionMode) => void
  tokenEstimate: number; ctxPct: number; ctxColor: string; ctxLimit: number
  isAgentBusy: boolean; onComputerClick: () => void; computerActive: boolean
  onBeforeToggle?: () => void; computerDropdown?: React.ReactNode; openDown?: boolean
  onCompact?: () => void; isCompacting?: boolean
  agentUsage: { sessionInputTokens: number; sessionOutputTokens: number; sessionCachedTokens: number; lastInputTokens: number }
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const calcPos = useCallback(() => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    let left = r.left
    if (left + DROPDOWN_WIDTH > vw - 8) left = vw - DROPDOWN_WIDTH - 8
    if (left < 8) left = 8
    setPos({ top: r.top - 6, left })
  }, [])

  useEffect(() => {
    if (!open || openDown) return
    calcPos()
    const close = (e: MouseEvent) => {
      if (!dropRef.current?.contains(e.target as Node) && !ref.current?.contains(e.target as Node))
        setOpen(false)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('resize', calcPos)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('resize', calcPos) }
  }, [open, openDown, calcPos])

  const permOptions = (['default', 'auto_review', 'full_access'] as PermissionMode[]).map(m => (
    <button key={m} className={'toolbar-pill-opt' + (permissionMode === m ? ' active' : '')}
      onClick={() => { onPermissionChange(m); if (!openDown) setOpen(false) }}>
      <span style={{ color: PERM_COLOR[m] }}>{PERM_ICONS[m]}</span>
      <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap' }}>{PERM_LABEL[m]}</span>
      {permissionMode === m && <span style={{ color: 'var(--accent)', flexShrink: 0 }}>✓</span>}
    </button>
  ))

  if (openDown) {
    return (
      <div className="toolbar-pill-inline" ref={ref}>
        <div className="toolbar-pill-inline-opts">
          {permOptions}
        </div>
      </div>
    )
  }

  const dropdown = open ? (
    <div
      ref={dropRef}
      className="toolbar-pill-dropdown"
      style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateY(-100%)', width: DROPDOWN_WIDTH }}
      onClick={e => e.stopPropagation()}
    >
      {permOptions}
    </div>
  ) : null

  return (
    <div className="toolbar-pill" ref={ref}>
      {/* Permission icon */}
      <button
        ref={btnRef}
        className="toolbar-pill-btn"
        style={{ color: PERM_COLOR[permissionMode] }}
        title={PERM_LABEL[permissionMode]}
        onClick={() => { onBeforeToggle?.(); setOpen(o => !o) }}
      >
        {PERM_ICONS[permissionMode]}
      </button>

      <div className="toolbar-pill-sep" />

      {/* Context window panel */}
      <ContextWindowPanel
        tokenEstimate={tokenEstimate}
        ctxPct={ctxPct}
        ctxColor={ctxColor}
        ctxLimit={ctxLimit}
        isCompacting={isCompacting}
        onCompact={onCompact}
        isAgentBusy={isAgentBusy}
        agentUsage={agentUsage}
      />

      {/* Computer dropdown */}
      {computerDropdown}

      {createPortal(dropdown, document.body)}
    </div>
  )
}

function ChatFooterMenus({
  isAgentBusy,
  onInsertSnippet,
  onBeforeToggle,
  openDown = false,
}: {
  isAgentBusy: boolean
  onInsertSnippet: (snippet: string) => void
  onBeforeToggle?: () => void
  openDown?: boolean
}) {
  const [openMenu, setOpenMenu] = useState<null | 'agent' | 'model'>(null)
  const [search, setSearch] = useState('')
  const [cfg, setCfg] = useConfig()
  const { models: betopiaModels } = useBetopiaModels()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (containerRef.current && !containerRef.current.contains(target)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [])

  const provider = getProvider(cfg.model.providerId)
  const allModels = cfg.model.providerId === 'betopia' && betopiaModels.length > 0
    ? betopiaModels
    : (provider?.models ?? [])
  const filteredModels = allModels.filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.id.toLowerCase().includes(search.toLowerCase()),
  )
  const currentModel = allModels.find(m => m.id === cfg.model.model)
  const currentModelName = currentModel?.name || cfg.model.model || 'Model'

  const switchModel = (modelId: string) => {
    const next = { ...cfg, model: { ...cfg.model, model: modelId } }
    setCfg(next)
    setOpenMenu(null)
  }

  const modelListContent = (
    <div className="chat-footer-model-list">
      {filteredModels.map(model => (
        <button
          key={model.id}
          className={'chat-footer-dropdown-item' + (cfg.model.model === model.id ? ' selected' : '')}
          onClick={() => switchModel(model.id)}
        >
          <span className="chat-footer-item-name">{model.name || model.id}</span>
          {model.description && <span className="chat-footer-dropdown-meta">{model.description}</span>}
        </button>
      ))}
    </div>
  )

  return (
    <div
      className="chat-footer-menus"
      ref={containerRef}
      onMouseLeave={openDown ? () => setOpenMenu(null) : undefined}
    >
      <div className="chat-footer-menu-item">
        <button
          className={'chat-footer-model-chip' + (openMenu === 'model' ? ' active' : '')}
          onClick={() => { onBeforeToggle?.(); setOpenMenu(prev => prev === 'model' ? null : 'model') }}
          onMouseEnter={openDown ? () => setOpenMenu('model') : undefined}
          title="Select model"
          aria-label="Select model"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" />
            <circle cx="9" cy="7" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="11" cy="17" r="2" />
          </svg>
          <span className="chat-footer-model-chip-name">{currentModelName}</span>
        </button>

        {openMenu === 'model' && (
          openDown ? (
            /* Inline list inside overflow panel — no floating needed */
            <div className="chat-footer-model-inline" onMouseEnter={() => setOpenMenu('model')}>
              <input
                className="chat-footer-model-search"
                placeholder="Search models"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {modelListContent}
            </div>
          ) : (
            /* Normal floating dropdown above the bar */
            <div className="chat-footer-dropdown chat-footer-dropdown-model">
              <div className="chat-footer-model-search-row">
                <input
                  className="chat-footer-model-search"
                  placeholder="Search models"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              {modelListContent}
            </div>
          )
        )}
      </div>
    </div>
  )
}

interface Attachment {
  id: string
  type: 'image' | 'file'
  name: string
  data: string // base64 or file content
  mimeType: string
  size: number
}

interface FileReferenceRequest {
  id: string | number
  path: string
}

interface Props {
  messages: Message[]
  isAgentBusy: boolean
  currentTool?: string | null
  onSend: (text: string, attachments?: Attachment[]) => void
  onCancel: () => void
  onHide?: () => void
  onCompact?: () => void
  isCompacting?: boolean
  permissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  agentMode?: 'backend' | 'inline'
  projectPath?: string | null
  files?: FileEntry[]
  pendingFileReference?: FileReferenceRequest | null
  planPhase?: PlanBuildPhase
  onStartBuildFromPlan?: () => void
  onOpenPlanFile?: () => void
  onApprovalResponse?: (id: string, approved: boolean, content?: string) => void
}

const SUGGESTIONS = [
  { title: 'React + Django', desc: 'Build a full-stack app with React frontend and Django backend' },
  { title: 'Admin Dashboard', desc: 'Create a dashboard UI in React with Django APIs' },
  { title: 'E-Commerce Store', desc: 'Create a React storefront powered by Django' },
  { title: 'Blog Platform', desc: 'Build a blog with React pages and Django admin' },
  { title: 'Auth Portal', desc: 'Create login, signup, and protected routes with Django auth' },
  { title: 'Custom Stack', desc: 'Build the exact React + Django app I need' },
]

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Current "@token" before the caret (for @file mention), or null.
function getAtQuery(value: string, pos: number): string | null {
  const m = value.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/)
  return m ? m[1] : null
}

export default function ChatPanel({
  messages,
  isAgentBusy,
  currentTool,
  onSend,
  onCancel,
  onHide,
  onCompact,
  isCompacting = false,
  permissionMode,
  onPermissionModeChange,
  projectPath,
  files = [],
  pendingFileReference,
  planPhase = 'idle',
  onStartBuildFromPlan,
  onOpenPlanFile,
  onApprovalResponse,
}: Props) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [snippetQuery, setSnippetQuery] = useState<string | null>(null)
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const atFiles = useMemo(() => flattenFiles(files).filter(f => !f.is_dir), [files])
  const atResults = useMemo(
    () => atQuery === null ? [] : fuzzyFilter(atQuery, atFiles, f => [f.name, f.path]).slice(0, 8),
    [atQuery, atFiles],
  )
  const [isCompactComposer, setIsCompactComposer] = useState(false)
  const [pendingInterrupt, setPendingInterrupt] = useState<{ text: string; attachments: Attachment[]; mode: 'idle' | 'stop-run' } | null>(null)

  const { setQueuedPrompt, agentUsage, taskDone, clearTaskDone } = useChatStore()

  // Token count via tiktoken (cl100k_base BPE); falls back to chars/4 if encoder unavailable
  const tokenEstimate = useMemo(() => estimateMessagesTokens(messages), [messages])
  const [activeCfg] = useConfig()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const CTX_LIMIT = useMemo(() => getModelInfo().contextLength || 128_000, [activeCfg.model.model, activeCfg.model.providerId])
  const ctxPct = Math.min(1, tokenEstimate / CTX_LIMIT)
  const ctxColor = ctxPct < 0.5 ? 'var(--green)' : ctxPct < 0.75 ? '#fbbf24' : ctxPct < 0.9 ? '#f97316' : 'var(--red)'
  const [openComposerMenu, setOpenComposerMenu] = useState<'add' | 'computer' | null>(null)
  const [openSubmenu, setOpenSubmenu] = useState<'more' | 'skills' | null>(null)
  const [showUploadMenu, setShowUploadMenu] = useState(false)
  const [uploadSubmenu, setUploadSubmenu] = useState<'skills' | 'connectors' | null>(null)
  const [showMicMenu, setShowMicMenu] = useState(false)
  const [showComposerOverflow, setShowComposerOverflow] = useState(false)
  const [overflowMenuPos, setOverflowMenuPos] = useState<{ bottom: number; left: number } | null>(null)
  const [selectedMicIndex, setSelectedMicIndex] = useState(0)
  const [holdToRecord, setHoldToRecord] = useState(true)
  const [isMicRecording, setIsMicRecording] = useState(false)
  const [connectorClaudeEnabled, setConnectorClaudeEnabled] = useState(true)
  const [connectorDesktopEnabled, setConnectorDesktopEnabled] = useState(true)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const uploadBtnRef = useRef<HTMLButtonElement>(null)
  const overflowBtnRef = useRef<HTMLButtonElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const historyRef = useRef<string[]>([])
  const historyIdxRef = useRef(-1)
  const savedInputRef = useRef('')
  const chatPanelRef = useRef<HTMLDivElement>(null)
  const composerMenuRef = useRef<HTMLDivElement>(null)
  const composerOverflowRef = useRef<HTMLDivElement>(null)
  const uploadMenuRef = useRef<HTMLDivElement>(null)
  const micMenuRef = useRef<HTMLDivElement>(null)
  const visibleMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant')
  const microphoneDevices = [
    'Default - Microphone (3- Logi USB Headset H340)',
    'Communications - Microphone (3- Logi USB Headset H340)',
    'Microphone (3- Logi USB Headset H340) (04...)',
  ]

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const el = chatPanelRef.current
    if (!el) return

    const updateCompactMode = () => {
      const width = el.getBoundingClientRect().width
      setIsCompactComposer(width < 430)
    }

    updateCompactMode()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateCompactMode)
      return () => window.removeEventListener('resize', updateCompactMode)
    }

    const observer = new ResizeObserver(() => updateCompactMode())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const key = `chat.draft.${projectPath ?? 'global'}`
    try {
      const v = localStorage.getItem(key)
      if (v) setInput(v)
    } catch {}
  }, [projectPath])

  // Persist ↑/↓ input history across reloads (shell-style), per project.
  useEffect(() => {
    try {
      const v = localStorage.getItem(`chat.history.${projectPath ?? 'global'}`)
      historyRef.current = v ? JSON.parse(v) : []
    } catch { historyRef.current = [] }
    historyIdxRef.current = -1
  }, [projectPath])

  useEffect(() => {
    const key = `chat.draft.${projectPath ?? 'global'}`
    const t = setTimeout(() => {
      try { localStorage.setItem(key, input) } catch {}
    }, 500)
    return () => clearTimeout(t)
  }, [input, projectPath])

  // Cancel (Esc while generating) handled by the central shortcut dispatcher.

  // Focus the chat input when the shortcut dispatcher fires (Ctrl+L).
  useEffect(() => {
    const focus = () => { textareaRef.current?.focus() }
    window.addEventListener('betopia:focus-chat', focus)
    return () => window.removeEventListener('betopia:focus-chat', focus)
  }, [])

  // When generation stops and user had chosen "Stop & Run", fire the queued prompt
  useEffect(() => {
    if (isAgentBusy) return
    if (!pendingInterrupt || pendingInterrupt.mode !== 'stop-run') return
    const { text, attachments: atts } = pendingInterrupt
    setPendingInterrupt(null)
    onSend(text, atts.length > 0 ? atts : undefined)
    setInput('')
    setAttachments([])
    setShowSuggestions(false)
    setShowComposerOverflow(false)
  }, [isAgentBusy]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (composerMenuRef.current && !composerMenuRef.current.contains(target)) {
        setOpenComposerMenu(null)
        setOpenSubmenu(null)
      }
      if (
        composerOverflowRef.current && !composerOverflowRef.current.contains(target) &&
        !(target instanceof Element && target.closest('.chat-composer-overflow-menu'))
      ) {
        setShowComposerOverflow(false)
      }
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(target)) {
        setShowUploadMenu(false)
        setUploadSubmenu(null)
      }
      if (micMenuRef.current && !micMenuRef.current.contains(target)) {
        setShowMicMenu(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [])

  useEffect(() => {
    if (!isMicRecording) return

    const stopRecording = () => setIsMicRecording(false)
    window.addEventListener('pointerup', stopRecording)
    window.addEventListener('pointercancel', stopRecording)

    return () => {
      window.removeEventListener('pointerup', stopRecording)
      window.removeEventListener('pointercancel', stopRecording)
    }
  }, [isMicRecording])

  useEffect(() => {
    if (!isCompactComposer) {
      setShowComposerOverflow(false)
    }
  }, [isCompactComposer])

  const resizeInput = useCallback(() => {
    const ta = textareaRef.current
    if (!ta || !(ta instanceof HTMLTextAreaElement)) return
    requestAnimationFrame(() => {
      ta.style.height = 'auto'
      const maxH = isCompactComposer ? 72 : 104
      ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px'
    })
  }, [isCompactComposer])

  useEffect(() => {
    if (!pendingFileReference?.path) return
    const normalized = pendingFileReference.path.replace(/\\/g, '/').replace(/^\/+/, '')
    const token = `@file(${normalized})`
    const tokenPattern = new RegExp(`(^|\\s)${escapeRegex(token)}(\\s|$)`)

    setInput(prev => {
      if (tokenPattern.test(prev)) return prev
      const separator = prev.trim().length === 0 ? '' : (prev.endsWith('\n') || prev.endsWith(' ') ? '' : '\n')
      return `${prev}${separator}${token}`
    })

    setShowSuggestions(false)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      resizeInput()
    })
  }, [pendingFileReference])

  const submit = () => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    if (isAgentBusy) {
      setPendingInterrupt({ text, attachments: [...attachments], mode: 'idle' })
      return
    }
    if (text) {
      historyRef.current = [text, ...historyRef.current.filter(h => h !== text)].slice(0, 100)
      historyIdxRef.current = -1
      savedInputRef.current = ''
      try { localStorage.setItem(`chat.history.${projectPath ?? 'global'}`, JSON.stringify(historyRef.current)) } catch {}
    }
    onSend(text, attachments.length > 0 ? attachments : undefined)
    setInput('')
    setAttachments([])
    setShowSuggestions(false)
    setShowComposerOverflow(false)
    if (textareaRef.current instanceof HTMLTextAreaElement) {
      textareaRef.current.style.height = 'auto'
    }
  }
  const canSend = input.trim().length > 0 || attachments.length > 0

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file') {
        e.preventDefault()
        const file = item.getAsFile()
        if (file && file.type.startsWith('image/')) {
          const reader = new FileReader()
          reader.onload = (evt) => {
            const data = evt.target?.result as string
            const base64 = data.split(',')[1] || data
            setAttachments(prev => [...prev, {
              id: `paste-${Date.now()}`,
              type: 'image',
              name: file.name || 'pasted-image',
              data: base64,
              mimeType: file.type,
              size: file.size,
            }])
          }
          reader.readAsDataURL(file)
        }
      }
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    // @file mention open: Enter inserts top match, Esc closes (before send/history)
    if (atQuery !== null && atResults.length > 0) {
      if (e.key === 'Enter') { e.preventDefault(); insertAtFile(atResults[0].path); return }
      if (e.key === 'Escape') { e.preventDefault(); setAtQuery(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }

    // Terminal-style history: Up/Down only when cursor is on first/last line
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const ta = textareaRef.current
      if (!ta) return
      const val = ta.value
      const selStart = ta.selectionStart ?? 0
      const onFirstLine = !val.slice(0, selStart).includes('\n')
      const onLastLine = !val.slice(selStart).includes('\n')

      if (e.key === 'ArrowUp' && onFirstLine) {
        const history = historyRef.current
        if (history.length === 0) return
        e.preventDefault()
        if (historyIdxRef.current === -1) savedInputRef.current = val
        const next = Math.min(historyIdxRef.current + 1, history.length - 1)
        historyIdxRef.current = next
        setInput(history[next])
        requestAnimationFrame(() => { if (textareaRef.current) { textareaRef.current.selectionStart = textareaRef.current.selectionEnd = textareaRef.current.value.length } })
      } else if (e.key === 'ArrowDown' && onLastLine && historyIdxRef.current !== -1) {
        e.preventDefault()
        const next = historyIdxRef.current - 1
        historyIdxRef.current = next
        setInput(next === -1 ? savedInputRef.current : historyRef.current[next])
        requestAnimationFrame(() => { if (textareaRef.current) { textareaRef.current.selectionStart = textareaRef.current.selectionEnd = textareaRef.current.value.length } })
      }
    }
  }

  const onInput = () => {
    resizeInput()
  }

  const handleComposerChange = (value: string, selectionStart?: number | null) => {
    setInput(value)
    const pos = selectionStart ?? value.length
    setSnippetQuery(getSnippetQuery(value, pos))
    setAtQuery(getAtQuery(value, pos))
  }

  const insertAtFile = (path: string) => {
    const ta = textareaRef.current
    const pos = ta?.selectionStart ?? input.length
    const before = input.slice(0, pos)
    const after = input.slice(pos)
    const replaced = before.replace(/(^|\s)@[^\s@]*$/, (_m, lead) => `${lead}@${path} `)
    setInput(replaced + after)
    setAtQuery(null)
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (t) { t.focus(); t.selectionStart = t.selectionEnd = replaced.length }
    })
  }

  const handleFileSelect = (files: FileList) => {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const reader = new FileReader()
      reader.onload = (e) => {
        const data = e.target?.result as string
        const base64 = data.split(',')[1] || data
        setAttachments(prev => [...prev, {
          id: `${Date.now()}-${i}`,
          type: file.type.startsWith('image/') ? 'image' : 'file',
          name: file.name,
          data: base64,
          mimeType: file.type,
          size: file.size,
        }])
      }
      reader.readAsDataURL(file)
    }
  }

  // Just closes the upload menu — the actual file dialog is triggered by <label htmlFor="chat-file-input">
  const openFilePicker = () => {
    if (isAgentBusy) return
    setOpenComposerMenu(null)
    setOpenSubmenu(null)
    setShowUploadMenu(false)
    setUploadSubmenu(null)
  }

  const openFolderPicker = async () => {
    if (isAgentBusy) return
    try {
      const { open: tauriOpen } = await import('@tauri-apps/plugin-dialog')
      const selected = await tauriOpen({ directory: true, multiple: false })
      if (typeof selected === 'string' && selected.trim().length > 0) {
        injectSnippet(`Use this local folder as context: ${selected}`)
      } else {
        setShowUploadMenu(false)
        setUploadSubmenu(null)
      }
    } catch {
      injectSnippet('Add local folder context for this task and continue.')
    }
  }

  const injectSnippet = (snippet: string) => {
    setOpenComposerMenu(null)
    setOpenSubmenu(null)
    setShowComposerOverflow(false)
    setShowUploadMenu(false)
    setUploadSubmenu(null)
    setInput(prev => {
      const trimmed = prev.trim()
      if (!trimmed) return snippet
      if (trimmed.toLowerCase().includes(snippet.toLowerCase())) return prev
      return `${prev}${prev.endsWith('\n') ? '' : '\n'}${snippet}`
    })
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      resizeInput()
    })
  }

  const toggleComposerMenu = (menu: 'add' | 'computer') => {
    if (isAgentBusy) return
    setShowComposerOverflow(false)
    setShowMicMenu(false)
    setOpenSubmenu(null)
    setOpenComposerMenu(prev => prev === menu ? null : menu)
  }

  const closeMonitorPanel = () => {
    setOpenComposerMenu(null)
    setOpenSubmenu(null)
    setShowComposerOverflow(false)
    setShowUploadMenu(false)
    setUploadSubmenu(null)
    setShowMicMenu(false)
  }

  const toggleComposerOverflow = () => {
    if (isAgentBusy) return
    setShowUploadMenu(false)
    setUploadSubmenu(null)
    setShowMicMenu(false)
    setOpenComposerMenu(null)
    setOpenSubmenu(null)
    setShowComposerOverflow(prev => {
      if (!prev && overflowBtnRef.current) {
        const r = overflowBtnRef.current.getBoundingClientRect()
        const menuW = Math.min(340, window.innerWidth - 24)
        const left = Math.max(12, Math.min(r.left, window.innerWidth - menuW - 12))
        setOverflowMenuPos({ bottom: window.innerHeight - r.top + 8, left })
      }
      return !prev
    })
  }

  const sessions      = useSessionStore(s => s.sessions)
  const activeId      = useSessionStore(s => s.activeId)
  const setActiveId   = useSessionStore(s => s.setActiveId)
  const createSession = useSessionStore(s => s.createSession)
  const deleteSession = useSessionStore(s => s.deleteSession)
  const [sessionOpen, setSessionOpen] = useState(false)
  const sessionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sessionOpen) return
    const h = (e: MouseEvent) => { if (!sessionRef.current?.contains(e.target as Node)) setSessionOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [sessionOpen])

  const activeSession = sessions.find(s => s.id === activeId)

  return (
    <div className={'chat-panel' + (isCompactComposer ? ' chat-panel--compact' : '')} ref={chatPanelRef}>
      {/* Session bar */}
      <div className="session-bar" ref={sessionRef}>
        <button className="session-trigger" onClick={() => setSessionOpen(o => !o)}>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 3h10M2 7h10M2 11h6" strokeLinecap="round" />
          </svg>
          <span className="session-trigger-name">{activeSession?.title ?? 'Session'}</span>
          <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="2,3.5 5,6.5 8,3.5" />
          </svg>
        </button>

        <button className="session-new-btn" title="New session" onClick={() => { createSession(); setSessionOpen(false) }}>
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="6" y1="2" x2="6" y2="10" /><line x1="2" y1="6" x2="10" y2="6" />
          </svg>
        </button>
        {sessionOpen && (
          <div className="session-dropdown">
            {sessions.map(s => (
              <div key={s.id} className={`session-item${s.id === activeId ? ' active' : ''}`}>
                <button className="session-item-btn" onClick={() => { setActiveId(s.id); setSessionOpen(false) }}>
                  <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M1 2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2z" />
                    <line x1="3" y1="4" x2="9" y2="4" strokeLinecap="round" />
                    <line x1="3" y1="6.5" x2="7" y2="6.5" strokeLinecap="round" />
                  </svg>
                  <span className="session-item-title">{s.title}</span>
                  <span className="session-item-count">{s.messages.filter(m => m.role === 'user').length}</span>
                </button>
                {sessions.length > 1 && (
                  <button className="session-item-del" title="Delete" onClick={e => { e.stopPropagation(); deleteSession(s.id) }}>
                    <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {ctxPct >= 0.75 && visibleMessages.length > 0 && (
        <button
          className={'ctx-compact-banner' + (isCompacting ? ' compacting' : '')}
          onClick={onCompact}
          disabled={isCompacting || isAgentBusy}
        >
          <span className="ctx-compact-banner-dot" style={{ background: ctxColor }} />
          {isCompacting
            ? 'Compacting conversation…'
            : `${Math.round(ctxPct * 100)}% context used — click to compact`}
        </button>
      )}
      <div className="chat-messages">
        {visibleMessages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon" aria-hidden="true">
              <img src="/favicon.ico" alt="" className="chat-empty-logo" />
            </div>
            <h2>What would you like to build?</h2>
            <p>Describe your project and I will write the code for you</p>
            <div className="chat-empty-suggestions">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  className="suggestion-btn"
                  title={s.desc}
                  onClick={() => {
                    setInput(s.desc)
                    setShowSuggestions(false)
                    textareaRef.current?.focus()
                  }}
                >
                  <span className="suggestion-title">{s.title}</span>
                  <span className="suggestion-desc">{s.desc}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {visibleMessages.map((msg, idx) => {
              const isLastMsg = idx === visibleMessages.length - 1
              const isLiveMsg = isAgentBusy && isLastMsg && msg.role === 'assistant' && !msg.parts.some(p => p.type === 'finish')
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  onApprovalResponse={onApprovalResponse}
                  isLive={isLiveMsg}
                  currentTool={isLiveMsg ? currentTool : undefined}
                  onEdit={text => { setInput(text); requestAnimationFrame(() => { const ta = textareaRef.current; if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length } }) }}
                />
              )
            })}
            {isAgentBusy && (visibleMessages.length === 0 || visibleMessages[visibleMessages.length - 1].role !== 'assistant' || visibleMessages[visibleMessages.length - 1].parts.some(p => p.type === 'finish')) && <AgentBusyIndicator currentTool={currentTool} />}
          </>
        )}
        {!isAgentBusy && taskDone && (
          <TaskDoneBar
            durationMs={taskDone.durationMs}
            inputTokens={taskDone.inputTokens}
            outputTokens={taskDone.outputTokens}
            onDismiss={clearTaskDone}
          />
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        {(planPhase === 'awaiting_plan' || planPhase === 'awaiting_confirmation' || planPhase === 'building') && (
          <div className="plan-workflow-box">
            <div className="plan-workflow-title">Project Build Workflow</div>
            {planPhase === 'awaiting_plan' && (
              <div className="plan-workflow-status">Creating complete plan first...</div>
            )}
            {planPhase === 'building' && (
              <div className="plan-workflow-status">Building project step by step...</div>
            )}
            {planPhase === 'awaiting_confirmation' && (
              <>
                <div className="plan-workflow-status">
                  Plan ready. Confirm to start build or edit and regenerate the plan.
                </div>
                <div className="plan-workflow-actions">
                  <button
                    className="plan-workflow-btn primary"
                    onClick={() => onStartBuildFromPlan?.()}
                    disabled={isAgentBusy}
                  >
                    Start build
                  </button>
                  <button
                    className="plan-workflow-btn"
                    onClick={() => onOpenPlanFile?.()}
                    disabled={isAgentBusy}
                  >
                    Edit plan
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachments-preview">
            {attachments.map(att => (
              <div key={att.id} className="attachment-item">
                {att.type === 'image' ? (
                  <div className="attachment-image-preview">
                    <img src={`data:${att.mimeType};base64,${att.data}`} alt={att.name} />
                    <button
                      className="attachment-remove"
                      onClick={() => removeAttachment(att.id)}
                      title="Remove attachment"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div className="attachment-file">
                    <span className="attachment-icon">📎</span>
                    <div className="attachment-info">
                      <div className="attachment-name">{att.name}</div>
                      <div className="attachment-size">{(att.size / 1024).toFixed(1)} KB</div>
                    </div>
                    <button
                      className="attachment-remove"
                      onClick={() => removeAttachment(att.id)}
                      title="Remove attachment"
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <div className={'chat-input-wrap' + (isAgentBusy ? ' generating' : '') + (isCompactComposer ? ' compact' : '')} style={{ position: 'relative' }}>
          {/* Snippet picker — shown when typing #handle */}
          {snippetQuery !== null && (
            <SnippetPicker
              query={snippetQuery}
              onSelect={handle => {
                // Replace the #query with #handle in input
                const ta = textareaRef.current
                if (!ta) return
                const pos = ta.selectionStart ?? input.length
                const before = input.slice(0, pos)
                const after = input.slice(pos)
                const replaced = before.replace(/(^|\s)#[a-z0-9-]*$/, (m, lead) => lead + '#' + handle)
                setInput(replaced + after)
                setSnippetQuery(null)
                setTimeout(() => ta.focus(), 0)
              }}
              onClose={() => setSnippetQuery(null)}
            />
          )}
          {/* @file mention — shown when typing @ */}
          {atQuery !== null && atResults.length > 0 && (
            <div className="chat-at-picker">
              {atResults.map((f, i) => (
                <button key={f.path} className={'chat-at-item' + (i === 0 ? ' active' : '')}
                  onClick={() => insertAtFile(f.path)}>
                  <img src={getFileIcon(f.name)} alt="" width={14} height={14} />
                  <span className="chat-at-name">{f.name}</span>
                  <span className="chat-at-path">{f.path}</span>
                </button>
              ))}
            </div>
          )}
          {pendingInterrupt && (
            <div className="interrupt-toast">
              <span className="interrupt-toast-label">Generation in progress. What do you want to do?</span>
              <div className="interrupt-toast-actions">
                <button
                  className="interrupt-toast-btn interrupt-toast-btn-stop"
                  onClick={() => {
                    setPendingInterrupt(prev => prev ? { ...prev, mode: 'stop-run' } : null)
                    onCancel()
                  }}
                  title="Stop current generation and run new prompt"
                >
                  Stop &amp; Run
                </button>
                <button
                  className="interrupt-toast-btn interrupt-toast-btn-queue"
                  onClick={() => {
                    setQueuedPrompt(pendingInterrupt.text, pendingInterrupt.attachments)
                    setPendingInterrupt(null)
                    setInput('')
                    setAttachments([])
                  }}
                  title="Run after current generation finishes"
                >
                  Run after
                </button>
                <button
                  className="interrupt-toast-btn interrupt-toast-btn-dismiss"
                  onClick={() => setPendingInterrupt(null)}
                  title="Dismiss"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
          <div className="chat-composer-top">
          <textarea
            ref={el => { textareaRef.current = el }}
            className="chat-input"
            placeholder="Send message to Betopia Web Builder"
            value={input}
            onChange={e => handleComposerChange(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            onInput={onInput}
            onPaste={handlePaste}
            onFocus={() => setShowSuggestions(visibleMessages.length === 0 && !input)}
            rows={1}
          />

          <div className="chat-composer-bottom">
            <div className="chat-quick-actions" ref={composerMenuRef}>
                <div className="chat-upload-wrap" ref={uploadMenuRef}>
                <button
                  ref={uploadBtnRef}
                  className={'chat-upload-btn' + (showUploadMenu ? ' active' : '')}
                  onClick={() => {
                    setOpenComposerMenu(null)
                    setUploadSubmenu(null)
                    setShowComposerOverflow(false)
                    if (uploadBtnRef.current) {
                      const r = uploadBtnRef.current.getBoundingClientRect()
                      // Position menu above-left of the button
                      setMenuPos({ top: r.top - 8, left: r.left })
                    }
                    setShowUploadMenu(prev => !prev)
                  }}
                  title="Open quick tools"
                  aria-label="Open quick tools"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </button>
                {showUploadMenu && menuPos && (
                  <div
                    className="chat-upload-menu"
                    style={{
                      position: 'fixed',
                      top: menuPos.top,
                      left: menuPos.left,
                      transform: 'translateY(-100%)',
                    }}
                  >
                    <div
                      className="chat-upload-menu-item"
                      style={{ position: 'relative', cursor: isAgentBusy ? 'not-allowed' : 'pointer' }}
                    >
                      <span className="chat-upload-menu-item-main">
                        <span className="chat-upload-menu-icon">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.2a4 4 0 0 1 5.66 5.66l-9.2 9.2a2 2 0 1 1-2.83-2.84l8.49-8.48" />
                          </svg>
                        </span>
                        <span>Add files or photos</span>
                      </span>
                      {!isAgentBusy && (
                        <input
                          type="file"
                          multiple
                          accept="image/*,.pdf,.doc,.docx,.txt,.md,.csv,.json"
                          style={{ position: 'absolute', inset: 0, opacity: 0.001, cursor: 'pointer', width: '100%', height: '100%' }}
                          onChange={(e) => {
                            setShowUploadMenu(false)
                            setOpenComposerMenu(null)
                            setOpenSubmenu(null)
                            setUploadSubmenu(null)
                            if (e.target.files) handleFileSelect(e.target.files)
                            e.target.value = ''
                          }}
                        />
                      )}
                    </div>
                    <button className="chat-upload-menu-item" onClick={openFolderPicker}>
                      <span className="chat-upload-menu-item-main">
                        <span className="chat-upload-menu-icon">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                            <path d="M12 11v6" />
                            <path d="M9 14h6" />
                          </svg>
                        </span>
                        <span>Add folder</span>
                      </span>
                    </button>
                    <div className="chat-upload-menu-sep" />

                    <div className="chat-upload-submenu-wrap">
                      <button
                        className="chat-upload-menu-item"
                        onClick={() => setUploadSubmenu(prev => prev === 'skills' ? null : 'skills')}
                        onMouseEnter={() => setUploadSubmenu('skills')}
                        title="Skills"
                      >
                        <span className="chat-upload-menu-item-main">
                          <span className="chat-upload-menu-icon">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14.5 4a2.5 2.5 0 0 1 3.54 3.54L7.5 18.1 4 19l.9-3.5L14.5 4z" />
                            </svg>
                          </span>
                          <span>Skills</span>
                        </span>
                        <span className="chat-upload-menu-chevron">›</span>
                      </button>
                      {uploadSubmenu === 'skills' && (
                        <div className="chat-upload-submenu">
                          <button className="chat-upload-menu-item" onClick={() => injectSnippet('Use UI skill and improve spacing, hierarchy, and responsiveness.')}>
                            <span className="chat-upload-menu-item-main"><span>UI Skill</span></span>
                          </button>
                          <button className="chat-upload-menu-item" onClick={() => injectSnippet('Use Debug skill and fix all runtime and build issues.')}>
                            <span className="chat-upload-menu-item-main"><span>Debug Skill</span></span>
                          </button>
                          <button className="chat-upload-menu-item" onClick={() => injectSnippet('Use Deployment skill and prepare publish-ready build.')}>
                            <span className="chat-upload-menu-item-main"><span>Deploy Skill</span></span>
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="chat-upload-submenu-wrap">
                      <button
                        className="chat-upload-menu-item"
                        onClick={() => setUploadSubmenu(prev => prev === 'connectors' ? null : 'connectors')}
                        onMouseEnter={() => setUploadSubmenu('connectors')}
                        title="Connectors"
                      >
                        <span className="chat-upload-menu-item-main">
                          <span className="chat-upload-menu-icon">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M7 7h.01" />
                              <path d="M3 7a4 4 0 0 1 4-4h4" />
                              <path d="M13 3h4a4 4 0 0 1 4 4v4" />
                              <path d="M21 13v4a4 4 0 0 1-4 4h-4" />
                              <path d="M11 21H7a4 4 0 0 1-4-4v-4" />
                              <path d="M10 14a4 4 0 0 0 4-4V8" />
                            </svg>
                          </span>
                          <span>Connectors</span>
                        </span>
                        <span className="chat-upload-menu-chevron">›</span>
                      </button>
                      {uploadSubmenu === 'connectors' && (
                        <div className="chat-upload-submenu">
                          <button
                            className="chat-upload-subtoggle-row"
                            onClick={() => setConnectorClaudeEnabled(v => !v)}
                            aria-pressed={connectorClaudeEnabled}
                          >
                            <span className="chat-upload-subtoggle-left">
                              <span className="chat-upload-subtoggle-icon">◉</span>
                              <span>Claude in Chrome</span>
                            </span>
                            <span className={'chat-upload-subtoggle-switch' + (connectorClaudeEnabled ? ' on' : '')} />
                          </button>
                          <button
                            className="chat-upload-subtoggle-row"
                            onClick={() => setConnectorDesktopEnabled(v => !v)}
                            aria-pressed={connectorDesktopEnabled}
                          >
                            <span className="chat-upload-subtoggle-left">
                              <span className="chat-upload-subtoggle-icon">⌘</span>
                              <span>Desktop Commander</span>
                            </span>
                            <span className={'chat-upload-subtoggle-switch' + (connectorDesktopEnabled ? ' on' : '')} />
                          </button>
                          <div className="chat-upload-menu-sep" />
                          <button className="chat-upload-menu-item" onClick={() => injectSnippet('Open connector manager and configure integrations.')}>
                            <span className="chat-upload-menu-item-main"><span>Manage connectors</span></span>
                          </button>
                          <button className="chat-upload-menu-item" onClick={() => injectSnippet('Add connector for this project workflow.')}>
                            <span className="chat-upload-menu-item-main"><span>Add connector</span></span>
                          </button>
                        </div>
                      )}
                    </div>

                    <button className="chat-upload-menu-item" onClick={() => injectSnippet('Add plugins for this workspace and enable the required integrations.')}>
                      <span className="chat-upload-menu-item-main">
                        <span className="chat-upload-menu-icon">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2v6" />
                            <path d="m8 6 4-4 4 4" />
                            <path d="M5 10v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
                            <path d="M8 14h8" />
                          </svg>
                        </span>
                        <span>Add plugins...</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>

              {/* Computer dropdown — anchored to pill position below */}
              <ChatFooterMenus
                isAgentBusy={isAgentBusy}
                onInsertSnippet={injectSnippet}
                onBeforeToggle={closeMonitorPanel}
              />
              <AgentSwitcher />

              {/* Combined pill: Permission + Computer + Context */}
              <ToolbarPill
                permissionMode={permissionMode}
                onPermissionChange={onPermissionModeChange}
                tokenEstimate={tokenEstimate}
                ctxPct={ctxPct}
                ctxColor={ctxColor}
                ctxLimit={CTX_LIMIT}
                isAgentBusy={isAgentBusy}
                onComputerClick={() => toggleComposerMenu('computer')}
                computerActive={openComposerMenu === 'computer'}
                onBeforeToggle={closeMonitorPanel}
                onCompact={onCompact}
                isCompacting={isCompacting}
                agentUsage={agentUsage}
                computerDropdown={openComposerMenu === 'computer' ? (
                  <div className="chat-mini-dropdown chat-mini-dropdown-computer" style={{ left: 'auto', right: 0 }}>
                    <button className="chat-mini-item" onClick={openFolderPicker}>
                      <span className="chat-mini-item-left">
                        <span className="chat-mini-leading-icon" aria-hidden="true">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 5v14" /><path d="M5 12h14" />
                          </svg>
                        </span>
                        Add local folder
                      </span>
                    </button>
                    <div className="chat-mini-sep" />
                    <div className="chat-cloud-card">
                      <div className="chat-cloud-card-left">
                        <div className="chat-cloud-card-icon" aria-hidden="true">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" />
                          </svg>
                        </div>
                        <div className="chat-cloud-card-text">
                          <div className="chat-cloud-title">Cloud computer</div>
                          <div className="chat-cloud-subtitle">An always-on workspace for your agent to work 24/7.</div>
                        </div>
                      </div>
                      <button className="chat-cloud-create-btn" onClick={() => injectSnippet('Create a cloud computer workspace and continue this task there.')}>Create</button>
                    </div>
                  </div>
                ) : null}
              />
            </div>
            <div className="chat-right-actions">
              {isCompactComposer && (
                <div className="chat-composer-overflow-wrap" ref={composerOverflowRef}>
                  <button
                    ref={overflowBtnRef}
                    className={'chat-composer-overflow-btn' + (showComposerOverflow ? ' active' : '')}
                    onClick={toggleComposerOverflow}
                    disabled={isAgentBusy}
                    title="More composer options"
                    aria-label="More composer options"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.8" />
                      <circle cx="12" cy="12" r="1.8" />
                      <circle cx="19" cy="12" r="1.8" />
                    </svg>
                  </button>
                  {showComposerOverflow && overflowMenuPos && createPortal(
                    <div className="chat-composer-overflow-menu" style={{ position: 'fixed', bottom: overflowMenuPos.bottom, left: overflowMenuPos.left, top: 'auto', right: 'auto', zIndex: 4000 }}>
                      <div className="chat-composer-overflow-section">
                        <div className="chat-composer-overflow-label">Model</div>
                        <ChatFooterMenus
                          isAgentBusy={isAgentBusy}
                          onInsertSnippet={injectSnippet}
                          onBeforeToggle={closeMonitorPanel}
                          openDown
                        />
                      </div>
                      <div className="chat-composer-overflow-section">
                        <div className="chat-composer-overflow-label">Agent</div>
                        <AgentSwitcher openDown />
                      </div>
                      <div className="chat-composer-overflow-section">
                        <div className="chat-composer-overflow-label">Workspace</div>
                        <ToolbarPill
                          permissionMode={permissionMode}
                          onPermissionChange={onPermissionModeChange}
                          tokenEstimate={tokenEstimate}
                          ctxPct={ctxPct}
                          ctxColor={ctxColor}
                          ctxLimit={CTX_LIMIT}
                          isAgentBusy={isAgentBusy}
                          onComputerClick={() => toggleComposerMenu('computer')}
                          computerActive={openComposerMenu === 'computer'}
                          onBeforeToggle={closeMonitorPanel}
                          agentUsage={agentUsage}
                          openDown
                          computerDropdown={openComposerMenu === 'computer' ? (
                            <div className="chat-mini-dropdown chat-mini-dropdown-computer" style={{ left: 'auto', right: 0 }}>
                              <button className="chat-mini-item" onClick={openFilePicker}>
                                <span className="chat-mini-item-left">
                                  <span className="chat-mini-leading-icon" aria-hidden="true">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M12 5v14" /><path d="M5 12h14" />
                                    </svg>
                                  </span>
                                  Add local folder
                                </span>
                              </button>
                              <div className="chat-mini-sep" />
                              <div className="chat-cloud-card">
                                <div className="chat-cloud-card-left">
                                  <div className="chat-cloud-card-icon" aria-hidden="true">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" />
                                    </svg>
                                  </div>
                                  <div className="chat-cloud-card-text">
                                    <div className="chat-cloud-title">Cloud computer</div>
                                    <div className="chat-cloud-subtitle">An always-on workspace for your agent to work 24/7.</div>
                                  </div>
                                </div>
                                <button className="chat-cloud-create-btn" onClick={() => injectSnippet('Create a cloud computer workspace and continue this task there.')}>Create</button>
                              </div>
                            </div>
                          ) : null}
                        />
                      </div>
                    </div>,
                    document.body
                  )}
                </div>
              )}
          {isAgentBusy ? (
            <button className="send-btn stop" onClick={onCancel} title="Stop generation" aria-label="Stop">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className={'send-btn' + (canSend ? ' ready' : '')}
              onClick={submit}
              disabled={!canSend}
              title="Send message (Enter)"
              aria-label="Send"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  )
}
