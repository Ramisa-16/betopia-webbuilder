import { useMemo, useCallback, useState, useEffect, useRef } from 'react'
import CodeMirror, { type Extension } from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { StateEffect, StateField, RangeSetBuilder, Prec } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { selectAll } from '@codemirror/commands'
import { acceptCompletion, completionStatus, selectedCompletion } from '@codemirror/autocomplete'
import { getSavedMode, getSavedThemeId, THEMES, onThemeChange } from '@/lib/themes'
import { resolveEditorThemeExt, getSavedEditorTheme, type EditorThemeId } from '@/lib/editorThemes'

// ── File-tree search → editor highlight (fully self-contained) ──────────────
const setExternalSearch = StateEffect.define<string>()

const externalSearchField = StateField.define<string>({
  create: () => '',
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setExternalSearch)) return effect.value
    }
    return value
  },
})

const searchMark = Decoration.mark({ class: 'cm-searchMatch' })

function buildSearchDecorations(view: EditorView): DecorationSet {
  const query = view.state.field(externalSearchField, false) ?? ''
  if (!query) return Decoration.none
  const lower = query.toLowerCase()
  const builder = new RangeSetBuilder<Decoration>()
  const doc = view.state.doc
  for (const { from, to } of view.visibleRanges) {
    const text = doc.sliceString(from, to).toLowerCase()
    let offset = 0
    while (true) {
      const idx = text.indexOf(lower, offset)
      if (idx === -1) break
      builder.add(from + idx, from + idx + lower.length, searchMark)
      offset = idx + lower.length
    }
  }
  return builder.finish()
}

const externalSearchHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = buildSearchDecorations(view) }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.state.field(externalSearchField) !== update.startState.field(externalSearchField)
      ) {
        this.decorations = buildSearchDecorations(update.view)
      }
    }
  },
  { decorations: v => v.decorations },
)
// ────────────────────────────────────────────────────────────────────────────

// ── Ghost text: shows the selected completion inline after the cursor ────────
class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super() }
  eq(other: GhostWidget) { return other.text === this.text }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-ghost-text'
    el.textContent = this.text
    return el
  }
  ignoreEvent() { return true }
}

function getWordBefore(view: EditorView, pos: number): string {
  const line = view.state.doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  const match = before.match(/[\w$]+$/)
  return match ? match[0] : ''
}

const ghostTextPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = this.compute(view) }
  update(u: ViewUpdate) { this.decorations = this.compute(u.view) }
  compute(view: EditorView): DecorationSet {
    try {
      if (completionStatus(view.state) !== 'active') return Decoration.none
      const c = selectedCompletion(view.state)
      if (!c) return Decoration.none
      const pos = view.state.selection.main.head
      const typed = getWordBefore(view, pos)
      const ghost = c.label.toLowerCase().startsWith(typed.toLowerCase())
        ? c.label.slice(typed.length)
        : ''
      if (!ghost) return Decoration.none
      return Decoration.set([
        Decoration.widget({ widget: new GhostWidget(ghost), side: 1 }).range(pos),
      ])
    } catch { return Decoration.none }
  }
}, { decorations: v => v.decorations })
// ────────────────────────────────────────────────────────────────────────────

interface Props {
  path: string | null
  content: string
  searchQuery?: string
  onContentChange?: (content: string) => void
  onInlineChat?: (selection: string) => void
}

function getLangExtension(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'ts':
    case 'tsx':  return javascript({ typescript: true, jsx: ext === 'tsx' })
    case 'js':
    case 'jsx':  return javascript({ jsx: ext === 'jsx' })
    case 'html':
    case 'htm':  return html()
    case 'css':
    case 'scss':
    case 'less': return css()
    case 'json': return json()
    case 'md':
    case 'mdx':
    case 'markdown': return markdown()
    case 'py': return python()
    case 'rs': return rust()
    default: return []
  }
}

const darkBase = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', fontFamily: 'var(--mono)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': { borderRight: '1px solid rgba(255,255,255,0.06)', padding: '0 4px' },
})

const lightBase = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', fontFamily: 'var(--mono)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': {
    borderRight: '1px solid rgba(0,0,0,0.08)', padding: '0 4px',
    background: '#f5f5f5', color: '#999',
  },
  '.cm-activeLineGutter': { background: '#e8e8e8' },
})

