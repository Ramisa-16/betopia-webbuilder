import React, { useState, useRef, useEffect, useMemo, KeyboardEvent, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { Message, Attachment, PlanData } from '@/types'
import MessageBubble from './MessageBubble'
import PlanPanel from './PlanPanel'
import TaskSummaryPanel from './TaskSummaryPanel'
import PermissionDialog from '@/modules/workspace/components/PermissionDialog'
import { getConfig, saveConfig, getModelInfo, type CustomSubagentDef } from '@/lib/config'
import { useConfig, useBetopiaModels } from '@/lib/useConfig'
import { getProvider, normalizeBetopiaModelId } from '@/lib/providers'
import { SnippetPicker, getSnippetQuery } from '@/modules/ai/components/SnippetPicker'
import type { FileEntry } from '@/types'
import { flattenFiles } from '@/lib/project-scaffold'
import { fuzzyFilter } from '@/lib/fuzzy'
import { getFileIcon } from '@/lib/file-icons'
import { useSessionStore } from '@/store/sessionStore'
import { useAgentsStore } from '@/store/agentsStore'
import { BUILTIN_AGENTS } from '@/lib/agents'
import { useChatStore } from '@/store/chatStore'
import { estimateMessagesTokens } from '@/lib/tokenCounter'
import { allSlashOptions, CAVEMAN_CLIENT_COMMAND, isCustomSkillPath, type SlashSkillOption } from '@/lib/builtin-skills'
import { buildSkillPrompt, buildSkillVisibleText, resolveSkillDirective } from '@/lib/skill-routing'
import { resolveTypedCavemanSubmitAction } from '@/lib/caveman-command'
import SkillIcon from './SkillIcon'
import { loadCustomSkillsForSettings, type Skill } from '@/lib/agent'
import { SKILLS_CHANGED_EVENT } from '@/lib/skill-events'
import { getRecentProjectPaths } from '@/lib/recent-projects'
import { materializeUiUxProMaxSkill } from '@/lib/ui-ux-pro-max/materialize'
import { getScrollbackLines } from '@/modules/settings/generalPrefs'
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

type PermissionMode = 'default' | 'auto_review' | 'plan_mode' | 'full_access'
type EffortLevel = 'low' | 'medium' | 'high'

const SUGGESTIONS = [
  { icon: '⚛', title: 'React + Django', desc: 'Build a full-stack app with React frontend and Django backend' },
  { icon: '📊', title: 'Admin Dashboard', desc: 'Create a dashboard UI in React with Django APIs' },
  { icon: '🛍', title: 'E-Commerce Store', desc: 'Create a React storefront powered by Django' },
  { icon: '✍', title: 'Blog Platform', desc: 'Build a blog with React pages and Django admin' },
  { icon: '🔐', title: 'Auth Portal', desc: 'Create login, signup, and protected routes with Django auth' },
  { icon: '🧩', title: 'Custom Stack', desc: 'Build the exact React + Django app I need' },
]

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

function TaskDoneBar({ durationMs, inputTokens, outputTokens, interrupted, isError, onDismiss }: {
  durationMs: number; inputTokens: number; outputTokens: number; interrupted?: boolean; isError?: boolean; onDismiss: () => void
}) {
  const parts: string[] = [formatDuration(durationMs)]
  if (!interrupted && !isError) {
    if (inputTokens > 0) parts.push(`↑ ${formatTokensBar(inputTokens)}`)
    if (outputTokens > 0) parts.push(`↓ ${formatTokensBar(outputTokens)}`)
  }
  return (
    <div className="agent-task-done" style={isError ? { borderColor: 'var(--red, #e55)', background: 'color-mix(in srgb, var(--red, #e55) 10%, transparent)' } : undefined}>
      {isError ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="agent-task-done-icon" style={{ color: 'var(--red, #e55)' }}>
          <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      ) : interrupted ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="agent-task-done-icon" style={{ color: 'var(--text-3)' }}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="agent-task-done-icon">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      <span className="agent-task-done-label" style={isError ? { color: 'var(--red, #e55)' } : interrupted ? { color: 'var(--text-3)' } : undefined}>
        {isError ? 'Error' : interrupted ? 'Interrupted' : 'Task complete'}
      </span>
      <span className="agent-task-done-meta">{parts.join(' · ')}</span>
      <button className="agent-task-done-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  )
}

// ── Combined toolbar pill ─────────────────────────────────────────────────────

interface ModeOption { id: PermissionMode; label: string; shortLabel: string; desc: string; icon: JSX.Element }

const MODES: ModeOption[] = [
  {
    id: 'default',
    label: 'Ask before edits',
    shortLabel: 'Ask before edits',
    desc: 'Claude will ask for approval before making each edit',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 11V9a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
        <path d="M14 10V8a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
        <path d="M10 9.5V5a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v9" />
        <path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
      </svg>
    ),
  },
  {
    id: 'auto_review',
    label: 'Edit automatically',
    shortLabel: 'Edit automatically',
    desc: 'Claude will edit your selected text or the whole file',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
        <line x1="12" y1="2" x2="12" y2="22" />
      </svg>
    ),
  },
  {
    id: 'plan_mode',
    label: 'Plan mode',
    shortLabel: 'Plan mode',
    desc: 'Claude will explore the code and present a plan before editing',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="7" y1="8" x2="17" y2="8" />
        <line x1="7" y1="12" x2="17" y2="12" />
        <line x1="7" y1="16" x2="13" y2="16" />
      </svg>
    ),
  },
  {
    id: 'full_access',
    label: 'Auto mode',
    shortLabel: 'Auto mode',
    desc: 'Claude will automatically choose the best permission mode for each task',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
  },
]

const PERM_COLOR: Record<PermissionMode, string> = {
  default:     'var(--text-2)',
  auto_review: '#60a5fa',
  plan_mode:   '#a78bfa',
  full_access: '#34d399',
}

const DROPDOWN_WIDTH = 320

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
  const usedTokens = tokenEstimate
  const pct = ctxPct
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
              <span className="ctx-row-label">Current context</span>
              <span className="ctx-row-val">{fmtTokens(usedTokens)}</span>
            </div>
            {agentUsage.lastInputTokens > 0 && (
              <div className="ctx-window-row">
                <span className="ctx-row-label">Last request</span>
                <span className="ctx-row-val">{fmtTokens(agentUsage.lastInputTokens)}</span>
              </div>
            )}
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
            <span className="ctx-window-note">Current context reflects what will be sent on the next run.</span>
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

