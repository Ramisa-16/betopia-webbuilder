/**
 * TabBar.tsx
 * Multi-file tab system for the code editor.
 * Supports open/close, dirty state indicators, keyboard navigation.
 */

import { useRef, useEffect } from 'react'
import type { TabEntry } from '@/types'

// File extension → language badge colour
const LANG_COLORS: Record<string, string> = {
  tsx: '#3b82f6', ts: '#2563eb', jsx: '#f59e0b', js: '#eab308',
  css: '#a855f7', scss: '#ec4899', html: '#f97316', json: '#10b981',
  md: '#6b7280', py: '#3b82f6', go: '#00acd7', rs: '#ce422b',
}

function langColor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANG_COLORS[ext] ?? '#6b7280'
}

function getIcon(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const icons: Record<string, string> = {
    tsx: '⚛', ts: '📘', jsx: '⚛', js: '📙',
    html: '🌐', css: '🎨', scss: '🎨',
    json: '📋', md: '📝', py: '🐍', go: '🐹',
    rs: '🦀', yaml: '⚙', yml: '⚙', env: '🔑',
  }
  return icons[ext] ?? '📄'
}

interface TabBarProps {
  tabs: TabEntry[]
  activeTab: string | null
  onSelectTab: (path: string) => void
  onCloseTab: (path: string) => void
  onCloseOtherTabs?: (path: string) => void
  previewTabOpen?: boolean
  previewTabActive?: boolean
  onSelectPreviewTab?: () => void
  onClosePreviewTab?: () => void
  apiDocsTabOpen?: boolean
  apiDocsTabActive?: boolean
  onSelectApiDocsTab?: () => void
  onCloseApiDocsTab?: () => void
}

export default function TabBar({
  tabs,
  activeTab,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  previewTabOpen,
  previewTabActive,
  onSelectPreviewTab,
  onClosePreviewTab,
  apiDocsTabOpen,
  apiDocsTabActive,
  onSelectApiDocsTab,
  onCloseApiDocsTab,
}: TabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)

  // Scroll active tab into view when it changes
  useEffect(() => {
    if (!activeRef.current || !scrollRef.current) return
    const container = scrollRef.current
    const tab = activeRef.current
    const { left, right } = tab.getBoundingClientRect()
    const { left: cLeft, right: cRight } = container.getBoundingClientRect()
    if (left < cLeft) {
      container.scrollLeft -= cLeft - left + 8
    } else if (right > cRight) {
      container.scrollLeft += right - cRight + 8
    }
  }, [activeTab])

  if (tabs.length === 0 && !previewTabOpen && !apiDocsTabOpen) {
    return (
      <div className="tab-bar tab-bar-empty">
        <span>No files open</span>
      </div>
    )
  }

  return (
    <div className="tab-bar" role="tablist">
      <div
        className="tab-bar-scroll"
        ref={scrollRef}
        onWheel={e => {
          if (tabs.length < 2) return
          e.preventDefault()
          const idx = tabs.findIndex(t => t.path === activeTab)
          const next = e.deltaY > 0 ? tabs[idx + 1] : tabs[idx - 1]
          if (next) onSelectTab(next.path)
        }}
      >
        {tabs.map(tab => {
          const isActive = tab.path === activeTab
          return (
            <div
              key={tab.path}
              ref={isActive ? activeRef : undefined}
              role="tab"
              aria-selected={isActive}
              className={`tab-item${isActive ? ' tab-item-active' : ''}${tab.isDirty ? ' tab-item-dirty' : ''}`}
              onClick={() => onSelectTab(tab.path)}
              title={tab.path}
            >
              {/* Language dot */}
              <span
                className="tab-lang-dot"
                style={{ background: langColor(tab.path) }}
              />
              {/* Icon */}
              <span className="tab-icon">{getIcon(tab.path)}</span>
              {/* Label */}
              <span className="tab-label">{tab.label}</span>
              {/* Dirty / close */}
              {tab.isDirty ? (
                <span
                  className="tab-dirty-dot"
                  title="Unsaved changes"
                  onClick={e => { e.stopPropagation(); onCloseTab(tab.path) }}
                />
              ) : (
                <button
                  className="tab-close-btn"
                  title="Close tab"
                  onClick={e => { e.stopPropagation(); onCloseTab(tab.path) }}
                  aria-label={`Close ${tab.label}`}
                >
                  ✕
                </button>
              )}
            </div>
          )
        })}
        {previewTabOpen && (
          <div
            role="tab"
            aria-selected={previewTabActive}
            className={`tab-item${previewTabActive ? ' tab-item-active' : ''}`}
            onClick={onSelectPreviewTab}
            title="Live Preview"
          >
            <span className="tab-lang-dot" style={{ background: '#10b981' }} />
            <span className="tab-icon">🌐</span>
            <span className="tab-label">Preview</span>
            <button
              className="tab-close-btn"
              title="Close preview"
              onClick={e => { e.stopPropagation(); onClosePreviewTab?.() }}
              aria-label="Close preview tab"
            >✕</button>
          </div>
        )}
        {apiDocsTabOpen && (
          <div
            role="tab"
            aria-selected={apiDocsTabActive}
            className={`tab-item${apiDocsTabActive ? ' tab-item-active' : ''}`}
            onClick={onSelectApiDocsTab}
            title="API Documentation"
          >
            <span className="tab-lang-dot" style={{ background: '#f59e0b' }} />
            <span className="tab-icon">📡</span>
            <span className="tab-label">API Docs</span>
            <button
              className="tab-close-btn"
              title="Close API docs"
              onClick={e => { e.stopPropagation(); onCloseApiDocsTab?.() }}
              aria-label="Close API docs tab"
            >✕</button>
          </div>
        )}
      </div>

      {/* Actions */}
      {tabs.length > 1 && onCloseOtherTabs && activeTab && (
        <div className="tab-bar-actions">
          <button
            className="tab-action-btn"
            title="Close other tabs"
            onClick={() => onCloseOtherTabs(activeTab)}
          >
            ✕ others
          </button>
        </div>
      )}
    </div>
  )
}

// ── Tab state helpers (used in App.tsx) ───────────────────────────────────────

export function buildTabLabel(path: string): string {
  return path.split('/').pop() ?? path.split('\\').pop() ?? path
}

export function openTab(tabs: TabEntry[], path: string, isDirty = false): TabEntry[] {
  const exists = tabs.find(t => t.path === path)
  if (exists) return tabs
  return [...tabs, { path, label: buildTabLabel(path), isDirty }]
}

export function closeTab(tabs: TabEntry[], path: string): TabEntry[] {
  return tabs.filter(t => t.path !== path)
}

export function markTabDirty(tabs: TabEntry[], path: string, dirty: boolean): TabEntry[] {
  return tabs.map(t => t.path === path ? { ...t, isDirty: dirty } : t)
}

export function getAdjacentTab(tabs: TabEntry[], closedPath: string): string | null {
  const idx = tabs.findIndex(t => t.path === closedPath)
  if (idx === -1) return null
  if (tabs.length === 1) return null
  return (tabs[idx + 1] ?? tabs[idx - 1])?.path ?? null
}