export default function CodeViewer({ path, content, searchQuery = '', onContentChange, onInlineChat }: Props) {
  const [isDark, setIsDark] = useState(() => getSavedMode() !== 'light')
  const [appThemeId, setAppThemeId] = useState(() => getSavedThemeId())
  const [editorThemePref, setEditorThemePref] = useState<EditorThemeId>(() => getSavedEditorTheme())
  const editorViewRef = useRef<EditorView | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const onInlineChatRef = useRef(onInlineChat)
  useEffect(() => { onInlineChatRef.current = onInlineChat }, [onInlineChat])

  useEffect(() => {
    return onThemeChange(() => {
      setIsDark(getSavedMode() !== 'light')
      setAppThemeId(getSavedThemeId())
    })
  }, [])

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === 'betopia:editor:theme') setEditorThemePref(getSavedEditorTheme())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  // Push file-tree search term into the editor on every change
  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return
    view.dispatch({ effects: setExternalSearch.of(searchQuery) })
  }, [searchQuery])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [contextMenu])

  const appTheme = THEMES.find(t => t.id === appThemeId)
  const cmTheme = resolveEditorThemeExt(appTheme?.editorTheme, isDark ? 'dark' : 'light', editorThemePref)
  const baseExt  = isDark ? darkBase : lightBase

  const saveKeymap = useMemo(() => keymap.of([
    {
      key: 'Mod-s',
      run: (view) => { onContentChange?.(view.state.doc.toString()); return true },
    },
    {
      key: 'Mod-i',
      run: (view) => {
        const { from, to } = view.state.selection.main
        const sel = view.state.sliceDoc(from, to)
        onInlineChatRef.current?.(sel)
        return true
      },
    },
  ]), [onContentChange])

  const tabAccept = useMemo(
    () => Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
    [],
  )

  const extensions = useMemo<Extension[]>(() => {
    const base: Extension[] = [tabAccept, baseExt, saveKeymap, externalSearchField, externalSearchHighlight, ghostTextPlugin]
    if (!path) return base
    return [getLangExtension(path), ...base, EditorView.lineWrapping]
  }, [path, baseExt, saveKeymap, tabAccept])

  const onChange = useCallback(
    (value: string) => onContentChange?.(value),
    [onContentChange],
  )

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const handleCopy = useCallback(async () => {
    const view = editorViewRef.current
    if (!view) return
    const { from, to } = view.state.selection.main
    const text = view.state.sliceDoc(from, to)
    if (text) await navigator.clipboard.writeText(text)
    setContextMenu(null)
  }, [])

  const handleCut = useCallback(async () => {
    const view = editorViewRef.current
    if (!view) return
    const { from, to } = view.state.selection.main
    const text = view.state.sliceDoc(from, to)
    if (text) {
      await navigator.clipboard.writeText(text)
      view.dispatch({ changes: { from, to, insert: '' } })
    }
    setContextMenu(null)
  }, [])

  const handlePaste = useCallback(async () => {
    const view = editorViewRef.current
    if (!view) return
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        const { from, to } = view.state.selection.main
        view.dispatch({ changes: { from, to, insert: text } })
        view.focus()
      }
    } catch {}
    setContextMenu(null)
  }, [])

  const handleSelectAll = useCallback(() => {
    const view = editorViewRef.current
    if (!view) return
    selectAll(view)
    setContextMenu(null)
  }, [])

  const handleOpenInlineChat = useCallback(() => {
    const view = editorViewRef.current
    if (!view) return
    const { from, to } = view.state.selection.main
    const sel = view.state.sliceDoc(from, to)
    setContextMenu(null)
    onInlineChat?.(sel)
  }, [onInlineChat])

  if (!path) {
    return (
      <div className="code-viewer">
        <div className="code-viewer-empty">
          <div className="code-viewer-empty-icon">{'</>'}</div>
          <p>Select a file to edit</p>
        </div>
      </div>
    )
  }

  return (
    <div className="code-viewer" onContextMenu={handleContextMenu}>
      <CodeMirror
        value={content}
        theme={cmTheme}
        extensions={extensions}
        onChange={onChange}
        onCreateEditor={(view) => {
          editorViewRef.current = view
          if (searchQuery) {
            view.dispatch({ effects: setExternalSearch.of(searchQuery) })
          }
        }}
        height="100%"
        style={{ height: '100%' }}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
          syntaxHighlighting: true,
          tabSize: 2,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          searchKeymap: true,
        }}
      />
      {contextMenu && (
        <div
          className="code-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button className="code-context-menu-item" onClick={handleCopy}>
            <span className="code-context-menu-label">Copy</span>
            <span className="code-context-menu-shortcut">Ctrl+C</span>
          </button>
          <button className="code-context-menu-item" onClick={handleCut}>
            <span className="code-context-menu-label">Cut</span>
            <span className="code-context-menu-shortcut">Ctrl+X</span>
          </button>
          <button className="code-context-menu-item" onClick={handlePaste}>
            <span className="code-context-menu-label">Paste</span>
            <span className="code-context-menu-shortcut">Ctrl+V</span>
          </button>
          <div className="code-context-menu-sep" />
          <button className="code-context-menu-item" onClick={handleSelectAll}>
            <span className="code-context-menu-label">Select All</span>
            <span className="code-context-menu-shortcut">Ctrl+A</span>
          </button>
          <div className="code-context-menu-sep" />
          <button className="code-context-menu-item code-context-menu-item--accent" onClick={handleOpenInlineChat}>
            <span className="code-context-menu-label">Open Inline Chat</span>
            <span className="code-context-menu-shortcut">Ctrl+I</span>
          </button>
        </div>
      )}
    </div>
  )
}
