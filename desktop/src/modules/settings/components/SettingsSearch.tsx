import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  THEMES, getSavedThemeId, getSavedMode,
  applyTheme, applyThemeAndNotify, saveThemeId, saveMode,
  type ThemeMode,
} from '@/lib/themes'
import { useUiStore } from '@/store/uiStore'
import { fuzzyFilter } from '@/lib/fuzzy'
import { parseIntent, describeIntent, type ParsedIntent } from '@/lib/intentParser'
import { setApiKey, getConfig, saveConfig } from '@/lib/config'
import type { MCPServer } from '@/lib/config'
import type { ViewMode } from '@/types'

// ── Setting item type ─────────────────────────────────────────────────────────

type SettingItem = {
  id: string
  label: string
  description: string
  category: string
  keywords: string[]
  swatch?: [string, string, string]
  active?: boolean
  action: () => void
}

// ── Registry builder ──────────────────────────────────────────────────────────

function buildRegistry(
  setViewMode: (v: ViewMode) => void,
  openAgentSettings: (tab?: string) => void,
  close: () => void,
): SettingItem[] {
  const currentThemeId = getSavedThemeId()
  const currentMode = getSavedMode()
  const items: SettingItem[] = []

  for (const theme of THEMES) {
    if (theme.dark) {
      items.push({
        id: `theme.${theme.id}.dark`,
        label: `${theme.name} — Dark`,
        description: theme.description,
        category: 'Theme',
        keywords: ['appearance', 'color', 'dark', 'night', theme.id, 'theme', theme.name.toLowerCase()],
        swatch: theme.preview,
        active: currentThemeId === theme.id && currentMode === 'dark',
        action: () => { saveThemeId(theme.id); saveMode('dark'); applyThemeAndNotify(theme.id, 'dark'); close() },
      })
    }
    if (theme.light) {
      const lv = theme.light
      items.push({
        id: `theme.${theme.id}.light`,
        label: `${theme.name} — Light`,
        description: theme.description,
        category: 'Theme',
        keywords: ['appearance', 'color', 'light', theme.id, 'theme', theme.name.toLowerCase()],
        swatch: [lv.bg, lv.accent, lv.surface],
        active: currentThemeId === theme.id && currentMode === 'light',
        action: () => { saveThemeId(theme.id); saveMode('light'); applyThemeAndNotify(theme.id, 'light'); close() },
      })
    }
  }

  const VIEWS: [string, string, string, ViewMode, string[]][] = [
    ['view.code',      'Code Editor',      'Switch to code editor',       'code',      ['code', 'editor', 'file', 'coding']],
    ['view.preview',   'Live Preview',     'Switch to live preview',      'live',      ['preview', 'live', 'browser', 'render', 'website']],
    ['view.terminal',  'Terminal',         'Open terminal / shell',       'terminal',  ['terminal', 'shell', 'bash', 'command', 'cli']],
    ['view.dashboard', 'Dashboard',        'Switch to project dashboard', 'dashboard', ['dashboard', 'overview', 'stats', 'summary']],
    ['view.database',  'Database',         'Switch to database panel',    'database',  ['database', 'db', 'sql', 'data', 'table']],
    ['view.storage',   'Storage',          'Switch to storage panel',     'storage',   ['storage', 'files', 'assets', 'media', 'uploads']],
    ['view.settings',  'Project Settings', 'Open project settings',       'settings',  ['settings', 'project', 'config', 'configure', 'general']],
  ]

  for (const [id, label, description, view, keywords] of VIEWS) {
    items.push({ id, label, description, category: 'View', keywords, action: () => { setViewMode(view); close() } })
  }

  items.push(
    { id: 'settings.agent',        label: 'Agent Settings',       description: 'Configure AI model, API keys, and agent behavior', category: 'Settings', keywords: ['agent', 'ai', 'api', 'key', 'model', 'provider', 'openai', 'configure'], action: () => { openAgentSettings('model'); close() } },
    { id: 'settings.shortcuts',    label: 'Keyboard Shortcuts',   description: 'View and customize keyboard shortcuts',            category: 'Settings', keywords: ['shortcuts', 'keybindings', 'keyboard', 'hotkeys', 'keys', 'bindings', 'rebind'], action: () => { openAgentSettings('shortcuts'); close() } },
    { id: 'settings.theme-picker', label: 'Theme & Appearance',   description: 'Open the full theme selector panel',              category: 'Settings', keywords: ['theme', 'appearance', 'color', 'dark', 'light', 'style', 'palette'], action: () => { openAgentSettings('theme'); close() } },
    { id: 'settings.mcp',          label: 'MCP Servers',          description: 'Configure Model Context Protocol servers',         category: 'Settings', keywords: ['mcp', 'server', 'context', 'protocol', 'tools', 'extensions'], action: () => { openAgentSettings('mcp'); close() } },
    { id: 'settings.general',      label: 'General Settings',     description: 'Auto save, zoom level, explorer options',         category: 'Settings', keywords: ['general', 'autosave', 'auto', 'save', 'zoom', 'hidden', 'files', 'explorer'], action: () => { openAgentSettings('general'); close() } },
    { id: 'settings.projects-folder', label: 'Projects Folder',  description: 'Set the default folder where new projects are created', category: 'Settings', keywords: ['projects', 'folder', 'directory', 'workspace', 'path', 'location', 'new project', 'create'], action: () => { openAgentSettings('general'); close() } },
    { id: 'settings.behavior',     label: 'Agent Behavior',       description: 'Configure agent behavior, yolo mode, and permissions', category: 'Settings', keywords: ['behavior', 'yolo', 'mode', 'permissions', 'auto', 'confirm', 'agent'], action: () => { openAgentSettings('behavior'); close() } },
    { id: 'settings.integrations', label: 'Integrations',         description: 'Configure git and other integrations',            category: 'Settings', keywords: ['integrations', 'git', 'github', 'gitlab', 'version', 'control'], action: () => { openAgentSettings('integrations'); close() } },
  )

  return items
}

