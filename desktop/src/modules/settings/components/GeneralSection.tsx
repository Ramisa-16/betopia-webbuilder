import { useState, useEffect } from 'react'

export const PREFS_KEY = 'betopia:general-prefs'

interface GeneralPrefs {
  showHidden: boolean
  autoSave: boolean
  autoSaveDelay: number
  zoomLevel: number
  projectsFolder: string
  // UI font
  uiFontFamily: string
  uiFontSize: number
  // Terminal font
  termFontFamily: string
  termFontSize: number
  termLetterSpacing: number
  termFontWeight: string
}

const DEFAULTS: GeneralPrefs = {
  showHidden: false, autoSave: true, autoSaveDelay: 500, zoomLevel: 1, projectsFolder: '',
  uiFontFamily: '', uiFontSize: 13,
  termFontFamily: '', termFontSize: 13, termLetterSpacing: 0, termFontWeight: 'normal',
}

function loadPrefs(): GeneralPrefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') } }
  catch { return { ...DEFAULTS } }
}

function savePrefs(p: GeneralPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch {}
}

function applyZoom(level: number) {
  document.documentElement.style.setProperty('--zoom', String(level))
  ;(document.documentElement.style as any).zoom = String(level)
}

function applyUiFont(family: string, size: number) {
  if (family) {
    document.documentElement.style.setProperty('--font', `${family}, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`)
  } else {
    document.documentElement.style.removeProperty('--font')
  }
  document.body.style.fontSize = size + 'px'
}

const UI_FONT_SIZES = [11, 12, 13, 14, 15, 16]
const TERM_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20]
const TERM_FONT_WEIGHTS = [
  { value: 'normal', label: 'Normal' },
  { value: '500',    label: 'Medium' },
  { value: '600',    label: 'Semi-Bold' },
  { value: 'bold',   label: 'Bold' },
]
const LETTER_SPACINGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4]

const UI_FONT_FAMILIES = [
  { value: '', label: 'Default (Inter)' },
  { value: 'Inter', label: 'Inter' },
  { value: 'system-ui', label: 'System UI' },
  { value: 'Geist', label: 'Geist' },
  { value: '-apple-system', label: 'San Francisco (macOS)' },
  { value: 'Segoe UI', label: 'Segoe UI (Windows)' },
  { value: 'Roboto', label: 'Roboto' },
]

