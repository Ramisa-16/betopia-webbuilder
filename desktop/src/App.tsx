/**
 * App.tsx — wiring layer only.
 * State: store/*  |  Logic: lib/*  |  UI: modules/*
 * No Go backend. All AI runs inline via lib/agent.ts.
 */

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { invoke } from '@tauri-apps/api/core'
import { exists as pathExists } from '@tauri-apps/plugin-fs'
import { normalizeDialogPath } from './lib/path'
import { IS_WINDOWS } from './lib/platform'
import { getFileTree, readProjectFile, writeProjectFile, ensureProjectDir, duplicateProjectDirectory, createProjectFile, createProjectFolder } from './lib/fs'
import { runAgent, streamInlineEdit, compactHistory, type AgentAuditEvent } from './lib/agent'
import { getConfig, saveConfig, migrateApiKeysToKeychain, initConfig, getModelInfo } from './lib/config'
import { restoreSessionsFromFile } from './store/sessionStore'
import { addCodeHistoryEntry, restoreCodeHistoryFromFile, saveSnapshot, restoreSnapshot } from './lib/codeHistory'
import { getDefaultPublishState, loadPublishState, savePublishState, type PublishState } from './lib/publish'
import { ensureProjectIdentity, markProjectRunning, markProjectStopped, readProjectRuntime, updateProjectRuntime } from './lib/project-runtime'
import { makeLogEntry, errorToLogEntry, scanAgentOutputForErrors } from './lib/error-detector'
import { appendAuditEvent, loadAuditEvents } from './lib/audit-log'
import { resizeImageForApi } from './lib/image-utils'
import { buildAttachmentContextBlock } from './lib/attachment-context'
import { fileExists } from './lib/manifest'
import type { SlashSkillOption } from './lib/builtin-skills'
import { BACKEND_CLEANUP_PORTS, BACKEND_PROBE_PORTS } from './lib/backend-routing'
import { getTypeScriptLspClient, invalidateTypeScriptLspProject } from './lib/lsp/typescript-client'
import type { LspDiagnostic } from './lib/lsp/types'
import { expandSnippetTokens } from './lib/snippets'
import { buildUrlContextBlock } from './lib/url-context'
import { estimateMessagesTokens } from './lib/tokenCounter'
import { estimateHistoryTokens } from './lib/agent-history'
import { findAgent, BUILTIN_AGENTS } from './lib/agents'
import { buildVisualAssetManifestTemplate, buildVisualAssetSourcingInstructions, resolveVisualAssets, shouldSourceVisualAssets } from './lib/asset-sourcing'
import { getQueuedPromptExecutionArgs } from './lib/queued-prompt'
import { prefetchBetopiaModels } from './lib/providers'
import { PluginManager, usePluginStore, usePanelStore } from './lib/plugin'
import { useAgentsStore } from './store/agentsStore'
import { useSnippetsStore } from './store/snippetsStore'
import { useSessionStore } from './store/sessionStore'
import type { Message, MessagePart, FileEntry, DetectedError, ApprovalData, ApprovalStatus, Attachment, SessionCompactionData } from './types'
import type { EditorRevealTarget, LspDefinitionTarget } from './lib/lsp/types'
import TabBar, { openTab, closeTab, markTabDirty, getAdjacentTab } from './modules/editor/components/TabBar'

import { useAppStore, type PermissionMode } from './store/appStore'
import { useChatStore } from './store/chatStore'
import type { PlanBuildPhase, PlanSource } from './store/chatStore'
import { useEditorStore } from './store/editorStore'
import { useUiStore } from './store/uiStore'
import { buildSkillPrompt, buildSkillVisibleText } from './lib/skill-routing'
import { isPlanApprovalPrompt, isPlanEditPrompt } from './lib/plan-intents'

import { ChatPanel, LandingChat } from './modules/chat'
import { AgentSwitcher } from './modules/ai'
// import { NotificationBell } from './modules/agents'
import { LocalAgentNotificationsBridge, type AgentRunStatus } from './modules/ai/components/LocalAgentNotificationsBridge'
import { Terminal, TerminalHandle } from './modules/terminal'
import { CodePanel } from './modules/editor'
import InlineChatPopup from './modules/editor/components/InlineChatPopup'
import { FileTree } from './modules/explorer'
import { LivePreview } from './modules/preview'
import { PreviewGeneratingState } from './modules/preview/components/LivePreview'
import ApiDocsPanel from './modules/preview/components/ApiDocsPanel'
import { AgentSettings, SettingsPanel, SettingsSearch } from './modules/settings'
import SurfaceLayer from './components/SurfaceLayer'
import { useShortcuts } from './lib/useShortcuts'
import { TASK_ACTION_PATTERN, shouldPromptModeSwitch, shouldSkipPlanning, shouldUsePlanningForPrompt } from './lib/mode-switch'
import QuickOpen from './modules/explorer/components/QuickOpen'
import StatusBar from './modules/workspace/components/StatusBar'
import {
  Header, /* DashboardPanel, DatabasePanel, StoragePanel, */
  LogsPanel, ProjectPicker, addRecent,
  EntryFilePicker,
} from './modules/workspace'

// ── Constants ────────────────────────────────────────────────────────────────

const CHAT_WIDTH_DEFAULT  = 344
const CHAT_WIDTH_MIN      = 120
const CHAT_WIDTH_EDGE_GAP = 120
const EXPLORER_WIDTH_DEFAULT  = 220
const EXPLORER_WIDTH_MIN      = 80
const EXPLORER_WIDTH_EDGE_GAP = 80
const FRONTEND_PREVIEW_PORTS = new Set([5173, 5174, 5175, 5176, 3000, 3001, 4000, 4173, 8080, 8081])
const PREVIEW_PROXY_PORT = 8790

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

// Detects casual/vague messages that should never trigger coding mode
function isCasualOrVague(prompt: string): boolean {
  const t = prompt.trim()
  if (t.length === 0) return true
  if (t.length <= 3) return true  // ".", "hi", "ok", "yo"
  const p = t.toLowerCase().replace(/[!?.]+$/, '').trim()
  if (/^(hi|hey|hello|howdy|sup|yo|hola|hiya|heya|greetings|good morning|good afternoon|good evening|what'?s up|how are you|how r u|how's it going)$/.test(p)) return true
  if (/^(thanks?|thank you|ty|thx|cheers|np|no problem|sure|got it|i see|understood|noted|ok|okay|alright|cool|great|awesome|nice|wow|interesting|sounds good|makes sense|perfect|good|k)$/.test(p)) return true
  return false
}

// Detects question prompts — agent should answer directly, no project_structure
function isQuestionPrompt(prompt: string): boolean {
  const t = prompt.trim()
  if (t.length > 300) return false  // long prompts are likely instructions, not questions
  const p = t.toLowerCase()
  const hasBuildIntent = /\b(build|create|make|generate|scaffold|write|develop|construct)\b/.test(p) || TASK_ACTION_PATTERN.test(p)
  if (hasBuildIntent) return false
  // Starts with question word or explanation request
  if (/^(what|why|how|when|where|which|who|is |are |does |do |can |could |should |would |explain|tell me|show me|describe|define|what's|whats|how's|hows)\b/.test(p)) return true
  // Contains question mark and no build intent
  if (p.includes('?') && !hasBuildIntent) return true
  return false
}

