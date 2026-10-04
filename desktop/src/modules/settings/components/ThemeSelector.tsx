import { useState, useRef, useEffect, useCallback } from 'react'
import {
  THEMES, applyThemeAndNotify, getSavedThemeId, getSavedMode,
  saveThemeId, saveMode, type ThemeMode,
} from '@/lib/themes'
import {
  listCustomThemes, saveCustomTheme, deleteCustomTheme,
  parseThemeFile, exportTheme, STARTER_THEME, type ValidationResult,
} from '@/lib/customThemes'
import {
  EDITOR_THEME_LABELS, getSavedEditorTheme, saveEditorTheme, type EditorThemeId,
} from '@/lib/editorThemes'
import {
  getBgKind, setBgKind, getBgImageId, setBgImageId,
  getBgOpacity, setBgOpacity, getBgBlur, setBgBlur,
  importBgImageFromFile, getBgImage, deleteBgImage, type BgKind,
} from '@/lib/bgImageStore'

function dispatchBgChange() {
  window.dispatchEvent(new CustomEvent('betopia:bg:changed'))
}

export default function ThemeSelector() {
  // App theme
  const [activeId, setActiveId] = useState(getSavedThemeId)
  const [mode, setMode] = useState<ThemeMode>(getSavedMode)
  const [customThemes, setCustomThemes] = useState(listCustomThemes)

  // Create / import
  const [creating, setCreating] = useState(false)
  const [createJson, setCreateJson] = useState('')
  const [createError, setCreateError] = useState('')
  const importThemeRef = useRef<HTMLInputElement>(null)

  // Editor theme
  const [editorTheme, setEditorTheme] = useState<EditorThemeId>(() => getSavedEditorTheme())

  // Background
  const [bgKind, setBgKindState] = useState<BgKind>(getBgKind)
  const [bgOpacity, setBgOpacityState] = useState(getBgOpacity)
  const [bgBlur, setBgBlurState] = useState(getBgBlur)
  const [bgPreviewUrl, setBgPreviewUrl] = useState<string | null>(null)
  const [bgError, setBgError] = useState('')
  const [bgLoading, setBgLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Load background preview on mount
  useEffect(() => {
    if (getBgKind() !== 'image') return
    const id = getBgImageId()
    if (!id) return
    getBgImage(id).then(blob => {
      if (blob) setBgPreviewUrl(URL.createObjectURL(blob))
    })
  }, [])

  useEffect(() => {
    return () => { if (bgPreviewUrl) URL.revokeObjectURL(bgPreviewUrl) }
  }, [bgPreviewUrl])

  const apply = (id: string, m: ThemeMode) => {
    setActiveId(id); setMode(m)
    saveThemeId(id); saveMode(m)
    applyThemeAndNotify(id, m)
  }

  // ── Create theme ──────────────────────────────────────────────────────────
  const openCreate = () => {
    setCreateJson(JSON.stringify(STARTER_THEME, null, 2))
    setCreateError('')
    setCreating(true)
  }

  const handleCreateSave = () => {
    const result = parseThemeFile(createJson)
    if (!result.ok) { setCreateError((result as Extract<ValidationResult, { ok: false }>).error); return }
    saveCustomTheme(result.theme)
    setCustomThemes(listCustomThemes())
    setCreating(false)
  }

  // ── Import theme file ─────────────────────────────────────────────────────
  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text()
      const result = parseThemeFile(text)
      if (!result.ok) { alert(`Import failed: ${(result as Extract<ValidationResult, { ok: false }>).error}`); return }
      saveCustomTheme(result.theme)
      setCustomThemes(listCustomThemes())
    } catch { alert('Could not read file') }
  }

  // ── Export theme ──────────────────────────────────────────────────────────
  const handleExport = (theme: ReturnType<typeof listCustomThemes>[0]) => {
    const blob = new Blob([exportTheme(theme)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${theme.id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Editor theme ──────────────────────────────────────────────────────────
  const handleEditorTheme = (id: EditorThemeId) => {
    setEditorTheme(id)
    saveEditorTheme(id)
    window.dispatchEvent(new StorageEvent('storage', { key: 'betopia:editor:theme', newValue: id }))
  }

  // ── Background image ──────────────────────────────────────────────────────
  const handleBgFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) { setBgError('Must be an image file'); return }
    setBgLoading(true); setBgError('')
    try {
      const id = await importBgImageFromFile(file)
      setBgImageId(id); setBgKind('image'); setBgKindState('image')
      const blob = await getBgImage(id)
      if (blob) setBgPreviewUrl(URL.createObjectURL(blob))
      dispatchBgChange()
    } catch (e: any) {
      setBgError(e.message ?? 'Import failed')
    } finally { setBgLoading(false) }
  }, [])

  const handleBgRemove = async () => {
    const id = getBgImageId()
    if (id) { try { await deleteBgImage(id) } catch {} }
    setBgImageId(null); setBgKind('none'); setBgKindState('none')
    setBgPreviewUrl(null)
    dispatchBgChange()
  }

  const handleOpacityChange = (v: number) => {
    setBgOpacityState(v); setBgOpacity(v); dispatchBgChange()
  }

  const handleBlurChange = (v: number) => {
    setBgBlurState(v); setBgBlur(v); dispatchBgChange()
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleBgFile(file)
  }, [handleBgFile])

  const allThemes = [...THEMES, ...customThemes]

  return (
    <div className="theme-section">
      {/* ── Mode Toggle ─────────────────────────────────────────────────── */}
      <div className="theme-mode-row">
        <span className="theme-section-label">Appearance</span>
        <div className="theme-mode-btns">
          <button className={`theme-mode-btn${mode === 'dark' ? ' active' : ''}`} onClick={() => apply(activeId, 'dark')}>
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12.5 9.5A6 6 0 0 1 4.5 1.5a6 6 0 1 0 8 8z" />
            </svg>
            Dark
          </button>
          <button className={`theme-mode-btn${mode === 'light' ? ' active' : ''}`} onClick={() => apply(activeId, 'light')}>
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="7" cy="7" r="2.5" />
              <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M3.05 3.05l1.06 1.06M9.89 9.89l1.06 1.06M3.05 10.95l1.06-1.06M9.89 4.11l1.06-1.06" />
            </svg>
            Light
          </button>
        </div>
      </div>

      {/* ── Theme Grid ──────────────────────────────────────────────────── */}
      <div className="theme-grid">
        {allThemes.map(t => {
          const isCustom = !!t.custom
          const vars = mode === 'light' ? (t.light ?? t.dark) : (t.dark ?? t.light)
          const hasMode = mode === 'light' ? !!t.light : !!t.dark
          const isActive = t.id === activeId
          return (
            <div key={t.id} className="theme-card-wrap">
              <button
                className={`theme-card${isActive ? ' active' : ''}${!hasMode ? ' no-mode' : ''}`}
                onClick={() => hasMode && apply(t.id, mode)}
                title={t.description}
                disabled={!hasMode}
              >
                {/* Color swatch — left side */}
                <div className="theme-card-swatch" style={{ background: vars?.bg ?? '#111' }}>
                  <div className="theme-card-swatch-bar" style={{ background: vars?.surface ?? '#222' }}>
                    <div className="theme-card-swatch-dot" style={{ background: vars?.accent ?? '#888' }} />
                  </div>
                  <div className="theme-card-swatch-lines">
                    <div className="theme-card-swatch-line" style={{ background: vars?.text ?? '#eee', width: '75%' }} />
                    <div className="theme-card-swatch-line" style={{ background: vars?.text2 ?? '#888', width: '50%' }} />
                  </div>
                  {!hasMode && <div className="theme-card-no-mode">N/A</div>}
                </div>

                {/* Name + desc — right side */}
                <div className="theme-card-body">
                  <div className="theme-card-name-row">
                    <span className="theme-card-name">{t.name}</span>
                    {isActive && (
                      <span className="theme-card-active-badge">Active</span>
                    )}
                    {isCustom && (
                      <span className="theme-card-custom-badge">Custom</span>
                    )}
                  </div>
                  <span className="theme-card-desc">{t.description}</span>
                </div>
              </button>

              {isCustom && (
                <div className="theme-card-actions">
                  <button className="theme-card-action-btn" title="Export" onClick={() => handleExport(t)}>
                    <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M7 1v8M4 6l3 3 3-3M2 11h10" />
                    </svg>
                  </button>
                  <button className="theme-card-action-btn theme-card-action-btn--danger" title="Delete"
                    onClick={() => { deleteCustomTheme(t.id); setCustomThemes(listCustomThemes()) }}>
                    <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M2 4h10M5 4V2h4v2M6 7v4M8 7v4M3 4l1 8h6l1-8" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Create / Import ──────────────────────────────────────────────── */}
      <div className="theme-actions-row">
        <button className="theme-action-btn" onClick={openCreate}>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M7 2v10M2 7h10" />
          </svg>
          Create Theme
        </button>
        <button className="theme-action-btn" onClick={() => importThemeRef.current?.click()}>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M7 9V1M4 4l3-3 3 3M2 11h10" />
          </svg>
          Import
        </button>
        <input ref={importThemeRef} type="file" accept=".json" style={{ display: 'none' }}
          onChange={e => { if (e.target.files?.[0]) handleImportFile(e.target.files[0]); e.target.value = '' }} />
      </div>

      {/* ── Create Theme Panel ───────────────────────────────────────────── */}
      {creating && (
        <div className="theme-create-panel">
          <div className="theme-create-header">
            <span className="theme-section-label">New Theme (JSON)</span>
            <button className="theme-create-close" onClick={() => setCreating(false)}>
              <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2 2l10 10M12 2L2 12" />
              </svg>
            </button>
          </div>
          <textarea
            className="theme-create-textarea"
            value={createJson}
            onChange={e => { setCreateJson(e.target.value); setCreateError('') }}
            spellCheck={false}
          />
          {createError && <p className="theme-create-error">{createError}</p>}
          <div className="theme-create-footer">
            <button className="theme-action-btn" onClick={() => setCreating(false)}>Cancel</button>
            <button className="theme-action-btn theme-action-btn--primary" onClick={handleCreateSave}>Save Theme</button>
          </div>
        </div>
      )}

      {/* ── Editor Theme ─────────────────────────────────────────────────── */}
      <div className="theme-subsection">
        <div className="theme-subsection-header">
          <span className="theme-section-label">Editor Theme</span>
          <span className="theme-section-hint">Controls CodeMirror syntax highlighting</span>
        </div>
        <select
          className="theme-select"
          value={editorTheme}
          onChange={e => handleEditorTheme(e.target.value as EditorThemeId)}
        >
          <option value="auto">Auto (follows app theme)</option>
          <optgroup label="──────────────">
            {Object.entries(EDITOR_THEME_LABELS).map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </optgroup>
        </select>
      </div>

    </div>
  )
}