export default function GeneralSection() {
  const [prefs, setPrefs_] = useState<GeneralPrefs>(loadPrefs)

  const set = (patch: Partial<GeneralPrefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs_(next); savePrefs(next)
    if (patch.zoomLevel !== undefined) applyZoom(patch.zoomLevel)
    if (patch.uiFontFamily !== undefined || patch.uiFontSize !== undefined) {
      applyUiFont(next.uiFontFamily, next.uiFontSize)
    }
  }

  useEffect(() => {
    applyZoom(prefs.zoomLevel)
    applyUiFont(prefs.uiFontFamily, prefs.uiFontSize)
  }, [])

  const browseProjectsFolder = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: 'Choose projects folder' })
      if (selected && typeof selected === 'string') set({ projectsFolder: selected })
    } catch {}
  }

  const clearProjectsFolder = () => set({ projectsFolder: '' })

  return (
    <div className="general-section">

      {/* Editor */}
      <div className="gen-group">
        <div className="gen-group-label">Editor</div>
        <div className="gen-rows">
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Auto save</span>
              <span className="gen-row-desc">Automatically save files after changes.</span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={prefs.autoSave} onChange={e => set({ autoSave: e.target.checked })} />
              <span className="toggle-slider" />
            </label>
          </div>
          {prefs.autoSave && (
            <div className="gen-row">
              <div className="gen-row-info">
                <span className="gen-row-title">Auto save delay</span>
                <span className="gen-row-desc">Milliseconds before unsaved changes are saved.</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="number" min={100} max={10000} step={100}
                  value={prefs.autoSaveDelay}
                  onChange={e => set({ autoSaveDelay: Number(e.target.value) })}
                  className="gen-number-input"
                />
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>ms</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Interface */}
      <div className="gen-group">
        <div className="gen-group-label">Interface</div>
        <div className="gen-rows">
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Zoom level</span>
              <span className="gen-row-desc">Scale the entire UI. Applies immediately.</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="range" min="0.7" max="1.5" step="0.05"
                value={prefs.zoomLevel}
                onChange={e => set({ zoomLevel: Number(e.target.value) })}
                className="gen-slider"
              />
              <span className="gen-zoom-label">{Math.round(prefs.zoomLevel * 100)}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* UI Fonts */}
      <div className="gen-group">
        <div className="gen-group-label">UI Font</div>
        <div className="gen-rows">
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Font family</span>
              <span className="gen-row-desc">App interface font. Applies immediately.</span>
            </div>
            <select className="gen-select"
              value={prefs.uiFontFamily}
              onChange={e => set({ uiFontFamily: e.target.value })}>
              {UI_FONT_FAMILIES.map(f => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Font size</span>
              <span className="gen-row-desc">Base text size for the interface.</span>
            </div>
            <select className="gen-select"
              value={prefs.uiFontSize}
              onChange={e => set({ uiFontSize: Number(e.target.value) })}>
              {UI_FONT_SIZES.map(s => (
                <option key={s} value={s}>{s} px</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Terminal Font */}
      <div className="gen-group">
        <div className="gen-group-label">Terminal Font</div>
        <div className="gen-rows">
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Font family</span>
              <span className="gen-row-desc">Monospace font for the terminal. Takes effect on next terminal open.</span>
            </div>
            <input
              type="text"
              className="gen-font-input"
              value={prefs.termFontFamily}
              placeholder="JetBrains Mono"
              onChange={e => set({ termFontFamily: e.target.value })}
            />
          </div>
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Font size</span>
              <span className="gen-row-desc">Terminal text size in pixels.</span>
            </div>
            <select className="gen-select"
              value={prefs.termFontSize}
              onChange={e => set({ termFontSize: Number(e.target.value) })}>
              {TERM_FONT_SIZES.map(s => (
                <option key={s} value={s}>{s} px</option>
              ))}
            </select>
          </div>
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Font weight</span>
              <span className="gen-row-desc">Thickness of terminal characters.</span>
            </div>
            <select className="gen-select"
              value={prefs.termFontWeight}
              onChange={e => set({ termFontWeight: e.target.value })}>
              {TERM_FONT_WEIGHTS.map(w => (
                <option key={w.value} value={w.value}>{w.label}</option>
              ))}
            </select>
          </div>
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Letter spacing</span>
              <span className="gen-row-desc">Extra horizontal space between characters (px). Use negative to tighten Nerd Fonts.</span>
            </div>
            <select className="gen-select"
              value={prefs.termLetterSpacing}
              onChange={e => set({ termLetterSpacing: Number(e.target.value) })}>
              {LETTER_SPACINGS.map(v => (
                <option key={v} value={v}>{v > 0 ? `+${v}` : v} px</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Explorer */}
      <div className="gen-group">
        <div className="gen-group-label">Explorer</div>
        <div className="gen-rows">
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Show hidden files</span>
              <span className="gen-row-desc">Show dot-prefixed files (.env, .gitignore) in file tree.</span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={prefs.showHidden} onChange={e => set({ showHidden: e.target.checked })} />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>

      {/* Projects */}
      <div className="gen-group">
        <div className="gen-group-label">Projects</div>
        <div className="gen-rows">
          <div className="gen-row gen-row-col">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <div className="gen-row-info">
                <span className="gen-row-title">Projects folder</span>
                <span className="gen-row-desc">New projects are created inside this folder. Leave empty to be asked each time.</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                {prefs.projectsFolder && (
                  <button className="gen-browse-btn gen-browse-btn--clear" onClick={clearProjectsFolder} title="Clear">✕</button>
                )}
                <button className="gen-browse-btn" onClick={browseProjectsFolder}>Browse</button>
              </div>
            </div>
            {prefs.projectsFolder ? (
              <span className="gen-folder-path">{prefs.projectsFolder}</span>
            ) : (
              <span className="gen-folder-path gen-folder-path--empty">Not set — you will be asked each time.</span>
            )}
          </div>
        </div>
      </div>


    </div>
  )
}