// Detects summary/overview prompts — agent should answer from conversation history, no tools
function isSummaryRequest(prompt: string): boolean {
  const p = prompt.trim().toLowerCase().replace(/[!?.]+$/, '').trim()
  if (/^(summaris[e]?|summarize|recap|overview|summary)(\s+it|\s+this|\s+everything|\s+what we (did|have done|built|made))?$/.test(p)) return true
  if (/^(what (have we|did we|we) (done|built|build|made|created|worked on)( here| so far)?|what('?s| is) done (so far|here)|where (were|are) we(\s+now)?|what weve done( here)?|whats been done)$/.test(p)) return true
  if (/^(project overview|task overview|progress (update|overview|summary)|show (me )?(the )?(progress|summary|overview)|give (me )?(a )?(summary|recap|overview))$/.test(p)) return true
  if (/^(what('?s| is) (the )?(status|progress)|fill me in|catch me up|bring me up to speed)$/.test(p)) return true
  return false
}

// Detects status-check prompts — agent should review + verify, not generate code
function isStatusCheck(prompt: string): boolean {
  const p = prompt.trim().toLowerCase().replace(/[!?.]+$/, '').trim()
  if (/\b(verify|check everything|status check|final check|health check)\b/.test(p)) return true
  if (/^(are we (good|done|fine|ok|okay|set|ready|there|finished|complete|all good)|is (it|everything|this) (working|ok|okay|good|fine|correct|clean|done)|did (it|that|this) work|is everything (ok|okay|working|fine|good|complete)|were we (fine|good|done|ok|okay)|in better shape|better now|fixed now|all good now|good now|is it fixed|did we (finish|complete|do it)|are we in good shape)$/.test(p)) return true
  if (/^(are you (fine|ok|okay|good|alright|working|there)|you (ok|fine|good|alright|working)|is (the system|it all) (ok|fine|good|working))$/.test(p)) return true
  return false
}

// Local response for casual/vague messages — no API call needed
function buildCasualReply(prompt: string, hasProjectContext: boolean): string {
  const p = prompt.trim().toLowerCase().replace(/[!?.]+$/, '').trim()
  if (/^(thanks?|thank you|ty|thx|cheers|np|no problem|got it|understood|noted|perfect|sounds good|makes sense)$/.test(p))
    return hasProjectContext ? "Glad to help! Let me know when you're ready to continue." : "No problem! What would you like to build?"
  if (/^(cool|great|awesome|nice|wow|interesting|ok|okay|alright|sure|good|k)$/.test(p))
    return hasProjectContext ? "Ready when you are." : "What would you like to build?"
  if (/^(hi|hey|hello|howdy|sup|yo|hola|hiya|heya|greetings|good morning|good afternoon|good evening)$/.test(p))
    return hasProjectContext ? "Hey! What do you need?" : "Hey! What would you like to build today?"
  if (prompt.trim().length <= 3 || /^[^a-z0-9]+$/i.test(prompt.trim()))
    return hasProjectContext ? "Want to continue where we left off?" : "What would you like to build?"
  return hasProjectContext ? "What do you need?" : "What would you like to build?"
}

function collectTextFromParts(parts: MessagePart[]): string {
  return parts.filter(p => p.type === 'text').map(p => (p.data as any)?.text ?? '').join('\n\n').trim()
}

function buildPlanningOnlyPrompt(userPrompt: string, editInstruction?: string, existingPlan?: string): string {
  const needsVisualAssets = shouldSourceVisualAssets(userPrompt)
  return [
    'You are in planning-only mode.',
    'Hard rule: do NOT create/edit/delete files and do NOT execute implementation tools.',
    'Hard rule: do NOT deploy.',
    'Return only a complete step-by-step implementation plan.',
    'Format EVERY implementation task as a checkbox: `- [ ] Task description`',
    'Include all folder/file plan, frontend, backend/API, database, integration, and validation steps.',
    needsVisualAssets ? 'If the page needs visuals, include a task to source or verify images and write `.betopia/assets.md`.' : '',
    'End by asking the user to choose Start build or Edit plan.',
    `\nProject request:\n${userPrompt.trim()}`,
    existingPlan?.trim() ? `\n\nCurrent plan draft:\n${existingPlan.trim()}` : '',
    editInstruction?.trim() ? `\n\nUser feedback:\n${editInstruction.trim()}` : '',
  ].join('\n')
}

function buildArchitectPlanningPrompt(userPrompt: string, editInstruction?: string, existingPlan?: string): string {
  const needsVisualAssets = shouldSourceVisualAssets(userPrompt)
  return [
    'You are in architecture planning mode.',
    'Hard rule: do NOT create/edit/delete files. Do NOT run implementation tools.',
    'Output a complete implementation plan structured as:',
    '1. Problem statement (1-2 sentences)',
    '2. Recommended approach with key tradeoffs',
    '3. File/folder structure',
    '4. Implementation tasks — format EVERY task as: `- [ ] Task description`',
    ...(needsVisualAssets
      ? [
          '5. Visual asset sourcing — add a task to find or verify relevant images and write `.betopia/assets.md`.',
          '6. Risks and open questions',
        ]
      : [
          '5. Risks and open questions',
        ]),
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
    'If the page needs visuals, source candidate images directly from the web and record them in `.betopia/assets.md`.',
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

function extractVisualAssetSearchSource(agentPrompt: string | undefined, fallback: string): string {
  if (!agentPrompt?.trim()) return fallback
  const requestMatch = agentPrompt.match(/(?:^|\n)(?:Original request|Project request):\n([\s\S]*?)(?:\n\n(?:Approved plan|Current plan draft|Existing plan):|$)/i)
  const extracted = requestMatch?.[1]?.trim()
  return extracted || fallback
}

function formatPlanFile(originalPrompt: string, planText: string, phase: string, source: PlanSource = 'coder'): string {
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
    const source: PlanSource = rawSource === 'architect' ? 'architect' : rawSource === 'designer' ? 'designer' : 'coder'
    return {
      phase,
      originalPrompt: requestMatch?.[1]?.trim() ?? '',
      planText: planMatch[1].trim(),
      source,
    }
  } catch { return null }
}

function isPlanFileForActivePlan(
  parsed: ReturnType<typeof parsePlanFile>,
  originalPrompt: string,
  source: PlanSource,
  phase: PlanBuildPhase,
): parsed is NonNullable<ReturnType<typeof parsePlanFile>> {
  return parsed !== null
    && parsed.phase === phase
    && parsed.source === source
    && parsed.originalPrompt.trim() === originalPrompt.trim()
    && parsed.planText.trim().length > 0
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

function collectFilePaths(entries: FileEntry[], result: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.is_dir) {
      if (entry.children?.length) collectFilePaths(entry.children, result)
    } else {
      result.push(entry.path.replace(/\\/g, '/'))
    }
  }
  return result
}

function sameFilePathSet(a: FileEntry[], b: FileEntry[]): boolean {
  const left = new Set(collectFilePaths(a))
  const right = collectFilePaths(b)
  if (left.size !== right.length) return false
  return right.every(path => left.has(path))
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

function formatAuditLog(event: AgentAuditEvent): { level: 'debug' | 'warn'; message: string; details: string } {
  const level = event.status === 'success' ? 'debug' : 'warn'
  const files = event.touchedFiles.length > 0 ? `files=${event.touchedFiles.join(',')}` : ''
  const approval = `approval=${event.approval}`
  const duration = `${event.durationMs}ms`
  const category = event.errorCategory ? `category=${event.errorCategory}` : ''
  const args = Object.entries(event.argsSummary)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')
  return {
    level,
    message: `Audit: ${event.toolName} ${event.status}`,
    details: [approval, files, category, duration, args].filter(Boolean).join(' · '),
  }
}

type SendOpts = {
  forceMode?: PermissionMode
  agentPrompt?: string
  skipPlanWorkflow?: boolean
  fromLanding?: boolean
  overrideAgentId?: string
  skipModeMismatchPrompt?: boolean
  _retryAfterCompact?: boolean
  _retryAfterTransient?: boolean
}

type ModeSwitchRequest = {
  text: string
  attachments?: any[]
  options?: SendOpts
  suggestedMode: PermissionMode
  reason: string
}

function lspDiagnosticKey(diagnostic: LspDiagnostic): string {
  return [
    diagnostic.path,
    diagnostic.range.start.line,
    diagnostic.range.start.character,
    diagnostic.range.end.line,
    diagnostic.range.end.character,
    diagnostic.message,
    diagnostic.code ?? '',
  ].join('|')
}

function sameLspDiagnostics(a: LspDiagnostic[], b: LspDiagnostic[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (lspDiagnosticKey(a[i]) !== lspDiagnosticKey(b[i])) return false
  }
  return true
}

function lspDiagnosticToRuntimeError(diagnostic: LspDiagnostic): DetectedError {
  return {
    id: `lsp-${lspDiagnosticKey(diagnostic)}`,
    category: 'type-error',
    message: diagnostic.message,
    file: diagnostic.path,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    timestamp: Date.now(),
    fixPrompt: `Fix this TypeScript diagnostic in ${diagnostic.path}: ${diagnostic.message}${diagnostic.code ? ` (TS${diagnostic.code})` : ''}`,
  }
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const { init: initSessions, activeId: activeSessionId, sessions,
    syncMessages: syncSessionMessages, hydrateMessages: hydrateSessionMessages,
    loadMessagesFromDisk: loadSessionMessagesFromDisk, syncCompaction: syncSessionCompaction, reset: resetSessions } = useSessionStore()
  const activeSession = sessions.find(s => s.id === activeSessionId)

  const activeAgentId   = useAgentsStore(s => s.activeId)
  const customAgents    = useAgentsStore(s => s.customAgents)
  const allAgents       = useMemo(() => [...BUILTIN_AGENTS, ...customAgents], [customAgents])
  const snippets        = useSnippetsStore(s => s.snippets)

  const { status, projectPath, permissionMode, effortLevel, setStatus, setProjectPath, setPermissionMode, setEffortLevel } = useAppStore()
  const { messages, isAgentBusy, currentTool, planFlow, isFixing, autoFixAttempts, pendingFileReference,
    queuedPrompt, queuedAttachments,
    setMessages, setIsAgentBusy, setCurrentTool, setPlanFlow, resetPlanFlow,
    setIsFixing, setAutoFixAttempts, setPendingFileReference, setQueuedPrompt, updateUsage,
    resetSessionUiState, reset: resetChat } = useChatStore()
  const { files, selectedFile, fileContent, tabs, entryFile, showEntryPicker, explorerSearch,
    setFiles, setSelectedFile, setFileContent, setTabs, setEntryFile, setShowEntryPicker, setExplorerSearch, reset: resetEditor } = useEditorStore()
  const { viewMode, previewKey, liveServerUrl, liveServerMode, publishedUrl, isPublishing,
    logs, runtimeErrors, logsOpen, chatWidth, explorerWidth, isResizingChat, isResizingExplorer,
    showSettings, settingsInitialTab,
    setViewMode, bumpPreviewKey, setLiveServerUrl, setLiveServerMode, setPublishedUrl, setIsPublishing,
    addLog, clearLogs, addRuntimeError, setLogsOpen, setChatWidth, setExplorerWidth,
    setIsResizingChat, setIsResizingExplorer, setShowSettings, reset: resetUi } = useUiStore()
  const [projectRuntimeStatus, setProjectRuntimeStatus] = useState<'running' | 'stopped' | null>(null)
  const [sourceControlRefreshTick, setSourceControlRefreshTick] = useState(0)

  // Refs (stable refs avoid stale closures in callbacks)
  const pathRef             = useRef<string>('')
  const selectedFileRef     = useRef<string | null>(null)
  const filesRef            = useRef<FileEntry[]>([])
  const messagesRef         = useRef<Message[]>([])
  const compactionRef       = useRef<SessionCompactionData | undefined>(undefined)
  const abortRef            = useRef<AbortController | null>(null)
  const permResolveRef      = useRef<((v: boolean) => void) | null>(null)
  const refreshTimerRef     = useRef<NodeJS.Timeout | null>(null)
  const projectDiagnosticsRequestRef = useRef(0)
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
  const sendMessageCoreRef = useRef<(text: string, attachments?: any[], options?: SendOpts) => Promise<void>>(async () => {})
  const modeSwitchRequestRef = useRef<ModeSwitchRequest | null>(null)
  const wasCancelledRef = useRef(false)
  const continueCounterRef = useRef(0)
  const lastAutoCompactSignatureRef = useRef<string | null>(null)
  const [isCompacting, setIsCompacting] = useState(false)


  useEffect(() => {
    compactionRef.current = activeSession?.compaction
  }, [activeSession?.compaction])

  const buildAgentHistory = useCallback((history: Message[], compaction = compactionRef.current): Message[] => {
    if (!compaction?.summary?.trim()) return history
    const cutIdx = history.findIndex(m => m.id === compaction.compactedThroughMessageId)
    if (cutIdx === -1) return history
    const summaryMsg: Message = {
      id: `compaction-${compaction.compactedThroughMessageId}`,
      session_id: activeSessionId ?? history[0]?.session_id ?? 'local',
      role: 'user',
      parts: [{ type: 'compaction', data: compaction as unknown as Record<string, unknown> }],
      created_at: compaction.compactedAt,
      updated_at: compaction.compactedAt,
    }
    return [summaryMsg, ...history.slice(cutIdx + 1)]
  }, [activeSessionId])

  const getVisibleContextTokens = useCallback(() => {
    const compactedThroughId = compactionRef.current?.compactedThroughMessageId
    if (!compactedThroughId) return estimateMessagesTokens(messagesRef.current)
    const compactedIdx = messagesRef.current.findIndex(m => m.id === compactedThroughId)
    if (compactedIdx === -1) return 0
    return estimateMessagesTokens(messagesRef.current.slice(compactedIdx + 1))
  }, [])

  const getAutoCompactTokens = useCallback(() => {
    // Use the same history shape the model receives, plus the built-in token
    // overhead already baked into estimateHistoryTokens().
    return estimateHistoryTokens(buildAgentHistory(messagesRef.current))
  }, [buildAgentHistory])

  const autoCompactIfNeeded = useCallback(async () => {
    const cfgNow = getConfig()
    if (!cfgNow.behavior.autoCompact || isCompacting) return false

    const threshold = cfgNow.behavior.autoCompactThreshold ?? 0.75
    let compacted = false

    for (let pass = 0; pass < 3; pass++) {
      const { contextLength } = getModelInfo()
      const usedTokens = getAutoCompactTokens()
      if (contextLength <= 0 || usedTokens <= 0 || usedTokens / contextLength < threshold) break
      if (isAgentBusy) break

      compacted = true
      await handleCompactRef.current()
    }

    return compacted
  }, [getAutoCompactTokens, isAgentBusy, isCompacting])

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
  const [editorRevealTarget, setEditorRevealTarget] = useState<EditorRevealTarget | null>(null)
  const [apiDocsTabOpen, setApiDocsTabOpen] = useState(false)
  const [detectedBackendUrl, setDetectedBackendUrl] = useState<string | null>(null)
  const [lspDiagnostics, setLspDiagnostics] = useState<LspDiagnostic[]>([])
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
  const [showSettingsSearch, setShowSettingsSearch] = useState(false)
  const [showQuickOpen, setShowQuickOpen] = useState(false)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [modeSwitchRequest, setModeSwitchRequest] = useState<ModeSwitchRequest | null>(null)
  useLayoutEffect(() => {
    if (terminalTabs.length === 0) return
    const terminalPanel = terminalPanelRef.current
    if (!terminalPanel) return

    if (terminalVisible) {
      terminalPanel.expand?.()
    } else {
      terminalPanel.collapse?.()
    }
  }, [terminalVisible, terminalTabs.length])
  useEffect(() => {
    setLspDiagnostics([])
    projectDiagnosticsRequestRef.current += 1
  }, [projectPath])
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
  const pendingAgentPromptRef = useRef<string>('')
  const pendingAttachmentsRef = useRef<Attachment[]>([])
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
  const skipNextSessionSyncRef = useRef(false)

  // Sync refs
  useEffect(() => { permissionModeRef.current = permissionMode }, [permissionMode])
  useEffect(() => { planFlowRef.current = planFlow }, [planFlow])
  useEffect(() => { modeSwitchRequestRef.current = modeSwitchRequest }, [modeSwitchRequest])
  useEffect(() => { filesRef.current = files }, [files])

  const modeAllowsAutomaticFileEdits = useCallback(() => {
    const mode = permissionModeRef.current
    return mode === 'auto_review' || mode === 'full_access'
  }, [])

  // Keep legacy yolo config in sync for non-UI tool paths. In the UI,
  // Auto mode intentionally means no permission prompts.
  useEffect(() => {
    const cfg = getConfig()
    const shouldYolo = permissionMode === 'full_access'
    if (cfg.behavior.yoloMode !== shouldYolo) saveConfig({ ...cfg, behavior: { ...cfg.behavior, yoloMode: shouldYolo } })
  }, [permissionMode])

  // Plugin manager instance (stable across renders)
  const pluginManagerRef = useRef<PluginManager | null>(null)

  // Restore persisted config + migrate keys to keychain + prefetch models + init plugins
  useEffect(() => {
    initConfig()
      .then(() => migrateApiKeysToKeychain())
      .catch(() => {})

    const pm = new PluginManager(
      {
        chat: {
          getMessages: () => messagesRef.current,
          sendMessage: (text: string) => setQueuedPrompt({ text }),
        },
        session: {
          getActiveSession: () => {
            const sid = useSessionStore.getState().activeId
            return useSessionStore.getState().sessions.find(s => s.id === sid) ?? null
          },
        },
        app: {
          getPermissionMode: () => permissionModeRef.current,
        },
      },
      '',
    )

    pm.on('plugin:activated', ({ pluginId }) => {
      const state = pm.getPluginState(pluginId)
      if (state) usePluginStore.getState().setPlugin(state)
    })

    pm.on('plugin:deactivated', ({ pluginId }) => {
      usePluginStore.getState().removePlugin(pluginId)
    })

    pm.on('plugin:error', ({ pluginId, error }) => {
      usePluginStore.getState().setPluginError(pluginId, error ?? 'unknown')
    })

    const cfg = getConfig()
    pm.configure(cfg.plugins ?? [])
    pm.loadAndActivateAll()
    pluginManagerRef.current = pm

    return () => {
      pm.deactivateAll()
      pluginManagerRef.current = null
    }
  }, [])

  // Register plugin panels into panel store when they change
  useEffect(() => {
    const pm = pluginManagerRef.current
    if (!pm) return
    const panels = pm.registry.getAllPanels()
    for (const { definition } of panels) {
      usePanelStore.getState().registerPanel(definition)
    }
  })

  // Clear explorer search on project change
  useEffect(() => { setExplorerSearch('') }, [projectPath, setExplorerSearch])

  // Sync messages → session store (debounced so streaming doesn't flood file writes)
  useEffect(() => {
    if (skipNextSessionSyncRef.current) {
      skipNextSessionSyncRef.current = false
      return
    }
    const t = setTimeout(() => syncSessionMessages(messages), 800)
    return () => clearTimeout(t)
  }, [messages, syncSessionMessages])

  // Load messages from active session when it changes
  useEffect(() => {
    if (!activeSession) return
    let cancelled = false
    resetSessionUiState()

    ;(async () => {
      let sessionMsgs = activeSession.messages
      if (sessionMsgs.length === 0) {
        const diskMsgs = await loadSessionMessagesFromDisk(activeSession.id)
        if (cancelled) return
        if (diskMsgs.length > 0) {
          sessionMsgs = diskMsgs
          hydrateSessionMessages(activeSession.id, diskMsgs)
        }
      }

      if (cancelled) return
      if (JSON.stringify(sessionMsgs) !== JSON.stringify(messagesRef.current)) {
        skipNextSessionSyncRef.current = true
        setMessages(sessionMsgs); messagesRef.current = sessionMsgs
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeSessionId, hydrateSessionMessages, loadSessionMessagesFromDisk, resetSessionUiState, setMessages])  // only when session switches

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

  const refreshProjectDiagnostics = useCallback(async (seedPath: string | null | undefined, seedContent?: string) => {
    const projPath = pathRef.current || projectPath
    if (!projPath || !seedPath) return

    let content = seedContent
    if (content == null) {
      try {
        content = await readProjectFile(projPath, seedPath)
      } catch {
        return
      }
    }

    const requestId = ++projectDiagnosticsRequestRef.current
    try {
      const diagnostics = await getTypeScriptLspClient().diagnostics(projPath, seedPath, content)
      if (requestId !== projectDiagnosticsRequestRef.current) return
      setLspDiagnostics(prev => sameLspDiagnostics(prev, diagnostics) ? prev : diagnostics)
    } catch {
      // Ignore transient diagnostics failures while the project is changing.
    }
  }, [projectPath])

  const refreshFiles = useCallback(async () => {
    const projPath = pathRef.current || projectPath
    if (!projPath) return
    if (!pathRef.current) pathRef.current = projPath
    try {
      const f = await getFileTree(projPath)
      if (!sameFilePathSet(filesRef.current, f)) invalidateTypeScriptLspProject(projPath)
      filesRef.current = f
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
          void refreshProjectDiagnostics(resolved, norm)
        } catch {
          try { setFileContent(await readProjectFile(projPath, resolved)) } catch { setFileContent('') }
        }
      } else { setSelectedFile(null); selectedFileRef.current = null; setFileContent('') }
      setSourceControlRefreshTick(t => t + 1)
    } catch {}
  }, [projectPath, resolveEntryFile, setFiles, setSelectedFile, setTabs, setFileContent, addLog, refreshProjectDiagnostics])

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

  const handleOpenDefinition = useCallback(async (target: LspDefinitionTarget) => {
    const normalized = normalizePathReq(target.path) || target.path
    setEditorView('code')
    setEditorRevealTarget({
      ...target,
      path: normalized,
      token: Date.now(),
    })
    if (normalized !== selectedFileRef.current) {
      await selectFile(normalized)
    }
  }, [selectFile])

  const handleDropFile = useCallback((path: string, content: string) => {
    const tabPath = path.replace(/\\/g, '/')
    setSelectedFile(tabPath); selectedFileRef.current = tabPath
    setTabs(prev => openTab(prev, tabPath))
    setFileContent(content)
  }, [setSelectedFile, setTabs, setFileContent])

  const openPlanFileInEditor = useCallback(async () => {
    const projPath = pathRef.current || projectPath
    const flow = planFlowRef.current
    if (projPath && flow.phase !== 'idle' && flow.originalPrompt.trim() && flow.planText.trim()) {
      let shouldWriteActivePlan = true
      try {
        const diskContent = await readProjectFile(projPath, 'plan.md')
        shouldWriteActivePlan = !isPlanFileForActivePlan(parsePlanFile(diskContent), flow.originalPrompt, flow.source, flow.phase)
      } catch {
        shouldWriteActivePlan = true
      }
      if (shouldWriteActivePlan) {
        await writeProjectFile(projPath, 'plan.md', formatPlanFile(flow.originalPrompt, flow.planText, flow.phase, flow.source))
          .then(() => refreshFilesRef.current())
          .catch(() => {})
      }
    }
    setViewMode('code')
    await selectFile('plan.md')
    setEditorView('code')
  }, [projectPath, selectFile, setEditorView, setViewMode])
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
    if (mode === 'full_access') return true
    if (mode === 'auto_review' && (tool === 'write_file' || tool === 'edit')) return true
    // plan_mode and default ask before edits.
    return new Promise<boolean>(resolve => { permResolveRef.current = resolve; setInlinePermRequest({ tool, args }) })
  }, [])

  const handlePermAllow    = useCallback(() => { permResolveRef.current?.(true);  permResolveRef.current = null; setInlinePermRequest(null) }, [])
  const handlePermDeny     = useCallback(() => { permResolveRef.current?.(false); permResolveRef.current = null; setInlinePermRequest(null) }, [])
  const handlePermAllowAll = useCallback(() => { setPermissionMode('full_access'); permResolveRef.current?.(true); permResolveRef.current = null; setInlinePermRequest(null) }, [setPermissionMode])

  const handleModeSwitchChoice = useCallback((nextMode?: PermissionMode) => {
    const pending = modeSwitchRequestRef.current
    if (!pending) return
    setModeSwitchRequest(null)
    modeSwitchRequestRef.current = null

    if (!nextMode) return

    permissionModeRef.current = nextMode
    setPermissionMode(nextMode)

    void sendMessageCoreRef.current(pending.text, pending.attachments, {
      ...pending.options,
      forceMode: nextMode,
      skipModeMismatchPrompt: true,
    })
  }, [setPermissionMode])

  const handleApprovalRequired = useCallback((approvalId: string, toolName: string): Promise<boolean | string> => {
    const mode = permissionModeRef.current
    if (mode === 'full_access') return Promise.resolve(true)
    if (mode === 'auto_review' && (toolName === 'write_file' || toolName === 'edit')) return Promise.resolve(true)
    // plan_mode: ask before edits (same as default).
    // default: block until user explicitly accepts or rejects.
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
            .then(() => {
            return getTypeScriptLspClient().syncFile(pathRef.current || projectPath || '', revertInfo.path, revertInfo.originalContent)
              .then(() => refreshFilesRef.current())
            })
            .catch(() => {})
        } else if (approved && content) {
          writeProjectFile(pathRef.current, revertInfo.path, content)
            .then(() => {
            return getTypeScriptLspClient().syncFile(pathRef.current || projectPath || '', revertInfo.path, content)
              .then(() => refreshFilesRef.current())
            })
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

  const activateRuntimePreview = useCallback(async (url: string, openPreview = false): Promise<boolean> => {
    let port: number
    try {
      const parsed = new URL(url)
      if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return false
      port = Number(parsed.port)
    } catch {
      return false
    }

    if (!FRONTEND_PREVIEW_PORTS.has(port)) return false

    setLiveServerUrl(url)
    setLiveServerMode('runtime')
    setProjectRuntimeStatus('running')
    const scopePath = pathRef.current
    if (scopePath) {
      const portValue = Number(port)
      updateProjectRuntime(scopePath, {
        status: 'running',
        preview: { url, mode: 'runtime', port: Number.isFinite(portValue) ? portValue : null },
      }).catch(() => {})
    }
    bumpPreviewKey()
    if (openPreview) {
      setPreviewTabOpen(true)
      setEditorView('preview')
    }
    addLog(makeLogEntry('info', `Preview: using dev server at ${url}`, 'preview'))
    return true
  }, [setLiveServerUrl, setLiveServerMode, bumpPreviewKey, setPreviewTabOpen, setEditorView, addLog])

  const stopListeningPorts = useCallback(async (ports: number[]) => {
    const uniquePorts = [...new Set(ports.filter(port => Number.isFinite(port) && port > 0))]
    if (uniquePorts.length === 0) return
    try {
      await invoke('stop_listening_ports', { ports: uniquePorts })
    } catch {}
  }, [])

  const stopProjectRuntimeArtifacts = useCallback(async (projectPath: string) => {
    if (!projectPath) return
    try {
      await invoke('stop_project_runtime_artifacts', { projectPath })
    } catch {}
  }, [])

  const stopProjectServers = useCallback(async (projectToClose?: string | null) => {
    const closePath = projectToClose || pathRef.current
    if (closePath) {
      // Stop only background commands tied to this project.
      try {
        await invoke('shell_bg_stop_project', { projectPath: closePath })
      } catch {}

      await stopProjectRuntimeArtifacts(closePath)
      await stopListeningPorts(BACKEND_CLEANUP_PORTS)

      const runtime = await readProjectRuntime(closePath).catch(() => null)
      const portCandidates = new Set<number>()
      const addPort = (value?: number | null) => {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) portCandidates.add(value)
      }
      try {
        if (liveServerUrl) addPort(Number(new URL(liveServerUrl).port))
      } catch {}
      try {
        if (detectedBackendUrl) addPort(Number(new URL(detectedBackendUrl).port))
      } catch {}
      addPort(runtime?.preview?.port ?? null)
      addPort(runtime?.backend?.port ?? null)
      for (const port of portCandidates) {
        await stopListeningPorts([port])
      }

      markProjectStopped(closePath, {
        preview: { url: null, mode: null, port: null },
        backend: { running: false, entryCwd: null, command: null, procId: null, url: null, port: null },
        watcher: { running: false },
      }).catch(() => {})
    }

    try { await invoke('stop_live_server') } catch {}
  }, [stopListeningPorts, stopProjectRuntimeArtifacts])

  const openWorkspace = useCallback(async (path: string) => {
    const previousPath = pathRef.current
    if (previousPath && previousPath !== path) {
      await stopProjectServers(previousPath)
      try { await invoke('stop_file_watcher') } catch {}
    }
    addRecent(path)   // always track, regardless of how project was opened
    pathRef.current = path
    setLiveServerUrl(null); setLiveServerMode(null); setDetectedBackendUrl(null)
    setProjectRuntimeStatus(null)
    setPreviewTabOpen(false); setApiDocsTabOpen(false)
    const loaded = loadPublishState(path)
    setPublishState(loaded); setPublishedUrl(loaded.publishedUrl ?? null)
    await ensureProjectDir(path)
    await ensureProjectIdentity(path).catch(() => {})
    const runtime = await readProjectRuntime(path).catch(() => null)
    setProjectRuntimeStatus(runtime?.status ?? null)
    clearLogs()

    const f = await getFileTree(path)
    await Promise.all([
      restoreSessionsFromFile(path).catch(() => {}),
      restoreCodeHistoryFromFile(path).catch(() => {}),
    ])
    const historyFallback = loadInlineChat(path)
    initSessions(path, historyFallback)
    // Read messages from the now-active session. Sessions only store metadata in localStorage (messages
    // stripped to save quota), so hydrate from JSONL before falling back to legacy inline history.
    const { sessions: restoredSessions, activeId: restoredActiveId } = useSessionStore.getState()
    const sessionMsgs = restoredSessions.find(s => s.id === restoredActiveId)?.messages ?? []
    const diskMsgs = restoredActiveId ? await loadSessionMessagesFromDisk(restoredActiveId) : []
    const activeMessages = sessionMsgs.length > 0 ? sessionMsgs : diskMsgs.length > 0 ? diskMsgs : historyFallback
    if (restoredActiveId && sessionMsgs.length === 0 && diskMsgs.length > 0) {
      hydrateSessionMessages(restoredActiveId, diskMsgs)
    }
    setProjectPath(path); setFiles(f); setMessages(activeMessages); messagesRef.current = activeMessages
    skipNextSessionSyncRef.current = true
    if (restoredActiveId && sessionMsgs.length === 0 && diskMsgs.length === 0 && historyFallback.length > 0) {
      syncSessionMessages(historyFallback)
    }
    setSelectedFile(null); selectedFileRef.current = null; setFileContent('')
    setIsAgentBusy(false); setCurrentTool(null); bumpPreviewKey()
    setEntry(null); setShowEntryPicker(false); setTabs([])
    setTerminalTabs([]); setActiveTerminalId(null); termTabSeqRef.current = 0
    resolveEntryFile(f); setStatus('ready')
    // Start filesystem watcher for external changes
    invoke('start_file_watcher', { projectPath: path }).catch(() => {})
    markProjectRunning(path, {
      watcher: { running: true },
    }).catch(() => {})
    addLog(makeLogEntry('info', activeMessages.length > 0 ? 'Project opened with history' : 'Project opened', 'system'))
    // Restore persisted audit events into the log panel (best-effort, non-blocking)
    ;(async () => {
      const pastEvents = await loadAuditEvents(path)
      for (const event of pastEvents) {
        const audit = formatAuditLog(event)
        addLog(makeLogEntry(audit.level, `[restored] ${audit.message}`, 'agent', audit.details))
      }
    })()
    // Auto-start project servers if start_servers.py exists (runs non-blocking after UI is ready)
    ;(async () => {
      try { await invoke('fs_stat', { path: `${path}/start_servers.py` }) } catch { return }
      // Kill any stale servers from a previous session for this project
      await stopProjectRuntimeArtifacts(path)
      await stopListeningPorts(BACKEND_CLEANUP_PORTS)
      const bgId = 'betopia-project-servers'
      // Brief pause so killed processes fully release their ports before the new servers bind
      await new Promise(r => setTimeout(r, 2000))
      try { await invoke('shell_bg_start', { id: bgId, command: 'python start_servers.py', cwd: path }) } catch { return }
      markProjectRunning(path, {
        backend: { running: true, entryCwd: path, command: 'python start_servers.py', procId: bgId },
      }).catch(() => {})
      const deadline = Date.now() + 60000
      let frontend: string | null = null
      let backend: string | null = null
      let gotFirst = false; let firstTime = 0
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500))
        if (pathRef.current !== path) return
        const logs = await invoke<string[]>('shell_bg_logs', { id: bgId })
        const txt = logs.join('\n')
        if (!frontend) { const m = txt.match(/Frontend running: (http:\/\/127\.0\.0\.1:\d+)/); if (m) { frontend = m[1]; gotFirst = true; firstTime = Date.now() } }
        if (!backend)  { const m = txt.match(/Backend running: (http:\/\/127\.0\.0\.1:\d+)/);  if (m) { backend  = m[1]; gotFirst = true; firstTime = Date.now() } }
        if (frontend && backend) break
        if (gotFirst && Date.now() - firstTime > 5000) break
      }
      if (pathRef.current !== path) return
      if (frontend) {
        await activateRuntimePreview(frontend, true)
        updateProjectRuntime(path, {
          preview: { url: frontend, mode: 'runtime', port: Number(new URL(frontend).port) || null },
          status: 'running',
        }).catch(() => {})
      }
      if (backend)  {
        setDetectedBackendUrl(backend); setApiDocsTabOpen(true)
        updateProjectRuntime(path, {
          backend: { running: true, entryCwd: path, command: 'python start_servers.py', procId: bgId },
          status: 'running',
        }).catch(() => {})
      }
    })().catch(() => {})
  }, [resolveEntryFile, setEntry, addLog, loadInlineChat, clearLogs, setPublishedUrl,
      setProjectPath, setFiles, setMessages, setSelectedFile, setFileContent, setIsAgentBusy,
      setCurrentTool, bumpPreviewKey, setShowEntryPicker, setTabs, setStatus,
      setLiveServerUrl, setLiveServerMode, setPreviewTabOpen, setEditorView, setDetectedBackendUrl, setApiDocsTabOpen,
      activateRuntimePreview, stopProjectServers, stopProjectRuntimeArtifacts])

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

  // Listen for filesystem watcher events (external file changes via git pull, terminal, etc.)
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let alive = true
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ paths: string[] }>('betopia:file-changed', () => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = setTimeout(async () => {
          if (!isRefreshingRef.current) {
            isRefreshingRef.current = true
            try { await refreshFiles(); bumpPreviewKey() } finally { isRefreshingRef.current = false }
          }
        }, 50)
      }).then((u) => { if (alive) unlisten = u; else u() }).catch(() => {})
    })
    return () => { alive = false; unlisten?.() }
  }, [refreshFiles, bumpPreviewKey])

  const cleanupWorkspace = useCallback(async () => {
    abortRef.current?.abort(); abortRef.current = null

    const projPath = pathRef.current
    if (projPath) {
      try { await invoke('shell_bg_stop_project', { projectPath: projPath }) } catch {}
      await stopProjectRuntimeArtifacts(projPath)

      // 2. Silent fallback: kill anything still holding common dev ports regardless of PID tracking.
      //    Covers processes that escaped both the project-scoped bg stop and the PID file (e.g. manually started).
      await stopListeningPorts(BACKEND_CLEANUP_PORTS)
      markProjectStopped(projPath, {
        preview: { url: null, mode: null, port: null },
        backend: { running: false, entryCwd: null, command: null, procId: null, url: null, port: null },
        watcher: { running: false },
      }).catch(() => {})
    }
    // 3. Stop every tracked background job plus the Rust static file server.
    try { await invoke('shell_bg_stop_all') } catch {}
    try { await invoke('stop_live_server') } catch {}
    try { await invoke('stop_file_watcher') } catch {}
    pathRef.current = ''; selectedFileRef.current = null; messagesRef.current = []
    setPreviewTabOpen(false); setApiDocsTabOpen(false); setDetectedBackendUrl(null)
    setProjectRuntimeStatus(null)
    // Reset session store FIRST (sets activeId → null) so the syncMessages effect
    // triggered by resetChat's message clear is a no-op and doesn't wipe session data.
    resetSessions()
    resetChat(); resetEditor(); resetUi()
    setPublishState(getDefaultPublishState()); setInlinePermRequest(null)
  }, [resetSessions, resetChat, resetEditor, resetUi, stopListeningPorts])

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
  const handlePromptCreate = useCallback(async (promptText: string, attachments?: Attachment[], skill?: SlashSkillOption | null) => {
    const clearPendingPromptCreate = () => {
      pendingPromptRef.current = ''
      pendingAgentPromptRef.current = ''
      pendingAttachmentsRef.current = []
    }

    try {
      let baseFolder = ''
      try { baseFolder = JSON.parse(localStorage.getItem('betopia:general-prefs') ?? '{}').projectsFolder ?? '' } catch {}

      if (!baseFolder) {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({ directory: true, multiple: false, title: 'Choose project folder' })
        const path = normalizeDialogPath(selected)
        if (path) {
          pendingPromptRef.current = skill ? buildSkillVisibleText(skill, promptText) : promptText
          pendingAgentPromptRef.current = skill ? buildSkillPrompt(skill, promptText) : ''
          pendingAttachmentsRef.current = attachments ?? []
          try {
            await openViaMenu(path)
          } catch {
            clearPendingPromptCreate()
            throw new Error('Failed to open selected project folder')
          }
        }
        return
      }

      const baseName = promptToFolderName(promptText.trim() || skill?.name || promptText)
      const sep = baseFolder.includes('\\') ? '\\' : '/'
      const { mkdir, exists } = await import('@tauri-apps/plugin-fs')
      let finalName = baseName
      let i = 1
      while (await exists(`${baseFolder}${sep}${finalName}`)) finalName = `${baseName}-${i++}`
      const newPath = `${baseFolder}${sep}${finalName}`
      await mkdir(newPath, { recursive: true })
      pendingPromptRef.current = skill ? buildSkillVisibleText(skill, promptText) : promptText
      pendingAgentPromptRef.current = skill ? buildSkillPrompt(skill, promptText) : ''
      pendingAttachmentsRef.current = attachments ?? []
      try {
        await openViaMenu(newPath)
      } catch {
        clearPendingPromptCreate()
        throw new Error('Failed to open newly created project folder')
      }
    } catch {
      clearPendingPromptCreate()
    }
  }, [openViaMenu])

  // ── Send message ──────────────────────────────────────────────────────────────

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
    const activePermissionMode = options?.forceMode ?? permissionModeRef.current
    const canAutoEdit = activePermissionMode === 'auto_review' || activePermissionMode === 'full_access'
    const isArchitect = activeAgentId === 'builtin:architect'
    const isDesigner = activeAgentId === 'builtin:designer'

    if (
      !options?.skipModeMismatchPrompt &&
      activePermissionMode === 'plan_mode' &&
      activePlan.phase !== 'idle' &&
      !isCasualOrVague(trimmed) &&
      !isStatusCheck(trimmed) &&
      !isSummaryRequest(trimmed) &&
      !isQuestionPrompt(trimmed) &&
      shouldPromptModeSwitch(trimmed) &&
      !shouldSkipPlanning(trimmed)
    ) {
      setModeSwitchRequest({
        text,
        attachments,
        options,
        suggestedMode: 'auto_review',
        reason: 'This looks like a build task, but Plan mode is selected.',
      })
      return
    }

    // Early return for casual/vague: no API call, no context sent, no busy state
    if (
      isCasualOrVague(trimmed) &&
      !options?.agentPrompt &&
      !attachments?.length
    ) {
      const hasContext = messagesRef.current.some(
        m => m.role === 'assistant' && m.parts.some(p => p.type === 'text')
      )
      const replyText = buildCasualReply(trimmed, hasContext)
      const userMsg = makeMsg('user', [{ type: 'text' as const, data: { text } }])
      const assistantMsg = makeMsg('assistant', [
        { type: 'text' as const, data: { text: replyText } },
        { type: 'finish' as const, data: { reason: 'stop', time: Date.now() } },
      ])
      messagesRef.current = [...messagesRef.current, userMsg, assistantMsg]
      setMessages([...messagesRef.current])
      syncSessionMessages(messagesRef.current)
      addLog(makeLogEntry('info', text.slice(0, 80), 'user'))
      useChatStore.getState().clearTaskDone()
      return
    }

    // Question: answer directly, no project_structure, no unnecessary file reads
    if (
      isQuestionPrompt(trimmed) &&
      !options?.agentPrompt &&
      !attachments?.length
    ) {
      effectivePrompt = `[INTENT: QUESTION — answer directly from knowledge and conversation context. Only use read_file/grep_search if the specific answer requires reading project code. Do NOT run project_structure or list_files.]\n\n${trimmed}`
    }

    // Summary request: use streamInlineEdit with conversation text — bypasses context limit entirely
    if (
      isSummaryRequest(trimmed) &&
      !options?.agentPrompt &&
      !attachments?.length
    ) {
      const historyText = messagesRef.current
        .map(m => {
          const textParts = m.parts.filter(p => p.type === 'text').map(p => (p.data as any)?.text ?? '').join('')
          return textParts ? `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${textParts.slice(0, 800)}` : null
        })
        .filter(Boolean)
        .join('\n\n')
      const userMsg = makeMsg('user', [{ type: 'text' as const, data: { text } }])
      messagesRef.current = [...messagesRef.current, userMsg]
      setMessages([...messagesRef.current])
      addLog(makeLogEntry('info', text.slice(0, 80), 'user'))
      try {
        const result = await streamInlineEdit(
          `Based on this conversation, summarize what was built and done in this session. List: completed tasks, files created/modified, current state of the project. Be clear and structured.\n\nConversation:\n${historyText}`,
          () => {},
        )
        const now = Date.now()
        const activeSessionId = useSessionStore.getState().activeId ?? 'default'
        const summaryMsg = {
          id: `summary-${now}`,
          session_id: activeSessionId,
          role: 'assistant' as const,
          parts: [
            { type: 'text' as const, data: { text: result } },
            { type: 'finish' as const, data: { reason: 'stop', time: now } },
          ],
          created_at: now,
          updated_at: now,
        }
        messagesRef.current = [...messagesRef.current, summaryMsg]
        setMessages([...messagesRef.current])
        syncSessionMessages(messagesRef.current)
      } catch (e) {
        const errMsg = makeMsg('assistant', [
          { type: 'text' as const, data: { text: `Summary failed: ${e instanceof Error ? e.message : String(e)}` } },
          { type: 'finish' as const, data: { reason: 'error', time: Date.now() } },
        ])
        messagesRef.current = [...messagesRef.current, errMsg]
        setMessages([...messagesRef.current])
        syncSessionMessages(messagesRef.current)
      }
      return
    }

    // Status check: prefix so agent reviews + verifies instead of generating code
    if (
      isStatusCheck(trimmed) &&
      !options?.agentPrompt &&
      !attachments?.length
    ) {
      effectivePrompt = `[INTENT: STATUS_CHECK — review this session's completed tasks, run tsc check, show git diff, give honest verdict. Do NOT generate new code.]\n\n${trimmed}`
    }

    const shouldPlanInPlanMode =
      activePermissionMode === 'plan_mode' &&
      !isCasualOrVague(trimmed) &&
      !isStatusCheck(trimmed) &&
      !isSummaryRequest(trimmed) &&
      !isQuestionPrompt(trimmed)

    if (!options?.skipPlanWorkflow) {
      if (activePlan.phase === 'awaiting_confirmation' && activePlan.originalPrompt.trim()) {
        if (isPlanApprovalPrompt(normalized)) {
          effectivePrompt = buildStartBuildPrompt(activePlan.originalPrompt, activePlan.planText)
          setPlanFlow(prev => ({ ...prev, phase: 'building' }))
        } else if (isPlanEditPrompt(trimmed)) {
          const src = activePlan.source
          const editInstruction = options?.agentPrompt ?? trimmed
          effectivePrompt = (src === 'architect' || src === 'designer')
            ? buildArchitectPlanningPrompt(activePlan.originalPrompt, editInstruction, activePlan.planText)
            : buildPlanningOnlyPrompt(activePlan.originalPrompt, editInstruction, activePlan.planText)
          setPlanFlow(prev => ({ ...prev, phase: 'awaiting_plan' }))
          if (canAutoEdit) {
            writeProjectFile(projPath, 'plan.md', formatPlanFile(activePlan.originalPrompt, '_Updating plan..._', 'awaiting_plan', src))
              .then(() => refreshFiles()).catch(() => {})
          }
        }
      } else if (activePlan.phase === 'idle' && (shouldUsePlanningForPrompt(trimmed) || shouldPlanInPlanMode) && !shouldSkipPlanning(trimmed)) {
        const planningRequest = options?.agentPrompt ?? trimmed
        if (isArchitect || isDesigner) {
          const src: PlanSource = isDesigner ? 'designer' : 'architect'
          effectivePrompt = buildArchitectPlanningPrompt(planningRequest)
          setPlanFlow({ phase: 'awaiting_plan', originalPrompt: trimmed, planText: '', source: src })
          if (canAutoEdit) {
            writeProjectFile(projPath, 'plan.md', formatPlanFile(trimmed, '_Generating plan..._', 'awaiting_plan', src))
              .then(() => refreshFiles()).catch(() => {})
          }
        } else {
          effectivePrompt = buildPlanningOnlyPrompt(planningRequest)
          setPlanFlow({ phase: 'awaiting_plan', originalPrompt: trimmed, planText: '', source: 'coder' })
          if (canAutoEdit) {
            writeProjectFile(projPath, 'plan.md', formatPlanFile(trimmed, '_Generating plan..._', 'awaiting_plan', 'coder'))
              .then(() => refreshFiles()).catch(() => {})
          }
        }
      }
    }
    const visualAssetSource = extractVisualAssetSearchSource(options?.agentPrompt, textForProcessing)
    const shouldSourceVisuals = shouldSourceVisualAssets(visualAssetSource)
    const hasImageAttachments = attachments?.some(att => att?.type === 'image') ?? false
    let visualAssetBundle = null as Awaited<ReturnType<typeof resolveVisualAssets>> | null
    if (shouldSourceVisuals && !hasImageAttachments && (canAutoEdit || options?.skipPlanWorkflow || Boolean(options?.agentPrompt))) {
      try {
        visualAssetBundle = await resolveVisualAssets(visualAssetSource)
      } catch (err) {
        addLog(makeLogEntry('warn', `Visual asset search failed: ${err instanceof Error ? err.message : String(err)}`, 'system'))
      }
      const visualAssetContext = buildVisualAssetSourcingInstructions(visualAssetSource, visualAssetBundle)
      if (visualAssetContext) {
        effectivePrompt = `${effectivePrompt}\n\n${visualAssetContext}`
      }
      if (projPath && canAutoEdit) {
        writeProjectFile(projPath, '.betopia/assets.md', buildVisualAssetManifestTemplate(visualAssetSource, visualAssetBundle))
          .catch(() => {})
      }
      if (visualAssetBundle?.selections.length) {
        const selectedCount = visualAssetBundle.selections.length
        addLog(makeLogEntry('info', `Sourced ${selectedCount} visual asset${selectedCount === 1 ? '' : 's'} from Openverse`, 'system'))
      } else {
        addLog(makeLogEntry('info', 'No direct visual match found — using asset fallback plan', 'system'))
      }
    }
    // Auto-compact: if the effective prompt context exceeds the threshold, compact before running.
    const compactedBeforeSend = await autoCompactIfNeeded()
    if (compactedBeforeSend) {
      const { contextLength } = getModelInfo()
      const usedTokens = getAutoCompactTokens()
      if (contextLength > 0) {
        addLog(makeLogEntry('info', `Auto-compacted at ${Math.round((usedTokens / contextLength) * 100)}% context`, 'system'))
      }
    }

    setIsAgentBusy(true); setCurrentTool(null)
    addLog(makeLogEntry('info', text.slice(0, 80) + (text.length > 80 ? '...' : ''), 'user'))

    const parts: MessagePart[] = text.trim() ? [{ type: 'text' as const, data: { text } }] : []
    if (attachments?.length) {
      const attachmentParts = await Promise.all(attachments.map(async (att): Promise<MessagePart | null> => {
        if (att.type === 'image') {
          const raw = `data:${att.mimeType};base64,${att.data}`
          const url = await resizeImageForApi(raw)
          return { type: 'image_url' as const, data: { url } as any }
        } else if (att.type === 'file') {
          return { type: 'binary' as const, data: { name: att.name, mimeType: att.mimeType, data: att.data } as any }
        }
        return null
      }))
      parts.push(...attachmentParts.filter((p): p is MessagePart => p !== null))
    }

    // Detect local image file paths typed or pasted into the message text
    {
      // Negative lookbehind prevents matching paths inside URLs (e.g. http://host/img.png)
      const IMAGE_PATH_RE = /(?<![:/\w])((?:\/[^\s,?#]+|[A-Za-z]:[\\\/][^\s,?#]+)\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif))/gi
      const pathMatches = [...text.matchAll(IMAGE_PATH_RE)]
      if (pathMatches.length > 0) {
        const { readFile } = await import('@tauri-apps/plugin-fs')
        const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif' }
        const pathParts = await Promise.all(pathMatches.map(async ([, filePath]): Promise<MessagePart | null> => {
          try {
            const bytes = await readFile(filePath)
            const ext = filePath.split('.').pop()?.toLowerCase() ?? 'jpeg'
            const mime = MIME[ext] ?? 'image/jpeg'
            let binary = ''
            const CHUNK = 8192
            for (let i = 0; i < bytes.length; i += CHUNK) {
              binary += String.fromCharCode(...(bytes.slice(i, i + CHUNK) as unknown as number[]))
            }
            const raw = `data:${mime};base64,${btoa(binary)}`
            const url = await resizeImageForApi(raw)
            return { type: 'image_url' as const, data: { url } as any }
          } catch { return null /* path not readable — skip silently */ }
        }))
        parts.push(...pathParts.filter((p): p is MessagePart => p !== null))
      }
    }

    const userMsg = makeMsg('user', parts)
    messagesRef.current = [...messagesRef.current, userMsg]
    setMessages([...messagesRef.current])

    const assistantMsg = makeMsg('assistant', [])
    messagesRef.current = [...messagesRef.current, assistantMsg]
    setMessages([...messagesRef.current])
    const assistantId = assistantMsg.id
    const fullHistBefore = messagesRef.current.filter(m => m.id !== assistantId && m.id !== userMsg.id)
    const histBefore = buildAgentHistory(fullHistBefore)
    const abort = new AbortController(); abortRef.current = abort

    const effectiveAgentId = options?.overrideAgentId ?? (options?.fromLanding ? 'builtin:coder' : activeAgentId)
    const activeAgent = findAgent(allAgents, effectiveAgentId)
    const agentPersona = activeAgent.id !== BUILTIN_AGENTS[0].id || activeAgent.instructions.trim()
      ? { name: activeAgent.name, instructions: activeAgent.instructions }
      : null
    const agentAllowedTools = activeAgent.allowedTools ?? null
    const customInstructions = (() => {
      try { return localStorage.getItem('betopia:custom-instructions') ?? '' } catch { return '' }
    })()

    // Throttle streaming renders to ~20fps — avoids flooding React reconciler
    let lastStreamRender = 0
    let latestStreamParts: MessagePart[] | null = null
    // Cache index so hot-path ref update is O(1) instead of O(n) map
    let assistantMsgIdx = messagesRef.current.length - 1

    const flushStreamRender = () => {
      const snapshot = latestStreamParts
      if (!snapshot) return
      lastStreamRender = Date.now()
      setMessages(prev => {
        const n = [...prev]
        const idx = n.findIndex(m => m.id === assistantId)
        if (idx !== -1) {
          assistantMsgIdx = idx
          n[idx] = { ...n[idx], parts: snapshot }
        }
        messagesRef.current = n
        return n
      })
    }

    const updateAssistantPartsRef = (nextParts: MessagePart[]) => {
      const idx = messagesRef.current[assistantMsgIdx]?.id === assistantId
        ? assistantMsgIdx
        : messagesRef.current.findIndex(m => m.id === assistantId)
      if (idx === -1) return
      assistantMsgIdx = idx
      messagesRef.current = [
        ...messagesRef.current.slice(0, idx),
        { ...messagesRef.current[idx], parts: nextParts },
        ...messagesRef.current.slice(idx + 1),
      ]
    }

    const agentCallbacks = {
        agentPersona,
        agentAllowedTools,
        customInstructions,
        permissionMode: activePermissionMode,
        effortLevel,
        modelOverride: activeAgent.model ?? undefined,
        onPartsUpdate: async (parts: MessagePart[]) => {
          latestStreamParts = parts
          updateAssistantPartsRef(parts)

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
                if (projPath && planText && canAutoEdit) {
                  writeProjectFile(projPath, 'plan.md', formatPlanFile(flow.originalPrompt, planText, 'awaiting_confirmation', flow.source))
                    .then(() => refreshFiles()).catch(() => {})
                }
              }
            } else if (flow.phase === 'building') {
              const planPart = parts.find(p => p.type === 'plan')
              const planSteps = (planPart?.data as { steps?: Array<{ step: string; status: string }> })?.steps
              const allComplete = Array.isArray(planSteps) && planSteps.length > 0 && planSteps.every(s => s.status === 'completed')
              if (allComplete) {
                if (projPath && flow.planText && modeAllowsAutomaticFileEdits()) {
                  writeProjectFile(projPath, 'plan.md', formatPlanFile(flow.originalPrompt, flow.planText, 'completed', flow.source)).catch(() => {})
                }
                resetPlanFlow()
                continueCounterRef.current = 0
              } else if (Array.isArray(planSteps) && planSteps.length > 0 && continueCounterRef.current < 10) {
                continueCounterRef.current++
                if (projPath && flow.planText && modeAllowsAutomaticFileEdits()) {
                  writeProjectFile(projPath, 'plan.md', formatPlanFile(flow.originalPrompt, flow.planText, 'building', flow.source)).catch(() => {})
                }
                const remaining = planSteps.filter(s => s.status !== 'completed')
                const continueText = `Continue building. Remaining:\n${remaining.map((s, i) => `${i + 1}. ${s.step}`).join('\n')}\nPick up where you left off.`
                setTimeout(() => sendMessageCoreRef.current(continueText, undefined, { skipPlanWorkflow: true, overrideAgentId: 'builtin:coder' }), 500)
              } else {
                if (projPath && flow.planText && modeAllowsAutomaticFileEdits()) {
                  writeProjectFile(projPath, 'plan.md', formatPlanFile(flow.originalPrompt, flow.planText, 'completed', flow.source)).catch(() => {})
                }
                resetPlanFlow()
                continueCounterRef.current = 0
              }
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
        onAuditEvent: (event: AgentAuditEvent) => {
          const audit = formatAuditLog(event)
          addLog(makeLogEntry(audit.level, audit.message, 'agent', audit.details))
          void appendAuditEvent(pathRef.current, event)
        },
        onUsage: (u) => updateUsage(u),
        onPermissionRequest: handlePermissionRequest,
        onApprovalRequired: handleApprovalRequired,
        pluginHookRegistry: pluginManagerRef.current?.hooks ?? undefined,
        pluginManagerRef: pluginManagerRef.current,
        onSubagentPart: (_subagentType: string, part: MessagePart) => {
          latestStreamParts = [...latestStreamParts, part]
          updateAssistantPartsRef(latestStreamParts)
          flushStreamRender()
        },
        onServerStarted: async (url: string) => {
          // Only route frontend-like servers to the preview pane.
          // Backend ports (Django/FastAPI at 8000 etc.) must NOT set liveServerUrl —
          // they would show JSON/admin HTML instead of the app UI.
          // Post-run backend probe sets detectedBackendUrl for API docs.
          await activateRuntimePreview(url, true)
        },
      }

    // Detect interrupted context: last assistant message has text but no finish marker
    if (!options?.agentPrompt) {
      let lastAssistant: (typeof messagesRef.current)[0] | undefined
      for (let i = fullHistBefore.length - 1; i >= 0; i--) {
        if (fullHistBefore[i].role === 'assistant') { lastAssistant = fullHistBefore[i]; break }
      }
      const wasInterrupted = lastAssistant != null
        && !lastAssistant.parts.some(p => p.type === 'finish')
        && lastAssistant.parts.some(p => p.type === 'text' && (p.data as { text: string })?.text?.trim())
      if (wasInterrupted) {
        const partialText = (lastAssistant!.parts.find(p => p.type === 'text')?.data as { text: string })?.text ?? ''
        const summary = partialText.slice(0, 120).replace(/\n/g, ' ').trim()
        effectivePrompt = `[CONTEXT: previous response was interrupted mid-task${summary ? ` — was working on: "${summary}..."` : ''}]\n\nNew request: ${effectivePrompt}`
      }
    }

    try {
      const imageUrls = parts
        .filter(p => p.type === 'image_url')
        .map(p => (p.data as { url: string }).url)
      const visualImageUrls = visualAssetBundle?.selections.map(selection => selection.imageUrl) ?? []
      const allImageUrls = [...imageUrls, ...visualImageUrls]
      await runAgent(projPath, histBefore, effectivePrompt, agentCallbacks, abort.signal, allImageUrls.length > 0 ? allImageUrls : undefined)

      // Post-run: probe for backend server if none was detected during the run via onServerStarted.
      // onServerStarted already handles frontend ports; this catches backend APIs (Django/FastAPI/etc).
      if (!abort.signal.aborted) {
        const probePort = async (url: string): Promise<boolean> => {
          try {
            const port = parseInt(new URL(url).port)
            if (!port) return false
            return await invoke<boolean>('probe_port', { port })
          } catch { return false }
        }
        // Use 127.0.0.1 (not localhost) — on Windows, localhost may resolve to ::1
        const currentFrontend = liveServerUrl
        for (const port of BACKEND_PROBE_PORTS) {
          const url = `http://127.0.0.1:${port}`
          if (url === currentFrontend) continue
          if (await probePort(url)) {
            setDetectedBackendUrl(url)
            setApiDocsTabOpen(true)
            break
          }
        }
      }
    } catch (err) {
      const errName = (err as Error)?.name ?? ''
      const errMsg = (err instanceof Error ? err.message : String(err)).toLowerCase()
      const isCancelled = wasCancelledRef.current || errName === 'AbortError' || errName === 'APIUserAbortError' || errMsg.includes('cancel') || errMsg.includes('aborted')

      // Transient backend error (e.g. 502 inference failure that is NOT context overflow) — retry once
      const isTransientBackend = !isCancelled && !options?._retryAfterTransient && (
        errMsg.includes('temporarily unavailable') ||
        errMsg.includes('ai service may be')
      )
      if (isTransientBackend) {
        const filtered = messagesRef.current.filter(m => m.id !== assistantId)
        messagesRef.current = filtered
        setMessages([...filtered])
        setIsAgentBusy(false, false); setCurrentTool(null)
        addLog(makeLogEntry('info', 'AI service temporarily unavailable — retrying in 5s...', 'system'))
        setTimeout(() => sendMessageCore(text, attachments, { ...options, _retryAfterTransient: true }), 5000)
        return
      }

      // Auto-compact and retry on context overflow (once only)
      const isContextTooLarge = !isCancelled && !options?._retryAfterCompact && (
        errMsg.includes('context too large') ||
        errMsg.includes('context_length_exceeded') ||
        errMsg.includes('maximum context') ||
        errMsg.includes('reduce the length') ||
        errMsg.includes('tokens exceeds') ||
        errMsg.includes('too many tokens')
      )
      if (isContextTooLarge) {
        // Remove the empty assistant placeholder — API failed before any streaming
        const filtered = messagesRef.current.filter(m => m.id !== assistantId)
        messagesRef.current = filtered
        setMessages([...filtered])
        setIsAgentBusy(false, false); setCurrentTool(null)
        addLog(makeLogEntry('info', 'Context too large — compacting and retrying...', 'system'))
        // Wait for React to flush isAgentBusy=false (handleCompact guards on it), then compact + retry
        // Retry compact up to 3 times with 2s backoff (e.g. transient API 502)
        setTimeout(async () => {
          let compactOk = false
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt))
            await handleCompactRef.current().then(() => { compactOk = true }).catch(() => {})
            if (compactOk) break
          }
          if (compactOk) {
            setTimeout(() => sendMessageCore(text, attachments, { ...options, _retryAfterCompact: true }), 150)
          } else {
            // Compact itself failed after retries — tell user to compact manually
            const now = Date.now()
            const activeSessionId = useSessionStore.getState().activeId ?? 'default'
            const compactErrMsg = {
              id: `err-compact-${now}`,
              session_id: activeSessionId,
              role: 'assistant' as const,
              parts: [
                { type: 'text' as const, data: { text: 'Context is too large and auto-compact failed after retries. Please click the **Compact** button in the toolbar to summarize the conversation, then try again.' } },
                { type: 'finish' as const, data: { reason: 'error', time: now } },
              ],
              created_at: now,
              updated_at: now,
            }
            messagesRef.current = [...messagesRef.current, compactErrMsg]
            setMessages([...messagesRef.current])
            syncSessionMessages(messagesRef.current)
            addLog(makeLogEntry('error', 'Auto-compact failed after retries — please compact manually', 'system'))
          }
        }, 250)
      } else {
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
        setIsAgentBusy(false, isCancelled); setCurrentTool(null)
      }
    } finally { abortRef.current = null; wasCancelledRef.current = false }
  }, [isAgentBusy, isCompacting, refreshFiles, handlePermissionRequest, modeAllowsAutomaticFileEdits, addLog, resetPlanFlow,
      setMessages, setPlanFlow, setIsAgentBusy, setCurrentTool, bumpPreviewKey, setAutoFixAttempts,
      syncSessionMessages, setEditorView, effortLevel, permissionMode, activateRuntimePreview, buildAgentHistory])

  // Keep sendMessageCoreRef stable for async continuations
  useEffect(() => { sendMessageCoreRef.current = sendMessageCore }, [sendMessageCore])

  const cancelAgent = useCallback(() => {
    approvalResolversRef.current.forEach(resolve => resolve(false))
    approvalResolversRef.current.clear()
    wasCancelledRef.current = true
    abortRef.current?.abort(); abortRef.current = null
    setIsAgentBusy(false, true); setCurrentTool(null); setIsFixing(false)
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

  const handleLspDiagnostics = useCallback((diagnostics: LspDiagnostic[]) => {
    setLspDiagnostics(prev => sameLspDiagnostics(prev, diagnostics) ? prev : diagnostics)
  }, [])

  const handleAutoFix = useCallback(async (error: DetectedError) => {
    if (isFixing || !error.fixPrompt || autoFixAttempts >= 3) return
    const projPath = pathRef.current
    if (!projPath) return
    setIsFixing(true); setAutoFixAttempts(n => n + 1)
    addLog(makeLogEntry('info', `Auto-fixing: ${error.message.slice(0, 60)}`, 'autofix'))
    const abort = new AbortController()
    try {
      await runAgent(projPath, buildAgentHistory(messagesRef.current), error.fixPrompt, {
        pluginHookRegistry: pluginManagerRef.current?.hooks ?? undefined,
        pluginManagerRef: pluginManagerRef.current,
        onPartsUpdate: async (parts) => {
          parts.filter(p => p.type === 'text').forEach(p => {
            const t = (p.data as any)?.text ?? ''
            if (t) addLog(makeLogEntry('info', t.slice(0, 120), 'autofix'))
          })
        },
        onFilesChanged: async () => { await refreshFiles() },
      }, abort.signal)
    } catch { /* silent */ } finally { setIsFixing(false) }
  }, [isFixing, autoFixAttempts, addLog, setIsFixing, setAutoFixAttempts, refreshFiles, buildAgentHistory])

  const lspRuntimeErrors = useMemo(() => lspDiagnostics.map(lspDiagnosticToRuntimeError), [lspDiagnostics])
  const combinedErrors = useMemo(() => [...runtimeErrors, ...lspRuntimeErrors], [runtimeErrors, lspRuntimeErrors])
  const explorerErrorFiles = useMemo(() => {
    const projectRoot = normalizePathReq(projectPath) ?? ''
    const files = new Set<string>()
    const addPath = (file?: string) => {
      if (!file) return
      const normalized = file.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
      if (!normalized) return
      if (projectRoot && normalized.startsWith(projectRoot + '/')) {
        files.add(normalized.slice(projectRoot.length + 1))
        return
      }
      if (projectRoot && normalized === projectRoot) return
      files.add(normalized)
    }
    for (const error of combinedErrors) addPath(error.file)
    return Array.from(files)
  }, [combinedErrors, projectPath])

  const handleCompact = useCallback(async () => {
    if (isCompacting || isAgentBusy || messagesRef.current.length === 0) return
    setIsCompacting(true)
    try {
      const fullHistory = messagesRef.current
      const { compactionMsg } = await compactHistory(fullHistory, 0)
      const data = compactionMsg.parts[0]?.data as unknown as SessionCompactionData
      const lastMessage = fullHistory[fullHistory.length - 1]
      const compaction: SessionCompactionData = {
        ...data,
        compactedThroughMessageId: lastMessage.id,
        compactedAt: Date.now(),
      }
      compactionRef.current = compaction
      syncSessionCompaction(compaction)
      const count = (compactionMsg.parts[0]?.data as { messageCount?: number })?.messageCount ?? 0
      addLog(makeLogEntry('info', `Conversation compacted — ${count} session messages summarized`, 'system'))
    } catch (e) {
      addLog(makeLogEntry('error', `Compact failed: ${e instanceof Error ? e.message : String(e)}`, 'system'))
    } finally {
      setIsCompacting(false)
    }
  }, [isCompacting, isAgentBusy, addLog, syncSessionCompaction])
  useEffect(() => { handleCompactRef.current = handleCompact }, [handleCompact])

  useEffect(() => {
    const cfgNow = getConfig()
    if (!cfgNow.behavior.autoCompact || isCompacting || isAgentBusy) return
    const { contextLength } = getModelInfo()
    if (contextLength <= 0) return
    const usedTokens = getAutoCompactTokens()
    if (usedTokens <= 0) return
    const threshold = cfgNow.behavior.autoCompactThreshold ?? 0.75
    if (usedTokens / contextLength < threshold) return

    const lastMessageId = messagesRef.current[messagesRef.current.length - 1]?.id ?? 'none'
    const compactedThrough = compactionRef.current?.compactedThroughMessageId ?? 'none'
    const signature = `${activeSessionId ?? 'session'}|${compactedThrough}|${lastMessageId}|${messagesRef.current.length}`
    if (lastAutoCompactSignatureRef.current === signature) return
    lastAutoCompactSignatureRef.current = signature
    void autoCompactIfNeeded().then(compacted => {
      if (!compacted) return
      const { contextLength: ctx } = getModelInfo()
      const usedTokens = getVisibleContextTokens()
      if (ctx > 0) addLog(makeLogEntry('info', `Auto-compacted at ${Math.round((usedTokens / ctx) * 100)}% context`, 'system'))
    })
  }, [activeSessionId, addLog, autoCompactIfNeeded, getAutoCompactTokens, isAgentBusy, isCompacting, messages])

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
          await getTypeScriptLspClient().syncFile(projPath, normFile, match[1])
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
    const pendingAgentPrompt = pendingAgentPromptRef.current
    pendingPromptRef.current = ''
    pendingAgentPromptRef.current = ''
    const atts = pendingAttachmentsRef.current.length > 0 ? pendingAttachmentsRef.current : undefined
    pendingAttachmentsRef.current = []
    const t = setTimeout(() => sendMessageCore(pending, atts, { fromLanding: true, agentPrompt: pendingAgentPrompt || undefined }), 400)
    return () => clearTimeout(t)
  }, [status, sendMessageCore])

  // Fire queued prompt once generation finishes (user chose "Run after")
  useEffect(() => {
    if (isAgentBusy || !queuedPrompt) return
    const queued = getQueuedPromptExecutionArgs(queuedPrompt, queuedAttachments)
    if (!queued) return
    setQueuedPrompt(null)
    const t = setTimeout(() => sendMessageCore(queued.text, queued.attachments, queued.options), 100)
    return () => clearTimeout(t)
  }, [isAgentBusy]) // eslint-disable-line react-hooks/exhaustive-deps

  const startBuildFromPlan = useCallback(async () => {
    if (isAgentBusy || planFlow.phase !== 'awaiting_confirmation') return
    const orig = planFlowRef.current.originalPrompt.trim()
    if (!orig) return
    const projPath = pathRef.current
    const planSource = planFlowRef.current.source
    // Read latest plan.md from disk — user may have edited it in the editor
    let planText = planFlowRef.current.planText
    if (projPath) {
      try {
        const diskContent = await readProjectFile(projPath, 'plan.md')
        const parsed = parsePlanFile(diskContent)
        if (isPlanFileForActivePlan(parsed, orig, planSource, 'awaiting_confirmation')) planText = parsed.planText
      } catch { /* fallback to in-memory */ }
    }
    if (planText !== planFlowRef.current.planText) {
      setPlanFlow(prev => ({ ...prev, planText }))
    }
    if (permissionModeRef.current === 'plan_mode') {
      setModeSwitchRequest({
        text: 'Start build',
        attachments: undefined,
        options: {
          agentPrompt: buildStartBuildPrompt(orig, planText),
          skipPlanWorkflow: true,
          overrideAgentId: 'builtin:coder',
        },
        suggestedMode: 'auto_review',
        reason: 'This plan is ready to build, but Plan mode is still selected.',
      })
      return
    }
    // Set phase to 'building' only once we are actually allowed to start.
    setPlanFlow(prev => ({ ...prev, phase: 'building' }))
    if (projPath && planText && modeAllowsAutomaticFileEdits()) {
      // Write compact task list to plan.md — architecture detail moves to .betopia/
      writeProjectFile(projPath, 'plan.md', formatPlanFile(orig, planText, 'building', planSource)).catch(() => {})

      // App writes .betopia/architecture.md from full plan text — guaranteed non-empty.
      // Agent reads it; does NOT write it (LLM compliance with doc tasks is unreliable).
      const archContent = [
        '# Architecture',
        '',
        `## Original Request`,
        orig,
        '',
        '## Plan & Design',
        planText,
      ].join('\n')
      writeProjectFile(projPath, '.betopia/architecture.md', archContent)
        .then(() => refreshFiles()).catch(() => {})

      // Write design.md placeholder for frontend/full-stack projects
      const isFrontend = /\b(react|vue|angular|svelte|next|frontend|css|tailwind|component|ui|design|landing|dashboard|website|web app)\b/i.test(planText + orig)
      if (isFrontend) {
        const designContent = [
          '# Design',
          '',
          '_Agent fills UI tokens, color system, and component decisions during implementation._',
          '',
          'See architecture.md for component structure and tech stack.',
        ].join('\n')
        writeProjectFile(projPath, '.betopia/design.md', designContent).catch(() => {})
      }
    }
    void sendMessageCore('Start build', undefined, { agentPrompt: buildStartBuildPrompt(orig, planText), skipPlanWorkflow: true, overrideAgentId: 'builtin:coder' })
  }, [isAgentBusy, modeAllowsAutomaticFileEdits, planFlow.phase, sendMessageCore, setPlanFlow, setModeSwitchRequest])

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

    // If a server URL is already known, probe it before starting a new one.
    // Prevents duplicate servers (start_servers.py projects) and needless static server restarts.
    if (liveServerUrl) {
      try {
        const port = parseInt(new URL(liveServerUrl).port)
        if (port && await invoke<boolean>('probe_port', { port })) {
          if (FRONTEND_PREVIEW_PORTS.has(port)) {
            setLiveServerUrl(null); setLiveServerMode(null)
          } else {
            bumpPreviewKey(); return
          }
        }
      } catch {}
      // Server is dead — clear stale URL and fall through to start fresh
      setLiveServerUrl(null); setLiveServerMode(null)
    }

    // Before starting a Rust static server, probe common dev-server ports IN PARALLEL.
    // Handles the case where the agent started a server via bash but onServerStarted
    // wasn't called (e.g. old session) — so we don't spawn a fresh Rust server on a new port.
    // Sequential probing = 8 ports × 800ms = 6.4s blocking. Parallel = 800ms total.
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
        const started = await invoke<{ port: number; mode: string }>('start_live_server', { projectPath: c, port: PREVIEW_PROXY_PORT })
        const port = typeof started?.port === 'number' ? started.port : PREVIEW_PROXY_PORT
        const previewUrl = `http://127.0.0.1:${port}`
        const previewMode: 'runtime' | 'static' = started?.mode === 'runtime' ? 'runtime' : 'static'
        setLiveServerUrl(previewUrl)
        setLiveServerMode(previewMode)
        setProjectRuntimeStatus('running')
        updateProjectRuntime(currentPath, {
          status: 'running',
          preview: { url: previewUrl, mode: previewMode, port },
        }).catch(() => {})
        bumpPreviewKey()
        addLog(makeLogEntry('info', started?.mode === 'runtime' ? 'Preview: runtime server' : 'Preview: static server', 'preview'))
        return
      } catch {}
    }
    addLog(makeLogEntry('error', 'Failed to start preview', 'preview'))
    setLiveServerUrl(null); setLiveServerMode(null)
    setProjectRuntimeStatus('stopped')
  }, [projectPath, files, liveServerUrl, liveServerMode, setLiveServerUrl, setLiveServerMode, setProjectRuntimeStatus, bumpPreviewKey, addLog, activateRuntimePreview])
  handleRequestPreviewRef.current = handleRequestPreview

  const handleStopServer = useCallback(async () => {
    const currentPath = projectPath || pathRef.current
    if (currentPath) {
      await stopProjectServers(currentPath)
    } else {
      try { await invoke('stop_live_server') } catch {}
    }
    setLiveServerUrl(null); setLiveServerMode(null)
    setDetectedBackendUrl(null)
    setProjectRuntimeStatus('stopped')
    addLog(makeLogEntry('info', 'Project runtime stopped', 'preview'))
  }, [projectPath, setLiveServerUrl, setLiveServerMode, setDetectedBackendUrl, setProjectRuntimeStatus, addLog, stopProjectServers])

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

  // Keep an existing terminal tab selected so the panel never renders as an
  // empty shell when the active id is lost or out of sync.
  useEffect(() => {
    if (terminalTabs.length === 0) return
    const hasActive = activeTerminalId && terminalTabs.some(tab => tab.id === activeTerminalId)
    if (!hasActive) setActiveTerminalId(terminalTabs[0].id)
  }, [activeTerminalId, terminalTabs])

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

  const hasStarted = Boolean(projectPath)
  const hasFiles = files.length > 0
  const renderPreviewEmptyState = useCallback((mode: 'code-preview' | 'live-preview' | 'tab-preview') => {
    if (isAgentBusy && !hasFiles) {
      return <PreviewGeneratingState />
    }
    const subtitle = mode === 'code-preview'
      ? 'Ask AI to generate your project first.'
      : 'Switch to Code and ask AI to generate your project.'
    return (
      <div className="preview-no-files">
        <div className="preview-no-files-icon">&#128065;</div>
        <p className="preview-no-files-title">No files to preview</p>
        <p className="preview-no-files-sub">{subtitle}</p>
        {mode !== 'code-preview' && (
          <button className="preview-retry-btn" onClick={() => setViewMode('code')}>Go to Code</button>
        )}
      </div>
    )
  }, [hasFiles, isAgentBusy, setViewMode])
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
          <LandingChat isAgentBusy={isAgentBusy} onSend={(text, attachments, options) => { sendMessageCore(text, attachments, { fromLanding: true, agentPrompt: options?.agentPrompt }) }} />
        </div>
      )}

      {hasStarted && (
        <PanelGroup
          // Keep terminal visibility out of the remount key so hiding/showing the
          // terminal does not tear down the PTY session and lose scrollback.
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
                              onDropFiles={dropped => {
                                if (dropped.length === 0) return
                                const first = dropped[0]
                                setSelectedFile(first.relativePath); selectedFileRef.current = first.relativePath
                                setTabs(prev => openTab(prev, first.relativePath))
                                setFileContent(first.content)
                              }}
                              projectPath={projectPath}
                              searchQuery={explorerSearch}
                              onSearchQueryChange={setExplorerSearch}
                              autoExpandAll
                              forceView={sidePanel === 'source-control' ? 'source-control' : 'files'}
                              gitRefreshTick={sourceControlRefreshTick}
                              problemFiles={explorerErrorFiles}
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
                            renderPreviewEmptyState('code-preview')
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
                              onStartServer={handleRequestPreview}
                              runtimeStatus={projectRuntimeStatus}
                              isGenerating={isAgentBusy}
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
                          tabs={tabs}
                          onSelectTab={selectFile}
                          onCloseTab={handleCloseTab}
                          onInlineChat={(sel, file) => setInlineChat({ selection: sel, fileName: file })}
                          onOpenDefinition={handleOpenDefinition}
                          onDiagnostics={handleLspDiagnostics}
                          revealTarget={editorRevealTarget}
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
                          onDropFile={handleDropFile}
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
                renderPreviewEmptyState('live-preview')
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
                  onStartServer={handleRequestPreview}
                  runtimeStatus={projectRuntimeStatus}
                  isGenerating={isAgentBusy}
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
                  renderPreviewEmptyState('tab-preview')
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
                    onStartServer={handleRequestPreview}
                    runtimeStatus={projectRuntimeStatus}
                    isGenerating={isAgentBusy}
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
                    style={{ flex: 1, display: tab.id === activeTerminalId ? 'flex' : 'none', flexDirection: 'column', minHeight: 0 }}
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
                  agentContextMessages={buildAgentHistory(messages, activeSession?.compaction)}
                  isAgentBusy={isAgentBusy}
                  currentTool={currentTool}
                  onSend={sendMessageCore}
                  onCancel={cancelAgent}
                  onHide={() => setChatSidebarVisible(false)}
                  onCompact={handleCompact}
                  isCompacting={isCompacting}
                  permissionMode={permissionMode}
                  onPermissionModeChange={setPermissionMode}
                  effortLevel={effortLevel}
                  onEffortChange={setEffortLevel}
                  agentMode="inline"
                  projectPath={projectPath}
                  files={files}
                  pendingFileReference={pendingFileReference}
                  onApprovalResponse={handleApprovalResponse}
                  permissionRequest={inlinePermRequest}
                  onPermissionAllow={handlePermAllow}
                  onPermissionDeny={handlePermDeny}
                  onPermissionAutoMode={handlePermAllowAll}
                  modeSwitchRequest={modeSwitchRequest}
                  onModeSwitchChoice={handleModeSwitchChoice}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
      )}

      <LogsPanel logs={logs} errors={combinedErrors} isOpen={logsOpen}
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
      {hasStarted && <StatusBar filePath={selectedFile} branch={gitBranch} errorCount={combinedErrors.length} />}
    </div>
    </>
  )
}