// ── Status feedback ───────────────────────────────────────────────────────────

type CmdStatus = 'idle' | 'running' | 'done' | 'error' | 'info'

type Page = 'main' | 'theme-picker'

// ── Component ─────────────────────────────────────────────────────────────────

export default function SettingsSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [cmdStatus, setCmdStatus] = useState<CmdStatus>('idle')
  const [cmdMsg, setCmdMsg] = useState('')
  const [page, setPage] = useState<Page>('main')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // ── Theme preview ──
  const originalTheme = useRef({ id: getSavedThemeId(), mode: getSavedMode() as ThemeMode })
  const committedRef = useRef(false)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const previewTheme = useCallback((themeId: string, mode: ThemeMode) => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => applyTheme(themeId, mode), 120)
  }, [])

  const previewThemeByItemId = useCallback((itemId: string) => {
    const parts = itemId.split('.')
    if (parts.length < 3) return
    previewTheme(parts[1], parts[2] as ThemeMode)
  }, [previewTheme])

  const restoreTheme = useCallback(() => {
    if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null }
    const { id, mode } = originalTheme.current
    applyTheme(id, mode)
  }, [])

  const handleClose = useCallback(() => {
    if (!committedRef.current) restoreTheme()
    onCloseRef.current()
  }, [restoreTheme])

  const { setViewMode, setShowSettings, setSettingsInitialTab } = useUiStore()

  const openThemePicker = useCallback(() => {
    setPage('theme-picker')
    setQuery('')
  }, [])

  // ── Registry (stable) ──
  const allItems = useMemo(
    () => buildRegistry(
      setViewMode,
      (tab?: string) => { if (tab) setSettingsInitialTab(tab); setShowSettings(true) },
      () => { committedRef.current = true; onCloseRef.current() },
    ),
    [setViewMode, setShowSettings, setSettingsInitialTab],
  )

  // ── Override "Theme & Appearance" to open inline picker instead of Agent Settings ──
  const itemsWithThemeOverride = useMemo(() => allItems.map(item =>
    item.id === 'settings.theme-picker'
      ? { ...item, action: openThemePicker }
      : item
  ), [allItems, openThemePicker])

  // ── Intent detection ──
  const intent = useMemo<ParsedIntent | null>(() => parseIntent(query), [query])
  const intentMeta = useMemo(() => intent ? describeIntent(intent) : null, [intent])

  // ── Fuzzy search results ──
  // Hide Theme category items from the default (empty query) view — they appear via the sub-page
  const filteredItems = useMemo(() =>
    query ? itemsWithThemeOverride : itemsWithThemeOverride.filter(i => i.category !== 'Theme'),
    [query, itemsWithThemeOverride],
  )

  const results = useMemo(
    () => fuzzyFilter(query, filteredItems, item => [item.label, ...item.keywords, item.description, item.category]),
    [query, filteredItems],
  )

  const grouped = useMemo((): [string, SettingItem[]][] => {
    const map = new Map<string, SettingItem[]>()
    for (const item of results) {
      if (!map.has(item.category)) map.set(item.category, [])
      map.get(item.category)!.push(item)
    }
    return Array.from(map.entries())
  }, [results])

  // Total selectable items: command (if any) at idx 0, then results
  const hasCommand = !!intent
  const commandIdx = 0
  const resultOffset = hasCommand ? 1 : 0
  const totalItems = results.length + resultOffset

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setSelectedIdx(0) }, [results, intent])

  useEffect(() => {
    if (selectedIdx === commandIdx && hasCommand) return
    const resultIdx = selectedIdx - resultOffset
    if (resultIdx < 0) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${resultIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, hasCommand, resultOffset])

  // ── Theme preview on keyboard navigation ──
  useEffect(() => {
    const resultIdx = selectedIdx - resultOffset
    if (resultIdx < 0) return
    const item = results[resultIdx]
    if (!item?.id.startsWith('theme.')) {
      if (!committedRef.current) restoreTheme()
      return
    }
    previewThemeByItemId(item.id)
  }, [selectedIdx, results, resultOffset, previewThemeByItemId, restoreTheme])

  // ── Intent executor ──
  const executeIntent = useCallback(async (i: ParsedIntent) => {
    switch (i.type) {
      case 'apply-theme':
        saveThemeId(i.themeId)
        saveMode(i.mode)
        applyThemeAndNotify(i.themeId, i.mode)
        onCloseRef.current()
        break

      case 'switch-view':
        setViewMode(i.view)
        onCloseRef.current()
        break

      case 'set-api-key':
        setCmdStatus('running')
        try {
          await setApiKey(i.providerId, i.key)
          setCmdStatus('done')
          setCmdMsg(`${i.providerName} API key saved`)
          setTimeout(() => onCloseRef.current(), 1400)
        } catch {
          setCmdStatus('error')
          setCmdMsg('Failed to save key')
        }
        break

      case 'add-mcp': {
        const cfg = getConfig()
        const newServer: MCPServer = {
          id: `mcp-${Date.now()}`,
          name: i.name,
          type: i.serverType,
          url: i.url,
        }
        saveConfig({ ...cfg, mcpServers: [...cfg.mcpServers, newServer] })
        setCmdStatus('done')
        setCmdMsg(`MCP server "${i.name}" added`)
        setTimeout(() => onCloseRef.current(), 1400)
        break
      }

      case 'setup-mcp-preset': {
        if (i.missingKeys.length > 0) {
          setCmdStatus('info')
          setCmdMsg(`Needs: ${i.missingKeys.join(' and ')} — type it after the command`)
          break
        }
        const cfg = getConfig()
        const server: MCPServer = {
          id: `mcp-${Date.now()}`,
          disabled: false,
          ...i.preset.partial,
          name: i.preset.name,
          type: i.preset.partial.type ?? 'stdio',
          env: { ...(i.preset.partial.env ?? {}), ...i.providedEnv },
        }
        saveConfig({ ...cfg, mcpServers: [...cfg.mcpServers, server] })
        setCmdStatus('done')
        setCmdMsg(`${i.preset.name} MCP added`)
        setTimeout(() => onCloseRef.current(), 1400)
        break
      }
    }
  }, [setViewMode])

  // ── Keyboard handler ──
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        if (page === 'theme-picker') { setPage('main'); if (!committedRef.current) restoreTheme() }
        else handleClose()
        break
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIdx(i => Math.min(i + 1, totalItems - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIdx(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (selectedIdx === commandIdx && intent) {
          executeIntent(intent)
        } else {
          results[selectedIdx - resultOffset]?.action()
        }
        break
      case 'Tab':
        // Tab selects command if present
        if (intent) { e.preventDefault(); setSelectedIdx(0) }
        break
    }
  }, [totalItems, selectedIdx, intent, results, resultOffset, executeIntent, handleClose, page, restoreTheme])

  // ── Status badge ──
  const statusIcon = cmdStatus === 'running' ? '…' : cmdStatus === 'done' ? '✓' : cmdStatus === 'error' ? '✕' : cmdStatus === 'info' ? 'i' : null

  return createPortal(
    <div className="ss-overlay" onClick={handleClose} data-testid="ss-overlay">
      <div
        className="ss-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search settings"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        data-testid="ss-modal"
      >
        {page === 'theme-picker' ? (
          // ── Theme picker sub-page ──────────────────────────────────────────
          <ThemePickerPage
            originalTheme={originalTheme.current}
            committedRef={committedRef}
            previewTheme={previewTheme}
            restoreTheme={restoreTheme}
            onBack={() => { setPage('main'); if (!committedRef.current) restoreTheme() }}
            onClose={handleClose}
          />
        ) : (
          <>
            {/* ── Input ── */}
            <div className="ss-input-row">
              <input
                ref={inputRef}
                className="ss-input"
                placeholder="Type a command or search settings…"
                value={query}
                onChange={e => { setQuery(e.target.value); setCmdStatus('idle'); setCmdMsg('') }}
                autoComplete="off"
                spellCheck={false}
                data-testid="ss-input"
              />
              {query ? (
                <button
                  className="ss-clear"
                  onClick={() => { setQuery(''); setCmdStatus('idle'); setCmdMsg(''); inputRef.current?.focus() }}
                  aria-label="Clear"
                  data-testid="ss-clear"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              ) : null}
              <svg className="ss-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>

            {/* ── Results ── */}
            <div ref={listRef} className="ss-results" role="listbox" aria-label="Results" data-testid="ss-results"
              onMouseLeave={() => { if (!committedRef.current) restoreTheme() }}
            >
              {/* Command suggestion */}
              {intent && intentMeta && (
                <div className="ss-command-section" data-testid="ss-command-section">
                  <div className="ss-group-label">Command</div>
                  <button
                    className={'ss-command-item' + (selectedIdx === commandIdx ? ' selected' : '')}
                    role="option"
                    aria-selected={selectedIdx === commandIdx}
                    onMouseMove={() => setSelectedIdx(commandIdx)}
                    onClick={() => executeIntent(intent)}
                    data-testid="ss-command-item"
                    disabled={cmdStatus === 'running'}
                  >
                    <div className="ss-command-icon" aria-hidden="true">
                      {statusIcon
                        ? <span className={'ss-cmd-status-icon' + (cmdStatus === 'done' ? ' done' : cmdStatus === 'error' ? ' err' : cmdStatus === 'info' ? ' info' : '')}>{statusIcon}</span>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                          </svg>
                      }
                    </div>
                    <div className="ss-item-body">
                      <span className="ss-command-label">{(cmdStatus === 'done' || cmdStatus === 'error' || cmdStatus === 'info') ? cmdMsg : intentMeta.label}</span>
                      <span className="ss-item-desc">{cmdStatus === 'idle' ? intentMeta.description : cmdStatus === 'running' ? 'Working…' : cmdStatus === 'info' ? intentMeta.label : ''}</span>
                    </div>
                    {cmdStatus === 'idle' && <kbd className="ss-command-run">↵</kbd>}
                  </button>
                </div>
              )}

              {/* Regular search results */}
              {results.length === 0 && !intent
                ? (
                  <div className="ss-empty" data-testid="ss-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.35 }}>
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <span>{query ? `No results for "${query}"` : 'No commands found.'}</span>
                  </div>
                )
                : grouped.map(([cat, catItems]) => (
                  <div key={cat} className="ss-group" data-testid={`ss-group-${cat}`}>
                    <div className="ss-group-label">{cat}</div>
                    {catItems.map(item => {
                      const idx = results.indexOf(item) + resultOffset
                      return (
                        <button
                          key={item.id}
                          data-idx={results.indexOf(item)}
                          data-testid={`ss-item-${item.id}`}
                          className={'ss-item' + (selectedIdx === idx ? ' selected' : '') + (item.active ? ' ss-item--active' : '')}
                          role="option"
                          aria-selected={selectedIdx === idx}
                          onMouseMove={() => setSelectedIdx(idx)}
                          onMouseEnter={() => { if (item.id.startsWith('theme.')) previewThemeByItemId(item.id) }}
                          onClick={() => { if (item.id.startsWith('theme.')) committedRef.current = true; item.action() }}
                        >
                          {item.swatch ? (
                            <div className="ss-swatch" aria-hidden="true">
                              <div style={{ background: item.swatch[0] }} />
                              <div style={{ background: item.swatch[1] }} />
                              <div style={{ background: item.swatch[2] }} />
                            </div>
                          ) : null}
                          <div className="ss-item-body">
                            <span className="ss-item-label">{item.label}</span>
                            <span className="ss-item-desc">{item.description}</span>
                          </div>
                          {item.active && <div className="ss-active-dot" aria-label="Active" />}
                        </button>
                      )
                    })}
                  </div>
                ))
              }
            </div>

            {/* ── Footer ── */}
            <div className="ss-footer">
              <span className="ss-hint"><kbd>↑↓</kbd> navigate</span>
              <span className="ss-hint"><kbd>↵</kbd> {intent ? 'run' : 'select'}</span>
              <span className="ss-hint"><kbd>Esc</kbd> close</span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ── Theme picker sub-page ─────────────────────────────────────────────────────

function ThemePickerPage({
  originalTheme,
  committedRef,
  previewTheme,
  restoreTheme,
  onBack,
  onClose,
}: {
  originalTheme: { id: string; mode: ThemeMode }
  committedRef: React.MutableRefObject<boolean>
  previewTheme: (themeId: string, mode: ThemeMode) => void
  restoreTheme: () => void
  onBack: () => void
  onClose: () => void
}) {
  const { setShowSettings, setSettingsInitialTab } = useUiStore()
  const currentThemeId = getSavedThemeId()
  const currentMode = getSavedMode() as ThemeMode
  const [mode, setMode] = useState<ThemeMode>(currentMode)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const openFullAppearance = () => {
    committedRef.current = true
    setSettingsInitialTab('theme')
    setShowSettings(true)
    onClose()
  }

  const selectTheme = (themeId: string, m: ThemeMode) => {
    committedRef.current = true
    saveThemeId(themeId)
    saveMode(m)
    applyThemeAndNotify(themeId, m)
    onClose()
  }

  const handleMouseEnter = (themeId: string, m: ThemeMode) => {
    setHoveredId(`${themeId}.${m}`)
    previewTheme(themeId, m)
  }

  const handleMouseLeave = () => {
    setHoveredId(null)
    if (!committedRef.current) restoreTheme()
  }

  return (
    <>
      {/* ── Header with back button ── */}
      <div className="ss-subpage-header">
        <button className="ss-back-btn" onClick={onBack} title="Back">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="ss-subpage-title">Theme &amp; Appearance</span>
        <div className="ss-mode-toggle">
          <button className={mode === 'dark' ? 'active' : ''} onClick={() => setMode('dark')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>
            Dark
          </button>
          <button className={mode === 'light' ? 'active' : ''} onClick={() => setMode('light')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            Light
          </button>
        </div>
      </div>

      {/* ── Theme list ── */}
      <div className="ss-results ss-theme-list" onMouseLeave={handleMouseLeave}>
        {THEMES.filter(t => mode === 'dark' ? !!t.dark : !!t.light).map(theme => {
          const variant = mode === 'dark' ? theme.dark! : theme.light!
          const isActive = currentThemeId === theme.id && currentMode === mode
          const isHovered = hoveredId === `${theme.id}.${mode}`
          const swatch: [string, string, string] = mode === 'dark'
            ? (theme.preview ?? [variant.bg, variant.accent, variant.surface])
            : [variant.bg, variant.accent, variant.surface]
          return (
            <button
              key={theme.id}
              className={'ss-item' + (isActive || isHovered ? ' selected' : '') + (isActive ? ' ss-item--active' : '')}
              onMouseEnter={() => handleMouseEnter(theme.id, mode)}
              onClick={() => selectTheme(theme.id, mode)}
            >
              <div className="ss-swatch" aria-hidden="true">
                <div style={{ background: swatch[0] }} />
                <div style={{ background: swatch[1] }} />
                <div style={{ background: swatch[2] }} />
              </div>
              <div className="ss-item-body">
                <span className="ss-item-label">{theme.name}</span>
                <span className="ss-item-desc">{theme.description}</span>
              </div>
              {isActive && <div className="ss-active-dot" aria-label="Active" />}
            </button>
          )
        })}
      </div>

      {/* ── Footer ── */}
      <div className="ss-footer">
        <span className="ss-hint"><kbd>Esc</kbd> back</span>
        <button className="ss-appearance-settings-btn" onClick={openFullAppearance} title="Open Appearance in Agent Settings">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
          More settings
        </button>
      </div>
    </>
  )
}