function PermDropdown({
  permissionMode, onPermissionChange,
  effortLevel, onEffortChange,
  dropRef, openDown,
  pos,
  onClose,
}: {
  permissionMode: PermissionMode; onPermissionChange: (m: PermissionMode) => void
  effortLevel: EffortLevel; onEffortChange: (l: EffortLevel) => void
  dropRef: React.RefObject<HTMLDivElement>
  openDown: boolean
  pos: { top: number; left: number }
  onClose: () => void
}) {
  const customAgents = useAgentsStore(s => s.customAgents)
  const activeAgentId = useAgentsStore(s => s.activeId)
  const agentName = useMemo(() => {
    const all = [...BUILTIN_AGENTS, ...customAgents]
    return all.find(a => a.id === activeAgentId)?.name ?? 'Claude'
  }, [customAgents, activeAgentId])

  const modeDescs: Record<PermissionMode, string> = useMemo(() => ({
    default:     `${agentName} will ask for approval before making each edit`,
    auto_review: `${agentName} will edit your selected text or the whole file`,
    plan_mode:   `${agentName} will explore the code and present a plan before editing`,
    full_access: `${agentName} will automatically choose the best permission mode for each task`,
  }), [agentName])

  const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high']
  const cycleEffort = () => {
    const idx = EFFORT_ORDER.indexOf(effortLevel)
    onEffortChange(EFFORT_ORDER[(idx + 1) % EFFORT_ORDER.length])
  }

  const content = (
    <div
      ref={dropRef}
      className="perm-dropdown"
      style={openDown ? undefined : { position: 'fixed', top: pos.top, left: pos.left, transform: 'translateY(-100%)', width: DROPDOWN_WIDTH }}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if (e.key === 'Tab') {
          e.preventDefault()
          const all: PermissionMode[] = ['default', 'auto_review', 'plan_mode', 'full_access']
          const idx = all.indexOf(permissionMode)
          const next = e.shiftKey ? all[(idx - 1 + all.length) % all.length] : all[(idx + 1) % all.length]
          onPermissionChange(next)
        }
      }}
    >
      {/* Header */}
      <div className="perm-dropdown-header">
        <span className="perm-dropdown-title">Modes</span>
        <span className="perm-dropdown-kb-hint">
          <kbd className="perm-kbd">↑</kbd>
          <span className="perm-kbd-plus">+</span>
          <kbd className="perm-kbd">tab</kbd>
          <span className="perm-kbd-label">to switch</span>
        </span>
      </div>

      {/* Mode rows */}
      {MODES.map(m => (
        <button
          key={m.id}
          className={'perm-mode-row' + (permissionMode === m.id ? ' active' : '')}
          onClick={() => { onPermissionChange(m.id); onClose() }}
        >
          <span className="perm-mode-icon" style={{ color: PERM_COLOR[m.id] }}>{m.icon}</span>
          <span className="perm-mode-body">
            <span className="perm-mode-name">{m.label}</span>
            <span className="perm-mode-desc">{modeDescs[m.id]}</span>
          </span>
          {permissionMode === m.id && (
            <svg className="perm-mode-check" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <polyline points="2,7 5.5,10.5 12,3.5" />
            </svg>
          )}
        </button>
      ))}

      <div className="perm-sep" />

      {/* Effort row */}
      <button className="perm-effort-row" onClick={cycleEffort}>
        <span className="perm-mode-icon" style={{ color: 'var(--text-3)' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
        </span>
        <span className="perm-effort-label">
          Effort <span className="perm-effort-level">({effortLevel.charAt(0).toUpperCase() + effortLevel.slice(1)})</span>
        </span>
        <span className={'perm-effort-toggle' + (effortLevel === 'high' ? ' on' : effortLevel === 'medium' ? ' mid' : '')}>
          <span className="perm-effort-thumb" />
        </span>
      </button>
    </div>
  )

  return openDown ? content : createPortal(content, document.body)
}

