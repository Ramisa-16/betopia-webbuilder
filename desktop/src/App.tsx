/**
 * App.tsx — wiring layer only.
 * State: store/*  |  Logic: lib/*  |  UI: modules/*
 * No Go backend. All AI runs inline via lib/agent.ts.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { invoke } from '@tauri-apps/api/core'
import { exists as pathExists } from '@tauri-apps/plugin-fs'
import { normalizeDialogPath } from './lib/path'
import { getFileTree, readProjectFile, writeProjectFile, ensureProjectDir, duplicateProjectDirectory, createProjectFile, createProjectFolder } from './lib/fs'
import { runAgent, streamInlineEdit } from './lib/agent'
import { runOrchestration } from './lib/orchestration'
import { getConfig, saveConfig, migrateApiKeysToKeychain, initConfig, getModelInfo } from './lib/config'
import { restoreSessionsFromFile } from './store/sessionStore'
import { addCodeHistoryEntry, restoreCodeHistoryFromFile, saveSnapshot, restoreSnapshot } from './lib/codeHistory'
import { getDefaultPublishState, loadPublishState, savePublishState, type PublishState } from './lib/publish'
import { makeLogEntry, errorToLogEntry, scanAgentOutputForErrors } from './lib/error-detector'
import { fileExists } from './lib/manifest'
import { expandSnippetTokens } from './lib/snippets'
import { estimateMessagesTokens } from './lib/tokenCounter'
import { findAgent, BUILTIN_AGENTS } from './lib/agents'
import { prefetchBetopiaModels } from './lib/providers'
import { useAgentsStore } from './store/agentsStore'
import { useSnippetsStore } from './store/snippetsStore'
import { useSessionStore } from './store/sessionStore'
import type { Message, MessagePart, FileEntry, DetectedError, ApprovalData, ApprovalStatus } from './types'
import TabBar, { openTab, closeTab, markTabDirty, getAdjacentTab } from './modules/editor/components/TabBar'

import { useAppStore } from './store/appStore'
import { useChatStore } from './store/chatStore'
import type { PlanBuildPhase, PlanSource } from './store/chatStore'
import { useEditorStore } from './store/editorStore'
import { useUiStore } from './store/uiStore'

import { ChatPanel, LandingChat } from './modules/chat'
import { AgentSwitcher } from './modules/ai'
// import { NotificationBell } from './modules/agents'
import { LocalAgentNotificationsBridge, type AgentRunStatus } from './modules/ai/components/LocalAgentNotificationsBridge'
import { Terminal, TerminalHandle } from './modules/terminal'
import { CodePanel } from './modules/editor'
import InlineChatPopup from './modules/editor/components/InlineChatPopup'
import { FileTree } from './modules/explorer'
import { LivePreview } from './modules/preview'
import ApiDocsPanel from './modules/preview/components/ApiDocsPanel'
import { AgentSettings, SettingsPanel, SettingsSearch } from './modules/settings'
import SurfaceLayer from './components/SurfaceLayer'
import { useShortcuts } from './lib/useShortcuts'
import QuickOpen from './modules/explorer/components/QuickOpen'
import StatusBar from './modules/workspace/components/StatusBar'
import {
  Header, /* DashboardPanel, DatabasePanel, StoragePanel, */
  LogsPanel, PermissionDialog, ProjectPicker, addRecent,
  EntryFilePicker, PublishDialog,
} from './modules/workspace'

// ── Constants ────────────────────────────────────────────────────────────────

const CHAT_WIDTH_DEFAULT  = 344
const CHAT_WIDTH_MIN      = 120
const CHAT_WIDTH_EDGE_GAP = 120
const EXPLORER_WIDTH_DEFAULT  = 220
const EXPLORER_WIDTH_MIN      = 80
const EXPLORER_WIDTH_EDGE_GAP = 80

const ORCH_APPROVAL_SIGNALS = new Set([
  'approved','approve','confirm','confirmed','continue','done','go','go ahead',
  'looks good','lgtm','next','ok','okay','perfect','proceed','start','yes','yep',
  'retry','redo','regenerate','try again','run again','rerun',
])

// ── Shell icons ──────────────────────────────────────────────────────────────

function ShellIcon({ name }: { name: string }) {
  const n = name.toLowerCase()
  let bg = '#444', fg = '#fff', label = '$'

  if (n.includes('developer') && n.includes('powershell')) { bg = '#68217A'; fg = '#fff'; label = 'PS' }
  else if (n.includes('developer') && n.includes('command')) { bg = '#68217A'; fg = '#fff'; label = '>' }
  else if (n.includes('powershell 7') || n === 'powershell 7') { bg = '#5391FE'; fg = '#fff'; label = 'PS' }
  else if (n.includes('powershell')) { bg = '#012456'; fg = '#00BFFF'; label = 'PS' }
  else if (n.includes('command prompt') || n === 'cmd') { bg = '#1a1a1a'; fg = '#fff'; label = '>' }
  else if (n.includes('git bash') || n.includes('git')) { bg = '#F05032'; fg = '#fff'; label = 'git' }
  else if (n.includes('wsl')) { bg = '#FCC624'; fg = '#000'; label = 'WSL' }
  else if (n.includes('zsh')) { bg = '#c5d928'; fg = '#000'; label = 'zsh' }
  else if (n.includes('fish')) { bg = '#3AAFA9'; fg = '#fff'; label = 'fish' }
  else if (n.includes('bash')) { bg = '#4EAA25'; fg = '#fff'; label = 'bash' }
  else if (n.includes('sh')) { bg = '#555'; fg = '#fff'; label = 'sh' }

  const small = label.length > 2
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
      <rect width="16" height="16" rx="3" fill={bg}/>
      <text
        x="8" y={small ? "11" : "12"}
        textAnchor="middle"
        fontSize={small ? "5.5" : label.length > 1 ? "6" : "10"}
        fontFamily="'JetBrains Mono','Fira Code',monospace"
        fontWeight="700"
        fill={fg}
      >{label}</text>
    </svg>
  )
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function makeId() { return Math.random().toString(36).slice(2, 10) }

function shouldUseOrchestrationForPrompt(prompt: string): boolean {
  const p = prompt.toLowerCase()
  return (
    (/\b(build|create|make|generate|develop|scaffold|construct)\b/.test(p) &&
      (/\b(project|app|application|website|web app|system|platform|dashboard|portal|api|backend|frontend|full stack|fullstack|database|store|shop|e-?commerce|portfolio|landing page|blog|saas)\b/.test(p) ||
       /\b(react|next\.?js|node|express|go|rust|python|django|flask|postgres|mongodb|mysql|api|frontend|backend|fullstack|full stack)\b/.test(p))) ||
    /\b(step by step|architecture|module|plan then build|analyze ui|design analysis)\b/.test(p)
  )
}

function shouldForceAgenticMode(prompt: string): boolean {
  return /\b(stop orchestration|disable orchestration|normal mode|agentic mode|quick fix|single fix)\b/.test(prompt)
}

// Tasks that a single Coder agent can handle — skip the 5-agent orchestration pipeline
function isSimpleTask(prompt: string): boolean {
  const p = prompt.toLowerCase()
  // Full project/app builds always need orchestration
  if (/\b(full[- ]stack|complete (app|project|site|website)|build (me )?(a |an )?(full|complete)|from scratch|end[- ]to[- ]end|entire (app|project|site))\b/.test(p)) return false
  if (prompt.length > 300) return false
  // Single component / quick edit → just use Coder
  return /\b(hero|navbar|footer|button|card|section|component|page|form|modal|banner|sidebar|header|simple|just|only|quick|small|add a|add the|create a|make a|fix|update|change|tweak)\b/.test(p)
}

function collectTextFromParts(parts: MessagePart[]): string {
  return parts.filter(p => p.type === 'text').map(p => (p.data as any)?.text ?? '').join('\n\n').trim()
}

function buildPlanningOnlyPrompt(userPrompt: string, editInstruction?: string, existingPlan?: string): string {
  return [
    'You are in planning-only mode.',
    'Hard rule: do NOT create/edit/delete files and do NOT execute implementation tools.',
    'Hard rule: do NOT deploy.',
    'Return only a complete step-by-step implementation plan.',
    'Format EVERY implementation task as a checkbox: `- [ ] Task description`',
    'The FIRST tasks in your checklist must always be:',
    '  - [ ] Write .betopia/architecture.md (stack, API contracts, file structure, conventions, security)',
    '  - [ ] Write .betopia/design.md (only if frontend: color tokens, components, breakpoints)',
    '  - [ ] Create README.md and .env.example',
    'Then include all folder/file plan, frontend, backend/API, database, integration, and validation steps.',
    'End by asking the user to choose Start build or Edit plan.',
    `\nProject request:\n${userPrompt.trim()}`,
    existingPlan?.trim() ? `\n\nCurrent plan draft:\n${existingPlan.trim()}` : '',
    editInstruction?.trim() ? `\n\nUser feedback:\n${editInstruction.trim()}` : '',
  ].join('\n')
}

function buildArchitectPlanningPrompt(userPrompt: string, editInstruction?: string, existingPlan?: string): string {
  return [
    'You are in architecture planning mode.',
    'Hard rule: do NOT create/edit/delete files. Do NOT run implementation tools.',
    'Output a complete implementation plan structured as:',
    '1. Problem statement (1-2 sentences)',
    '2. Recommended approach with key tradeoffs',
    '3. File/folder structure',
    '4. Implementation tasks — format EVERY task as: `- [ ] Task description`',
    '   The FIRST tasks must always be:',
    '   - [ ] Write .betopia/architecture.md (stack, API contracts, file structure, conventions)',
    '   - [ ] Write .betopia/design.md (only if frontend: color tokens, components, breakpoints)',
    '   - [ ] Create README.md and .env.example',
    '5. Risks and open questions',
    'End by telling the user to click "Start build" to execute with Coder, or "Edit plan" to modify.',
    `\nProject request:\n${userPrompt.trim()}`,
    existingPlan?.trim() ? `\n\nExisting plan:\n${existingPlan.trim()}` : '',
    editInstruction?.trim() ? `\n\nUser feedback:\n${editInstruction.trim()}` : '',
  ].join('\n')
}

// Extracts only checkbox task lines from plan text — strips all prose/headers.
// Falls back to full planText if no checkboxes found (backward compat).
function extractTaskList(planText: string): string {
  const lines = planText.split('\n').filter(l => /^\s*-\s*\[[ x]\]/.test(l))
  return lines.length > 0 ? lines.join('\n') : planText.trim()
}

function buildStartBuildPrompt(originalPrompt: string, approvedPlan: string): string {
  return [
    'The user approved the plan. Start implementing now.',
    '',
    '## Step 1 — Write context files FIRST (before any code)',
    'Write `.betopia/architecture.md` containing:',
    '- Tech stack and key decisions',
    '- Component/module responsibilities',
    '- API contracts (endpoints, request/response shape)',
    '- File/folder structure',
    '- Conventions (naming, patterns, state management)',
    '',
    'If project has a frontend: also write `.betopia/design.md` containing:',
    '- Color tokens (primary, accent, neutral, background)',
    '- Component library choice and key reusable components',
    '- Breakpoints and responsive strategy',
    '- Typography and spacing scale',
    '',
    'Also ensure `README.md` and `.env.example` are created during implementation.',
    '',
    '## Step 2 — Implement tasks',
    'Build step by step according to the approved plan.',
    'Create only required folders/files for this project.',
    'Do not deploy unless the user explicitly asks.',
    `\nOriginal request:\n${originalPrompt.trim()}`,
    `\nApproved plan:\n${approvedPlan.trim()}`,
  ].join('\n')
}

