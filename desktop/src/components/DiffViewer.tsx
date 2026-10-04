import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { presentableDiff, unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { defaultLightThemeOption } from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { getSavedMode, onThemeChange } from '@/lib/themes'
import type { Extension } from '@codemirror/state'

export type DiffStatus = 'pending' | 'approved' | 'rejected'

interface Props {
  path: string
  originalContent: string
  proposedContent: string
  status: DiffStatus
  isNewFile: boolean
  onAccept: () => void
  onReject: () => void
  onAcceptContent?: (content: string) => void
  showActions?: boolean
  fillHeight?: boolean
}

function getLangExt(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'ts': case 'tsx': return javascript({ typescript: true, jsx: ext === 'tsx' })
    case 'js': case 'jsx': return javascript({ jsx: ext === 'jsx' })
    case 'html': case 'htm': return html()
    case 'css': case 'scss': case 'less': return css()
    case 'json': return json()
    case 'md': case 'mdx': case 'markdown': return markdown()
    case 'py': return python()
    case 'rs': return rust()
    default: return []
  }
}

const DIFF_THEME = EditorView.theme({
  '.cm-changedText': { background: '#88ff881a !important' },
  '&': { fontSize: '12px', fontFamily: 'var(--mono, monospace)' },
  '.cm-scroller': { fontFamily: 'var(--mono, monospace)', overflow: 'auto' },
  '.cm-content': { padding: '4px 0' },
  '.cm-gutters': { background: 'transparent', border: 'none' },
  '.cm-merge-accept': {
    background: 'rgba(74,222,128,0.15)', borderRadius: '3px',
    padding: '1px 6px', fontSize: '10px', cursor: 'pointer',
  },
})

function computeStats(original: string, proposed: string): { added: number; removed: number } {
  try {
    const changes = presentableDiff(original, proposed)
    let added = 0, removed = 0
    for (const c of changes) {
      removed += countLines(original, c.fromA, c.toA)
      added += countLines(proposed, c.fromB, c.toB)
    }
    return { added, removed }
  } catch { return { added: 0, removed: 0 } }
}

function countLines(doc: string, from: number, to: number): number {
  if (from === to) return 0
  const slice = doc.slice(from, to)
  let n = 1
  for (let i = 0; i < slice.length; i++) if (slice.charCodeAt(i) === 10) n++
  if (slice.endsWith('\n')) n--
  return Math.max(n, 1)
}

export default function DiffViewer({ path, originalContent, proposedContent, status, isNewFile, onAccept, onReject, onAcceptContent, showActions = true, fillHeight }: Props) {
  const [isDark, setIsDark] = useState(() => getSavedMode() !== 'light')
  const editorViewRef = useRef<EditorView | null>(null)

  useEffect(() => onThemeChange(() => setIsDark(getSavedMode() !== 'light')), [])

  const stats = useMemo(() => computeStats(originalContent, proposedContent), [originalContent, proposedContent])

  const isPending = status === 'pending'

  const extensions = useMemo<Extension[]>(() => {
    const base: Extension[] = [
      getLangExt(path),
      unifiedMergeView({
        original: originalContent,
        mergeControls: isPending,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        // In fill-height (editor panel) mode show full file; chat mode collapses for space
        ...(fillHeight ? {} : { collapseUnchanged: { margin: 3, minSize: 6 } }),
      }),
      DIFF_THEME,
    ]
    if (!isPending) {
      base.push(EditorState.readOnly.of(true))
    }
    return base
  }, [path, originalContent, isPending, fillHeight])

  const handleApplyAccepted = () => {
    const view = editorViewRef.current
    if (!view || !onAcceptContent) return
    const content = view.state.doc.toString()
    onAcceptContent(content)
  }

  // Scroll to first changed line when editor is created (fill-height mode only)
  const handleCreateEditor = useCallback((view: EditorView) => {
    editorViewRef.current = view
    if (!fillHeight) return
    requestAnimationFrame(() => {
      try {
        const diffs = presentableDiff(originalContent, proposedContent)
        if (diffs.length > 0) {
          const firstPos = diffs[0].fromB
          view.dispatch({
            effects: EditorView.scrollIntoView(firstPos, { y: 'center' }),
          })
        }
      } catch { /* ignore */ }
    })
  }, [fillHeight, originalContent, proposedContent])

  const statusLabel = status === 'pending' ? 'Review required' : status === 'approved' ? 'Applied' : 'Reverted'

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-header">
        <div className="diff-viewer-info">
          <span className={`diff-status-badge diff-status-${status}`}>{statusLabel}</span>
          {isNewFile && <span className="diff-new-badge">New</span>}
          <span className="diff-path" title={path}>{path}</span>
          <span className="diff-stats">
            <span className="diff-stat-added">+{stats.added}</span>
            <span className="diff-stat-removed">-{stats.removed}</span>
          </span>
        </div>
        {showActions && (
          <div className="diff-viewer-actions">
            {isPending && onAcceptContent && (
              <button className="diff-btn diff-btn-partial" onClick={handleApplyAccepted} title="Apply only the accepted chunks">
                Apply accepted
              </button>
            )}
            {isPending && <button className="diff-btn diff-btn-accept" onClick={onAccept}>Accept all</button>}
            {isPending && <button className="diff-btn diff-btn-reject" onClick={onReject}>Reject</button>}
            {/* In fill-height editor mode, show Revert when file already applied */}
            {fillHeight && status === 'approved' && (
              <button className="diff-btn diff-btn-reject" onClick={onReject} title="Undo this change">↩ Revert</button>
            )}
          </div>
        )}
      </div>
      <div className="diff-viewer-body">
        <CodeMirror
          value={proposedContent}
          theme={isDark ? oneDark : defaultLightThemeOption}
          extensions={extensions}
          editable={isPending}
          onCreateEditor={handleCreateEditor}
          {...(fillHeight ? { height: '100%' } : { maxHeight: '320px' })}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
          }}
        />
      </div>
    </div>
  )
}