function ToolbarPill({
  permissionMode, onPermissionChange,
  effortLevel, onEffortChange,
  tokenEstimate, ctxPct, ctxColor, ctxLimit,
  isAgentBusy, onComputerClick, computerActive, onBeforeToggle,
  computerDropdown, openDown = false, onCompact, isCompacting, agentUsage,
}: {
  permissionMode: PermissionMode; onPermissionChange: (m: PermissionMode) => void
  effortLevel: EffortLevel; onEffortChange: (l: EffortLevel) => void
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

  const activeMode = MODES.find(m => m.id === permissionMode) ?? MODES[0]

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

  if (openDown) {
    return (
      <div className="toolbar-pill-inline" ref={ref}>
        <PermDropdown
          permissionMode={permissionMode}
          onPermissionChange={onPermissionChange}
          effortLevel={effortLevel}
          onEffortChange={onEffortChange}
          dropRef={dropRef}
          openDown
          pos={pos}
          onClose={() => setOpen(false)}
        />
      </div>
    )
  }

  return (
    <div className="toolbar-pill" ref={ref}>
      {/* Permission button — shows mode name */}
      <button
        ref={btnRef}
        className={'toolbar-pill-btn perm-pill-btn' + (open ? ' active' : '')}
        style={{ color: PERM_COLOR[permissionMode] }}
        title={activeMode.label}
        onClick={() => { onBeforeToggle?.(); setOpen(o => !o) }}
      >
        <span className="perm-pill-icon">{activeMode.icon}</span>
        <span className="perm-pill-label">{activeMode.shortLabel}</span>
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

      {open && (
        <PermDropdown
          permissionMode={permissionMode}
          onPermissionChange={onPermissionChange}
          effortLevel={effortLevel}
          onEffortChange={onEffortChange}
          dropRef={dropRef}
          openDown={false}
          pos={pos}
          onClose={() => setOpen(false)}
        />
      )}
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
  const allModels = cfg.model.providerId === 'betopia'
    ? betopiaModels
    : (provider?.models ?? [])
  const filteredModels = allModels.filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.id.toLowerCase().includes(search.toLowerCase()),
  )
  const currentModel = allModels.find(m =>
    normalizeBetopiaModelId(m.id, m.name, m.providerId ?? '').toLowerCase() === normalizeBetopiaModelId(cfg.model.model, cfg.model.model, 'betopia').toLowerCase() ||
    normalizeBetopiaModelId(m.name, m.name, m.providerId ?? '').toLowerCase() === normalizeBetopiaModelId(cfg.model.model, cfg.model.model, 'betopia').toLowerCase()
  )
  const currentModelName = currentModel?.name || cfg.model.model || 'Model'

  const switchModel = (modelId: string) => {
    const selected = allModels.find(model =>
      normalizeBetopiaModelId(model.id, model.name, model.providerId ?? '').toLowerCase() === normalizeBetopiaModelId(modelId, modelId, cfg.model.providerId).toLowerCase() ||
      normalizeBetopiaModelId(model.name, model.name, model.providerId ?? '').toLowerCase() === normalizeBetopiaModelId(modelId, modelId, cfg.model.providerId).toLowerCase()
    )
    const next = {
      ...cfg,
      model: {
        ...cfg.model,
        model: selected?.id ?? modelId,
        providerId: cfg.model.providerId,
        customBaseUrl: cfg.model.customBaseUrl,
      },
    }
    setCfg(next)
    setOpenMenu(null)
  }

  const modelListContent = (
    <div className="chat-footer-model-list">
      {filteredModels.map(model => (
        <button
          key={model.id}
          className={'chat-footer-dropdown-item' + (
            normalizeBetopiaModelId(cfg.model.model, cfg.model.model, 'betopia').toLowerCase() === normalizeBetopiaModelId(model.id, model.name, model.providerId ?? '').toLowerCase()
              ? ' selected'
              : ''
          )}
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

interface FileReferenceRequest {
  id: string | number
  path: string
}

interface Props {
  messages: Message[]
  agentContextMessages?: Message[]
  isAgentBusy: boolean
  currentTool?: string | null
  onSend: (text: string, attachments?: Attachment[], options?: { agentPrompt?: string }) => void
  onCancel: () => void
  onHide?: () => void
  onCompact?: () => void
  isCompacting?: boolean
  permissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  effortLevel: EffortLevel
  onEffortChange: (l: EffortLevel) => void
  agentMode?: 'backend' | 'inline'
  projectPath?: string | null
  files?: FileEntry[]
  pendingFileReference?: FileReferenceRequest | null
  onApprovalResponse?: (id: string, approved: boolean, content?: string) => void
  permissionRequest?: { tool: string; args: string } | null
  onPermissionAllow?: () => void
  onPermissionDeny?: () => void
  onPermissionAutoMode?: () => void
  modeSwitchRequest?: { reason: string; suggestedMode: PermissionMode } | null
  onModeSwitchChoice?: (nextMode?: PermissionMode) => void
}

function buildSessionTree(sessions: Array<{ id: string; parentId?: string; title: string; messages: { role: string }[]; createdAt: number; updatedAt: number }>): Array<{ session: typeof sessions[number]; depth: number; isLast: boolean }> {
  const childrenOf = new Map<string, typeof sessions>()
  const roots: typeof sessions = []
  for (const s of sessions) {
    if (s.parentId && sessions.find(p => p.id === s.parentId)) {
      const list = childrenOf.get(s.parentId) ?? []
      list.push(s)
      childrenOf.set(s.parentId, list)
    } else {
      roots.push(s)
    }
  }
  const result: Array<{ session: typeof sessions[number]; depth: number; isLast: boolean }> = []
  function walk(list: typeof sessions, depth: number) {
    list.forEach((s, i) => {
      const children = childrenOf.get(s.id) ?? []
      result.push({ session: s, depth, isLast: i === list.length - 1 && children.length === 0 })
      if (children.length) walk(children, depth + 1)
    })
  }
  walk(roots, 0)
  return result
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Current "@token" before the caret (for @file mention), or null.
function getAtQuery(value: string, pos: number): string | null {
  const m = value.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/)
  return m ? m[1] : null
}

function extractMessageText(message: Message): string {
  return message.parts
    .filter(p => p.type === 'text')
    .map(p => (p.data as { text?: string }).text ?? '')
    .filter(Boolean)
    .join('\n')
}

function looksLikeTaskSummary(text: string): boolean {
  return /(what changed|files updated|files history|verification|result)\s*:/i.test(text)
}

export default function ChatPanel({
  messages,
  agentContextMessages,
  isAgentBusy,
  currentTool,
  onSend,
  onCancel,
  onHide,
  onCompact,
  isCompacting = false,
  permissionMode,
  onPermissionModeChange,
  effortLevel,
  onEffortChange,
  projectPath,
  files = [],
  pendingFileReference,
  onApprovalResponse,
  permissionRequest,
  onPermissionAllow,
  onPermissionDeny,
  onPermissionAutoMode,
  modeSwitchRequest,
  onModeSwitchChoice,
}: Props) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [snippetQuery, setSnippetQuery] = useState<string | null>(null)
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const atFiles = useMemo(() => flattenFiles(files).filter(f => !f.is_dir), [files])
  const atResults = useMemo(
    () => atQuery === null ? [] : fuzzyFilter(atQuery, atFiles, f => [f.name, f.path]).slice(0, 8),
    [atQuery, atFiles],
  )
  const [isCompactComposer, setIsCompactComposer] = useState(false)
  const [pendingInterrupt, setPendingInterrupt] = useState<{ text: string; attachments: Attachment[]; mode: 'idle' | 'stop-run'; agentPrompt?: string } | null>(null)
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [slashActiveIdx, setSlashActiveIdx] = useState(0)
  const [customSkills, setCustomSkills] = useState<Skill[]>([])
  const [customSubagents, setCustomSubagents] = useState<CustomSubagentDef[]>(() => getConfig().customSubagents ?? [])
  const [activeSkill, setActiveSkill] = useState<SlashSkillOption | null>(null)
  const [cmdNotes, setCmdNotes] = useState<Array<{ id: string; text: string }>>([])
  const [isSkillInstalling, setIsSkillInstalling] = useState(false)
  const slashPickerRef = useRef<HTMLDivElement>(null)

  const { setQueuedPrompt, agentUsage, taskDone, clearTaskDone } = useChatStore()
  const taskSummaryMessage = useMemo(() => {
    const assistantMessages = messages.filter(m => m.role === 'assistant')
    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      const msg = assistantMessages[i]
      const text = extractMessageText(msg).trim()
      if (text && looksLikeTaskSummary(text)) return { id: msg.id, text }
    }
    return null
  }, [messages])
  const latestAssistantText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue
      const text = extractMessageText(messages[i]).trim()
      if (text) return text
    }
    return ''
  }, [messages])
  const activeSessionCompaction = useSessionStore(
    s => s.sessions.find(sess => sess.id === s.activeId)?.compaction ?? null,
  )

  // Visible context meter intentionally resets after compaction so the bar reflects
  // growth since the last compact, while the compacted summary remains in session memory.
  const meterMessages = useMemo(() => {
    const compactedThroughId = activeSessionCompaction?.compactedThroughMessageId
    if (!compactedThroughId) return agentContextMessages ?? messages
    const compactedIdx = messages.findIndex(m => m.id === compactedThroughId)
    if (compactedIdx === -1) return []
    return messages.slice(compactedIdx + 1)
  }, [activeSessionCompaction, agentContextMessages, messages])
  const tokenEstimate = useMemo(() => estimateMessagesTokens(meterMessages), [meterMessages])
  const [activeCfg] = useConfig()
  const [scrollbackLines, setScrollbackLines] = useState(getScrollbackLines)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const CTX_LIMIT = useMemo(() => getModelInfo().contextLength || 128_000, [activeCfg.model.model, activeCfg.model.providerId])
  const ctxPct = Math.min(1, tokenEstimate / CTX_LIMIT)
  const ctxColor = ctxPct < 0.5 ? 'var(--green)' : ctxPct < 0.75 ? '#fbbf24' : ctxPct < 0.9 ? '#f97316' : 'var(--red)'
  const [openComposerMenu, setOpenComposerMenu] = useState<'add' | 'computer' | null>(null)
  const [openSubmenu, setOpenSubmenu] = useState<'more' | 'skills' | null>(null)
  const [showUploadMenu, setShowUploadMenu] = useState(false)
  const [uploadSubmenu, setUploadSubmenu] = useState<'skills' | null>(null)
  const [showMicMenu, setShowMicMenu] = useState(false)
  const [showComposerOverflow, setShowComposerOverflow] = useState(false)
  const [overflowMenuPos, setOverflowMenuPos] = useState<{ bottom: number; left: number } | null>(null)
  const [selectedMicIndex, setSelectedMicIndex] = useState(0)
  const [holdToRecord, setHoldToRecord] = useState(true)
  const [isMicRecording, setIsMicRecording] = useState(false)
  const [selectedChatContext, setSelectedChatContext] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const uploadBtnRef = useRef<HTMLButtonElement>(null)
  const overflowBtnRef = useRef<HTMLButtonElement>(null)
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const historyRef = useRef<string[]>([])
  const historyIdxRef = useRef(-1)
  const savedInputRef = useRef('')
  const chatPanelRef = useRef<HTMLDivElement>(null)
  const composerMenuRef = useRef<HTMLDivElement>(null)
  const composerOverflowRef = useRef<HTMLDivElement>(null)
  const uploadMenuRef = useRef<HTMLDivElement>(null)
  const micMenuRef = useRef<HTMLDivElement>(null)
  const composerUndoRef = useRef<Array<{
    input: string
    attachments: Attachment[]
    activeSkill: SlashSkillOption | null
    selectedChatContext: string | null
    slashQuery: string | null
    atQuery: string | null
    snippetQuery: string | null
  }>>([])
  const pasteEventSeqRef = useRef(0)
  const composerStateRef = useRef({
    input,
    attachments,
    activeSkill,
    selectedChatContext,
    slashQuery,
    atQuery,
    snippetQuery,
  })
  useEffect(() => {
    composerStateRef.current = {
      input,
      attachments,
      activeSkill,
      selectedChatContext,
      slashQuery,
      atQuery,
      snippetQuery,
    }
  }, [input, attachments, activeSkill, selectedChatContext, slashQuery, atQuery, snippetQuery])
  const visibleMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant')
  const microphoneDevices = [
    'Default - Microphone (3- Logi USB Headset H340)',
    'Communications - Microphone (3- Logi USB Headset H340)',
    'Microphone (3- Logi USB Headset H340) (04...)',
  ]

  const appendAttachment = useCallback((attachment: Attachment) => {
    const state = composerStateRef.current
    composerUndoRef.current.push({
      input: state.input,
      attachments: state.attachments.map(att => ({ ...att })),
      activeSkill: state.activeSkill,
      selectedChatContext: state.selectedChatContext,
      slashQuery: state.slashQuery,
      atQuery: state.atQuery,
      snippetQuery: state.snippetQuery,
    })
    setAttachments(prev => {
      if (attachment.type === 'image' && prev.filter(a => a.type === 'image').length >= MAX_IMAGES) {
        return prev
      }
      return [...prev, attachment]
    })
  }, [])

  const pushComposerUndo = useCallback(() => {
    const state = composerStateRef.current
    composerUndoRef.current.push({
      input: state.input,
      attachments: state.attachments.map(att => ({ ...att })),
      activeSkill: state.activeSkill,
      selectedChatContext: state.selectedChatContext,
      slashQuery: state.slashQuery,
      atQuery: state.atQuery,
      snippetQuery: state.snippetQuery,
    })
    if (composerUndoRef.current.length > 200) composerUndoRef.current.shift()
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

  const [followLatest, setFollowLatest] = useState(true)

  const syncFollowLatest = useCallback(() => {
    const el = messagesScrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setFollowLatest(atBottom)
  }, [])

  const stickToLatest = useCallback(() => {
    const el = messagesScrollRef.current
    if (!el || !followLatest) return
    el.scrollTop = el.scrollHeight
  }, [followLatest])

  useEffect(() => {
    stickToLatest()
  }, [messages, stickToLatest])

  // Load custom skills for slash picker
  useEffect(() => {
    const refreshCustomSkills = () => {
      loadCustomSkillsForSettings(projectPath ?? '', getRecentProjectPaths())
        .then(skills => setCustomSkills(skills.filter(skill => isCustomSkillPath(skill.path))))
        .catch(() => setCustomSkills([]))
    }
    refreshCustomSkills()
    window.addEventListener(SKILLS_CHANGED_EVENT, refreshCustomSkills)
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, refreshCustomSkills)
  }, [projectPath])

  useEffect(() => {
    const syncSubagents = () => setCustomSubagents(getConfig().customSubagents ?? [])
    window.addEventListener('betopia:config-changed', syncSubagents)
    return () => window.removeEventListener('betopia:config-changed', syncSubagents)
  }, [])

  // Tauri native drag-drop: web dataTransfer.files is empty on Linux when
  // Tauri intercepts OS-level drops. Use onDragDropEvent as primary handler.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
      getCurrentWebviewWindow().onDragDropEvent(async (event) => {
        const payload = event.payload as { type: string; paths?: string[]; position?: { x: number; y: number } }
        // Only handle the drop — visual isDragging state is managed by web onDragOver/onDragLeave
        // (those are scoped to the chat div; Tauri events fire for the full window)
        if (payload.type === 'drop' && payload.paths?.length) {
          setIsDragging(false)
          for (const path of payload.paths) {
            await addPathAttachment(path, 'drop')
          }
        }
      }).then(fn => { unlisten = fn }).catch(() => {})
    }).catch(() => {}) // not in Tauri context — silently skip
    return () => { unlisten?.() }
  }, [addPathAttachment])

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
      historyRef.current = (v ? JSON.parse(v) : []).slice(0, scrollbackLines)
    } catch { historyRef.current = [] }
    historyIdxRef.current = -1
  }, [projectPath, scrollbackLines])

  useEffect(() => {
    const handler = () => {
      const next = getScrollbackLines()
      setScrollbackLines(next)
      historyRef.current = historyRef.current.slice(0, next)
      try { localStorage.setItem(`chat.history.${projectPath ?? 'global'}`, JSON.stringify(historyRef.current)) } catch {}
    }
    window.addEventListener('betopia:general-prefs-change', handler)
    return () => window.removeEventListener('betopia:general-prefs-change', handler)
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
    const { text, attachments: atts, agentPrompt } = pendingInterrupt
    setPendingInterrupt(null)
    onSend(text, atts.length > 0 ? atts : undefined, agentPrompt ? { agentPrompt } : undefined)
    setInput('')
    setAttachments([])
    setShowSuggestions(false)
    setShowComposerOverflow(false)
  }, [isAgentBusy, pendingInterrupt, onSend])

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
      const start = ta.selectionStart ?? ta.value.length
      const end = ta.selectionEnd ?? start
      try {
        ta.setSelectionRange(start, end)
      } catch {}
      if (end >= ta.value.length - 1) {
        ta.scrollTop = ta.scrollHeight
      }
    })
  }, [isCompactComposer])

  const keepComposerCaretVisible = useCallback(() => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta || !(ta instanceof HTMLTextAreaElement)) return
      const start = ta.selectionStart ?? ta.value.length
      const end = ta.selectionEnd ?? start
      try {
        ta.setSelectionRange(start, end)
      } catch {}
      if (end >= ta.value.length - 1) {
        ta.scrollTop = ta.scrollHeight
      }
    })
  }, [])

  const restoreComposerState = useCallback((state: {
    input: string
    attachments: Attachment[]
    activeSkill: SlashSkillOption | null
    selectedChatContext: string | null
    slashQuery: string | null
    atQuery: string | null
    snippetQuery: string | null
  }) => {
    setInput(state.input)
    setAttachments(state.attachments)
    setActiveSkill(state.activeSkill)
    setSelectedChatContext(state.selectedChatContext)
    setSlashQuery(state.slashQuery)
    setAtQuery(state.atQuery)
    setSnippetQuery(state.snippetQuery)
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (!t) return
      t.focus()
      const pos = state.input.length
      try { t.selectionStart = t.selectionEnd = pos } catch {}
      resizeInput()
      keepComposerCaretVisible()
    })
  }, [keepComposerCaretVisible, resizeInput])

  const addSelectionToChat = useCallback((text: string) => {
    const snippet = text.trim()
    if (!snippet) return
    pushComposerUndo()
    setSelectedChatContext(snippet)
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (!t) return
      t.focus()
      try { t.selectionStart = t.selectionEnd = t.value.length } catch {}
      resizeInput()
      keepComposerCaretVisible()
    })
  }, [pushComposerUndo, keepComposerCaretVisible, resizeInput])

  useEffect(() => {
    if (!pendingFileReference?.path) return
    const normalized = pendingFileReference.path.replace(/\\/g, '/').replace(/^\/+/, '')
    const token = `@file(${normalized})`
    const tokenPattern = new RegExp(`(^|\\s)${escapeRegex(token)}(\\s|$)`)

    pushComposerUndo()
    setInput(prev => {
      if (tokenPattern.test(prev)) return prev
      const separator = prev.trim().length === 0 ? '' : (prev.endsWith('\n') || prev.endsWith(' ') ? '' : '\n')
      return `${prev}${separator}${token}`
    })

    setShowSuggestions(false)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      resizeInput()
      keepComposerCaretVisible()
    })
  }, [pendingFileReference, keepComposerCaretVisible, resizeInput])

  const submit = async () => {
    if (isSkillInstalling) return
    const text = input.trim()
    const contextText = selectedChatContext?.trim() ?? ''
    if (!text && attachments.length === 0 && !activeSkill && !contextText) return
    const selectedContextPrompt = contextText ? `Selected context from chat:\n${contextText}\n\n` : ''

    if (activeSkill && activeSkill.slash.toLowerCase() === '/caveman') {
      const cfg = getConfig()
      const cur = cfg.behavior
      const intensity: 'lite' | 'full' | 'ultra' = (cur.cavemanIntensity as 'lite'|'full'|'ultra') ?? 'full'
      saveConfig({ ...cfg, behavior: { ...cur, cavemanEnabled: true, cavemanIntensity: intensity } })
      pushComposerUndo()
      setInput('')
      setAttachments([])
      setSlashQuery(null)
      setActiveSkill(null)
      setSelectedChatContext(null)
      if (textareaRef.current instanceof HTMLTextAreaElement) textareaRef.current.style.height = 'auto'
      const activationMsg = `${selectedContextPrompt}[Skill: Caveman Mode]\n\n${CAVEMAN_CLIENT_COMMAND.activationBody}\n\n---\n/caveman ${intensity}${text ? `\n\n${text}` : ''}`
      if (isAgentBusy) {
        setPendingInterrupt({ text: activationMsg, attachments: [...attachments], mode: 'idle' })
        return
      }
      onSend(activationMsg, attachments.length > 0 ? attachments : undefined)
      return
    }

    if (activeSkill) {
      const visibleText = buildSkillVisibleText(activeSkill, text)
      const agentPrompt = `${selectedContextPrompt}${buildSkillPrompt(activeSkill, text)}`
      if (isAgentBusy) {
        setPendingInterrupt({ text: visibleText, attachments: [...attachments], mode: 'idle', agentPrompt })
        return
      }
      pushComposerUndo()
      setInput('')
      setAttachments([])
      setSlashQuery(null)
      setActiveSkill(null)
      setSelectedChatContext(null)
      if (textareaRef.current instanceof HTMLTextAreaElement) textareaRef.current.style.height = 'auto'
      onSend(visibleText, attachments.length > 0 ? attachments : undefined, { agentPrompt })
      return
    }

    // /caveman — toggle config, then:
    //   ON  → send skill activation context to agent so it reads the mode and confirms in caveman style
    //   OFF → show local note only (no need to involve agent)
    const cfg = getConfig()
    const cur = cfg.behavior
    const cavemanAction = resolveTypedCavemanSubmitAction(
      text,
      isAgentBusy,
      cur.cavemanEnabled,
      (cur.cavemanIntensity as 'lite' | 'full' | 'ultra') ?? 'full',
    )
    if (cavemanAction) {
      const enabled = cavemanAction.enabled
      const intensity = cavemanAction.intensity
      // Save BEFORE onSend so the updated system prompt reaches the agent in this same call
      saveConfig({ ...cfg, behavior: { ...cur, cavemanEnabled: enabled, cavemanIntensity: intensity } })
      pushComposerUndo()
      setInput(''); setAttachments([]); setSlashQuery(null); setActiveSkill(null); setSelectedChatContext(null)
      if (textareaRef.current instanceof HTMLTextAreaElement) textareaRef.current.style.height = 'auto'
      if (!enabled) {
        // Turning OFF — local note only, no agent call needed
        setCmdNotes(prev => [...prev, { id: `cmd-${Date.now()}`, text: '💬 Caveman mode OFF.' }])
        return
      }
      if (cavemanAction.kind === 'queue') {
        setPendingInterrupt({ text: cavemanAction.visibleText, attachments: [], mode: 'idle', agentPrompt: `${selectedContextPrompt}${cavemanAction.agentPrompt}` })
        return
      }
      onSend(cavemanAction.visibleText, undefined, { agentPrompt: `${selectedContextPrompt}${cavemanAction.agentPrompt}` })
      return
    }

    // Resolve typed slash skills before the busy gate so queued execution keeps
    // the visible label and hidden expanded skill prompt together.
    // Other /skill-name slash commands — inject full skill body when available.
    const route = resolveSkillDirective(text, slashOptions)
    if (route) {
      let skillInstallNote = ''
      if (route.source === 'explicit' && route.option.slash.toLowerCase() === '/ui-ux') {
        if (projectPath) {
          setIsSkillInstalling(true)
          try {
            const result = await materializeUiUxProMaxSkill(projectPath)
            skillInstallNote = `[Betopia installed UI/UX Pro Max data pack at ${result.path}. Version: ${result.version}. Files: ${result.fileCount}. Status: ${result.installed ? 'installed/refreshed' : 'already current'}.]`
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            skillInstallNote = `[Betopia could not install the UI/UX Pro Max data pack. Error: ${message}. Continue with the embedded skill instructions, but tell the user the data-driven runtime is unavailable.]`
            setCmdNotes(prev => [...prev, { id: `cmd-${Date.now()}`, text: `UI/UX Pro Max install failed: ${message}` }])
          } finally {
            setIsSkillInstalling(false)
          }
        } else {
          skillInstallNote = '[Betopia could not install the UI/UX Pro Max data pack because no project is open. Continue with embedded instructions only.]'
        }
      }
      const visibleText = route.visibleText
      const agentPrompt = `${selectedContextPrompt}${skillInstallNote ? buildSkillPrompt(route.option, route.task, skillInstallNote) : route.agentPrompt}`
      if (isAgentBusy) {
        setPendingInterrupt({ text: visibleText, attachments: [...attachments], mode: 'idle', agentPrompt })
        return
      }
      pushComposerUndo()
      setInput('')
      setAttachments([])
      setSlashQuery(null)
      setActiveSkill(null)
      setSelectedChatContext(null)
      if (textareaRef.current instanceof HTMLTextAreaElement) textareaRef.current.style.height = 'auto'
      onSend(visibleText, attachments.length > 0 ? attachments : undefined, { agentPrompt })
      return
    }

    setSlashQuery(null)

    if (isAgentBusy) {
      setPendingInterrupt({ text: text || contextText, attachments: [...attachments], mode: 'idle', agentPrompt: contextText ? `${selectedContextPrompt}${text}`.trim() : undefined })
      return
    }
    if (text) {
      historyRef.current = [text, ...historyRef.current.filter(h => h !== text)].slice(0, scrollbackLines)
      historyIdxRef.current = -1
      savedInputRef.current = ''
      try { localStorage.setItem(`chat.history.${projectPath ?? 'global'}`, JSON.stringify(historyRef.current)) } catch {}
    }
    const effectiveText = text || contextText
    const effectivePrompt = contextText ? `${selectedContextPrompt}${text || contextText}` : undefined
    onSend(effectiveText, attachments.length > 0 ? attachments : undefined, effectivePrompt ? { agentPrompt: effectivePrompt } : undefined)
    pushComposerUndo()
    setInput('')
    setAttachments([])
    setActiveSkill(null)
    setSelectedChatContext(null)
    setShowSuggestions(false)
    setShowComposerOverflow(false)
    if (textareaRef.current instanceof HTMLTextAreaElement) {
      textareaRef.current.style.height = 'auto'
    }
  }
  const canSend = input.trim().length > 0 || attachments.length > 0 || !!activeSkill || !!selectedChatContext

  // RULE: e.preventDefault() must be called SYNCHRONOUSLY — never after an await.
  // If we don't preventDefault, browser handles text paste natively (correct for text).
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    pasteEventSeqRef.current += 1

    // 1. Actual file bytes in clipboard (screenshots, copied files, browser clipboard items).
    const attachmentFiles = Array.from(e.clipboardData?.items ?? [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file && !!resolveAttachmentMimeType(file.name, file.type))

    if (attachmentFiles.length > 0) {
      e.preventDefault()
      attachmentFiles.forEach(file => addBrowserFileAttachment(file, 'paste'))
      return
    }

    const types = Array.from(e.clipboardData?.types ?? [])
    const hasImageType = types.some(type => type.startsWith('image/'))
    if (hasImageType) {
      e.preventDefault()
      void handleSmartPaste()
      return
    }

    // 2. File URI or absolute path pointing to a supported attachment.
    // getData() is synchronous — e.preventDefault() is safe to call on result.
    const uriList  = e.clipboardData?.getData('text/uri-list') ?? ''
    const plain    = e.clipboardData?.getData('text/plain')    ?? ''
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
        if (!attached && plainTrimmed) {
          pushComposerUndo()
          execInsert(plainTrimmed)
        }
      })()
      return
    }

    // 3. Nothing matched → no preventDefault → browser pastes text natively.
  }

  const removeAttachment = (id: string) => {
    pushComposerUndo()
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  // Insert text at cursor preserving the native undo stack.
  // execCommand('insertText') is the only mechanism that adds to undo history in React controlled inputs.
  const execInsert = useCallback((text: string) => {
    const ta = textareaRef.current
    if (!ta) return
    ta.focus()
    if (!document.execCommand('insertText', false, text)) {
      // Fallback for environments where execCommand is unavailable
      const start = ta.selectionStart ?? ta.value.length
      const end   = ta.selectionEnd   ?? ta.value.length
      setInput(ta.value.slice(0, start) + text + ta.value.slice(end))
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + text.length
          resizeInput()
          keepComposerCaretVisible()
        }
      })
    }
  }, [setInput, textareaRef, resizeInput, keepComposerCaretVisible])

  // Shell-based clipboard paste — same native level as drag-drop (bypasses Tauri WebKit sandbox).
  // Used by the custom paste action; Ctrl/Cmd+V is left to the native paste event.
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

      // 1. Detect available types
      const typesResult = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
        command: '(command -v wl-paste >/dev/null 2>&1 && wl-paste --list-types 2>/dev/null) || (command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t TARGETS -o 2>/dev/null)',
        cwd: null,
      })
      const availTypes = typesResult.stdout

      // 2. Image in clipboard (screenshot tool or image viewer "Copy Image")
      const imageType = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']
        .find(type => availTypes.includes(type))
      if (imageType) {
        const ext = imageType.split('/')[1] || 'png'
        const imgResult = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
          command: `(command -v wl-paste >/dev/null 2>&1 && wl-paste -t ${imageType} 2>/dev/null | base64 -w0) || (command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t ${imageType} -o 2>/dev/null | base64 -w0)`,
          cwd: null,
        })
        if (imgResult.exit_code === 0 && imgResult.stdout.trim()) {
          appendAttachment({ id: `paste-${Date.now()}`, type: 'image', name: `pasted-image.${ext}`, data: imgResult.stdout.trim(), mimeType: imageType, size: 0 })
          return
        }
      }

      // 3. text/uri-list (Ctrl+C on file in Nautilus/file manager)
      if (availTypes.includes('text/uri-list')) {
        const uriResult = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
          command: '(command -v wl-paste >/dev/null 2>&1 && wl-paste -t text/uri-list 2>/dev/null) || (command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -t text/uri-list -o 2>/dev/null)',
          cwd: null,
        })
        const uris = uriResult.stdout.split('\n').map(l => l.trim().replace(/\r$/, '')).filter(l => l.startsWith('file://'))
        let attachedFile = false
        for (const uri of uris) {
          const path = decodeURIComponent(uri.slice(7))
          attachedFile = await addPathAttachment(path, 'paste') || attachedFile
        }
        if (attachedFile) return
      }

      // 4. No image — paste as text via shell
      const textResult = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
        command: '(command -v wl-paste >/dev/null 2>&1 && wl-paste --no-newline 2>/dev/null) || (command -v xclip >/dev/null 2>&1 && xclip -selection clipboard -o 2>/dev/null)',
        cwd: null,
      })
      if (textResult.exit_code === 0 && textResult.stdout) { pushComposerUndo(); execInsert(textResult.stdout); return }

    } catch { /* shell unavailable — fall through to web API */ }

    // Web API fallback (works in browser / non-Linux)
    try {
      const text = await navigator.clipboard.readText()
      if (text) { pushComposerUndo(); execInsert(text); return }
    } catch { /* blocked */ }
  }, [appendAttachment, addPathAttachment, execInsert])

  // Right-click context menu "Paste" uses the smart shell/Web API path.
  const handleSmartPaste = handleClipboardPaste

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      const pasteSeq = pasteEventSeqRef.current
      window.setTimeout(() => {
        if (pasteEventSeqRef.current === pasteSeq) void handleSmartPaste()
      }, 180)
      return
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      const prev = composerUndoRef.current.pop()
      if (prev) {
        e.preventDefault()
        restoreComposerState(prev)
      }
      return
    }

    // Slash picker: arrow keys navigate, Enter confirms active, Esc closes
    if (slashQuery !== null && slashResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActiveIdx(i => {
          const next = Math.min(i + 1, slashResults.length - 1)
          // scroll active item into view
          const el = slashPickerRef.current?.querySelectorAll('button')[next] as HTMLElement | undefined
          el?.scrollIntoView({ block: 'nearest' })
          return next
        })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActiveIdx(i => {
          const next = Math.max(i - 1, 0)
          const el = slashPickerRef.current?.querySelectorAll('button')[next] as HTMLElement | undefined
          el?.scrollIntoView({ block: 'nearest' })
          return next
        })
        return
      }
      if (e.key === 'Enter') { e.preventDefault(); activateSlashSkill(slashResults[slashActiveIdx] ?? slashResults[0]); return }
      if (e.key === 'Escape') { e.preventDefault(); setSlashQuery(null); return }
    }

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
        pushComposerUndo()
        setInput(history[next])
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = textareaRef.current.selectionEnd = textareaRef.current.value.length
            resizeInput()
            keepComposerCaretVisible()
          }
        })
      } else if (e.key === 'ArrowDown' && onLastLine && historyIdxRef.current !== -1) {
        e.preventDefault()
        const next = historyIdxRef.current - 1
        historyIdxRef.current = next
        pushComposerUndo()
        setInput(next === -1 ? savedInputRef.current : historyRef.current[next])
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.selectionStart = textareaRef.current.selectionEnd = textareaRef.current.value.length
            resizeInput()
            keepComposerCaretVisible()
          }
        })
      }
    }
  }

  const onInput = () => {
    resizeInput()
    keepComposerCaretVisible()
  }

  const handleComposerChange = (value: string, selectionStart?: number | null) => {
    pushComposerUndo()
    setInput(value)
    const pos = selectionStart ?? value.length
    setSnippetQuery(getSnippetQuery(value, pos))
    setAtQuery(getAtQuery(value, pos))
    // Detect /slash at start of line or after whitespace
    const before = value.slice(0, pos)
    const slashM = before.match(/(^|\s)(\/[\w-]*)$/)
    setSlashQuery(slashM ? slashM[2] : null)
  }

  const slashOptions = useMemo(
    () => allSlashOptions(customSkills, customSubagents),
    [customSkills, customSubagents]
  )

  const slashResults = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    if (q === '/') return slashOptions // show all when just /
    return slashOptions.filter(o => o.slash.toLowerCase().startsWith(q))
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

  // Reset active index when results change
  useEffect(() => { setSlashActiveIdx(0) }, [slashResults])

  const clearCurrentSlashToken = () => {
    const ta = textareaRef.current
    const pos = ta?.selectionStart ?? input.length
    const before = input.slice(0, pos)
    const after = input.slice(pos)
    const replaced = before.replace(/(^|\s)(\/[\w-]*)$/, (_m, lead) => lead)
    pushComposerUndo()
    setInput(`${replaced}${after}`)
    setSlashQuery(null)
    return replaced.length
  }

  const activateSlashSkill = (skill: SlashSkillOption) => {
    const caretPos = clearCurrentSlashToken()
    setActiveSkill(skill)
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (t) {
        t.focus()
        t.selectionStart = t.selectionEnd = caretPos
        resizeInput()
        keepComposerCaretVisible()
      }
    })
  }

  const selectSkillFromMenu = (skill: SlashSkillOption) => {
    pushComposerUndo()
    setShowUploadMenu(false)
    setOpenComposerMenu(null)
    setOpenSubmenu(null)
    setUploadSubmenu(null)
    setSlashQuery(null)
    setActiveSkill(skill)
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (t) {
        t.focus()
        resizeInput()
        keepComposerCaretVisible()
      }
    })
  }

  const insertAtFile = (path: string) => {
    const ta = textareaRef.current
    const pos = ta?.selectionStart ?? input.length
    const before = input.slice(0, pos)
    const after = input.slice(pos)
    const replaced = before.replace(/(^|\s)@[^\s@]*$/, (_m, lead) => `${lead}@${path} `)
    pushComposerUndo()
    setInput(replaced + after)
    setAtQuery(null)
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (t) {
        t.focus()
        t.selectionStart = t.selectionEnd = replaced.length
        resizeInput()
        keepComposerCaretVisible()
      }
    })
  }

  const handleFileSelect = (files: FileList) => {
    for (let i = 0; i < files.length; i++) {
      addBrowserFileAttachment(files[i], 'file')
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragging) setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    if (isAgentBusy) return

    // Normal web drop — File objects present
    if (e.dataTransfer.files?.length > 0) {
      handleFileSelect(e.dataTransfer.files)
      return
    }

    // Tauri/Linux: dataTransfer.files is empty but paths are in text/uri-list
    const uriList = e.dataTransfer.getData('text/uri-list')
    if (!uriList) return
    const paths = uriList.split('\n')
      .map(l => l.trim().replace(/\r$/, ''))
      .filter(l => l && !l.startsWith('#') && l.startsWith('file://'))
      .map(l => decodeURIComponent(l.slice(7)))

    ;(async () => {
      for (const path of paths) {
        await addPathAttachment(path, 'drop')
      }
    })()
  }

  // Just closes the upload menu — the actual file dialog is triggered by <label htmlFor="chat-file-input">
  const openFilePicker = () => {
    if (isAgentBusy) return
    setOpenComposerMenu(null)
    setOpenSubmenu(null)
    setShowUploadMenu(false)
    setUploadSubmenu(null)
  }

  const injectSnippet = (snippet: string) => {
    pushComposerUndo()
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

  const sessions       = useSessionStore(s => s.sessions)
  const activeId       = useSessionStore(s => s.activeId)
  const setActiveId    = useSessionStore(s => s.setActiveId)
  const createSession  = useSessionStore(s => s.createSession)
  const deleteSession  = useSessionStore(s => s.deleteSession)
  const branchSession  = useSessionStore(s => s.branchSession)
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
    <>
    <div className={'chat-panel' + (isCompactComposer ? ' chat-panel--compact' : '')} ref={chatPanelRef}>
      {permissionRequest && onPermissionAllow && onPermissionDeny && onPermissionAutoMode && (
        <PermissionDialog
          tool={permissionRequest.tool}
          args={permissionRequest.args}
          onAllow={onPermissionAllow}
          onDeny={onPermissionDeny}
          onAllowAll={onPermissionAutoMode}
        />
      )}
      {modeSwitchRequest && onModeSwitchChoice && (
        createPortal(
          <div className="perm-overlay" onClick={e => { if (e.target === e.currentTarget) onModeSwitchChoice() }}>
            <div className="perm-dialog" style={{ maxWidth: 560 }}>
              <div className="perm-header">
                <div className="perm-icon-wrap">↔</div>
                <div className="perm-title-area">
                  <div className="perm-title">Switch task mode?</div>
                  <div className="perm-sub">{modeSwitchRequest.reason}</div>
                </div>
              </div>

              <div className="perm-preview">
                <div className="perm-row">
                  <span className="perm-row-label">Current</span>
                  <pre className="perm-row-value">Plan mode</pre>
                </div>
                <div className="perm-row">
                  <span className="perm-row-label">Suggested</span>
                  <pre className="perm-row-value">{modeSwitchRequest.suggestedMode === 'auto_review' ? 'Edit automatically' : 'Auto mode'}</pre>
                </div>
              </div>

              <div className="perm-hint">
                Build tasks usually need an edit-capable mode. You can switch now or keep Plan mode.
              </div>

              <div className="perm-actions">
                <button className="perm-btn-deny" onClick={() => onModeSwitchChoice()}>Keep Plan mode</button>
                <button className="perm-btn-yolo" onClick={() => onModeSwitchChoice('auto_review')}>Switch to Edit automatically</button>
                <button className="perm-btn-allow" onClick={() => onModeSwitchChoice('full_access')}>Switch to Auto mode</button>
              </div>
            </div>
          </div>,
          document.body
        )
      )}
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
            {buildSessionTree(sessions).map(({ session: s, depth, isLast }) => (
              <div
                key={s.id}
                className={`session-item${s.id === activeId ? ' active' : ''}`}
                style={depth > 0 ? { paddingLeft: depth * 14 } : undefined}
              >
                {depth > 0 && (
                  <span className="session-tree-connector" aria-hidden="true" style={{
                    position: 'absolute', left: depth * 14 - 10, top: 0, bottom: isLast ? '50%' : 0,
                    width: 1, background: 'var(--border)', pointerEvents: 'none',
                  }} />
                )}
                <button className="session-item-btn" onClick={() => { setActiveId(s.id); setSessionOpen(false) }}>
                  {depth > 0 ? (
                    <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" style={{ opacity: 0.5, flexShrink: 0 }}>
                      <path d="M2 1v4M2 5c0 2 2 3 4 3M8 8V6" />
                      <circle cx="8" cy="5" r="1.2" fill="currentColor" stroke="none" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M1 2a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2z" />
                      <line x1="3" y1="4" x2="9" y2="4" strokeLinecap="round" />
                      <line x1="3" y1="6.5" x2="7" y2="6.5" strokeLinecap="round" />
                    </svg>
                  )}
                  <span className="session-item-title">{s.title}</span>
                  <span className="session-item-count">{s.messages.filter(m => m.role === 'user').length}</span>
                </button>
                <button
                  className="session-item-branch"
                  title="Branch — fork this session"
                  onClick={e => { e.stopPropagation(); branchSession(); setSessionOpen(false) }}
                >
                  <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M2 1v4M2 5c0 2 2 3 4 3M8 8V6" />
                    <circle cx="8" cy="5" r="1.2" fill="currentColor" stroke="none" />
                  </svg>
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
      <div className="chat-messages" ref={messagesScrollRef} onScroll={syncFollowLatest}>
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
                    pushComposerUndo()
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
              const isCompactedThrough = activeSession?.compaction?.compactedThroughMessageId === msg.id
              const showCompletedTaskSummary = !isAgentBusy && !!taskDone && isLastMsg && msg.role === 'assistant'
              // Find this message's index in the full messages array for accurate branch cut
              const fullIdx = messages.indexOf(msg)
              return (
                <React.Fragment key={msg.id}>
                  <MessageBubble
                    message={msg}
                    onApprovalResponse={onApprovalResponse}
                    isLive={isLiveMsg}
                    currentTool={isLiveMsg ? currentTool : undefined}
                    onAddToChat={text => addSelectionToChat(text)}
                    onEdit={text => {
                      pushComposerUndo()
                      setInput(text)
                      requestAnimationFrame(() => {
                        const ta = textareaRef.current
                        if (ta) {
                          ta.focus()
                          ta.selectionStart = ta.selectionEnd = ta.value.length
                          resizeInput()
                          keepComposerCaretVisible()
                        }
                      })
                    }}
                    onBranchHere={!isAgentBusy && !isLastMsg ? () => { branchSession(fullIdx); setSessionOpen(false) } : undefined}
                    projectPath={projectPath}
                    />
                  {msg.role === 'assistant' && msg.parts
                    .filter(part => part.type === 'plan')
                    .map((part, planIdx) => (
                      <PlanPanel
                        key={`${msg.id}-plan-${planIdx}`}
                        data={part.data as PlanData}
                      />
                    ))}
                  {showCompletedTaskSummary && (
                    <>
                      <TaskDoneBar
                        durationMs={taskDone.durationMs}
                        inputTokens={taskDone.inputTokens}
                        outputTokens={taskDone.outputTokens}
                        interrupted={taskDone.interrupted}
                        isError={taskDone.isError}
                        onDismiss={clearTaskDone}
                      />
                      <TaskSummaryPanel
                        text={taskSummaryMessage?.text ?? latestAssistantText}
                        projectPath={projectPath}
                        durationMs={taskDone.durationMs}
                      />
                    </>
                  )}
                  {isCompactedThrough && activeSession?.compaction && (
                    <div className="chat-compaction-marker">
                      <span className="chat-compaction-marker-line" />
                      <span className="chat-compaction-marker-pill">
                        <span className="chat-compaction-marker-dot" />
                        Conversation compacted — {activeSession.compaction.messageCount} messages summarized
                      </span>
                      <span className="chat-compaction-marker-line" />
                    </div>
                  )}
                </React.Fragment>
              )
            })}
            {isAgentBusy && (visibleMessages.length === 0 || visibleMessages[visibleMessages.length - 1].role !== 'assistant' || visibleMessages[visibleMessages.length - 1].parts.some(p => p.type === 'finish')) && <AgentBusyIndicator currentTool={currentTool} />}
            {/* Client-side command confirmations — not sent to AI, shown inline like Claude Code */}
            {cmdNotes.map(n => (
              <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', margin: '2px 0', borderRadius: 6, background: 'var(--surface-2,rgba(255,255,255,0.04))', fontSize: 12, color: 'var(--text-3)', alignSelf: 'flex-start' }}>
                <span style={{ fontFamily: 'var(--mono)' }}>{n.text}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div
        className={"chat-input-area" + (isDragging ? ' drag-over' : '')}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{ position: 'relative' }}
      >
        {isDragging && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 50,
            background: 'rgba(var(--accent-rgb, 99,102,241), 0.10)',
            border: '2px dashed var(--accent, #6366f1)',
            borderRadius: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <span style={{ color: 'var(--accent, #6366f1)', fontWeight: 600, fontSize: 14 }}>Drop images or files here</span>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachments-preview">
            {attachments.map(att => (
              <div key={att.id} className="attachment-item">
                {att.type === 'image' ? (
                  <div className="attachment-image-preview">
                    <img
                      src={`data:${att.mimeType};base64,${att.data}`}
                      alt={att.name}
                      style={{ cursor: 'zoom-in' }}
                      onClick={() => setPreviewImageSrc(`data:${att.mimeType};base64,${att.data}`)}
                      title="Click to preview"
                    />
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
        <div className={'chat-input-wrap' + (isAgentBusy ? ' generating' : '') + (isCompactComposer ? ' compact' : '') + ((activeSkill || selectedChatContext) ? ' has-composer-context' : '')} style={{ position: 'relative' }}>
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
          {slashQuery !== null && slashResults.length > 0 && (
            <div ref={slashPickerRef} className="chat-at-picker" style={{ maxHeight: 220, overflowY: 'auto' }}>
              {slashResultGroups.map(group => (
                <React.Fragment key={group.key}>
                  <div className="chat-at-section-label">{group.title}</div>
                  {group.options.map(opt => {
                    const i = slashOptionIndex(opt)
                    return (
                      <button key={opt.slash} className={'chat-at-item' + (i === slashActiveIdx ? ' active' : '')}
                        onMouseEnter={() => setSlashActiveIdx(i)}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => activateSlashSkill(opt)}>
                        <span style={{ fontSize: 10, flexShrink: 0 }}>◆</span>
                        <span className="chat-skill-picker-icon" aria-hidden="true">
                          <SkillIcon slash={opt.slash} size={13} />
                        </span>
                        <span className="chat-at-name" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{opt.slash}</span>
                        <span className="chat-at-path">{opt.description}</span>
                        {opt.source === 'custom' && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 'auto', flexShrink: 0 }}>custom</span>}
                        {opt.source === 'subagent' && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 'auto', flexShrink: 0 }}>{opt.writable ? 'sub-agent · write' : 'sub-agent'}</span>}
                      </button>
                    )
                  })}
                </React.Fragment>
              ))}
            </div>
          )}
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
                    setQueuedPrompt({
                      text: pendingInterrupt.text,
                      agentPrompt: pendingInterrupt.agentPrompt ?? undefined,
                    }, pendingInterrupt.attachments)
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
          {selectedChatContext && (
            <div className="chat-context-chip" title={selectedChatContext}>
              <span className="chat-context-chip-label">Selected context from chat</span>
              <span className="chat-context-chip-text">{selectedChatContext}</span>
              <button
                className="chat-context-chip-remove"
                onClick={() => setSelectedChatContext(null)}
                title="Remove selected context"
                aria-label="Remove selected context"
                type="button"
              >
                x
              </button>
            </div>
          )}
          {activeSkill && (
            <div className="chat-active-skill-chip" title={activeSkill.description}>
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
            onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }) }}
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
                          accept={CHAT_FILE_ACCEPT}
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
                    <div className="chat-upload-menu-sep" />

                    <div className="chat-upload-submenu-wrap">
                      <button
                        className="chat-upload-menu-item"
                        onClick={() => setUploadSubmenu(prev => prev === 'skills' ? null : 'skills')}
                        onMouseEnter={() => setUploadSubmenu('skills')}
                        title='Skills (slash "/" commands)'
                      >
                        <span className="chat-upload-menu-item-main">
                          <span className="chat-upload-menu-icon">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14.5 4a2.5 2.5 0 0 1 3.54 3.54L7.5 18.1 4 19l.9-3.5L14.5 4z" />
                            </svg>
                          </span>
                          <span>Skills <span className="chat-upload-menu-muted">(slash "/" commands)</span></span>
                        </span>
                      </button>
                      {uploadSubmenu === 'skills' && (
                        <div className="chat-upload-submenu chat-upload-skills-submenu">
                          {(['system', 'custom', 'subagent'] as const).map(source => {
                            const group = slashOptions.filter(skill => skill.source === source)
                            if (group.length === 0) return null
                            return (
                              <React.Fragment key={source}>
                                <div className="chat-upload-skill-section">
                                  {source === 'system' ? 'System skills' : source === 'custom' ? 'Custom skills' : 'Sub-agents'}
                                </div>
                                {group.map(skill => (
                                  <button
                                    key={skill.slash}
                                    className="chat-upload-menu-item chat-upload-skill-item"
                                    onClick={() => selectSkillFromMenu(skill)}
                                    title={skill.description}
                                  >
                                    <span className="chat-upload-menu-item-main chat-upload-skill-main">
                                      <span className="chat-upload-skill-slash">{skill.slash}</span>
                                    </span>
                                  </button>
                                ))}
                              </React.Fragment>
                            )
                          })}
                        </div>
                      )}
                    </div>

                  </div>
                )}
              </div>

              {/* Computer dropdown — anchored to pill position below */}
              <ChatFooterMenus
                isAgentBusy={isAgentBusy}
                onInsertSnippet={injectSnippet}
                onBeforeToggle={closeMonitorPanel}
              />
              {/* Combined pill: Permission + Computer + Context */}
              <ToolbarPill
                permissionMode={permissionMode}
                onPermissionChange={onPermissionModeChange}
                effortLevel={effortLevel}
                onEffortChange={onEffortChange}
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
                          openDown
                        />
                      </div>
                      <div className="chat-composer-overflow-section">
                        <div className="chat-composer-overflow-label">Workspace</div>
                        <ToolbarPill
                          permissionMode={permissionMode}
                          onPermissionChange={onPermissionModeChange}
                          effortLevel={effortLevel}
                          onEffortChange={onEffortChange}
                          tokenEstimate={tokenEstimate}
                          ctxPct={ctxPct}
                          ctxColor={ctxColor}
                          ctxLimit={CTX_LIMIT}
                          isAgentBusy={isAgentBusy}
                          onComputerClick={() => toggleComposerMenu('computer')}
                          computerActive={openComposerMenu === 'computer'}
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
          {isCompactComposer && (
            <ContextWindowPanel
              tokenEstimate={tokenEstimate}
              ctxPct={ctxPct}
              ctxColor={ctxColor}
              ctxLimit={CTX_LIMIT}
              isCompacting={isCompacting}
              onCompact={onCompact}
              isAgentBusy={isAgentBusy}
              agentUsage={agentUsage}
            />
          )}
          {isAgentBusy ? (
            <button className="send-btn stop" onClick={onCancel} title="Stop generation" aria-label="Stop">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className={'send-btn' + (canSend && !isSkillInstalling ? ' ready' : '')}
              onClick={submit}
              disabled={!canSend || isSkillInstalling}
              title={isSkillInstalling ? 'Installing skill assets...' : 'Send message (Enter)'}
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
  {ctxMenu && createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 99998 }} onClick={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null) }} />
      <div style={{
        position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 99999,
        background: 'var(--bg-elevated, #1e1e2e)', border: '1px solid var(--border, rgba(255,255,255,0.1))',
        borderRadius: 8, padding: '4px 0', minWidth: 140,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)', fontSize: 13,
      }}>
        {[
          {
            label: 'Paste', icon: '⌘V',
            action: () => { setCtxMenu(null); textareaRef.current?.focus(); handleSmartPaste() },
          },
          {
            label: 'Copy', icon: '⌘C',
            action: () => {
              setCtxMenu(null)
              const ta = textareaRef.current
              if (!ta) return
              const sel = ta.value.slice(ta.selectionStart ?? 0, ta.selectionEnd ?? ta.value.length)
              if (sel) navigator.clipboard.writeText(sel).catch(() => {})
            },
          },
          {
            label: 'Cut', icon: '⌘X',
            action: () => {
              setCtxMenu(null)
              const ta = textareaRef.current
              if (!ta) return
              ta.focus()
              const sel = ta.value.slice(ta.selectionStart ?? 0, ta.selectionEnd ?? ta.value.length)
              if (sel) {
                navigator.clipboard.writeText(sel).catch(() => {})
                document.execCommand('delete') // removes selection, preserves undo stack
              }
            },
          },
        ].map(item => (
          <button
            key={item.label}
            onClick={item.action}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', padding: '6px 14px', background: 'none', border: 'none',
              color: 'var(--text-primary, #e2e8f0)', cursor: 'pointer', gap: 24, textAlign: 'left',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <span>{item.label}</span>
            <span style={{ opacity: 0.45, fontSize: 11 }}>{item.icon}</span>
          </button>
        ))}
      </div>
    </>,
    document.body
  )}
  {previewImageSrc && createPortal(
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
      onClick={() => setPreviewImageSrc(null)}
    >
      <img
        src={previewImageSrc}
        alt="Preview"
        style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.6)', objectFit: 'contain' }}
        onClick={e => e.stopPropagation()}
      />
      <button
        style={{ position: 'absolute', top: 16, right: 20, background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', fontSize: 22, width: 36, height: 36, borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => setPreviewImageSrc(null)}
        aria-label="Close preview"
      >×</button>
    </div>,
    document.body
  )}
    </>
  )
}