function formatPlanFile(originalPrompt: string, planText: string, phase: string, source: PlanSource = 'orchestration'): string {
  const status = phase === 'building' ? 'In Progress' : phase === 'completed' ? 'Completed' : phase === 'awaiting_plan' ? 'Planning...' : 'Awaiting Approval'
  // During build, compact to task list only — architecture detail is in .betopia/architecture.md
  // and in chat history. Keeps MEMORY_FILES token cost minimal (~80 tokens vs ~1250).
  const content = phase === 'building' ? extractTaskList(planText) : planText.trim()
  return [
    '# Project Plan',
    '',
    `**Status:** ${status}`,
    `**Source:** ${source}`,
    `**Updated:** ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Original Request',
    originalPrompt.trim(),
    '',
    '## Plan',
    content,
  ].join('\n')
}

function parsePlanFile(content: string): { phase: PlanBuildPhase; originalPrompt: string; planText: string; source: PlanSource } | null {
  try {
    const statusMatch = content.match(/\*\*Status:\*\* (.+)/)
    const sourceMatch = content.match(/\*\*Source:\*\* (.+)/)
    const requestMatch = content.match(/## Original Request\n([\s\S]+?)\n## Plan/)
    const planMatch = content.match(/## Plan\n([\s\S]+)/)
    if (!statusMatch || !planMatch) return null
    const status = statusMatch[1]?.trim()
    const phase: PlanBuildPhase = status === 'Completed' ? 'idle'
      : status === 'In Progress' ? 'building'
      : 'awaiting_confirmation'
    const rawSource = sourceMatch?.[1]?.trim()
    const source: PlanSource = rawSource === 'architect' ? 'architect' : rawSource === 'designer' ? 'designer' : 'orchestration'
    return {
      phase,
      originalPrompt: requestMatch?.[1]?.trim() ?? '',
      planText: planMatch[1].trim(),
      source,
    }
  } catch { return null }
}

function makeMsg(role: 'user' | 'assistant', parts: MessagePart[]): Message {
  const now = Date.now()
  return { id: makeId(), session_id: 'local', role, parts, created_at: now, updated_at: now }
}

const SKIP_DIRS = new Set(['.venv','venv','env','.env','node_modules','__pycache__','.git','.tox','vendor','.cache','.parcel-cache','.next','.nuxt','target','Lib','Include'])

function findIndexHtml(entries: FileEntry[]): string | null {
  const preferred = ['index.html','main.html','app.html','home.html','login.html']
  let best: { path: string; rank: number } | null = null
  let first: string | null = null
  const stack = [...entries]
  while (stack.length) {
    const node = stack.pop()!
    if (node.is_dir) {
      const n = node.name.toLowerCase()
      if (SKIP_DIRS.has(node.name) || SKIP_DIRS.has(n) || n.startsWith('.')) continue
      if (node.children?.length) stack.push(...node.children)
      continue
    }
    const lower = node.name.toLowerCase()
    if (!lower.endsWith('.html') && !lower.endsWith('.htm')) continue
    if (!first) first = node.path
    const rank = preferred.indexOf(lower)
    if (rank !== -1 && (!best || rank < best.rank)) best = { path: node.path, rank }
  }
  return best?.path ?? first
}

function hasHtmlFiles(entries: FileEntry[]): boolean {
  for (const e of entries) {
    const n = e.name.toLowerCase()
    if (e.is_dir) {
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(n) || n.startsWith('.')) continue
      if (e.children && hasHtmlFiles(e.children)) return true
    } else if (n.endsWith('.html') || n.endsWith('.htm')) return true
  }
  return false
}

function findFirstFile(entries: FileEntry[]): string | null {
  for (const e of entries) {
    if (!e.is_dir) return e.path
    if (e.children?.length) { const n = findFirstFile(e.children); if (n) return n }
  }
  return null
}

function normalizeEscapedContent(path: string, content: string): string {
  if (!content || content.includes('\n')) return content
  const escapedNl = (content.match(/\\n/g) ?? []).length
  if (escapedNl < 2) return content
  const lower = path.toLowerCase()
  const isCode = /\.(tsx?|jsx?|css|scss|html?|md|json|py|go|rs|java|kt|swift|php|rb|sh|yml|yaml)$/.test(lower)
  const looksCode = /(import\s+|export\s+|function\s+|const\s+|return\s*\(|className=|<\w+)/m.test(content)
  if (!isCode && !looksCode) return content
  return content.replace(/\\r\\n/g,'\n').replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\"/g,'"')
}

function findRunnableRoots(entries: FileEntry[]): string[] {
  const roots = new Set<string>()
  const markers = new Set(['package.json','cargo.toml','go.mod','main.go'])
  const scan = (nodes: FileEntry[], dir: string) => {
    for (const n of nodes) { if (!n.is_dir && markers.has(n.name.toLowerCase())) roots.add(dir) }
    for (const n of nodes) { if (n.is_dir) scan(n.children ?? [], n.path.replace(/\\/g, '/')) }
  }
  scan(entries, '')
  return Array.from(roots).sort((a, b) => a.length - b.length)
}

function prioritizeRoots(roots: string[], selected: string | null, entry: string | null): string[] {
  if (roots.length <= 1) return roots
  const targets = [selected, entry].filter((v): v is string => Boolean(v)).map(v => v.replace(/\\/g,'/').replace(/^\/+/,''))
  if (!targets.length) return roots
  const score = (root: string) => {
    const r = root.replace(/\\/g,'/').replace(/^\/+|\/+$/g,'')
    let best = 0
    for (const t of targets) { if (t === r || t.startsWith(r + '/')) best = Math.max(best, 1000 + r.length) }
    return best
  }
  return [...roots].sort((a, b) => { const d = score(b) - score(a); return d !== 0 ? d : b.length - a.length })
}

function normalizePathReq(p: string | null | undefined): string | null {
  if (!p) return null
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '')
}

const FILLER_WORDS = new Set([
  'a','an','the','and','or','but','for','of','to','in','on','at','by','with','from',
  'that','this','is','are','was','be','as','it','its','i','my','me','we','our','us',
  'you','your','create','make','build','develop','design','generate','write','add',
  'new','please','want','need','would','like','can','will','use','using','include',
  'modern','responsive','mobile','friendly','complete','full','simple','based',
  'located','about','page','pages','site','website','web','app','application',
  'with','has','have','get','set','give','show','display','provide','allow',
])

function promptToFolderName(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !FILLER_WORDS.has(w))
  return words.slice(0, 4).join('-').replace(/-+$/, '') || 'new-project'
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const { init: initSessions, activeId: activeSessionId, sessions,
    syncMessages: syncSessionMessages, reset: resetSessions } = useSessionStore()
  const activeSession = sessions.find(s => s.id === activeSessionId)

  const activeAgentId   = useAgentsStore(s => s.activeId)
  const customAgents    = useAgentsStore(s => s.customAgents)
  const allAgents       = useMemo(() => [...BUILTIN_AGENTS, ...customAgents], [customAgents])
  const snippets        = useSnippetsStore(s => s.snippets)

  const { status, projectPath, permissionMode, setStatus, setProjectPath, setPermissionMode } = useAppStore()
  const { messages, isAgentBusy, currentTool, planFlow, isFixing, autoFixAttempts, pendingFileReference,
    queuedPrompt, queuedAttachments,
    setMessages, setIsAgentBusy, setCurrentTool, setPlanFlow, resetPlanFlow,
    setIsFixing, setAutoFixAttempts, setPendingFileReference, setQueuedPrompt, updateUsage, reset: resetChat } = useChatStore()
  const { files, selectedFile, fileContent, tabs, entryFile, showEntryPicker, explorerSearch,
    setFiles, setSelectedFile, setFileContent, setTabs, setEntryFile, setShowEntryPicker, setExplorerSearch, reset: resetEditor } = useEditorStore()
  const { viewMode, previewKey, liveServerUrl, liveServerMode, publishedUrl, isPublishing,
    logs, runtimeErrors, logsOpen, chatWidth, explorerWidth, isResizingChat, isResizingExplorer,
    showSettings, settingsInitialTab, showPublishDialog,
    setViewMode, bumpPreviewKey, setLiveServerUrl, setLiveServerMode, setPublishedUrl, setIsPublishing,
    addLog, clearLogs, addRuntimeError, setLogsOpen, setChatWidth, setExplorerWidth,
    setIsResizingChat, setIsResizingExplorer, setShowSettings, setShowPublishDialog, reset: resetUi } = useUiStore()

  // Refs (stable refs avoid stale closures in callbacks)
  const pathRef             = useRef<string>('')
  const selectedFileRef     = useRef<string | null>(null)
  const messagesRef         = useRef<Message[]>([])
  const abortRef            = useRef<AbortController | null>(null)
  const permResolveRef      = useRef<((v: boolean) => void) | null>(null)
  const refreshTimerRef     = useRef<NodeJS.Timeout | null>(null)
  const isRefreshingRef     = useRef(false)
  const appBodyRef          = useRef<HTMLDivElement | null>(null)
  const workspaceCodeRef    = useRef<HTMLDivElement | null>(null)
  const permissionModeRef   = useRef(permissionMode)
  const planFlowRef         = useRef(planFlow)
  const entryFileRef        = useRef<string | null>(null)

  const approvalResolversRef = useRef<Map<string, (result: boolean | string) => void>>(new Map())
  const openedDiffsRef = useRef<Set<string>>(new Set())
  // keyed by approvalId → { path, originalContent } — for revert-on-reject
  const revertFileMapRef = useRef<Map<string, { path: string; originalContent: string }>>(new Map())
  const refreshFilesRef = useRef<() => Promise<void>>(async () => {})
  const handleCompactRef = useRef<() => Promise<void>>(async () => {})
  const handleRequestPreviewRef = useRef<() => Promise<void>>(async () => {})
  const wasCancelledRef = useRef(false)

  type ActiveDiff = ApprovalData & { approvalId: string }
  // Per-file pending diffs: key = file path, value = diff data
  const [pendingDiffs, setPendingDiffs] = useState<Map<string, ActiveDiff>>(new Map())
  // autoAccept mode: diffs collected here after run; only moved to pendingDiffs when user clicks "Review in Editor"
  const [reviewableAutoAcceptDiffs, setReviewableAutoAcceptDiffs] = useState<Map<string, ActiveDiff>>(new Map())
  const [inlinePermRequest, setInlinePermRequest] = useState<{ tool: string; args: string } | null>(null)
  const [publishState, setPublishState] = useState<PublishState>(getDefaultPublishState())
  const [chatSidebarVisible, setChatSidebarVisible] = useState(true)
  const [codeVisible,        setCodeVisible]        = useState(true)
  const [previewVisible,     setPreviewVisible]     = useState(false)
  const [sidePanel, setSidePanel] = useState<'explorer' | 'search' | 'source-control' | null>('explorer')
  const [previewTabOpen, setPreviewTabOpen] = useState(false)
  const [editorView, setEditorView] = useState<'code' | 'preview' | 'apidocs'>('code')
  const [apiDocsTabOpen, setApiDocsTabOpen] = useState(false)
  const [detectedBackendUrl, setDetectedBackendUrl] = useState<string | null>(null)
  const [terminalVisible,    setTerminalVisible]    = useState(false)
  const termTabSeqRef     = useRef(0)   // ever-incrementing seed for unique tab IDs
  const terminalTabsRef   = useRef<{ id: string; title: string; shell?: string; shellArgs?: string[] }[]>([])
  const terminalPanelRef  = useRef<any>(null)
  const terminalRefs      = useRef<Map<string, TerminalHandle>>(new Map())
  const [terminalTabs,       setTerminalTabs]       = useState<{ id: string; title: string; shell?: string; shellArgs?: string[] }[]>([])
  // Mirror of terminalTabs as a ref so createTerminalTab (stable useCallback) can read current value
  // without closing over stale state. Updated synchronously after every setTerminalTabs.
  useEffect(() => { terminalTabsRef.current = terminalTabs }, [terminalTabs])
  const [activeTerminalId,   setActiveTerminalId]   = useState<string | null>(null)
  const [availableShells,    setAvailableShells]    = useState<{ name: string; path: string; args: string[] }[]>([])
  const [shellDropdownOpen,  setShellDropdownOpen]  = useState(false)
  const [shellDropdownPos,   setShellDropdownPos]   = useState<{ top: number; right: number } | null>(null)
  const shellBtnRef = useRef<HTMLButtonElement>(null)
  const [isCompacting, setIsCompacting] = useState(false)
  const [showSettingsSearch, setShowSettingsSearch] = useState(false)
  const [showQuickOpen, setShowQuickOpen] = useState(false)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  useEffect(() => {
    if (!projectPath) { setGitBranch(null); return }
    invoke('shell_run_command', { command: 'git branch --show-current', cwd: projectPath })
      .then((out: unknown) => {
        const s = typeof out === 'string' ? out : ((out as { stdout?: string })?.stdout ?? '')
        setGitBranch(s.trim() || null)
      })
      .catch(() => setGitBranch(null))
  }, [projectPath])
  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const pendingPromptRef = useRef<string>('')
  const [inlineChat, setInlineChat] = useState<{ selection: string; fileName: string } | null>(null)

  // Window focus tracking for notification routing
  const [windowFocused, setWindowFocused] = useState(() => typeof document !== 'undefined' ? document.hasFocus() : true)
  useEffect(() => {
    const onFocus = () => setWindowFocused(true)
    const onBlur = () => setWindowFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onBlur) }
  }, [])

  // Derive agent run status for notification bridge
  const agentRunStatus: AgentRunStatus = (() => {
    if (!isAgentBusy) return 'idle'
    if (approvalResolversRef.current.size > 0) return 'awaiting-approval'
    return 'thinking'
  })()

  // True when project has a runnable server (package.json, Cargo.toml, go.mod, manage.py, etc.)
  // even if it has no static index.html — enables preview for Next.js, Vite, Python, etc.
  const canRunProject = useMemo(() => findRunnableRoots(files).length > 0, [files])

  // Terminal session refs for managed agent tools
  const terminalSessionIdRef = useRef<string | null>(null)
  const terminalOutputBufRef = useRef<Map<string, string>>(new Map())

  // Sync refs
  useEffect(() => { permissionModeRef.current = permissionMode }, [permissionMode])
  useEffect(() => { planFlowRef.current = planFlow }, [planFlow])

  // Persist permission mode → config
  useEffect(() => {
    const cfg = getConfig()
    const shouldYolo = permissionMode === 'full_access'
    if (cfg.behavior.yoloMode !== shouldYolo) saveConfig({ ...cfg, behavior: { ...cfg.behavior, yoloMode: shouldYolo } })
  }, [permissionMode])

  // Restore persisted config + migrate keys to keychain + prefetch models
  useEffect(() => {
    initConfig()
      .then(() => migrateApiKeysToKeychain())
      .catch(() => {})
    prefetchBetopiaModels()
  }, [])

  // Clear explorer search on project change
  useEffect(() => { setExplorerSearch('') }, [projectPath, setExplorerSearch])

  // Sync messages → session store (debounced so streaming doesn't flood file writes)
  useEffect(() => {
    const t = setTimeout(() => syncSessionMessages(messages), 800)
    return () => clearTimeout(t)
  }, [messages, syncSessionMessages])

  // Load messages from active session when it changes
  useEffect(() => {
    if (!activeSession) return
    const sessionMsgs = activeSession.messages
    if (JSON.stringify(sessionMsgs) !== JSON.stringify(messages)) {
      setMessages(sessionMsgs); messagesRef.current = sessionMsgs
    }
  }, [activeSessionId])  // only when session switches

  // Persist inline chat history per project
  const chatHistoryKey = useCallback((p: string) => `betopia:project-chat:${p.replace(/\\/g,'/').toLowerCase()}`, [])
  const loadInlineChat = useCallback((p: string): Message[] => {
    try { const raw = localStorage.getItem(chatHistoryKey(p)); return raw ? JSON.parse(raw) : [] } catch { return [] }
  }, [chatHistoryKey])
  const lsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!projectPath) return
    if (lsDebounceRef.current) clearTimeout(lsDebounceRef.current)
    lsDebounceRef.current = setTimeout(() => {
      try {
        const toSave = messagesRef.current.length > 100 ? messagesRef.current.slice(-100) : messagesRef.current
        localStorage.setItem(chatHistoryKey(projectPath), JSON.stringify(toSave))
      } catch {}
    }, 1500)
  }, [projectPath, messages, chatHistoryKey])

  // ── Resize handlers ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isResizingChat) return
    const onMove = (e: MouseEvent) => {
      const rect = appBodyRef.current?.getBoundingClientRect()
      if (!rect) return
      setChatWidth(Math.max(CHAT_WIDTH_MIN, Math.min(Math.max(CHAT_WIDTH_MIN, rect.width - CHAT_WIDTH_EDGE_GAP), e.clientX - rect.left)))
    }
    const onUp = () => setIsResizingChat(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = '' }
  }, [isResizingChat, setChatWidth, setIsResizingChat])

  useEffect(() => {
    if (!isResizingExplorer) return
    const onMove = (e: MouseEvent) => {
      const container = workspaceCodeRef.current ?? appBodyRef.current
      const rect = container?.getBoundingClientRect()
      if (!rect) return
      setExplorerWidth(Math.max(EXPLORER_WIDTH_MIN, Math.min(Math.max(EXPLORER_WIDTH_MIN, rect.width - EXPLORER_WIDTH_EDGE_GAP), e.clientX - rect.left)))
    }
    const onUp = () => setIsResizingExplorer(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = '' }
  }, [isResizingExplorer, setExplorerWidth, setIsResizingExplorer])

  useEffect(() => {
    const onResize = () => {
      const r1 = appBodyRef.current?.getBoundingClientRect()
      if (r1) setChatWidth(prev => Math.max(CHAT_WIDTH_MIN, Math.min(Math.max(CHAT_WIDTH_MIN, r1.width - CHAT_WIDTH_EDGE_GAP), prev)))
      const r2 = (workspaceCodeRef.current ?? appBodyRef.current)?.getBoundingClientRect()
      if (r2) setExplorerWidth(prev => Math.max(EXPLORER_WIDTH_MIN, Math.min(Math.max(EXPLORER_WIDTH_MIN, r2.width - EXPLORER_WIDTH_EDGE_GAP), prev)))
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setChatWidth, setExplorerWidth])

  // ── File operations ──────────────────────────────────────────────────────────

  const setEntry = useCallback((v: string | null) => { entryFileRef.current = v; setEntryFile(v) }, [setEntryFile])

  const resolveEntryFile = useCallback((f: FileEntry[]) => {
    if (entryFileRef.current) return
    const ep = findIndexHtml(f)
    if (ep) { setEntry(ep); setShowEntryPicker(false) }
    else if (hasHtmlFiles(f)) setShowEntryPicker(true)
  }, [setEntry, setShowEntryPicker])

  const refreshFiles = useCallback(async () => {
    const projPath = pathRef.current || projectPath
    if (!projPath) return
    if (!pathRef.current) pathRef.current = projPath
    try {
      const f = await getFileTree(projPath)
      setFiles(f)
      resolveEntryFile(f)
      const cur = normalizePathReq(selectedFileRef.current) || selectedFileRef.current
      const resolved = (cur && fileExists(f, cur)) ? cur : normalizePathReq(entryFileRef.current) || findIndexHtml(f) || findFirstFile(f)
      if (resolved && resolved !== cur) { selectedFileRef.current = resolved; setSelectedFile(resolved); setTabs(prev => openTab(prev, resolved)) }
      if (resolved) {
        try {
          const content = await readProjectFile(projPath, resolved)
          const norm = normalizeEscapedContent(resolved, content)
          if (norm !== content) { await writeProjectFile(projPath, resolved, norm); addLog(makeLogEntry('warn', `Auto-fixed escaped newlines in ${resolved}`, 'system')) }
          setFileContent(norm)
        } catch { try { setFileContent(await readProjectFile(projPath, resolved)) } catch { setFileContent('') } }
      } else { setSelectedFile(null); selectedFileRef.current = null; setFileContent('') }
    } catch {}
  }, [projectPath, resolveEntryFile, setFiles, setSelectedFile, setTabs, setFileContent, addLog])

  const selectFile = useCallback(async (path: string) => {
    const projPath = pathRef.current || projectPath
    if (!projPath) return
    const normalized = normalizePathReq(path) || path
    setSelectedFile(normalized); selectedFileRef.current = normalized
    setTabs(prev => openTab(prev, normalized))
    try {
      const content = await readProjectFile(projPath, normalized)
      const norm = normalizeEscapedContent(normalized, content)
      if (norm !== content) { await writeProjectFile(projPath, normalized, norm); addLog(makeLogEntry('warn', `Auto-fixed escaped newlines in ${normalized}`, 'system')) }
      setFileContent(norm)
    } catch { try { setFileContent(await readProjectFile(projPath, normalized)) } catch { setFileContent('') } }
  }, [projectPath, setSelectedFile, setTabs, setFileContent, addLog])

  const openPlanFileInEditor = useCallback(async () => {
    setViewMode('code')
    await selectFile('plan.md')
    setEditorView('code')
  }, [selectFile, setEditorView, setViewMode])

  const clearSelectedFile = useCallback(() => { setSelectedFile(null); selectedFileRef.current = null; setFileContent('') }, [setSelectedFile, setFileContent])

  const closedTabsRef = useRef<string[]>([])
  const handleCloseTab = useCallback(async (path: string) => {
    const adjacent = getAdjacentTab(tabs, path)
    closedTabsRef.current = [...closedTabsRef.current.filter(p => p !== path), path].slice(-20)
    setTabs(prev => closeTab(prev, path))
    if (path === selectedFile) {
      if (adjacent) { await selectFile(adjacent) }
      else { clearSelectedFile() }
    }
  }, [tabs, selectedFile, selectFile, clearSelectedFile, setTabs])

  const cycleTab = useCallback((dir: 1 | -1) => {
    if (tabs.length < 2 || !selectedFile) return
    const i = tabs.findIndex(t => t.path === selectedFile)
    if (i === -1) return
    selectFile(tabs[(i + dir + tabs.length) % tabs.length].path)
  }, [tabs, selectedFile, selectFile])

  const chatWithFile = useCallback((path: string) => {
    setPendingFileReference({ id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`, path: path.replace(/\\/g,'/').replace(/^\.?\//,'') })
  }, [setPendingFileReference])

  const handleCreateFile = useCallback(async (relativePath: string) => {
    if (!pathRef.current) return
    try { const p = await createProjectFile(pathRef.current, relativePath, ''); await refreshFiles(); await selectFile(p); addLog(makeLogEntry('success', `Created: ${p}`, 'system')) }
    catch (e) { addLog(makeLogEntry('error', `Create failed: ${e instanceof Error ? e.message : String(e)}`, 'system')) }
  }, [refreshFiles, selectFile, addLog])

  const handleCreateFolder = useCallback(async (relativePath: string) => {
    if (!pathRef.current) return
    try { const p = await createProjectFolder(pathRef.current, relativePath); await refreshFiles(); addLog(makeLogEntry('success', `Created: ${p}`, 'system')) }
    catch (e) { addLog(makeLogEntry('error', `Create failed: ${e instanceof Error ? e.message : String(e)}`, 'system')) }
  }, [refreshFiles, addLog])

  // ── Permission ────────────────────────────────────────────────────────────────

  const handlePermissionRequest = useCallback(async (tool: string, args: string): Promise<boolean> => {
    const mode = permissionModeRef.current
    if (mode === 'full_access' || mode === 'auto_review') return true
    return new Promise<boolean>(resolve => { permResolveRef.current = resolve; setInlinePermRequest({ tool, args }) })
  }, [])

  const handlePermAllow    = useCallback(() => { permResolveRef.current?.(true);  permResolveRef.current = null; setInlinePermRequest(null) }, [])
  const handlePermDeny     = useCallback(() => { permResolveRef.current?.(false); permResolveRef.current = null; setInlinePermRequest(null) }, [])
  const handlePermAllowAll = useCallback(() => { setPermissionMode('full_access'); permResolveRef.current?.(true); permResolveRef.current = null; setInlinePermRequest(null) }, [setPermissionMode])

  const handleApprovalRequired = useCallback((approvalId: string, toolName: string): Promise<boolean | string> => {
    if (permissionModeRef.current === 'full_access') return Promise.resolve(true)
    // File tools: auto-approve instantly — agent writes without waiting, diff shows inline for review/revert
    if (toolName === 'write_file' || toolName === 'edit') return Promise.resolve(true)
    // bash: block and wait for user approval in chat
    return new Promise<boolean | string>(resolve => {
      approvalResolversRef.current.set(approvalId, resolve)
    })
  }, [])

  const handleApprovalResponse = useCallback((approvalId: string, approved: boolean, content?: string) => {
    // Resolve pending promise (bash approval)
    const resolve = approvalResolversRef.current.get(approvalId)
    if (resolve) {
      approvalResolversRef.current.delete(approvalId)
      resolve(approved && content ? content : approved)
    }
    // Revert or override file content
    const revertInfo = revertFileMapRef.current.get(approvalId)
    if (revertInfo) {
      if (!approved && revertInfo.originalContent) {
        writeProjectFile(pathRef.current, revertInfo.path, revertInfo.originalContent)
          .then(() => refreshFilesRef.current())
          .catch(() => {})
      } else if (approved && content) {
        writeProjectFile(pathRef.current, revertInfo.path, content)
          .then(() => refreshFilesRef.current())
          .catch(() => {})
      }
      if (!approved || content) revertFileMapRef.current.delete(approvalId)
    }
    // Update pending diff status briefly, then remove
    setPendingDiffs(prev => {
      const next = new Map(prev)
      for (const [filePath, diff] of next) {
        if (diff.approvalId === approvalId) {
          next.set(filePath, { ...diff, status: approved ? 'approved' : 'rejected' })
          break
        }
      }
      return next
    })
    setTimeout(() => {
      setPendingDiffs(prev => {
        const next = new Map(prev)
        for (const [filePath, diff] of next) {
          if (diff.approvalId === approvalId) { next.delete(filePath); break }
        }
        return next
      })
      openedDiffsRef.current.delete(approvalId)
    }, approved ? 900 : 600)
  }, [])

  // Keep refreshFilesRef stable
  useEffect(() => { refreshFilesRef.current = refreshFiles }, [refreshFiles])

  // Track file diffs in-editor (bash stays in chat only)
  useEffect(() => {
    const cfg = getConfig()
    if (cfg.behavior.yoloMode) return

    if (cfg.behavior.autoAccept) {
      if (isAgentBusy) {
        // Silently track originals while run is in progress (for revert support)
        for (const msg of messages) {
          if (msg.role !== 'assistant') continue
          for (const part of msg.parts) {
            if (part.type !== 'approval_request') continue
            const data = part.data as ApprovalData
            if (data.toolName === 'bash') continue
            if (!revertFileMapRef.current.has(data.id)) {
              revertFileMapRef.current.set(data.id, { path: data.path, originalContent: data.originalContent })
            }
          }
        }
      } else {
        // Run completed: stage all new diffs into reviewable queue, don't open editor automatically
        const staged = new Map<string, ActiveDiff>()
        for (const msg of messages) {
          if (msg.role !== 'assistant') continue
          for (const part of msg.parts) {
            if (part.type !== 'approval_request') continue
            const data = part.data as ApprovalData
            if (data.toolName === 'bash') continue
            if (!revertFileMapRef.current.has(data.id)) {
              revertFileMapRef.current.set(data.id, { path: data.path, originalContent: data.originalContent })
            }
            if (!openedDiffsRef.current.has(data.id)) {
              openedDiffsRef.current.add(data.id)
              staged.set(data.path, { ...data, approvalId: data.id })
            }
          }
        }
        if (staged.size > 0) setReviewableAutoAcceptDiffs(staged)
      }
    } else {
      // Normal mode: open diffs in editor immediately as they arrive
      for (const msg of messages) {
        if (msg.role !== 'assistant') continue
        for (const part of msg.parts) {
          if (part.type !== 'approval_request') continue
          const data = part.data as ApprovalData
          if (data.toolName === 'bash') continue
          if (!revertFileMapRef.current.has(data.id)) {
            revertFileMapRef.current.set(data.id, { path: data.path, originalContent: data.originalContent })
          }
          if (!openedDiffsRef.current.has(data.id)) {
            openedDiffsRef.current.add(data.id)
            setPendingDiffs(prev => new Map(prev).set(data.path, { ...data, approvalId: data.id }))
            setViewMode('code')
            setEditorView('code')
            if (data.path && projectPath) selectFile(data.path).catch(() => {})
          }
        }
      }
    }
  }, [messages, isAgentBusy, projectPath])

  const handleEditorDiffAccept = useCallback((approvalId: string, content?: string) => {
    handleApprovalResponse(approvalId, true, content)
  }, [handleApprovalResponse])

  const handleEditorDiffReject = useCallback((approvalId: string) => {
    handleApprovalResponse(approvalId, false)
  }, [handleApprovalResponse])

  // Transfer staged auto-accept diffs into the editor on user request
  const handleReviewAutoAcceptDiffs = useCallback(() => {
    if (reviewableAutoAcceptDiffs.size === 0) return
    setPendingDiffs(reviewableAutoAcceptDiffs)
    setReviewableAutoAcceptDiffs(new Map())
    setViewMode('code')
    setEditorView('code')
    const first = reviewableAutoAcceptDiffs.values().next().value
    if (first?.path && projectPath) selectFile(first.path).catch(() => {})
  }, [reviewableAutoAcceptDiffs, projectPath, setViewMode, setEditorView])

  // ── Workspace ─────────────────────────────────────────────────────────────────

  const openWorkspace = useCallback(async (path: string) => {
    addRecent(path)   // always track, regardless of how project was opened
    pathRef.current = path
    const loaded = loadPublishState(path)
    setPublishState(loaded); setPublishedUrl(loaded.publishedUrl ?? null)
    await ensureProjectDir(path)
    clearLogs()

    const f = await getFileTree(path)
    await Promise.all([
      restoreSessionsFromFile(path).catch(() => {}),
      restoreCodeHistoryFromFile(path).catch(() => {}),
    ])
    const historyFallback = loadInlineChat(path)
    initSessions(path, historyFallback)
    // Read messages from the now-active session (restored from file/localStorage), not from the
    // inline-chat key which is localStorage-only and gets wiped on dev restarts.
    const { sessions: restoredSessions, activeId: restoredActiveId } = useSessionStore.getState()
    const activeMessages = restoredSessions.find(s => s.id === restoredActiveId)?.messages ?? historyFallback
    setProjectPath(path); setFiles(f); setMessages(activeMessages); messagesRef.current = activeMessages
    // Restore plan from disk if project has an in-progress plan
    let planRestored = false
    try {
      const savedPlan = await readProjectFile(path, 'plan.md')
      if (savedPlan) {
        const restored = parsePlanFile(savedPlan)
        if (restored && restored.phase !== 'idle') {
          setPlanFlow({ phase: restored.phase, originalPrompt: restored.originalPrompt, planText: restored.planText, source: restored.source })
          planRestored = true
        }
      }
    } catch { /* no plan.md — fine */ }
    if (!planRestored) resetPlanFlow()
    setSelectedFile(null); selectedFileRef.current = null; setFileContent('')
    setIsAgentBusy(false); setCurrentTool(null); bumpPreviewKey()
    setEntry(null); setShowEntryPicker(false); setTabs([])
    setTerminalTabs([]); setActiveTerminalId(null); termTabSeqRef.current = 0
    resolveEntryFile(f); setStatus('ready')
    addLog(makeLogEntry('info', history.length > 0 ? 'Project opened with history' : 'Project opened', 'system'))
  }, [resolveEntryFile, setEntry, addLog, resetPlanFlow, loadInlineChat, clearLogs, setPublishedUrl,
      setProjectPath, setFiles, setMessages, setSelectedFile, setFileContent, setIsAgentBusy,
      setCurrentTool, bumpPreviewKey, setShowEntryPicker, setTabs, setStatus])

  // Listen for PTY agent signals (Claude Code / Codex detected in terminal)
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let alive = true
    Promise.all([
      import('@tauri-apps/api/event'),
      import('./store/agentStore'),
    ]).then(([{ listen }, { useAgentStore }]) => {
      listen<{ session_id: string; kind: string; agent: string | null }>('betopia:agent-signal', (e) => {
        const { session_id, kind, agent } = e.payload
        const s = useAgentStore.getState()
        switch (kind) {
          case 'started': s.start(session_id, agent ?? 'agent'); break
          case 'working': s.setStatus(session_id, 'working'); break
          case 'attention': s.setStatus(session_id, 'waiting'); break
          case 'finished': s.setStatus(session_id, 'waiting'); break
          case 'exited': s.finish(session_id); break
        }
      }).then((u) => { if (alive) unlisten = u; else u() }).catch(() => {})
    })
    return () => { alive = false; unlisten?.() }
  }, [])

  const cleanupWorkspace = useCallback(async () => {
    abortRef.current?.abort(); abortRef.current = null
    try { await invoke('stop_live_server') } catch {}
    pathRef.current = ''; selectedFileRef.current = null; messagesRef.current = []
    // Reset session store FIRST (sets activeId → null) so the syncMessages effect
    // triggered by resetChat's message clear is a no-op and doesn't wipe session data.
    resetSessions()
    resetChat(); resetEditor(); resetUi()
    setPublishState(getDefaultPublishState()); setInlinePermRequest(null)
  }, [resetSessions, resetChat, resetEditor, resetUi])

  const goHome      = useCallback(async () => { await cleanupWorkspace(); setStatus('picking') }, [cleanupWorkspace, setStatus])
  const openViaMenu = useCallback(async (path: string) => {
    await cleanupWorkspace(); setStatus('opening')
    try { await openWorkspace(path) } catch (e) { console.error('[openViaMenu] failed to open workspace:', e); setStatus('picking') }
  }, [cleanupWorkspace, openWorkspace, setStatus])

  const handleOpenProject = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false })
      const path = normalizeDialogPath(selected)
      if (path) await openViaMenu(path)
    } catch {}
  }, [openViaMenu])

  const handleOpenFile = useCallback(async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: false, multiple: false })
      const filePath = normalizeDialogPath(selected)
      if (!filePath) return
      const targetDir = pathRef.current || projectPath
      if (!targetDir) {
        // No project open — open parent folder as project
        const sep = filePath.includes('\\') ? '\\' : '/'
        const dir = filePath.substring(0, filePath.lastIndexOf(sep))
        if (dir) await openViaMenu(dir)
        return
      }
      // Copy file into the currently open project
      const { readFile, writeFile } = await import('@tauri-apps/plugin-fs')
      const fileName = filePath.split(/[/\\]/).pop() ?? 'imported-file'
      const content = await readFile(filePath)
      const destPath = `${targetDir}/${fileName}`
      await writeFile(destPath, content)
      await refreshFiles()
      await selectFile(destPath)
    } catch {}
  }, [projectPath, openViaMenu, refreshFiles, selectFile])

  useEffect(() => {
    try {
      const pending = localStorage.getItem('betopia_open_project_on_load')
      if (pending) { localStorage.removeItem('betopia_open_project_on_load'); openViaMenu(pending) }
    } catch {}
  }, [openViaMenu])

  // New File: open inline dialog to name the file, then create it in the project folder
  const handleNewFile = useCallback(async () => {
    const projPath = projectPath || pathRef.current
    if (!projPath) { await handleOpenProject(); return }
    setNewFileName('')
    setNewFileOpen(true)
  }, [projectPath, handleOpenProject])

  const handleNewFileSubmit = useCallback(async (name: string) => {
    setNewFileOpen(false)
    if (!name.trim()) return
    setViewMode('code')
    await handleCreateFile(name.trim())
  }, [handleCreateFile, setViewMode])

  // Prompt-driven create: auto-create folder in configured projects folder, or ask user
  const handlePromptCreate = useCallback(async (promptText: string) => {
    try {
      let baseFolder = ''
      try { baseFolder = JSON.parse(localStorage.getItem('betopia:general-prefs') ?? '{}').projectsFolder ?? '' } catch {}

      if (!baseFolder) {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({ directory: true, multiple: false, title: 'Choose project folder' })
        const path = normalizeDialogPath(selected)
        if (path) { pendingPromptRef.current = promptText; await openViaMenu(path) }
        return
      }

      const baseName = promptToFolderName(promptText)
      const sep = baseFolder.includes('\\') ? '\\' : '/'
      const { mkdir, exists } = await import('@tauri-apps/plugin-fs')
      let finalName = baseName
      let i = 1
      while (await exists(`${baseFolder}${sep}${finalName}`)) finalName = `${baseName}-${i++}`
      const newPath = `${baseFolder}${sep}${finalName}`
      await mkdir(newPath, { recursive: true })
      pendingPromptRef.current = promptText
      await openViaMenu(newPath)
    } catch {}
  }, [openViaMenu])

  // ── Send message ──────────────────────────────────────────────────────────────

  type SendOpts = { forceMode?: string; agentPrompt?: string; skipPlanWorkflow?: boolean; fromLanding?: boolean; overrideAgentId?: string }

  const sendMessageCore = useCallback(async (text: string, attachments?: any[], options?: SendOpts) => {
    if (isAgentBusy || (!text.trim() && !attachments?.length)) return
    const projPath = pathRef.current
    if (!projPath) return

    // Expand #snippet tokens before any further processing
    const { body: expandedText, blocks } = expandSnippetTokens(text, snippets)
    const expandedWithBlocks = blocks.length > 0 ? blocks.join('\n') + '\n\n' + expandedText : expandedText
    const textForProcessing = attachments?.length ? text : (blocks.length > 0 ? expandedWithBlocks : text)

    const trimmed = textForProcessing.trim()
    const normalized = trimmed.toLowerCase()
    const activePlan = planFlowRef.current
    let effectivePrompt = options?.agentPrompt ?? textForProcessing
    const isArchitect = activeAgentId === 'builtin:architect'
    const isDesigner = activeAgentId === 'builtin:designer'

    if (!options?.skipPlanWorkflow && !attachments?.length) {
      if (activePlan.phase === 'awaiting_confirmation' && activePlan.originalPrompt.trim()) {
        if (ORCH_APPROVAL_SIGNALS.has(normalized) || normalized.includes('start build')) {
          effectivePrompt = buildStartBuildPrompt(activePlan.originalPrompt, activePlan.planText)
          setPlanFlow(prev => ({ ...prev, phase: 'building' }))
        } else {
          const src = activePlan.source
          effectivePrompt = (src === 'architect' || src === 'designer')
            ? buildArchitectPlanningPrompt(activePlan.originalPrompt, trimmed, activePlan.planText)
            : buildPlanningOnlyPrompt(activePlan.originalPrompt, trimmed, activePlan.planText)
          setPlanFlow(prev => ({ ...prev, phase: 'awaiting_plan' }))
          writeProjectFile(projPath, 'plan.md', formatPlanFile(activePlan.originalPrompt, '_Updating plan..._', 'awaiting_plan', src))
            .then(() => refreshFiles()).catch(() => {})
        }
      } else if (activePlan.phase === 'idle' && shouldUseOrchestrationForPrompt(trimmed) && !shouldForceAgenticMode(trimmed)) {
        if (isArchitect || isDesigner) {
          const src: PlanSource = isDesigner ? 'designer' : 'architect'
          effectivePrompt = buildArchitectPlanningPrompt(trimmed)
          setPlanFlow({ phase: 'awaiting_plan', originalPrompt: trimmed, planText: '', source: src })
          writeProjectFile(projPath, 'plan.md', formatPlanFile(trimmed, '_Generating plan..._', 'awaiting_plan', src))
            .then(() => refreshFiles()).catch(() => {})
        } else {
          effectivePrompt = buildPlanningOnlyPrompt(trimmed)
          setPlanFlow({ phase: 'awaiting_plan', originalPrompt: trimmed, planText: '', source: 'orchestration' })
          writeProjectFile(projPath, 'plan.md', formatPlanFile(trimmed, '_Generating plan..._', 'awaiting_plan', 'orchestration'))
            .then(() => refreshFiles()).catch(() => {})
        }
      }
    }

    // Auto-compact: if context exceeds threshold, compact before running
    const cfgNow = getConfig()
    if (cfgNow.behavior.autoCompact && !isCompacting) {
      const { contextLength } = getModelInfo()
      const { agentUsage } = useChatStore.getState()
      // Prefer actual token count from last API response; fall back to local estimate
      const lastKnown = agentUsage.lastInputTokens || 0
      const estimated = estimateMessagesTokens(messagesRef.current)
      const usedTokens = lastKnown > 0 ? lastKnown : estimated
      const threshold = cfgNow.behavior.autoCompactThreshold ?? 0.75
      if (contextLength > 0 && usedTokens > 0 && usedTokens / contextLength >= threshold) {
        await handleCompactRef.current()
        addLog(makeLogEntry('info', `Auto-compacted at ${Math.round(usedTokens / contextLength * 100)}% context`, 'system'))
      }
    }

    setIsAgentBusy(true); setCurrentTool(null)
    addLog(makeLogEntry('info', text.slice(0, 80) + (text.length > 80 ? '...' : ''), 'user'))

    const parts: MessagePart[] = text.trim() ? [{ type: 'text' as const, data: { text } }] : []
    if (attachments?.length) {
      for (const att of attachments) {
        if (att.type === 'image') parts.push({ type: 'image_url' as const, data: { url: `data:${att.mimeType};base64,${att.data}` } as any })
        else if (att.type === 'file') parts.push({ type: 'binary' as const, data: { name: att.name, mimeType: att.mimeType, data: att.data } as any })
      }
    }

    const userMsg = makeMsg('user', parts)
    messagesRef.current = [...messagesRef.current, userMsg]
    setMessages([...messagesRef.current])

    const assistantMsg = makeMsg('assistant', [])
    messagesRef.current = [...messagesRef.current, assistantMsg]
    setMessages([...messagesRef.current])
    const assistantId = assistantMsg.id
    const histBefore = messagesRef.current.filter(m => m.id !== assistantId && m.id !== userMsg.id)
    const abort = new AbortController(); abortRef.current = abort

    const effectiveAgentId = options?.overrideAgentId ?? (options?.fromLanding ? 'builtin:orchestration' : activeAgentId)
    const activeAgent = findAgent(allAgents, effectiveAgentId)
    const isOrchestration = activeAgent.id === 'builtin:orchestration' && !isSimpleTask(effectivePrompt)
    const agentPersona = activeAgent.id !== BUILTIN_AGENTS[0].id || activeAgent.instructions.trim()
      ? { name: activeAgent.name, instructions: activeAgent.instructions }
      : null
    const customInstructions = (() => {
      try { return localStorage.getItem('betopia:custom-instructions') ?? '' } catch { return '' }
    })()

    // Throttle streaming renders to ~20fps — avoids flooding React reconciler
    let lastStreamRender = 0
    let latestStreamParts: MessagePart[] | null = null
    // Cache index so hot-path ref update is O(1) instead of O(n) map
    const assistantMsgIdx = messagesRef.current.length - 1

    const flushStreamRender = () => {
      const snapshot = latestStreamParts
      if (!snapshot) return
      lastStreamRender = Date.now()
      setMessages(prev => {
        const n = [...prev]
        const idx = n.findIndex(m => m.id === assistantId)
        if (idx !== -1) n[idx] = { ...n[idx], parts: snapshot }
        messagesRef.current = n
        return n
      })
    }

    const agentCallbacks = {
        agentPersona,
        customInstructions,
        onPartsUpdate: async (parts: MessagePart[]) => {
          latestStreamParts = parts
          // O(1) ref update — mutate the slot directly, no array clone
          if (messagesRef.current[assistantMsgIdx]) {
            messagesRef.current = [
              ...messagesRef.current.slice(0, assistantMsgIdx),
              { ...messagesRef.current[assistantMsgIdx], parts },
              ...messagesRef.current.slice(assistantMsgIdx + 1),
            ]
          }

          const isFinish = parts.some(p => p.type === 'finish')
          const now = Date.now()
          // Only push to React state at ~20fps (50ms), or immediately on finish
          if (isFinish || now - lastStreamRender > 50) {
            flushStreamRender()
          }

          // Error scanning only on finish to avoid scanning every token
          if (isFinish) {
            parts.filter(p => p.type === 'text').forEach(p => {
              scanAgentOutputForErrors((p.data as any)?.text ?? '').forEach(e => addLog(makeLogEntry('warn', e.message, 'agent')))
            })
          }
          if (parts.some(p => p.type === 'finish')) {
            const flow = planFlowRef.current
            if (flow.phase === 'awaiting_plan') {
              const planText = collectTextFromParts(parts) || flow.planText
              // If the agent actually built something (ran bash/wrote files), the build is already
              // done — reset instead of showing a stale "Start build" confirmation.
              const agentBuilt = parts.some(p =>
                p.type === 'tool_call' && ['bash', 'write_file', 'edit'].includes((p.data as { name: string }).name)
              )
              if (agentBuilt) {
                resetPlanFlow()
              } else {
                setPlanFlow(prev => ({ ...prev, phase: 'awaiting_confirmation', planText }))
                if (projPath && planText) {
                  writeProjectFile(projPath, 'plan.md', formatPlanFile(flow.originalPrompt, planText, 'awaiting_confirmation', flow.source))
                    .then(() => refreshFiles()).catch(() => {})
                }
              }
            } else if (flow.phase === 'building') {
              // Mark plan as completed
              if (projPath && flow.planText) {
                writeProjectFile(projPath, 'plan.md', formatPlanFile(flow.originalPrompt, flow.planText, 'completed', flow.source)).catch(() => {})
              }
              resetPlanFlow()
            }

            // Persist immediately so messages survive app close before the 800ms debounce fires
            syncSessionMessages(messagesRef.current)

            const snapshotId = addCodeHistoryEntry(projPath, text)
            try {
              await refreshFiles()
              const latestFiles = await getFileTree(projPath)
              if (latestFiles.length > 0) {
                bumpPreviewKey()
              }
              saveSnapshot(projPath, latestFiles, snapshotId).catch(() => {})
            } catch (err) {
              console.error('Failed to refresh files after generation:', err)
            } finally {
              setIsAgentBusy(false)
              setCurrentTool(null)
              addLog(makeLogEntry('success', 'Generation complete', 'agent'))
              setAutoFixAttempts(0)
            }
          }
        },
        onFilesChanged: async () => {
          if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
          refreshTimerRef.current = setTimeout(async () => {
            if (!isRefreshingRef.current) {
              isRefreshingRef.current = true
              try { await refreshFiles(); bumpPreviewKey() } finally { isRefreshingRef.current = false }
            }
          }, 50)
        },
        onToolStart: (name: string) => { setCurrentTool(name); addLog(makeLogEntry('debug', `Tool: ${name}`, 'agent')) },
        onToolEnd: () => setCurrentTool(null),
        onUsage: (u) => updateUsage(u),
        onPermissionRequest: handlePermissionRequest,
        onApprovalRequired: handleApprovalRequired,
        onServerStarted: (url: string) => {
          // Only route frontend-like servers to the preview pane.
          // Backend ports (Django/FastAPI at 8000 etc.) must NOT set liveServerUrl —
          // they would show JSON/admin HTML instead of the app UI.
          // The post-orchestration URL detection handles backend via detectedBackendUrl.
          try {
            const port = parseInt(new URL(url).port)
            const FRONTEND_PORTS = new Set([5173, 5174, 5175, 5176, 3000, 3001, 4000, 4173, 8080, 8081])
            if (!FRONTEND_PORTS.has(port)) return
          } catch { return }
          setLiveServerUrl(url)
          setLiveServerMode('runtime')
          bumpPreviewKey()
          setPreviewTabOpen(true)
          setEditorView('preview')
          addLog(makeLogEntry('info', `Dev server running at ${url}`, 'preview'))
        },
      }

    try {
      if (isOrchestration) {
        const agentUrls = await runOrchestration(projPath, histBefore, effectivePrompt, agentCallbacks, abort.signal)
        // After all agents complete, refresh files and open preview + api docs
        if (!abort.signal.aborted) {
          try { await refreshFiles() } catch {}

          // ── Resolve preview and API docs URLs from agent output ──────────────
          //
          // TRUSTED path (Reviewer used the mandatory format):
          //   "Frontend running: http://localhost:PORT"  → use directly, no probe
          //   "Backend running:  http://localhost:PORT"  → use directly, no probe
          //
          // UNTRUSTED path (heuristic guesses from agent text, or no URL at all):
          //   TCP-probe common ports via Rust invoke('probe_port') to verify a
          //   server is actually listening before setting the URL.
          //   Falls back to handleRequestPreview if nothing responds.

          const probePort = async (url: string): Promise<boolean> => {
            try {
              const port = parseInt(new URL(url).port)
              if (!port) return false
              return await invoke<boolean>('probe_port', { port })
            } catch { return false }
          }

          // Use 127.0.0.1 (not localhost) — on Windows, localhost may resolve to ::1
          // which could point to a different project's server running on the same port.
          const FRONTEND_FALLBACK = [5173, 5174, 5175, 3000, 3001, 4000].map(p => `http://127.0.0.1:${p}`)
          const BACKEND_FALLBACK  = [8000, 8001, 8002, 5000, 5001, 9000, 8888].map(p => `http://127.0.0.1:${p}`)

          let foundFrontend: string | null = null
          let foundBackend:  string | null = null

          if (agentUrls.trusted) {
            // Reviewer confirmed these are running — use them directly
            foundFrontend = agentUrls.frontend ?? null
            foundBackend  = agentUrls.backend  ?? null
          } else {
            // Probe to verify before committing to a URL (FRONTEND_FALLBACK already has 127.0.0.1 URLs)
            const fCandidates = agentUrls.frontend
              ? [agentUrls.frontend, ...FRONTEND_FALLBACK]
              : FRONTEND_FALLBACK
            for (const url of fCandidates) {
              if (await probePort(url)) { foundFrontend = url; break }
            }
            const bCandidates = agentUrls.backend
              ? [agentUrls.backend, ...BACKEND_FALLBACK]
              : BACKEND_FALLBACK
            for (const url of bCandidates) {
              if (url === foundFrontend) continue
              if (await probePort(url)) { foundBackend = url; break }
            }
          }

          // Set preview URL
          if (foundFrontend) {
            setLiveServerUrl(foundFrontend)
            setLiveServerMode('runtime')
            bumpPreviewKey()
          } else {
            // Nothing found — start a server via Tauri (will run npm dev or serve dist/)
            await handleRequestPreviewRef.current()
          }
          setPreviewTabOpen(true)
          setEditorView('preview')

          // Set backend URL for API Docs scanner
          if (foundBackend) {
            setDetectedBackendUrl(foundBackend)
            setApiDocsTabOpen(true)
          }
        }
      } else {
        await runAgent(projPath, histBefore, effectivePrompt, agentCallbacks, abort.signal)
      }
    } catch (err) {
      const errName = (err as Error)?.name ?? ''
      const errMsg = (err instanceof Error ? err.message : String(err)).toLowerCase()
      const isCancelled = wasCancelledRef.current || errName === 'AbortError' || errName === 'APIUserAbortError' || errMsg.includes('cancel') || errMsg.includes('aborted')
      if (!isCancelled) {
        const em = err instanceof Error ? err.message : String(err)
        setMessages(prev => {
          const n = prev.map(m => m.id === assistantId ? { ...m, parts: [
            { type: 'text' as const, data: { text: `Error: ${em}` } },
            { type: 'finish' as const, data: { reason: 'error', time: Date.now() } },
          ]} : m)
          messagesRef.current = n; return n
        })
        addLog(makeLogEntry('error', `Agent error: ${em}`, 'agent', undefined, true))
      }
      setIsAgentBusy(false); setCurrentTool(null)
    } finally { abortRef.current = null; wasCancelledRef.current = false }
  }, [isAgentBusy, isCompacting, refreshFiles, handlePermissionRequest, addLog, resetPlanFlow,
      setMessages, setPlanFlow, setIsAgentBusy, setCurrentTool, bumpPreviewKey, setAutoFixAttempts,
      syncSessionMessages, setEditorView])

  const cancelAgent = useCallback(() => {
    approvalResolversRef.current.forEach(resolve => resolve(false))
    approvalResolversRef.current.clear()
    wasCancelledRef.current = true
    abortRef.current?.abort(); abortRef.current = null
    setIsAgentBusy(false); setCurrentTool(null); setIsFixing(false)
    addLog(makeLogEntry('warn', 'Generation cancelled', 'agent'))
    // Preserve any assistant content that already streamed in.
    // Only remove the placeholder row if the assistant never produced output.
    const current = messagesRef.current
    const last = current[current.length - 1]
    const next = last?.role === 'assistant' && !last.parts.some(p => p.type !== 'finish')
      ? current.slice(0, -1)
      : current
    messagesRef.current = next
    setMessages([...next])
    syncSessionMessages(next)
  }, [addLog, setIsAgentBusy, setCurrentTool, setIsFixing, setMessages, syncSessionMessages])

  const handleAutoFix = useCallback(async (error: DetectedError) => {
    if (isFixing || !error.fixPrompt || autoFixAttempts >= 3) return
    const projPath = pathRef.current
    if (!projPath) return
    setIsFixing(true); setAutoFixAttempts(n => n + 1)
    addLog(makeLogEntry('info', `Auto-fixing: ${error.message.slice(0, 60)}`, 'autofix'))
    const abort = new AbortController()
    try {
      await runAgent(projPath, messagesRef.current, error.fixPrompt, {
        onPartsUpdate: async (parts) => {
          parts.filter(p => p.type === 'text').forEach(p => {
            const t = (p.data as any)?.text ?? ''
            if (t) addLog(makeLogEntry('info', t.slice(0, 120), 'autofix'))
          })
        },
        onFilesChanged: async () => { await refreshFiles() },
      }, abort.signal)
    } catch { /* silent */ } finally { setIsFixing(false) }
  }, [isFixing, autoFixAttempts, addLog, setIsFixing, setAutoFixAttempts, refreshFiles])

  const handleCompact = useCallback(async () => {
    if (isCompacting || isAgentBusy || messagesRef.current.length === 0) return
    setIsCompacting(true)
    try {
      const history = messagesRef.current
        .map(m => {
          const textParts = m.parts.filter(p => p.type === 'text').map(p => (p.data as any)?.text ?? '').join('')
          return textParts ? `${m.role.toUpperCase()}: ${textParts}` : null
        })
        .filter(Boolean)
        .join('\n\n')
      const summary = await streamInlineEdit(
        `Summarize this conversation concisely. Preserve: key decisions, files created/modified, current task status, important context needed to continue. Be brief but complete.\n\n${history}`,
        () => {},
      )
      const now = Date.now()
      const activeId = useSessionStore.getState().activeId ?? 'default'
      const compactMsg = {
        id: `compact-${now}`,
        session_id: activeId,
        role: 'assistant' as const,
        parts: [
          { type: 'text' as const, data: { text: `[Conversation compacted]\n\n${summary}` } },
          { type: 'finish' as const, data: { reason: 'stop', time: now } },
        ],
        created_at: now,
        updated_at: now,
      }
      const next = [compactMsg]
      setMessages(next)
      messagesRef.current = next
      addLog(makeLogEntry('info', 'Conversation compacted', 'system'))
    } catch (e) {
      addLog(makeLogEntry('error', `Compact failed: ${e instanceof Error ? e.message : String(e)}`, 'system'))
    } finally {
      setIsCompacting(false)
    }
  }, [isCompacting, isAgentBusy, addLog, setMessages])
  useEffect(() => { handleCompactRef.current = handleCompact }, [handleCompact])

  const handleInlineChatSend = useCallback((text: string, fileName: string, onChunk: (chunk: string, done: boolean, err?: string) => void) => {
    const projPath = pathRef.current || projectPath || ''
    if (!projPath) { onChunk('', true, 'No project open.'); return }
    if (!pathRef.current) pathRef.current = projPath
    const abort = new AbortController()
    streamInlineEdit(text, (chunk) => onChunk(chunk, false), abort.signal)
      .then(async (fullText) => {
        const match = fullText.match(/```(?:\w*)\n([\s\S]*?)```/)
        if (match && fileName) {
          const normFile = fileName.replace(/\\/g, '/')
          await writeProjectFile(projPath, normFile, match[1])
          await refreshFiles()
        }
        onChunk('', true)
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        onChunk('', true, msg || 'Failed. Check your API key in Settings.')
      })
  }, [refreshFiles, projectPath])

  useEffect(() => {
    if (viewMode !== 'live' || !runtimeErrors.length || isAgentBusy || isFixing || autoFixAttempts >= 3) return
    const latest = runtimeErrors[runtimeErrors.length - 1]
    if (latest.fixPrompt) handleAutoFix({ ...latest, fixPrompt: `The preview has a runtime error. Please fix it automatically: ${latest.message}` })
  }, [runtimeErrors, viewMode, isAgentBusy, isFixing, autoFixAttempts, handleAutoFix])

  useEffect(() => {
    if (!isAgentBusy && messages.length) {
      const last = messages[messages.length - 1]
      if (last.role === 'assistant' && last.parts.some(p => p.type === 'finish')) {
        const t = setTimeout(() => refreshFiles().catch(console.error), 100)
        return () => clearTimeout(t)
      }
    }
  }, [isAgentBusy, messages, refreshFiles])



  useEffect(() => { if (viewMode !== 'code') return; refreshFiles().catch(() => {}) }, [viewMode, refreshFiles])

  // Fire pending prompt (from landing input) once workspace becomes ready
  useEffect(() => {
    if (status !== 'ready') return
    const pending = pendingPromptRef.current
    if (!pending) return
    pendingPromptRef.current = ''
    const t = setTimeout(() => sendMessageCore(pending, undefined, { fromLanding: true }), 400)
    return () => clearTimeout(t)
  }, [status, sendMessageCore])

  // Fire queued prompt once generation finishes (user chose "Run after")
  useEffect(() => {
    if (isAgentBusy || !queuedPrompt) return
    const prompt = queuedPrompt
    const atts = queuedAttachments
    setQueuedPrompt(null)
    const t = setTimeout(() => sendMessageCore(prompt, atts.length > 0 ? atts : undefined), 100)
    return () => clearTimeout(t)
  }, [isAgentBusy]) // eslint-disable-line react-hooks/exhaustive-deps

  const startBuildFromPlan = useCallback(async () => {
    if (isAgentBusy || planFlow.phase !== 'awaiting_confirmation') return
    const orig = planFlowRef.current.originalPrompt.trim()
    if (!orig) return
    // Set phase to 'building' immediately so rapid re-clicks are blocked
    setPlanFlow(prev => ({ ...prev, phase: 'building' }))
    const projPath = pathRef.current
    // Read latest plan.md from disk — user may have edited it in the editor
    let planText = planFlowRef.current.planText
    if (projPath) {
      try {
        const diskContent = await readProjectFile(projPath, 'plan.md')
        const parsed = parsePlanFile(diskContent)
        if (parsed !== null) planText = parsed.planText
      } catch { /* fallback to in-memory */ }
    }
    if (planText !== planFlowRef.current.planText) {
      setPlanFlow(prev => ({ ...prev, planText }))
    }
    const planSource = planFlowRef.current.source
    if (projPath && planText) {
      writeProjectFile(projPath, 'plan.md', formatPlanFile(orig, planText, 'building', planSource)).catch(() => {})
    }
    // Architect/Designer plans → execute with Coder; Orchestration → execute with Orchestration
    const overrideAgentId = (planSource === 'architect' || planSource === 'designer') ? 'builtin:coder' : undefined
    void sendMessageCore('Start build', undefined, { forceMode: 'orchestration', agentPrompt: buildStartBuildPrompt(orig, planText), skipPlanWorkflow: true, overrideAgentId })
  }, [isAgentBusy, planFlow.phase, sendMessageCore, setPlanFlow])



  // ── Preview & publish ────────────────────────────────────────────────────────

  const setAndPersistPublishState = useCallback((updater: PublishState | ((prev: PublishState) => PublishState)) => {
    setPublishState(prev => {
      const next = typeof updater === 'function' ? (updater as (p: PublishState) => PublishState)(prev) : updater
      if (pathRef.current) savePublishState(pathRef.current, next)
      return next
    })
  }, [])

  const handleRequestPreview = useCallback(async () => {
    const currentPath = projectPath || pathRef.current
    if (!currentPath) return
    const candidates: string[] = []; const seen = new Set<string>()
    const add = (v: string) => { const n = v.replace(/\\/g,'/').replace(/\/+$/,''); if (!n || seen.has(n)) return; seen.add(n); candidates.push(v) }
    const discovered = prioritizeRoots(findRunnableRoots(files), selectedFileRef.current, entryFileRef.current)
    for (const r of discovered) {
      const c = r ? `${currentPath.replace(/[/\\]+$/,'')}/${r.replace(/^[/\\]+/,'')}` : currentPath
      try { if (await pathExists(c)) add(c) } catch {}
    }
    add(currentPath)
    for (const c of candidates) {
      try {
        const started = await invoke<{ port: number; mode: string }>('start_live_server', { projectPath: c, port: 8000 })
        const port = typeof started?.port === 'number' ? started.port : 8000
        setLiveServerUrl(`http://127.0.0.1:${port}`)
        setLiveServerMode(started?.mode === 'runtime' ? 'runtime' : 'static')
        bumpPreviewKey()
        addLog(makeLogEntry('info', started?.mode === 'runtime' ? 'Preview: runtime server' : 'Preview: static server', 'preview'))
        return
      } catch {}
    }
    addLog(makeLogEntry('error', 'Failed to start preview', 'preview'))
    setLiveServerUrl(null); setLiveServerMode(null)
  }, [projectPath, files, setLiveServerUrl, setLiveServerMode, bumpPreviewKey, addLog])
  handleRequestPreviewRef.current = handleRequestPreview

  const handleStopServer = useCallback(async () => {
    try { await invoke('stop_live_server') } catch {}
    setLiveServerUrl(null); setLiveServerMode(null)
    addLog(makeLogEntry('info', 'Dev server stopped', 'preview'))
  }, [setLiveServerUrl, setLiveServerMode, addLog])

  // Terminal tab management
  const createTerminalTab = useCallback((shell?: { name: string; path: string; args: string[] }) => {
    // Use ref so this callback stays stable (empty deps) while reading current tabs
    const cur = terminalTabsRef.current
    const used = new Set(cur.flatMap(t => {
      const m = t.title.match(/^Terminal (\d+)$/)
      return m ? [Number(m[1])] : []
    }))
    let n = 1
    while (used.has(n)) n++
    const id = `t${++termTabSeqRef.current}`
    const title = shell ? shell.name : `Terminal ${n}`
    setTerminalTabs(prev => [...prev, { id, title, shell: shell?.path, shellArgs: shell?.args }])
    setActiveTerminalId(id)
    setShellDropdownOpen(false)
  }, [])

  const closeTerminalTab = useCallback((id: string) => {
    setTerminalTabs(prev => {
      const next = prev.filter(t => t.id !== id)
      if (next.length === 0) {
        setTerminalVisible(false)
        setActiveTerminalId(null)
      } else {
        setActiveTerminalId(cur => cur === id ? next[next.length - 1].id : cur)
      }
      return next
    })
  }, [])

  // Detect installed shells once on startup
  useEffect(() => {
    invoke<{ name: string; path: string; args: string[] }[]>('detect_shells')
      .then(shells => setAvailableShells(shells))
      .catch(() => {})
  }, [])

  // Create first tab when terminal is shown and no tabs exist yet
  useEffect(() => {
    if (terminalVisible && terminalTabs.length === 0) createTerminalTab()
  }, [terminalVisible, terminalTabs.length, createTerminalTab])

  // Collapse/expand the terminal panel imperatively so the panel stays mounted
  // (history preserved) when the user hides the terminal via the sidebar button.
  // Only the close-tab (X) action actually unmounts the panel.
  useEffect(() => {
    if (terminalTabs.length === 0) return
    if (terminalVisible) {
      terminalPanelRef.current?.expand()
    } else {
      terminalPanelRef.current?.collapse()
    }
  }, [terminalVisible, terminalTabs.length])

  // After the terminal panel becomes visible, directly call fit() on every
  // mounted terminal via the imperative handle. Three shots at 50/150/350ms
  // cover both instant-transition and slow-animation cases.
  useEffect(() => {
    if (!terminalVisible || terminalTabs.length === 0) return
    const fire = () => terminalRefs.current.forEach(t => t.fit())
    const t1 = setTimeout(fire, 50)
    const t2 = setTimeout(fire, 150)
    const t3 = setTimeout(fire, 350)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [terminalVisible, terminalTabs.length])

  // ── Keyboard shortcuts — single dispatcher (reads the rebindable registry) ──
  const forwardToEditor = useCallback((key: string) => {
    const cm = document.querySelector('.cm-content') as HTMLElement | null
    if (!cm) return
    cm.focus()
    cm.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }))
  }, [])

  useShortcuts({
    'settings.open':   () => setShowSettings(true),
    'settings.search': () => setShowSettingsSearch(prev => !prev),
    'home.goHome':     () => { goHome() },
    'file.new':        () => { handleNewFile() },
    'file.quickOpen':  () => { if (pathRef.current) setShowQuickOpen(true) },
    'tab.next':        () => cycleTab(1),
    'tab.prev':        () => cycleTab(-1),
    'tab.close':       () => { if (selectedFile) handleCloseTab(selectedFile) },
    'tab.reopen':      () => { const p = closedTabsRef.current.pop(); if (p) selectFile(p) },
    'project.open':    () => { handleOpenProject() },
    'view.code':       () => { if (pathRef.current) setViewMode('code') },
    'view.preview':    () => {
      if (pathRef.current && entryFileRef.current) {
        setViewMode('live')
        if (!liveServerUrl) handleRequestPreview()
      }
    },
    'view.terminal':   () => { if (pathRef.current) setTerminalVisible(prev => !prev) },
    'view.toggleCode': () => { if (pathRef.current) setCodeVisible(prev => !prev) },
    'view.togglePreview': () => {
      if (!pathRef.current) return
      setPreviewVisible(prev => {
        const next = !prev
        if (next && entryFileRef.current && !liveServerUrl) handleRequestPreview()
        return next
      })
    },
    'preview.reload':  () => { if (pathRef.current) { refreshFiles().catch(() => {}); bumpPreviewKey() } },
    'chat.focus':      () => window.dispatchEvent(new CustomEvent('betopia:focus-chat')),
    'chat.toggle':     () => setChatSidebarVisible(prev => {
      const next = !prev
      addLog(makeLogEntry('info', next ? 'Chat sidebar shown' : 'Chat sidebar hidden', 'system'))
      return next
    }),
    'explorer.search': () => window.dispatchEvent(new CustomEvent('betopia:focus-file-search')),
    'editor.save':     () => forwardToEditor('s'),
    'editor.undo':     () => forwardToEditor('z'),
    'editor.redo':     () => forwardToEditor('y'),
    ...(isAgentBusy ? { 'ai.cancel': () => cancelAgent() } : {}),
  })

  const handlePublishNow = useCallback(async () => {
    if (!projectPath || isPublishing) return
    setIsPublishing(true)
    try {
      const currentPath = projectPath || pathRef.current
      if (!currentPath) return
      const candidates: string[] = []; const seen = new Set<string>()
      const add = (v: string) => { const n = v.replace(/\\/g,'/').replace(/\/+$/,''); if (!n || seen.has(n)) return; seen.add(n); candidates.push(v) }
      for (const r of prioritizeRoots(findRunnableRoots(files), selectedFileRef.current, entryFileRef.current)) {
        const c = r ? `${currentPath.replace(/[/\\]+$/,'')}/${r.replace(/^[/\\]+/,'')}` : currentPath
        try { if (await pathExists(c)) add(c) } catch {}
      }
      add(currentPath)
      for (const sub of ['client','frontend','web','app','server','backend','api']) {
        try { const c = `${currentPath.replace(/[/\\]+$/,'')}/${sub}`; if (await pathExists(c)) add(c) } catch {}
      }
      const buildCandidates = (await Promise.all(candidates.map(async c => {
        try { return (await pathExists(`${c.replace(/[/\\]+$/,'')}/package.json`)) ? c : null } catch { return null }
      }))).filter((c): c is string => c !== null)
      let url: string | null = null
      for (const c of buildCandidates) {
        try {
          const result = await invoke<{ port: number; url: string }>('publish_project', { projectPath: c, port: 8088 })
          if (result?.url) { url = result.url.replace('localhost','127.0.0.1'); setLiveServerUrl(url); setLiveServerMode('build'); break }
        } catch {}
      }
      if (url) {
        setAndPersistPublishState(prev => ({ ...prev, isPublished: true, publishedUrl: url!, updatedAt: Date.now() }))
        setPublishedUrl(url); addLog(makeLogEntry('success', `Published at ${url}`, 'system'))
      } else { addLog(makeLogEntry('error', 'Publish failed', 'system')) }
    } catch (e) { addLog(makeLogEntry('error', `Publish error: ${e}`, 'system')) }
    finally { setIsPublishing(false) }
  }, [projectPath, isPublishing, setAndPersistPublishState, addLog, files, setLiveServerUrl, setLiveServerMode, setPublishedUrl, setIsPublishing])

  const handleResetProject = useCallback(async () => {
    if (isAgentBusy) return
    resetChat(); resetEditor(); resetUi()
    setPublishState(getDefaultPublishState())
    addLog(makeLogEntry('info', 'Workspace reset', 'system'))
  }, [isAgentBusy, addLog, resetChat, resetEditor, resetUi])

  const handleRestoreHistory = useCallback(async (snapshotId: string) => {
    const projPath = pathRef.current || projectPath
    if (!projPath) return
    try {
      const ok = await restoreSnapshot(projPath, snapshotId)
      if (ok) {
        await refreshFiles()
        bumpPreviewKey()
        if (entryFileRef.current) setViewMode('live')
      }
    } catch {}
  }, [projectPath, refreshFiles, bumpPreviewKey, setViewMode])

  const handleMakeCopy = useCallback(async () => {
    const currentPath = projectPath || pathRef.current
    if (!currentPath) return
    try {
      const copy = await duplicateProjectDirectory(currentPath)
      if (copy) { await openViaMenu(copy); addLog(makeLogEntry('success', 'Project duplicated', 'system')) }
    } catch (e) { addLog(makeLogEntry('error', `Duplicate failed: ${e}`, 'system')) }
  }, [projectPath, openViaMenu, addLog])

  // ── Render ────────────────────────────────────────────────────────────────────

  if (status === 'opening') {
    return (
      <div className="connecting">
        <div className="connecting-logo"><img src="/favicon.ico" alt="Betopia" style={{ width: 48, height: 48, objectFit: 'contain' }} /></div>
        <div className="spinner" />
        <p>Opening project...</p>
      </div>
    )
  }

  if (status === 'picking') {
    return (
      <>
        <ProjectPicker
          onOpen={openViaMenu}
          onCreate={handleOpenProject}
          onPromptCreate={handlePromptCreate}
        />
        {showSettings && <AgentSettings onClose={() => setShowSettings(false)} initialTab={settingsInitialTab} />}
        {showSettingsSearch && <SettingsSearch onClose={() => setShowSettingsSearch(false)} />}
        <button onClick={() => setShowSettings(true)} title="Settings" style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 50, width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-3)', cursor: 'pointer' }}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </>
    )
  }

  const hasStarted = Boolean(projectPath)
  const hasFiles = files.length > 0
  const panelSizes = (() => {
    const c = chatSidebarVisible, k = codeVisible, p = previewVisible, t = terminalVisible
    if (c && k && p && t) return { chat: 18, code: 27, preview: 28, terminal: 27 }
    if (c && k && p)      return { chat: 20, code: 40, preview: 40, terminal: 0  }
    if (c && k && t)      return { chat: 20, code: 40, preview: 0,  terminal: 40 }
    if (c && p && t)      return { chat: 20, code: 0,  preview: 40, terminal: 40 }
    if (k && p && t)      return { chat: 0,  code: 34, preview: 33, terminal: 33 }
    if (c && k)           return { chat: 25, code: 75, preview: 0,  terminal: 0  }
    if (c && p)           return { chat: 25, code: 0,  preview: 75, terminal: 0  }
    if (c && t)           return { chat: 25, code: 0,  preview: 0,  terminal: 75 }
    if (k && p)           return { chat: 0,  code: 50, preview: 50, terminal: 0  }
    if (k && t)           return { chat: 0,  code: 50, preview: 0,  terminal: 50 }
    if (p && t)           return { chat: 0,  code: 0,  preview: 50, terminal: 50 }
    if (c)                return { chat: 100, code: 0,  preview: 0,  terminal: 0  }
    if (k)                return { chat: 0,  code: 100, preview: 0,  terminal: 0  }
    if (p)                return { chat: 0,  code: 0,  preview: 100, terminal: 0  }
    return                  { chat: 0,  code: 0,  preview: 0,  terminal: 100 }
  })()

  return (
    <>
    <SurfaceLayer />
    <div className="app-layout">
      <LocalAgentNotificationsBridge
        status={agentRunStatus}
        error={null}
        visible={true}
        focused={windowFocused}
        onActivate={() => {}}
      />
      <Header
        projectPath={projectPath ?? ''}
        viewMode={viewMode}
        onViewChange={setViewMode}
        onGoHome={goHome}
        onOpenProject={handleOpenProject}
        onOpenFile={handleOpenFile}
        onNewFile={handleNewFile}
        onOpenRecent={openViaMenu}
        onOpenSettings={() => setShowSettings(true)}
        onRequestPreview={handleRequestPreview}
        onToggleChatSidebar={() => setChatSidebarVisible(prev => !prev)}
        chatSidebarVisible={chatSidebarVisible}
        codeVisible={codeVisible}
        previewVisible={previewVisible}
        terminalVisible={terminalVisible}
        canPreview={!projectPath || files.length === 0 || Boolean(entryFile) || canRunProject}
        onToggleCodeVisible={() => setCodeVisible(prev => !prev)}
        onTogglePreviewVisible={() => {
          if (!entryFile && !canRunProject) return
          if (!previewVisible) handleRequestPreview()
          setPreviewVisible(prev => !prev)
        }}
        onToggleTerminalVisible={() => setTerminalVisible(prev => !prev)}
        onResetProject={handleResetProject}
        liveServerUrl={liveServerUrl}
        isPublishing={isPublishing}
        hasStarted={hasStarted}
        publishVisibility={publishState.visibility as any}
        isPublished={publishState.isPublished}
        onChangePublishVisibility={(v: any) => setAndPersistPublishState(prev => ({ ...prev, visibility: v }))}
        onPublishNow={handlePublishNow}
        onOpenPublishSettings={() => setShowPublishDialog(true)}
        onDownloadAsZip={() => addLog(makeLogEntry('info', 'Download as ZIP coming soon', 'system'))}
        onOpenVersionHistory={() => addLog(makeLogEntry('info', 'Version history coming soon', 'system'))}
        onRestoreHistory={handleRestoreHistory}
        onMakeCopy={handleMakeCopy}
        onViewDocs={() => window.open('https://github.com', '_blank')}
        publishedUrl={publishedUrl}
        extraActions={null}
        onOpenSpotlight={() => setShowSettingsSearch(true)}
      />

      {!hasStarted && (
        <div className="landing-wrapper">
          <LandingChat isAgentBusy={isAgentBusy} onSend={(text) => { sendMessageCore(text, undefined, { fromLanding: true }) }} />
        </div>
      )}

      {hasStarted && (
        <PanelGroup
          key={`${chatSidebarVisible}-${codeVisible}-${previewVisible}`}
          direction="horizontal" className="app-body"
        >
          {codeVisible && (
            <>
              <Panel id="workspace" order={1} defaultSize={panelSizes.code} minSize={20}>
            {viewMode === 'code' && (
              <div className="workspace-area workspace-code">
                {/* Activity bar — VS Code-style left icon strip */}
                <div className="activity-bar">
                  <button
                    className={'activity-bar-btn' + (sidePanel === 'explorer' ? ' active' : '')}
                    onClick={() => setSidePanel(p => p === 'explorer' ? null : 'explorer')}
                    title="Explorer"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                  </button>
                  <button
                    className={'activity-bar-btn' + (sidePanel === 'search' ? ' active' : '')}
                    onClick={() => setSidePanel(p => p === 'search' ? null : 'search')}
                    title="Search"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                  </button>
                  <button
                    className={'activity-bar-btn' + (sidePanel === 'source-control' ? ' active' : '')}
                    onClick={() => setSidePanel(p => p === 'source-control' ? null : 'source-control')}
                    title="Source Control"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
                      <path d="M9 6h3a3 3 0 0 1 3 3v3"/><line x1="6" y1="9" x2="6" y2="15"/>
                    </svg>
                  </button>

                  <div className="activity-bar-sep" />

                  <button
                    className={'activity-bar-btn' + (previewTabOpen ? ' active' : '')}
                    disabled={Boolean(projectPath && files.length > 0 && !entryFile && !canRunProject)}
                    onClick={() => {
                      if (!previewTabOpen) {
                        handleRequestPreview()
                        setPreviewTabOpen(true)
                        setEditorView('preview')
                      } else {
                        setPreviewTabOpen(false)
                        setEditorView('code')
                      }
                    }}
                    title={projectPath && files.length > 0 && !entryFile && !canRunProject ? 'No preview — project has no frontend' : 'Preview'}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2"/>
                      <line x1="3" y1="9" x2="21" y2="9"/>
                      <line x1="9" y1="21" x2="9" y2="9"/>
                    </svg>
                  </button>
                  <button
                    className={'activity-bar-btn' + (terminalVisible ? ' active' : '')}
                    onClick={() => setTerminalVisible(prev => !prev)}
                    title="Terminal"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                    </svg>
                  </button>
                  <button
                    className={'activity-bar-btn' + (apiDocsTabOpen ? ' active' : '')}
                    onClick={() => {
                      if (!apiDocsTabOpen) {
                        setApiDocsTabOpen(true)
                        setEditorView('apidocs')
                      } else {
                        setApiDocsTabOpen(false)
                        setEditorView('code')
                      }
                    }}
                    title="API Docs"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="9" y1="13" x2="15" y2="13"/>
                      <line x1="9" y1="17" x2="13" y2="17"/>
                      <line x1="9" y1="9" x2="10" y2="9"/>
                    </svg>
                  </button>
                </div>

                <PanelGroup
                  key={sidePanel === null ? 'no-sidebar' : 'with-sidebar'}
                  direction="horizontal" autoSaveId="betopia-code" className="workspace-code-panels"
                >
                  {sidePanel !== null && (
                    <>
                      <Panel defaultSize={18} minSize={10} maxSize={40} id="explorer">
                        <div className="explorer-panel">
                          {sidePanel === 'search' ? (
                            <div className="activity-search-panel">
                              <div className="fe-header">
                                <span className="fe-title">Search</span>
                              </div>
                              <div className="activity-search-body">
                                <input
                                  className="activity-search-input"
                                  placeholder="Search files..."
                                  value={explorerSearch}
                                  onChange={e => setExplorerSearch(e.target.value)}
                                  autoFocus
                                />
                                {explorerSearch && (
                                  <p className="activity-search-hint">Matching filenames shown in Explorer.</p>
                                )}
                              </div>
                            </div>
                          ) : (
                            <FileTree
                              files={files}
                              rootName={projectPath?.split(/[\/\\]/).pop() || 'Project'}
                              selectedFile={selectedFile}
                              onSelect={selectFile}
                              onClearSelection={clearSelectedFile}
                              onChatWithFile={chatWithFile}
                              onCreateFile={handleCreateFile}
                              onCreateFolder={handleCreateFolder}
                              onRefresh={refreshFiles}
                              projectPath={projectPath}
                              searchQuery={explorerSearch}
                              onSearchQueryChange={setExplorerSearch}
                              autoExpandAll
                              forceView={sidePanel === 'source-control' ? 'source-control' : 'files'}
                            />
                          )}
                        </div>
                      </Panel>
                      <PanelResizeHandle className="panel-resize-handle" />
                    </>
                  )}
                  <Panel id="editor" minSize={30}>
                    <div className="editor-pane">
                      {(tabs.length > 0 || previewTabOpen || apiDocsTabOpen) && (
                        <TabBar
                          tabs={tabs}
                          activeTab={editorView === 'preview' || editorView === 'apidocs' ? null : selectedFile}
                          onSelectTab={(path) => { selectFile(path); setEditorView('code') }}
                          onCloseTab={handleCloseTab}
                          previewTabOpen={previewTabOpen}
                          previewTabActive={editorView === 'preview'}
                          onSelectPreviewTab={() => setEditorView('preview')}
                          onClosePreviewTab={() => { setPreviewTabOpen(false); setEditorView('code') }}
                          apiDocsTabOpen={apiDocsTabOpen}
                          apiDocsTabActive={editorView === 'apidocs'}
                          onSelectApiDocsTab={() => setEditorView('apidocs')}
                          onCloseApiDocsTab={() => { setApiDocsTabOpen(false); setEditorView('code') }}
                        />
                      )}
                      {editorView === 'preview' ? (
                        <div className="workspace-area workspace-preview">
                          {!hasFiles ? (
                            <div className="preview-no-files">
                              <div className="preview-no-files-icon">&#128065;</div>
                              <p className="preview-no-files-title">No files to preview</p>
                              <p className="preview-no-files-sub">Ask AI to generate your project first.</p>
                            </div>
                          ) : (
                            <LivePreview
                              projectPath={projectPath ?? ''}
                              entryFile={entryFile}
                              refreshKey={previewKey}
                              onChangeEntry={() => setShowEntryPicker(true)}
                              overrideSrc={publishedUrl ?? undefined}
                              serverUrl={liveServerUrl}
                              serverMode={liveServerMode}
                              onError={addRuntimeError}
                              onLog={addLog}
                              onSwitchToCode={() => setEditorView('code')}
                              onStopServer={handleStopServer}
                              hideBuilderBadge={publishState.hideBuilderBadge}
                            />
                          )}
                        </div>
                      ) : editorView === 'apidocs' ? (
                        <div className="workspace-area workspace-preview">
                          <ApiDocsPanel
                            projectPath={projectPath ?? ''}
                            serverUrl={detectedBackendUrl}
                          />
                        </div>
                      ) : (
                        <CodePanel
                          selectedFile={selectedFile}
                          fileContent={fileContent}
                          projectPath={projectPath ?? ''}
                          searchQuery={explorerSearch}
                          onFilesChanged={refreshFiles}
                          onMarkDirty={(path, dirty) => setTabs(prev => markTabDirty(prev, path, dirty))}
                          tabs={[]}
                          onSelectTab={selectFile}
                          onCloseTab={handleCloseTab}
                          onInlineChat={(sel, file) => setInlineChat({ selection: sel, fileName: file })}
                          activeDiff={selectedFile ? pendingDiffs.get(selectedFile) : undefined}
                          pendingDiffCount={pendingDiffs.size}
                          onDiffAccept={handleEditorDiffAccept}
                          onDiffReject={handleEditorDiffReject}
                          onDiffAcceptAll={() => {
                            for (const diff of pendingDiffs.values()) handleEditorDiffAccept(diff.approvalId)
                          }}
                          onDiffRejectAll={() => {
                            for (const diff of pendingDiffs.values()) handleEditorDiffReject(diff.approvalId)
                          }}
                          reviewableCount={reviewableAutoAcceptDiffs.size}
                          onReviewChanges={handleReviewAutoAcceptDiffs}
                        />
                      )}
                    </div>
                  </Panel>
                </PanelGroup>
              </div>
            )}

          {viewMode === 'live' && (
            <div className="workspace-area workspace-preview">
              {!hasFiles ? (
                <div className="preview-no-files">
                  <div className="preview-no-files-icon">&#128065;</div>
                  <p className="preview-no-files-title">No files to preview</p>
                  <p className="preview-no-files-sub">Switch to Code and ask AI to generate your project.</p>
                  <button className="preview-retry-btn" onClick={() => setViewMode('code')}>Go to Code</button>
                </div>
              ) : (
                <LivePreview
                  projectPath={projectPath ?? ''}
                  entryFile={entryFile}
                  refreshKey={previewKey}
                  onChangeEntry={() => setShowEntryPicker(true)}
                  overrideSrc={publishedUrl ?? undefined}
                  serverUrl={liveServerUrl}
                  serverMode={liveServerMode}
                  onError={addRuntimeError}
                  onLog={addLog}
                  onSwitchToCode={() => setViewMode('code')}
                  onStopServer={handleStopServer}
                  hideBuilderBadge={publishState.hideBuilderBadge}
                />
              )}
            </div>
          )}

            {/* {viewMode === 'dashboard' && <div className="workspace-area workspace-panel"><DashboardPanel projectName={projectPath?.split(/[\/\\]/).pop() || 'Project'} publishedUrl={publishedUrl} isPublished={publishState.isPublished} onMakeCopy={handleMakeCopy} onAskAI={msg => { setViewMode('code'); sendMessageCore(msg) }} /></div>} */}
            {/* {viewMode === 'database'  && <div className="workspace-area workspace-panel"><DatabasePanel onAskAI={msg => { setViewMode('code'); sendMessageCore(msg) }} /></div>} */}
            {/* {viewMode === 'storage'   && <div className="workspace-area workspace-panel"><StoragePanel onAskAI={msg => { setViewMode('code'); sendMessageCore(msg) }} /></div>} */}
            {/* {viewMode === 'settings'  && <div className="workspace-area workspace-panel"><SettingsPanel projectName={projectPath?.split(/[\/\\]/).pop() || 'Project'} publishedUrl={publishedUrl} isPublished={publishState.isPublished} onMakeCopy={handleMakeCopy} onAskAI={msg => { setViewMode('code'); sendMessageCore(msg) }} /></div>} */}
              </Panel>
              {(previewVisible || terminalTabs.length > 0 || chatSidebarVisible) && <PanelResizeHandle className="panel-resize-handle" />}
            </>
          )}

          {previewVisible && (
            <Panel id="live-preview" order={3} defaultSize={panelSizes.preview} minSize={15}>
              <div className="workspace-area workspace-preview">
                {!hasFiles ? (
                  <div className="preview-no-files">
                    <div className="preview-no-files-icon">&#128065;</div>
                    <p className="preview-no-files-title">No files to preview</p>
                    <p className="preview-no-files-sub">Switch to Code and ask AI to generate your project.</p>
                    <button className="preview-retry-btn" onClick={() => setViewMode('code')}>Go to Code</button>
                  </div>
                ) : (
                  <LivePreview
                    projectPath={projectPath ?? ''}
                    entryFile={entryFile}
                    refreshKey={previewKey}
                    onChangeEntry={() => setShowEntryPicker(true)}
                    overrideSrc={publishedUrl ?? undefined}
                    serverUrl={liveServerUrl}
                    serverMode={liveServerMode}
                    onError={addRuntimeError}
                    onLog={addLog}
                    onSwitchToCode={() => setViewMode('code')}
                    onStopServer={handleStopServer}
                    hideBuilderBadge={publishState.hideBuilderBadge}
                  />
                )}
              </div>
            </Panel>
          )}

          {previewVisible && terminalTabs.length > 0 && (
            <PanelResizeHandle
              className="panel-resize-handle"
              style={{ opacity: terminalVisible ? 1 : 0, pointerEvents: terminalVisible ? 'auto' : 'none' }}
            />
          )}

          {terminalTabs.length > 0 && (
            <Panel
              ref={terminalPanelRef}
              id="terminal-panel"
              order={4}
              defaultSize={Math.max(panelSizes.terminal, 25)}
              minSize={15}
              collapsible
              collapsedSize={0}
            >
              <div className="workspace-area workspace-terminal" style={{ flexDirection: 'column', display: terminalVisible ? 'flex' : 'none' }}>
                {/* Terminal tab bar */}
                <div className="term-tab-bar">
                  {terminalTabs.map(tab => (
                    <div
                      key={tab.id}
                      className={`term-tab${tab.id === activeTerminalId ? ' term-tab-active' : ''}`}
                      onClick={() => setActiveTerminalId(tab.id)}
                    >
                      <span className="term-tab-label">{tab.title}</span>
                      <button
                        className="term-tab-close"
                        onClick={e => { e.stopPropagation(); closeTerminalTab(tab.id) }}
                        title="Close terminal"
                      >✕</button>
                    </div>
                  ))}
                  {/* New terminal + shell picker */}
                  <div className="term-tab-actions">
                    <button className="term-tab-new" onClick={() => createTerminalTab()} title="New terminal">+</button>
                    {availableShells.length > 1 && (
                      <button
                        ref={shellBtnRef}
                        className="term-tab-new term-tab-caret"
                        title="Select shell"
                        onClick={() => {
                          const rect = shellBtnRef.current?.getBoundingClientRect()
                          if (rect) setShellDropdownPos({ top: rect.bottom + 2, right: window.innerWidth - rect.right })
                          setShellDropdownOpen(v => !v)
                        }}
                      >▾</button>
                    )}
                  </div>
                </div>
                {/* One Terminal per tab; hide inactive ones without unmounting */}
                {terminalTabs.map(tab => (
                  <div
                    key={tab.id}
                    style={{ flex: 1, display: tab.id === activeTerminalId ? 'flex' : 'none', minHeight: 0 }}
                  >
                    <Terminal
                      ref={el => { if (el) terminalRefs.current.set(tab.id, el); else terminalRefs.current.delete(tab.id) }}
                      sessionId={`term-${projectPath?.replace(/[/\\:]/g,'_') ?? 'x'}-${tab.id}`}
                      cwd={projectPath ?? undefined}
                      shell={tab.shell}
                      shellArgs={tab.shellArgs}
                    />
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {chatSidebarVisible && (
            <>
              {(codeVisible || previewVisible || terminalTabs.length > 0) && <PanelResizeHandle className="panel-resize-handle" />}
              <Panel defaultSize={panelSizes.chat} minSize={12} maxSize={45} id="chat" order={5}>
                <ChatPanel
                  messages={messages}
                  isAgentBusy={isAgentBusy}
                  currentTool={currentTool}
                  onSend={sendMessageCore}
                  onCancel={cancelAgent}
                  onHide={() => setChatSidebarVisible(false)}
                  onCompact={handleCompact}
                  isCompacting={isCompacting}
                  permissionMode={permissionMode}
                  onPermissionModeChange={setPermissionMode}
                  agentMode="inline"
                  projectPath={projectPath}
                  files={files}
                  pendingFileReference={pendingFileReference}
                  planPhase={planFlow.phase}
                  onStartBuildFromPlan={startBuildFromPlan}
                  onOpenPlanFile={openPlanFileInEditor}
                  onApprovalResponse={handleApprovalResponse}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
      )}

      <LogsPanel logs={logs} errors={runtimeErrors} isOpen={logsOpen}
        onToggle={() => setLogsOpen(!logsOpen)} onClose={() => setLogsOpen(false)}
        onAutoFix={handleAutoFix} onClearLogs={clearLogs} isFixing={isFixing} />

      {inlineChat && (
        <InlineChatPopup
          selection={inlineChat.selection}
          fileName={inlineChat.fileName}
          onSend={handleInlineChatSend}
          onClose={() => setInlineChat(null)}
        />
      )}
      {showEntryPicker && <EntryFilePicker files={files} onSelect={p => { setEntry(p); setShowEntryPicker(false) }} onCancel={files.length === 0 ? undefined : () => setShowEntryPicker(false)} />}
      {showSettings && <AgentSettings onClose={() => setShowSettings(false)} initialTab={settingsInitialTab} />}
      {showQuickOpen && <QuickOpen files={files} onSelect={p => { selectFile(p); setViewMode('code') }} onClose={() => setShowQuickOpen(false)} />}
      {showSettingsSearch && <SettingsSearch onClose={() => setShowSettingsSearch(false)} />}
      {showPublishDialog && (
        <PublishDialog
          projectPath={projectPath ?? ''}
          isPublished={publishState.isPublished}
          visibility={publishState.visibility}
          hideBuilderBadge={publishState.hideBuilderBadge}
          publishedUrl={publishedUrl}
          isPublishing={isPublishing}
          onClose={() => setShowPublishDialog(false)}
          onPublishNow={handlePublishNow}
          onVisibilityChange={v => setAndPersistPublishState(prev => ({ ...prev, visibility: v }))}
          onHideBadgeChange={v => setAndPersistPublishState(prev => ({ ...prev, hideBuilderBadge: v }))}
          onDuplicateProject={handleMakeCopy}
        />
      )}
      {inlinePermRequest && (
        <PermissionDialog
          tool={inlinePermRequest.tool}
          args={inlinePermRequest.args}
          onAllow={handlePermAllow}
          onDeny={handlePermDeny}
          onAllowAll={handlePermAllowAll}
        />
      )}
      {/* Shell picker dropdown — rendered via portal so it escapes overflow:hidden panels */}
      {shellDropdownOpen && shellDropdownPos && createPortal(
        <>
          <div className="fe-git-dropdown-overlay" onClick={() => setShellDropdownOpen(false)} />
          <div className="term-shell-dropdown" style={{ position: 'fixed', top: shellDropdownPos.top, right: shellDropdownPos.right }}>
            {availableShells.map(shell => (
              <button key={shell.path} className="term-shell-item" onClick={() => createTerminalTab(shell)}>
                <ShellIcon name={shell.name} />
                <span>{shell.name}</span>
              </button>
            ))}
          </div>
        </>,
        document.body
      )}

      {newFileOpen && (
        <div className="newfile-overlay" onClick={() => setNewFileOpen(false)}>
          <div className="newfile-dialog" onClick={e => e.stopPropagation()}>
            <div className="newfile-label">New file name</div>
            <input
              className="newfile-input"
              value={newFileName}
              onChange={e => setNewFileName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleNewFileSubmit(newFileName)
                if (e.key === 'Escape') setNewFileOpen(false)
              }}
              autoFocus
              placeholder="e.g. index.html, styles.css, app.js"
            />
            <div className="newfile-actions">
              <button className="newfile-cancel" onClick={() => setNewFileOpen(false)}>Cancel</button>
              <button className="newfile-confirm" onClick={() => handleNewFileSubmit(newFileName)}>Create</button>
            </div>
          </div>
        </div>
      )}
      {hasStarted && <StatusBar filePath={selectedFile} branch={gitBranch} errorCount={runtimeErrors.length} />}
    </div>
    </>
  )
}
