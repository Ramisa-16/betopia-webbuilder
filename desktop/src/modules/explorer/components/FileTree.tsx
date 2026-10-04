/**
 * FileTree.tsx — Professional file explorer
 * Features: search, categorized view, file icons, expand/collapse,
 * active file highlight, file count badges.
 */

import { useEffect, useState, useCallback, useRef, useMemo, createContext, useContext, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { GraphRail, railWidth, MAX_VISIBLE_LANES } from './GraphRail'
import { layoutGraph } from '../lib/graph'
import type { FileEntry } from '@/types'
import { groupFilesByCategory, CATEGORY_META, CATEGORY_ORDER, flattenFiles } from '@/lib/project-scaffold'
import { readTextFile } from '@tauri-apps/plugin-fs'
import type { ProjectCategory } from '@/types'
import { invoke } from '@tauri-apps/api/core'
import { proxyFetch } from '@/lib/proxyFetch'
import { getResolvedEndpointAsync } from '@/lib/config'
import { getFileIcon, getFolderIcon } from '@/lib/file-icons'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import DiffViewer from '@/components/DiffViewer'

// ── Explorer context (avoids prop-drilling through recursive FileNode) ─────────

interface FileClipboard { op: 'cut' | 'copy'; absPath: string; name: string }

interface ExplorerCtx {
  projectPath: string | null
  onContextMenu: (e: MouseEvent<HTMLDivElement>, entry: FileEntry) => void
  fileClipboard: FileClipboard | null
}
const ExplorerContext = createContext<ExplorerCtx>({
  projectPath: null,
  onContextMenu: () => {},
  fileClipboard: null,
})

// ── OS detection ──────────────────────────────────────────────────────────────

function getOsPlatform(): 'mac' | 'win' | 'linux' {
  const ua = navigator.userAgent
  if (ua.includes('Windows')) return 'win'
  if (ua.includes('Mac')) return 'mac'
  return 'linux'
}

function openInFileManager(absPath: string, isDir: boolean) {
  const os = getOsPlatform()
  const folder = isDir ? absPath : absPath.replace(/[/\\][^/\\]+$/, '')
  let cmd: string
  if (os === 'win') {
    const winPath = folder.replace(/\//g, '\\')
    cmd = `explorer "${winPath}"`
  } else if (os === 'mac') {
    cmd = `open "${folder}"`
  } else {
    cmd = `xdg-open "${folder}"`
  }
  invoke('shell_run_command', { command: cmd, cwd: null }).catch(console.error)
}

function fileManagerLabel(): string {
  const os = getOsPlatform()
  if (os === 'mac') return 'Reveal in Finder'
  if (os === 'win') return 'Open in Explorer'
  return 'Open in Files'
}

type ExplorerTab = 'files' | 'source-control'

interface GitChange {
  status: string  // single letter: M, A, D, R, ?, U
  file: string
}

function parseGitStatusPorcelain(raw: string): { staged: GitChange[]; unstaged: GitChange[] } {
  const staged: GitChange[] = []
  const unstaged: GitChange[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const x = line[0] ?? ' '   // index (staged) status
    const y = line[1] ?? ' '   // worktree (unstaged) status
    const file = line.slice(3).trim()
    if (!file) continue
    if (x !== ' ' && x !== '?') staged.push({ status: x, file })
    if (y !== ' ') unstaged.push({ status: y === '?' ? '?' : y, file })
  }
  return { staged, unstaged }
}

function gitStatusColor(s: string): string {
  if (s === 'M') return '#fbbf24'
  if (s === 'A') return '#4ade80'
  if (s === 'D') return '#f87171'
  if (s === 'R') return '#60a5fa'
  if (s === 'U') return '#fb923c'
  if (s === '?') return '#9b9ba0'
  return 'var(--text-2)'
}

interface GitLogEntry {
  sha: string       // full SHA
  hash: string      // short hash
  message: string
  author: string
  time: string      // relative (e.g. "2 hours ago")
  refs: string[]    // branch/tag names
  parents: string[] // full parent SHAs (for graph layout)
}

function parseGitLog(raw: string): GitLogEntry[] {
  const entries: GitLogEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\x09')
    if (parts.length < 5) continue
    const [sha, hash, message, author, time, refsRaw = '', parentsRaw = ''] = parts
    const refs = refsRaw.split(',').map(r => r.trim()).filter(Boolean)
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(' ').filter(Boolean) : []
    entries.push({ sha: sha.trim(), hash: hash.trim(), message: message.trim(), author: author.trim(), time: time.trim(), refs, parents })
  }
  return entries
}

function refColor(ref: string): string {
  if (ref.includes('HEAD')) return '#fb923c'
  if (ref.startsWith('tag:')) return '#4ade80'
  return '#60a5fa'
}

// ── Icon system ───────────────────────────────────────────────────────────────

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <span className="file-dir-arrow" aria-hidden="true">
      <svg className={`file-chevron-icon${expanded ? ' expanded' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

function MaterialFileIcon({ name }: { name: string }) {
  return (
    <img
      src={getFileIcon(name)}
      alt=""
      aria-hidden="true"
      className="material-file-icon"
      width={16}
      height={16}
    />
  )
}

function MaterialFolderIcon({ name, expanded }: { name: string; expanded: boolean }) {
  return (
    <img
      src={getFolderIcon(name, expanded)}
      alt=""
      aria-hidden="true"
      className="material-file-icon"
      width={16}
      height={16}
    />
  )
}

function countFiles(entries: FileEntry[]): number {
  let n = 0
  for (const e of entries) {
    if (!e.is_dir) n++
    else if (e.children) n += countFiles(e.children)
  }
  return n
}

function findEntryByPath(entries: FileEntry[], path: string): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry
    if (entry.is_dir && entry.children?.length) {
      const nested = findEntryByPath(entry.children, path)
      if (nested) return nested
    }
  }
  return null
}

function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

function collectAllSelectablePaths(entries: FileEntry[]): string[] {
  const paths: string[] = []
  for (const entry of entries) {
    paths.push(entry.path)
    if (entry.is_dir && entry.children?.length) {
      paths.push(...collectAllSelectablePaths(entry.children))
    }
  }
  return paths
}

const SEARCHABLE_TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'css', 'scss', 'html', 'htm',
  'yml', 'yaml', 'toml', 'xml', 'txt', 'env', 'ini', 'cfg', 'sql', 'graphql', 'gql', 'prisma',
  'py', 'go', 'rs', 'sh', 'bash', 'zsh', 'cmd', 'bat', 'java', 'kt', 'kts', 'swift', 'dart',
  'rb', 'php', 'vue', 'svelte', 'astro', 'lock', 'log', 'csv', 'tsv', 'less', 'sass', 'scss',
])

function toAbsoluteProjectPath(projectPath: string, relPath: string): string {
  return `${projectPath.replace(/\\/g, '/').replace(/\/$/, '')}/${relPath.replace(/\\/g, '/').replace(/^\/+/, '')}`
}

function isSearchableTextFile(entry: FileEntry): boolean {
  if (entry.is_dir) return false
  const lower = entry.name.toLowerCase()
  if (lower === 'dockerfile' || lower === 'makefile') return true
  if (lower.startsWith('readme')) return true
  if (lower.includes('.')) {
    const ext = lower.split('.').pop() ?? ''
    return SEARCHABLE_TEXT_EXTENSIONS.has(ext)
  }
  return SEARCHABLE_TEXT_EXTENSIONS.has(lower)
}

function tokenizeSearchQuery(query: string): string[] {
  return query.toLowerCase().split(/[\s,]+/).map(token => token.trim()).filter(Boolean)
}

function matchesSearchText(value: string, query: string, tokens: string[]): boolean {
  const lower = value.toLowerCase()
  if (lower.includes(query)) return true
  if (tokens.length === 0) return false
  return tokens.length === 1
    ? lower.includes(tokens[0])
    : tokens.every(token => lower.includes(token))
}

function FileChatButton({
  path,
  onChatWithFile,
}: {
  path: string
  onChatWithFile?: (path: string) => void
}) {
  if (!onChatWithFile) return null

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onChatWithFile(path)
  }

  return (
    <button
      type="button"
      className="file-chat-btn"
      title="Chat with file"
      data-tooltip="Chat with file"
      aria-label={`Chat with file ${path}`}
      onClick={handleClick}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
        <path d="M12 8v6" />
        <path d="M9 11h6" />
      </svg>
    </button>
  )
}

// ── Search bar ────────────────────────────────────────────────────────────────

function SearchBar({
  value,
  onChange,
  onClose,
}: {
  value: string
  onChange: (v: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    // Focus the search box when the central shortcut dispatcher fires (rebindable).
    const focusSearch = () => ref.current?.focus()
    window.addEventListener('keydown', handler)
    window.addEventListener('betopia:focus-file-search', focusSearch)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('betopia:focus-file-search', focusSearch)
    }
  }, [onClose])

  useEffect(() => {
    const timer = window.setTimeout(() => ref.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className="file-search-bar">
      <span className="file-search-icon">&#128269;</span>
      <input
        ref={ref}
        className="file-search-input"
        placeholder="Search files, functions, variables..."
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        spellCheck={false}
      />
      {value && (
        <button type="button" className="file-search-clear" onClick={onClose} aria-label="Close search">
          ×
        </button>
      )}
    </div>
  )
}

// ── Search results ────────────────────────────────────────────────────────────

function SearchResults({
  results, query, selectedPaths, onItemMouseDown, onItemMouseEnter, onChatWithFile, isSearching,
}: {
  results: FileEntry[]
  query: string
  selectedPaths: Set<string>
  onItemMouseDown: (event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean) => void
  onItemMouseEnter: (event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean) => void
  onChatWithFile?: (path: string) => void
  isSearching: boolean
}) {
  if (isSearching) return <div className="file-tree-empty">Searching &quot;{query}&quot;...</div>
  if (!results.length) return <div className="file-tree-empty">No files match &quot;{query}&quot;</div>

  return (
    <div className="file-children">
      {results.map(f => {
        return (
          <div
            key={f.path}
            className={`file-item${selectedPaths.has(f.path) ? ' selected' : ''}`}
            style={{ paddingLeft: 12 }}
            onMouseDown={(event) => onItemMouseDown(event, f.path, false)}
            onMouseEnter={(event) => onItemMouseEnter(event, f.path, false)}
            title={f.path}
          >
            <MaterialFileIcon name={f.name} />
            <span className="file-name">{f.name}</span>
            <span className="file-path-hint">{f.path.replace(f.name, '').replace(/[/\\]$/, '')}</span>
            <FileChatButton path={f.path} onChatWithFile={onChatWithFile} />
          </div>
        )
      })}
      <div className="file-search-count">{results.length} result{results.length !== 1 ? 's' : ''}</div>
    </div>
  )
}

// ── Category view ─────────────────────────────────────────────────────────────

function CategoryView({
  files, selectedPaths, onItemMouseDown, onItemMouseEnter, onChatWithFile,
}: {
  files: FileEntry[]
  selectedPaths: Set<string>
  onItemMouseDown: (event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean) => void
  onItemMouseEnter: (event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean) => void
  onChatWithFile?: (path: string) => void
}) {
  const grouped = groupFilesByCategory(files)
  const [collapsed, setCollapsed] = useState<Set<ProjectCategory>>(new Set())

  const toggle = (cat: ProjectCategory) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(cat) ? next.delete(cat) : next.add(cat)
      return next
    })

  return (
    <div className="file-categories">
      {CATEGORY_ORDER.map(cat => {
        const items = grouped.get(cat)
        if (!items?.length) return null
        const meta = CATEGORY_META[cat]
        const isCollapsed = collapsed.has(cat)

        return (
          <div key={cat} className="file-category">
            <div className="file-category-header" onClick={() => toggle(cat)}>
              <span className="file-category-arrow">{isCollapsed ? '>' : 'v'}</span>
              <span className="file-category-icon">{meta.icon}</span>
              <span className="file-category-label" style={{ color: meta.color }}>{meta.label}</span>
              <span className="file-category-count">{items.length}</span>
            </div>
            {!isCollapsed && (
              <div className="file-category-items">
                {items.map(({ entry }) => {
                  return (
                    <div
                      key={entry.path}
                      className={`file-item${selectedPaths.has(entry.path) ? ' selected' : ''}`}
                      style={{ paddingLeft: 24 }}
                      onMouseDown={(event) => onItemMouseDown(event, entry.path, false)}
                      onMouseEnter={(event) => onItemMouseEnter(event, entry.path, false)}
                      title={entry.path}
                    >
                      <MaterialFileIcon name={entry.name} />
                      <span className="file-name">{entry.name}</span>
                      <FileChatButton path={entry.path} onChatWithFile={onChatWithFile} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Tree node ─────────────────────────────────────────────────────────────────

function FileNode({
  entry, selectedPaths, onItemMouseDown, onItemMouseEnter, depth, autoExpandAll, onChatWithFile,
}: {
  entry: FileEntry
  selectedPaths: Set<string>
  onItemMouseDown: (event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean) => void
  onItemMouseEnter: (event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean) => void
  depth: number
  autoExpandAll: boolean
  onChatWithFile?: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(autoExpandAll || depth < 2)
  const { onContextMenu } = useContext(ExplorerContext)

  useEffect(() => { if (autoExpandAll) setExpanded(true) }, [autoExpandAll])

  const indent = 12 + depth * 14

  if (entry.is_dir) {
    const fileCount = countFiles(entry.children ?? [])
    return (
      <>
        <div
          className={`file-item dir${expanded ? ' expanded' : ''}${selectedPaths.has(entry.path) ? ' selected' : ''}`}
          style={{ paddingLeft: indent }}
          onMouseDown={(event) => onItemMouseDown(event, entry.path, true)}
          onMouseEnter={(event) => onItemMouseEnter(event, entry.path, true)}
          onContextMenu={(e) => onContextMenu(e, entry)}
          onClick={() => { setExpanded(e => !e) }}
        >
          <ChevronIcon expanded={expanded} />
          <MaterialFolderIcon name={entry.name} expanded={expanded} />
          <span className="file-name">{entry.name}</span>
          {fileCount > 0 && <span className="file-count-badge">{fileCount}</span>}
        </div>
        {expanded && entry.children && (
          <div className="file-tree-inner">
            {entry.children.map(child => (
              <FileNode
                key={child.path}
                entry={child}
                selectedPaths={selectedPaths}
                onItemMouseDown={onItemMouseDown}
                onItemMouseEnter={onItemMouseEnter}
                depth={depth + 1}
                autoExpandAll={autoExpandAll}
                onChatWithFile={onChatWithFile}
              />
            ))}
          </div>
        )}
      </>
    )
  }

  return (
    <div
      className={`file-item${selectedPaths.has(entry.path) ? ' selected' : ''}`}
      style={{ paddingLeft: indent }}
      onMouseDown={(event) => onItemMouseDown(event, entry.path, false)}
      onMouseEnter={(event) => onItemMouseEnter(event, entry.path, false)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      title={entry.path}
    >
      <MaterialFileIcon name={entry.name} />
      <span className="file-name">{entry.name}</span>
      <FileChatButton path={entry.path} onChatWithFile={onChatWithFile} />
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

type ExplorerView = 'tree' | 'categories'

interface FileTreeProps {
  files: FileEntry[]
  rootName?: string
  selectedFile: string | null
  onSelect: (path: string) => void
  onClearSelection?: () => void
  onChatWithFile?: (path: string) => void
  onCreateFile?: (relativePath: string) => void
  onCreateFolder?: (relativePath: string) => void
  onRefresh?: () => void
  projectPath?: string | null
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  depth?: number
  autoExpandAll?: boolean
  forceView?: 'files' | 'source-control'
}

const GRAPH_ROW_H = 44        // base row height — enough for 2 lines
const GRAPH_ROW_H_REFS = 58   // extra height when refs pills are shown

function authorInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function authorTint(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xfffffff
  return `hsl(${h % 360}, 55%, 42%)`
}

function CommitGraph({
  gitLog, graphExpanded, setGraphExpanded,
}: {
  gitLog: GitLogEntry[]
  graphExpanded: boolean
  setGraphExpanded: (v: (prev: boolean) => boolean) => void
}) {
  const [activeHash, setActiveHash] = useState<string | null>(null)

  // Pre-compute row heights so the SVG rail can match exactly
  const rowHeights = useMemo(
    () => gitLog.map(e => e.refs.filter(r => r).length > 0 ? GRAPH_ROW_H_REFS : GRAPH_ROW_H),
    [gitLog]
  )


  const { graphByCommit, maxLaneCount } = useMemo(() => {
    const { rows } = layoutGraph(gitLog.map(e => ({ sha: e.sha, parents: e.parents })))
    const byCommit = new Map(rows.map(r => [r.sha, r]))
    let max = 1
    for (const r of rows) if (r.laneCount > max) max = r.laneCount
    return { graphByCommit: byCommit, maxLaneCount: max }
  }, [gitLog])

  const rw = railWidth(Math.min(maxLaneCount, MAX_VISIBLE_LANES))

  return (
    <div className="fe-git-section">
      <div className="fe-git-section-header" onClick={() => setGraphExpanded(v => !v)}>
        <svg className={`fe-git-chevron${graphExpanded ? ' open' : ''}`} viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 4.5l3 3 3-3"/>
        </svg>
        <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
          <circle cx="4" cy="4" r="1.5"/><circle cx="10" cy="4" r="1.5"/><circle cx="4" cy="10" r="1.5"/>
          <path d="M5.5 4h1.5a2 2 0 0 1 2 2v1.5"/><line x1="4" y1="5.5" x2="4" y2="8.5"/>
        </svg>
        <span>Commits</span>
        <span className="fe-git-count">{gitLog.length}</span>
      </div>
      {graphExpanded && (
        <div className="fe-graph-list">
          {gitLog.map((entry, i) => {
            const graphRow = graphByCommit.get(entry.sha)
            const isActive = activeHash === entry.sha
            const rowH = rowHeights[i]
            const visRefs = entry.refs.filter(r => r)
            const initials = authorInitials(entry.author)
            const tint = authorTint(entry.author || entry.hash)
            return (
              <div
                key={entry.sha}
                className={`fe-graph-row${isActive ? ' fe-graph-row--active' : ''}`}
                style={{ height: rowH }}
                onClick={() => setActiveHash(a => a === entry.sha ? null : entry.sha)}
              >
                {/* SVG graph rail — exact same height as row */}
                <div className="fe-graph-rail-col" style={{ width: rw, height: rowH, flexShrink: 0 }}>
                  {graphRow
                    ? <GraphRail row={graphRow} rowHeight={rowH} maxLaneCount={maxLaneCount} active={isActive} />
                    : <div style={{ width: rw, height: rowH }} />}
                </div>

                {/* Commit info */}
                <div className="fe-graph-info">
                  {/* Refs row */}
                  {visRefs.length > 0 && (
                    <div className="fe-graph-refs">
                      {visRefs.map((r, ri) => {
                        const isHead = r.includes('HEAD')
                        const isTag = r.startsWith('tag:')
                        const label = r.replace('HEAD -> ', '').replace('origin/', '').replace('tag: ', '')
                        return (
                          <span
                            key={ri}
                            className={`fe-graph-ref${isHead ? ' fe-graph-ref--head' : isTag ? ' fe-graph-ref--tag' : ''}`}
                            title={r}
                          >
                            {isHead && (
                              <span className="fe-graph-ref-dot" style={{ background: refColor(r) }} />
                            )}
                            {label}
                          </span>
                        )
                      })}
                    </div>
                  )}

                  {/* Message row */}
                  <span className="fe-graph-msg" title={entry.message}>{entry.message}</span>

                  {/* Meta row */}
                  <div className="fe-graph-meta">
                    <code className="fe-graph-hash">{entry.hash}</code>
                    <span
                      className="fe-graph-author-chip"
                      title={entry.author}
                      style={{ background: tint + '22', color: tint, borderColor: tint + '44' }}
                    >
                      <span className="fe-graph-author-avatar" style={{ background: tint }}>{initials}</span>
                      <span className="fe-graph-author-name">{entry.author}</span>
                    </span>
                    <span className="fe-graph-time">{entry.time}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function FileTree({
  files,
  rootName,
  selectedFile,
  onSelect,
  onClearSelection,
  onChatWithFile,
  onCreateFile,
  onCreateFolder,
  onRefresh,
  projectPath,
  searchQuery,
  onSearchQueryChange,
  autoExpandAll = false,
  forceView,
}: FileTreeProps) {
  const [query, setQuery] = useState(searchQuery)
  const [searchResults, setSearchResults] = useState<FileEntry[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [view]            = useState<ExplorerView>('tree')
  const [rootExpanded, setRootExpanded] = useState(true)
  const [explorerTab, setExplorerTab] = useState<ExplorerTab>('files')
  const [stagedChanges,   setStagedChanges]   = useState<GitChange[]>([])
  const [unstagedChanges, setUnstagedChanges] = useState<GitChange[]>([])
  const [gitLoading,  setGitLoading]   = useState(false)
  const [gitBranch,   setGitBranch]    = useState('')
  const [commitMsg,   setCommitMsg]    = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [stagedExpanded,   setStagedExpanded]   = useState(true)
  const [changesExpanded,  setChangesExpanded]  = useState(true)
  const [commitError, setCommitError] = useState('')
  const [gitLog,    setGitLog]    = useState<GitLogEntry[]>([])
  const [graphExpanded, setGraphExpanded] = useState(true)
  const [commitDropdownOpen, setCommitDropdownOpen] = useState(false)
  const [isSuggestingMsg, setIsSuggestingMsg] = useState(false)
  const [isGitRepo,      setIsGitRepo]        = useState(true)
  const [diffModal, setDiffModal] = useState<{ file: string; original: string; current: string } | null>(null)

  const handleShowChanges = useCallback(async (file: string) => {
    if (!projectPath) return
    const relFile = file.replace(/\\/g, '/')
    const headRes = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
      command: `git show HEAD:${relFile}`,
      cwd: projectPath,
    }).catch(() => ({ stdout: '', exit_code: -1 }))
    const original = headRes.exit_code === 0 ? (headRes.stdout ?? '') : ''
    const absPath = `${projectPath.replace(/\\/g, '/').replace(/\/$/, '')}/${relFile}`
    const current = await readTextFile(absPath).catch(() => '')
    setDiffModal({ file: relFile, original, current })
  }, [projectPath])

  const suggestCommitMessage = useCallback(async () => {
    if (!projectPath || isSuggestingMsg) return
    setIsSuggestingMsg(true)
    setCommitMsg('')
    try {
      // If files are staged, use only staged diff (what will actually be committed).
      // Fall back to unstaged diff only when nothing is staged.
      const hasStagedFiles = stagedChanges.length > 0
      const diffRes = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
        command: hasStagedFiles ? 'git diff --cached' : 'git diff',
        cwd: projectPath,
      }).catch(() => ({ stdout: '', exit_code: -1 }))
      let diff = (diffRes.stdout ?? '').slice(0, 4000)

      // No tracked diff — build pseudo-diff from untracked file contents
      if (!diff.trim()) {
        const untrackedFiles = [...stagedChanges, ...unstagedChanges]
          .filter(c => c.status === '?')
          .map(c => c.file)
        if (untrackedFiles.length === 0) {
          setCommitMsg('No changes to summarize')
          setIsSuggestingMsg(false)
          return
        }

        const CODE_EXTS = /\.(py|js|ts|tsx|jsx|rs|go|java|rb|php|cs|cpp|c|h|html|css|json|yaml|yml|toml|md|sh)$/i
        const sep = projectPath.includes('\\') ? '\\' : '/'
        const codeFiles = untrackedFiles.filter(f => CODE_EXTS.test(f)).slice(0, 6)

        const fileDiffs: string[] = []
        for (const f of codeFiles) {
          try {
            const absPath = `${projectPath}${sep}${f.replace(/\//g, sep)}`
            const content = await invoke<string>('fs_read_file', { path: absPath })
            if (!content) continue
            const lines = content.split('\n')
            const added = lines.map(l => `+${l}`).join('\n')
            fileDiffs.push(
              `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${added}`
            )
          } catch { /* skip unreadable file */ }
        }

        if (fileDiffs.length === 0) {
          setCommitMsg('No changes to summarize')
          setIsSuggestingMsg(false)
          return
        }
        diff = fileDiffs.join('\n').slice(0, 4000)
      }

      const { baseUrl, apiKey, model } = await getResolvedEndpointAsync()
      const res = await proxyFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            {
              role: 'system',
              content: 'You are a git commit message generator. Output ONLY the commit message text — no explanation, no markdown code fences, no quotes, no leading whitespace or blank lines. Use conventional commits format (feat/fix/refactor/chore/docs). Subject line max 72 chars. Optional body after a blank line.',
            },
            {
              role: 'user',
              content: `Generate a git commit message for this diff:\n\n${diff}`,
            },
          ],
        }),
      })

      if (!res.ok || !res.body) { setIsSuggestingMsg(false); return }

      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split('\n')) {
          const trimmed = line.replace(/^data:\s*/, '').trim()
          if (!trimmed || trimmed === '[DONE]') continue
          try {
            const parsed = JSON.parse(trimmed)
            const delta = parsed.choices?.[0]?.delta?.content ?? ''
            if (delta) { accumulated += delta; setCommitMsg(accumulated.trimStart()) }
          } catch { /* partial SSE line */ }
        }
      }
      setCommitMsg(accumulated.trim())
    } catch { /* silently fail */ }
    setIsSuggestingMsg(false)
  }, [projectPath, isSuggestingMsg, stagedChanges, unstagedChanges])

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(null)

  useEffect(() => {
    if (forceView) setExplorerTab(forceView)
  }, [forceView])

  const refreshGitStatus = useCallback(async (silent = false) => {
    if (!projectPath) return
    if (!silent) setGitLoading(true)
    try {
      const [statusRes, branchRes, logRes] = await Promise.all([
        invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
          command: 'git status --porcelain -u',
          cwd: projectPath,
        }).catch(() => ({ stdout: '', exit_code: -1 })),
        invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
          command: 'git branch --show-current',
          cwd: projectPath,
        }).catch(() => ({ stdout: '', exit_code: -1 })),
        invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
          command: 'git log --format="%H\t%h\t%s\t%an\t%ar\t%D\t%P" -n 50',
          cwd: projectPath,
        }).catch(() => ({ stdout: '', exit_code: -1 })),
      ])
      const isRepo = statusRes.exit_code === 0
      setIsGitRepo(isRepo)
      if (!isRepo) {
        setStagedChanges([])
        setUnstagedChanges([])
        setGitBranch('')
        setGitLog([])
        return
      }
      const { staged, unstaged } = parseGitStatusPorcelain(statusRes.stdout ?? '')
      setStagedChanges(staged)
      setUnstagedChanges(unstaged)
      setGitBranch((branchRes.stdout ?? '').trim())
      setGitLog(parseGitLog(logRes.stdout ?? ''))
    } catch {
      setStagedChanges([])
      setUnstagedChanges([])
    } finally {
      if (!silent) setGitLoading(false)
    }
  }, [projectPath])

  const gitRun = useCallback(async (command: string) => {
    await invoke('shell_run_command', { command, cwd: projectPath }).catch(() => {})
  }, [projectPath])

  const handleInitGitRepo = useCallback(async () => {
    if (!projectPath) return
    await invoke('shell_run_command', { command: 'git init', cwd: projectPath }).catch(() => {})
    await refreshGitStatus()
  }, [projectPath, refreshGitStatus])

  const handleStageFile = useCallback(async (file: string) => {
    await gitRun(`git add -- "${file}"`)
    await refreshGitStatus(true)
  }, [gitRun, refreshGitStatus])

  const handleUnstageFile = useCallback(async (file: string) => {
    await gitRun(`git restore --staged -- "${file}"`)
    await refreshGitStatus(true)
  }, [gitRun, refreshGitStatus])

  const handleDiscardFile = useCallback(async (file: string, status: string, fromStaged: boolean) => {
    if (status === '?') {
      await gitRun(`git clean -f -- "${file}"`)
    } else if (fromStaged) {
      await gitRun(`git restore --staged --worktree -- "${file}"`)
    } else {
      await gitRun(`git restore -- "${file}"`)
    }
    await refreshGitStatus(true)
  }, [gitRun, refreshGitStatus])

  const handleStageAll = useCallback(async () => {
    await gitRun('git add -A')
    await refreshGitStatus(true)
  }, [gitRun, refreshGitStatus])

  const handleUnstageAll = useCallback(async () => {
    await gitRun('git restore --staged .')
    await refreshGitStatus(true)
  }, [gitRun, refreshGitStatus])

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return
    if (stagedChanges.length === 0 && unstagedChanges.length === 0) return
    setIsCommitting(true)
    setCommitError('')
    try {
      if (stagedChanges.length === 0) {
        await invoke('shell_run_command', { command: 'git add -A', cwd: projectPath })
      }
      const safeMsg = commitMsg.replace(/"/g, '\\"')
      const res = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
        command: `git commit -m "${safeMsg}"`,
        cwd: projectPath,
      })
      if (res.exit_code !== 0) {
        setCommitError(res.stderr?.trim() || 'Commit failed')
      } else {
        setCommitMsg('')
        setCommitError('')
        await refreshGitStatus()
      }
    } catch (e) {
      setCommitError(String(e))
    } finally {
      setIsCommitting(false)
    }
  }, [commitMsg, stagedChanges.length, unstagedChanges.length, projectPath, refreshGitStatus])

  const handleCommitAmend = useCallback(async () => {
    if (!commitMsg.trim()) return
    setIsCommitting(true)
    setCommitError('')
    try {
      const safeMsg = commitMsg.replace(/"/g, '\\"')
      const res = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
        command: `git commit --amend -m "${safeMsg}"`,
        cwd: projectPath,
      })
      if (res.exit_code !== 0) {
        setCommitError(res.stderr?.trim() || 'Amend failed')
      } else {
        setCommitMsg('')
        setCommitError('')
        await refreshGitStatus()
      }
    } catch (e) {
      setCommitError(String(e))
    } finally {
      setIsCommitting(false)
    }
  }, [commitMsg, projectPath, refreshGitStatus])

  const handleCommitAndPush = useCallback(async () => {
    if (!commitMsg.trim()) return
    if (stagedChanges.length === 0 && unstagedChanges.length === 0) return
    setIsCommitting(true)
    setCommitError('')
    try {
      if (stagedChanges.length === 0) {
        await invoke('shell_run_command', { command: 'git add -A', cwd: projectPath })
      }
      const safeMsg = commitMsg.replace(/"/g, '\\"')
      const branch = gitBranch || 'main'
      const commitRes = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
        command: `git commit -m "${safeMsg}"`,
        cwd: projectPath,
      })
      if (commitRes.exit_code !== 0) {
        setCommitError(commitRes.stderr?.trim() || 'Commit failed')
        return
      }
      const pushRes = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
        command: `git push -u origin ${branch}`,
        cwd: projectPath,
      })
      if (pushRes.exit_code !== 0) {
        setCommitError(pushRes.stderr?.trim() || 'Push failed')
        return
      }
      setCommitMsg('')
      setCommitError('')
      await refreshGitStatus()
    } catch (e) {
      setCommitError(String(e))
    } finally {
      setIsCommitting(false)
    }
  }, [commitMsg, stagedChanges.length, unstagedChanges.length, gitBranch, projectPath, refreshGitStatus])

  const handleCommitAndSync = useCallback(async () => {
    if (!commitMsg.trim()) return
    if (stagedChanges.length === 0 && unstagedChanges.length === 0) return
    setIsCommitting(true)
    setCommitError('')
    try {
      if (stagedChanges.length === 0) {
        await invoke('shell_run_command', { command: 'git add -A', cwd: projectPath })
      }
      const safeMsg = commitMsg.replace(/"/g, '\\"')
      const branch = gitBranch || 'main'
      const commitRes = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
        command: `git commit -m "${safeMsg}"`,
        cwd: projectPath,
      })
      if (commitRes.exit_code !== 0) {
        setCommitError(commitRes.stderr?.trim() || 'Commit failed')
        return
      }
      await invoke('shell_run_command', { command: 'git pull --rebase', cwd: projectPath }).catch(() => {})
      const pushRes = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
        command: `git push -u origin ${branch}`,
        cwd: projectPath,
      })
      if (pushRes.exit_code !== 0) {
        setCommitError(pushRes.stderr?.trim() || 'Push failed')
        return
      }
      setCommitMsg('')
      setCommitError('')
      await refreshGitStatus()
    } catch (e) {
      setCommitError(String(e))
    } finally {
      setIsCommitting(false)
    }
  }, [commitMsg, stagedChanges.length, unstagedChanges.length, gitBranch, projectPath, refreshGitStatus])

  const handleCommitAndCreatePR = useCallback(async () => {
    if (!commitMsg.trim()) return
    if (stagedChanges.length === 0 && unstagedChanges.length === 0) return
    setIsCommitting(true)
    setCommitError('')
    try {
      if (stagedChanges.length === 0) {
        await invoke('shell_run_command', { command: 'git add -A', cwd: projectPath })
      }
      const safeMsg = commitMsg.replace(/"/g, '\\"')
      const branch = gitBranch || 'main'
      const commitRes = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
        command: `git commit -m "${safeMsg}"`,
        cwd: projectPath,
      })
      if (commitRes.exit_code !== 0) {
        setCommitError(commitRes.stderr?.trim() || 'Commit failed')
        return
      }
      const pushRes = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
        command: `git push -u origin ${branch}`,
        cwd: projectPath,
      })
      if (pushRes.exit_code !== 0) {
        setCommitError(pushRes.stderr?.trim() || 'Push failed')
        return
      }
      setCommitMsg('')
      setCommitError('')
      await refreshGitStatus()
      const remoteRes = await invoke<{ stdout: string; exit_code: number }>('shell_run_command', {
        command: 'git remote get-url origin',
        cwd: projectPath,
      }).catch(() => ({ stdout: '', exit_code: -1 }))
      const remoteUrl = ((remoteRes as { stdout: string }).stdout ?? '').trim()
      let prUrl = ''
      if (remoteUrl.includes('github.com')) {
        const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/)
        if (match) prUrl = `https://github.com/${match[1]}/compare/${branch}?expand=1`
      } else if (remoteUrl.includes('gitlab.com')) {
        const match = remoteUrl.match(/gitlab\.com[:/](.+?)(?:\.git)?$/)
        if (match) prUrl = `https://gitlab.com/${match[1]}/-/merge_requests/new?merge_request[source_branch]=${branch}`
      }
      if (prUrl) window.open(prUrl, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setCommitError(String(e))
    } finally {
      setIsCommitting(false)
    }
  }, [commitMsg, stagedChanges.length, unstagedChanges.length, gitBranch, projectPath, refreshGitStatus])

  useEffect(() => {
    if (explorerTab !== 'source-control') return
    refreshGitStatus(false)                                    // first open: show loading
    const id = window.setInterval(() => refreshGitStatus(true), 3000)  // polls: silent
    return () => window.clearInterval(id)
  }, [explorerTab, refreshGitStatus])
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const searchRequestRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const isDragSelectingRef = useRef(false)
  const explorerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSelectedDir(null)
    setSelectedPaths(new Set())
    setRootExpanded(true)
  }, [rootName])

  useEffect(() => {
    const handleMouseUp = () => {
      isDragSelectingRef.current = false
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [])

  useEffect(() => {
    setQuery(searchQuery)
  }, [searchQuery])

  useEffect(() => {
    if (query.trim()) setSearchOpen(true)
    if (!searchOpen && !query.trim()) setSearchResults([])
  }, [query, searchOpen])

  useEffect(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) {
      searchRequestRef.current += 1
      setSearchResults([])
      setIsSearching(false)
      return
    }

    const currentRequest = ++searchRequestRef.current
    const tokens = tokenizeSearchQuery(trimmed)
    setIsSearching(true)

    const timer = window.setTimeout(async () => {
      const flatFiles = flattenFiles(files)
      const results: FileEntry[] = []
      const seen = new Set<string>()

      for (const entry of flatFiles) {
        if (matchesSearchText(`${entry.name} ${entry.path}`, trimmed, tokens)) {
          results.push(entry)
          seen.add(entry.path)
        }
      }

      if (projectPath) {
        for (const entry of flatFiles) {
          if (seen.has(entry.path) || !isSearchableTextFile(entry)) continue
          try {
            const content = await readTextFile(toAbsoluteProjectPath(projectPath, entry.path))
            if (matchesSearchText(content, trimmed, tokens)) {
              results.push(entry)
              seen.add(entry.path)
            }
          } catch {
            // Ignore unreadable files during search.
          }
          if (currentRequest !== searchRequestRef.current) return
        }
      }

      if (currentRequest === searchRequestRef.current) {
        setSearchResults(results)
        setIsSearching(false)
      }
    }, 160)

    return () => window.clearTimeout(timer)
  }, [files, projectPath, query])

  const handleQuery = useCallback((v: string) => {
    setQuery(v)
    onSearchQueryChange(v)
  }, [onSearchQueryChange])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    window.setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
    onSearchQueryChange('')
    setSearchResults([])
    setIsSearching(false)
  }, [onSearchQueryChange])

  const toggleSearch = useCallback(() => {
    if (searchOpen) closeSearch()
    else openSearch()
  }, [closeSearch, openSearch, searchOpen])

  const displayRootName = (rootName && rootName.trim()) ? rootName.trim() : 'PROJECT'

  const currentEntry = selectedFile ? findEntryByPath(files, selectedFile) : null
  const selectedDirFromFile = currentEntry
    ? (currentEntry.is_dir ? currentEntry.path : parentDir(currentEntry.path))
    : ''
  const selectedDirPath = selectedDir ?? selectedDirFromFile

  const handleSelectFile = (path: string) => {
    onSelect(path)
    setSelectedDir(null)
    setSelectedPaths(new Set([path]))
  }

  const handleSelectFolder = (path: string) => {
    setSelectedDir(path)
    setSelectedPaths(new Set([path]))
    onClearSelection?.()
  }

  const handleItemMouseDown = (event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean) => {
    if (event.button !== 0) return
    explorerRef.current?.focus()
    const isMultiSelectAction = event.ctrlKey || event.metaKey
    event.preventDefault()
    isDragSelectingRef.current = true

    if (isMultiSelectAction) {
      setSelectedPaths(prev => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
      if (isDir) setSelectedDir(path)
      else {
        setSelectedDir(null)
        onSelect(path)
      }
      return
    }

    if (isDir) handleSelectFolder(path)
    else handleSelectFile(path)
  }

  const handleItemMouseEnter = (event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean) => {
    if (!isDragSelectingRef.current) return
    if ((event.buttons & 1) !== 1) return
    setSelectedPaths(prev => {
      if (prev.has(path)) return prev
      const next = new Set(prev)
      next.add(path)
      return next
    })
    if (isDir) setSelectedDir(path)
  }

  const handleCreateFile = () => {
    if (!onCreateFile) return
    const suggestion = selectedDirPath ? `${selectedDirPath}/new-file.ts` : 'new-file.ts'
    const value = window.prompt('Create file (relative path)', suggestion)
    const normalized = value?.trim().replace(/^\/+/, '').replace(/\\/g, '/')
    if (!normalized) return
    onCreateFile(normalized)
  }

  const handleCreateFolder = () => {
    if (!onCreateFolder) return
    const suggestion = selectedDirPath ? `${selectedDirPath}/new-folder` : 'new-folder'
    const value = window.prompt('Create folder (relative path)', suggestion)
    const normalized = value?.trim().replace(/^\/+/, '').replace(/\\/g, '/')
    if (!normalized) return
    onCreateFolder(normalized)
  }

  const handleExplorerBlankClick = (event: MouseEvent<HTMLDivElement>) => {
    explorerRef.current?.focus()
    const target = event.target as HTMLElement | null
    if (!target) return
    if (
      target.closest('.file-item') ||
      target.closest('.file-search-bar') ||
      target.closest('.file-explorer-header') ||
      target.closest('.file-search-count') ||
      target.closest('.file-chat-btn')
    ) {
      return
    }
    setSelectedDir(null)
    setSelectedPaths(new Set())
    onClearSelection?.()
  }

  const handleExplorerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey)) return
    if (event.key.toLowerCase() !== 'a') return
    event.preventDefault()
    event.stopPropagation()
    const allPaths = query.trim()
      ? searchResults.map(entry => entry.path)
      : collectAllSelectablePaths(files)
    setSelectedPaths(new Set(allPaths))
  }

  // ── Context menu ────────────────────────────────────────────────────────────

  const handleContextMenu = useCallback((e: MouseEvent<HTMLDivElement>, entry: FileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const buildContextMenuSections = (entry: FileEntry): ContextMenuItem[][] => {
    const absPath = projectPath ? toAbsoluteProjectPath(projectPath, entry.path) : entry.path
    const relPath = entry.path

    const copyToClipboard = (text: string) => navigator.clipboard.writeText(text).catch(console.error)

    const doRename = async () => {
      const newName = window.prompt('Rename', entry.name)
      if (!newName || newName === entry.name) return
      const dir = absPath.replace(/[/\\][^/\\]+$/, '')
      await invoke('fs_rename', { from: absPath, to: `${dir}/${newName}` }).catch(e => alert(`Rename failed: ${e}`))
      onRefresh?.()
    }

    const doDelete = async () => {
      if (!window.confirm(`Delete "${entry.name}"?\nThis cannot be undone.`)) return
      await invoke('fs_delete', { path: absPath }).catch(e => alert(`Delete failed: ${e}`))
      onRefresh?.()
    }

    const doPaste = async (targetAbsPath: string) => {
      if (!fileClipboard) return
      const dest = `${targetAbsPath}/${fileClipboard.name}`
      try {
        if (fileClipboard.op === 'cut') {
          await invoke('fs_rename', { from: fileClipboard.absPath, to: dest })
          setFileClipboard(null)
        } else {
          const content = await invoke<string>('fs_read_file', { path: fileClipboard.absPath })
          await invoke('fs_write_file', { path: dest, content })
        }
        onRefresh?.()
      } catch (err) { alert(`Paste failed: ${err}`) }
    }

    const commonSection2: ContextMenuItem[] = [
      { label: 'Cut',  shortcut: 'Ctrl+X', action: () => setFileClipboard({ op: 'cut',  absPath, name: entry.name }) },
      { label: 'Copy', shortcut: 'Ctrl+C', action: () => setFileClipboard({ op: 'copy', absPath, name: entry.name }) },
      ...(fileClipboard && entry.is_dir
        ? [{ label: 'Paste', shortcut: 'Ctrl+V', action: () => doPaste(absPath) }]
        : []),
    ]

    const commonSection3: ContextMenuItem[] = [
      { label: 'Copy Path',          shortcut: 'Ctrl+Alt+C',       action: () => copyToClipboard(absPath) },
      { label: 'Copy Relative Path', shortcut: 'Ctrl+Shift+Alt+C', action: () => copyToClipboard(relPath) },
    ]

    const commonSection4: ContextMenuItem[] = [
      { label: 'Rename…', shortcut: 'F2',  action: doRename },
      { label: 'Delete',  shortcut: 'Del', action: doDelete, danger: true },
    ]

    if (entry.is_dir) {
      const dirPath = absPath
      const dirRel  = relPath

      const doNewFile = () => {
        const value = window.prompt('New file (relative path)', `${dirRel}/new-file.ts`)
        const normalized = value?.trim().replace(/^\/+/, '').replace(/\\/g, '/')
        if (!normalized) return
        onCreateFile?.(normalized)
      }
      const doNewFolder = () => {
        const value = window.prompt('New folder (relative path)', `${dirRel}/new-folder`)
        const normalized = value?.trim().replace(/^\/+/, '').replace(/\\/g, '/')
        if (!normalized) return
        onCreateFolder?.(normalized)
      }

      return [
        [
          { label: 'New File',   action: doNewFile },
          { label: 'New Folder', action: doNewFolder },
          { label: fileManagerLabel(), action: () => openInFileManager(dirPath, true) },
        ],
        commonSection2,
        commonSection3,
        commonSection4,
      ]
    }

    // File
    const sections: ContextMenuItem[][] = []
    if (onChatWithFile) {
      sections.push([{ label: 'Add File to Chat', action: () => onChatWithFile(relPath) }])
    }
    sections.push(commonSection2, commonSection3, commonSection4)
    return sections
  }

  return (
    <ExplorerContext.Provider value={{ projectPath: projectPath ?? null, onContextMenu: handleContextMenu, fileClipboard }}>
    <div ref={explorerRef} className="file-explorer" tabIndex={0} onKeyDown={handleExplorerKeyDown}>
      {/* Header — terax style: folder icon + name + action icons */}
      <div className="fe-header">
        <div className="fe-header-name">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-3)', flexShrink: 0 }}>
            <path d="M2 5a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z"/>
          </svg>
          <span className="fe-header-title" title={projectPath ?? ''}>
            {rootName || 'Explorer'}
          </span>
        </div>
        <div className="fe-header-actions">
          <button className="fe-action-btn" title="Search files" onClick={toggleSearch}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/>
            </svg>
          </button>
          <button className="fe-action-btn" title="New file" onClick={handleCreateFile}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z"/>
              <path d="M9 2v4h4"/>
              <line x1="8" y1="9" x2="8" y2="13"/><line x1="6" y1="11" x2="10" y2="11"/>
            </svg>
          </button>
          <button className="fe-action-btn" title="New folder" onClick={handleCreateFolder}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <path d="M2 5a1 1 0 0 1 1-1h3.5l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z"/>
              <line x1="8" y1="8" x2="8" y2="12"/><line x1="6" y1="10" x2="10" y2="10"/>
            </svg>
          </button>
          <button className="fe-action-btn" title="Refresh" onClick={() => { /* trigger refresh */ }}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              <path d="M13.5 2.5A6.5 6.5 0 1 1 7 1.5"/><polyline points="13.5,1 13.5,4 10.5,4"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Search */}
      {searchOpen && (
        <SearchBar value={query} onChange={handleQuery} onClose={closeSearch} />
      )}

      {/* Source Control tab content */}
      {explorerTab === 'source-control' && (
        <div className="fe-git-panel">
          {/* Header */}
          <div className="fe-git-toolbar">
            <span className="fe-git-title">Source Control</span>
            {gitBranch && (
              <span className="fe-git-branch" title={`Branch: ${gitBranch}`}>
                <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="4" r="1.5"/>
                  <circle cx="4" cy="12" r="1.5"/>
                  <path d="M5.5 4h2a2 2 0 0 1 2 2v2"/><line x1="4" y1="5.5" x2="4" y2="10.5"/>
                </svg>
                {gitBranch}
              </span>
            )}
            <button className="fe-action-btn" title="Refresh" onClick={() => refreshGitStatus(false)} style={{ marginLeft: 'auto' }}>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M13.5 2.5A6.5 6.5 0 1 1 7 1.5"/><polyline points="13.5,1 13.5,4 10.5,4"/>
              </svg>
            </button>
          </div>

          {/* Commit area */}
          <div className="fe-git-commit-area">
            <div className="fe-git-commit-input-wrap">
              <textarea
                className="fe-git-commit-input"
                placeholder="Message (Ctrl+Enter to commit)"
                value={commitMsg}
                onChange={e => setCommitMsg(e.target.value)}
                onKeyDown={e => {
                  e.stopPropagation()   // prevent global handlers intercepting Ctrl+A, Ctrl+C, etc.
                  if (e.ctrlKey && e.key === 'Enter') handleCommit()
                }}
                rows={3}
              />
              <button
                className={'fe-git-suggest-btn' + (isSuggestingMsg ? ' loading' : '')}
                onClick={suggestCommitMessage}
                disabled={isSuggestingMsg || (stagedChanges.length === 0 && unstagedChanges.length === 0)}
                title="Suggest commit message with AI"
              >
                {isSuggestingMsg ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
                  </svg>
                )}
              </button>
            </div>
            {commitError && <div className="fe-git-commit-error">{commitError}</div>}
            <div className="fe-git-commit-row">
              <div className="fe-git-commit-split">
                <button
                  className="fe-git-commit-btn fe-git-commit-btn--main"
                  onClick={handleCommit}
                  disabled={!commitMsg.trim() || (stagedChanges.length === 0 && unstagedChanges.length === 0) || isCommitting}
                  title="Commit changes"
                >
                  <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polyline points="2,7 5.5,10.5 12,3.5"/>
                  </svg>
                  {isCommitting ? 'Committing…' : 'Commit'}
                </button>
                <button
                  className="fe-git-commit-btn fe-git-commit-btn--caret"
                  onClick={() => setCommitDropdownOpen(v => !v)}
                  disabled={isCommitting || !commitMsg.trim()}
                  title="More commit options"
                >
                  ▾
                </button>
                {commitDropdownOpen && (
                  <>
                    <div className="fe-git-dropdown-overlay" onClick={() => setCommitDropdownOpen(false)} />
                    <div className="fe-git-commit-dropdown">
                      <button
                        onClick={() => { setCommitDropdownOpen(false); handleCommit() }}
                        disabled={!commitMsg.trim()}
                      >Commit</button>
                      <button
                        onClick={() => { setCommitDropdownOpen(false); handleCommitAmend() }}
                        disabled={!commitMsg.trim()}
                      >Commit (Amend)</button>
                      <button
                        onClick={() => { setCommitDropdownOpen(false); handleCommitAndPush() }}
                        disabled={!commitMsg.trim()}
                      >Commit &amp; Push</button>
                      <button
                        onClick={() => { setCommitDropdownOpen(false); handleCommitAndSync() }}
                        disabled={!commitMsg.trim()}
                      >Commit &amp; Sync</button>
                      <button
                        onClick={() => { setCommitDropdownOpen(false); handleCommitAndCreatePR() }}
                        disabled={!commitMsg.trim()}
                      >Commit &amp; Create Pull Request</button>
                    </div>
                  </>
                )}
              </div>
              {unstagedChanges.length > 0 && (
                <button
                  className="fe-git-commit-btn fe-git-commit-btn--secondary"
                  onClick={async () => { await handleStageAll(); }}
                  title="Stage all changes"
                >
                  + Stage All
                </button>
              )}
            </div>
          </div>

          <div className="fe-git-list">
            {gitLoading && <div className="fe-git-empty">Loading…</div>}

            {!gitLoading && !isGitRepo && (
              <div className="fe-git-no-repo">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M9 9h.01M15 9h.01M8 14s1.5 2 4 2 4-2 4-2"/>
                </svg>
                <span>Not a git repository</span>
                <button className="fe-git-init-btn" onClick={handleInitGitRepo}>
                  Initialize Repository
                </button>
              </div>
            )}

            {!gitLoading && isGitRepo && stagedChanges.length === 0 && unstagedChanges.length === 0 && gitLog.length === 0 && (
              <div className="fe-git-empty">No changes</div>
            )}

            {/* Staged Changes */}
            {!gitLoading && stagedChanges.length > 0 && (
              <div className="fe-git-section">
                <div className="fe-git-section-header" onClick={() => setStagedExpanded(v => !v)}>
                  <svg className={`fe-git-chevron${stagedExpanded ? ' open' : ''}`} viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M3 4.5l3 3 3-3"/>
                  </svg>
                  <span>Staged Changes</span>
                  <span className="fe-git-count">{stagedChanges.length}</span>
                  <div className="fe-git-section-btns" onClick={e => e.stopPropagation()}>
                    <button className="fe-git-icon-btn" title="Unstage All" onClick={handleUnstageAll}>
                      <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <line x1="2" y1="6" x2="10" y2="6"/>
                      </svg>
                    </button>
                  </div>
                </div>
                {stagedExpanded && stagedChanges.map((c, i) => {
                  const parts = c.file.replace(/\\/g, '/').split('/')
                  const name = parts.pop() ?? c.file
                  const dir = parts.join('/')
                  const relPath = c.file.replace(/\\/g, '/')
                  return (
                    <div key={i} className="fe-git-row" onClick={() => onSelect?.(relPath)}>
                      <span className="fe-git-file">{name}</span>
                      {dir && <span className="fe-git-path">{dir}</span>}
                      <span className="fe-git-status" style={{ color: gitStatusColor(c.status) }}>{c.status}</span>
                      <div className="fe-git-row-actions">
                        {/* Show changes */}
                        <button className="fe-git-icon-btn" title="Show Changes" onClick={e => { e.stopPropagation(); handleShowChanges(c.file) }}>
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <path d="M1 6s2-4 5-4 5 4 5 4-2 4-5 4-5-4-5-4z"/><circle cx="6" cy="6" r="1.5"/>
                          </svg>
                        </button>
                        {/* Open file */}
                        <button className="fe-git-icon-btn" title="Open File" onClick={e => { e.stopPropagation(); onSelect?.(relPath) }}>
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <path d="M2 2h4l1 1h3v7H2z"/>
                          </svg>
                        </button>
                        {/* Unstage */}
                        <button className="fe-git-icon-btn" title="Unstage" onClick={e => { e.stopPropagation(); handleUnstageFile(c.file) }}>
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <line x1="2" y1="6" x2="10" y2="6"/>
                          </svg>
                        </button>
                        {/* Undo / discard */}
                        <button className="fe-git-icon-btn" title="Discard Changes" onClick={e => { e.stopPropagation(); handleDiscardFile(c.file, c.status, true) }}>
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 4a4 4 0 1 1 0 4"/><polyline points="2,1 2,4 5,4"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Changes (unstaged) */}
            {!gitLoading && unstagedChanges.length > 0 && (
              <div className="fe-git-section">
                <div className="fe-git-section-header" onClick={() => setChangesExpanded(v => !v)}>
                  <svg className={`fe-git-chevron${changesExpanded ? ' open' : ''}`} viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M3 4.5l3 3 3-3"/>
                  </svg>
                  <span>Changes</span>
                  <span className="fe-git-count">{unstagedChanges.length}</span>
                  <div className="fe-git-section-btns" onClick={e => e.stopPropagation()}>
                    <button className="fe-git-icon-btn" title="Stage All" onClick={handleStageAll}>
                      <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/>
                      </svg>
                    </button>
                  </div>
                </div>
                {changesExpanded && unstagedChanges.map((c, i) => {
                  const parts = c.file.replace(/\\/g, '/').split('/')
                  const name = parts.pop() ?? c.file
                  const dir = parts.join('/')
                  const relPath = c.file.replace(/\\/g, '/')
                  return (
                    <div key={i} className="fe-git-row" onClick={() => onSelect?.(relPath)}>
                      <span className="fe-git-file">{name}</span>
                      {dir && <span className="fe-git-path">{dir}</span>}
                      <span className="fe-git-status" style={{ color: gitStatusColor(c.status) }}>{c.status}</span>
                      <div className="fe-git-row-actions">
                        {/* Show changes (only for tracked modifications, not untracked) */}
                        {c.status !== '?' && (
                          <button className="fe-git-icon-btn" title="Show Changes" onClick={e => { e.stopPropagation(); handleShowChanges(c.file) }}>
                            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                              <path d="M1 6s2-4 5-4 5 4 5 4-2 4-5 4-5-4-5-4z"/><circle cx="6" cy="6" r="1.5"/>
                            </svg>
                          </button>
                        )}
                        {/* Open file */}
                        <button className="fe-git-icon-btn" title="Open File" onClick={e => { e.stopPropagation(); onSelect?.(relPath) }}>
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <path d="M2 2h4l1 1h3v7H2z"/>
                          </svg>
                        </button>
                        {/* Stage */}
                        <button className="fe-git-icon-btn" title="Stage" onClick={e => { e.stopPropagation(); handleStageFile(c.file) }}>
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/>
                          </svg>
                        </button>
                        {/* Undo / discard */}
                        <button className="fe-git-icon-btn" title="Discard Changes" onClick={e => { e.stopPropagation(); handleDiscardFile(c.file, c.status, false) }}>
                          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 4a4 4 0 1 1 0 4"/><polyline points="2,1 2,4 5,4"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Commit Graph / History */}
            {!gitLoading && gitLog.length > 0 && (
              <CommitGraph gitLog={gitLog} graphExpanded={graphExpanded} setGraphExpanded={setGraphExpanded} />
            )}
          </div>
        </div>
      )}

      {/* Diff modal */}
      {diffModal && (
        <div className="fe-diff-overlay" onClick={() => setDiffModal(null)}>
          <div className="fe-diff-modal" onClick={e => e.stopPropagation()}>
            <div className="fe-diff-modal-header">
              <span className="fe-diff-modal-title">{diffModal.file}</span>
              <button className="fe-diff-modal-close" onClick={() => setDiffModal(null)}>
                <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
                </svg>
              </button>
            </div>
            <div className="fe-diff-modal-body">
              <DiffViewer
                path={diffModal.file}
                originalContent={diffModal.original}
                proposedContent={diffModal.current}
                status="approved"
                isNewFile={!diffModal.original}
                onAccept={() => {}}
                onReject={() => {}}
              />
            </div>
          </div>
        </div>
      )}

      {/* Content — only visible in Files tab */}
      <div className="file-explorer-content" style={{ display: explorerTab === 'files' ? 'flex' : 'none' }} onMouseDown={handleExplorerBlankClick}>
        {query.trim() ? (
          <SearchResults
            results={searchResults}
            query={query}
            selectedPaths={selectedPaths}
            onItemMouseDown={handleItemMouseDown}
            onItemMouseEnter={handleItemMouseEnter}
            onChatWithFile={onChatWithFile}
            isSearching={isSearching}
          />
        ) : view === 'categories' ? (
          <CategoryView
            files={files}
            selectedPaths={selectedPaths}
            onItemMouseDown={handleItemMouseDown}
            onItemMouseEnter={handleItemMouseEnter}
            onChatWithFile={onChatWithFile}
          />
        ) : files.length === 0 ? (
          <div className="file-tree-empty">
            No files yet.<br />Start chatting to generate code.
          </div>
        ) : (
          <div className="file-children">
            <div
              className={`file-item dir file-root${rootExpanded ? ' expanded' : ''}${selectedPaths.has('') ? ' selected' : ''}`}
              style={{ paddingLeft: 8 }}
              onMouseDown={(event) => handleItemMouseDown(event, '', true)}
              onMouseEnter={(event) => handleItemMouseEnter(event, '', true)}
              onClick={() => {
                setRootExpanded(v => !v)
              }}
              title={displayRootName}
            >
              <ChevronIcon expanded={rootExpanded} />
              <MaterialFolderIcon name={rootName ?? ''} expanded={rootExpanded} />
              <span className="file-name">{displayRootName}</span>
              {files.length > 0 && <span className="file-count-badge">{countFiles(files)}</span>}
            </div>
            {rootExpanded && files.map(f => (
              <FileNode
                key={f.path}
                entry={f}
                selectedPaths={selectedPaths}
                onItemMouseDown={handleItemMouseDown}
                onItemMouseEnter={handleItemMouseEnter}
                depth={1}
                autoExpandAll={autoExpandAll}
                onChatWithFile={onChatWithFile}
              />
            ))}
          </div>
        )}
      </div>

    </div>

      {/* Custom context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          sections={buildContextMenuSections(ctxMenu.entry)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </ExplorerContext.Provider>
  )
}
