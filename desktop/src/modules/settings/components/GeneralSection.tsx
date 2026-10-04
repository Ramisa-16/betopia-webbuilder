import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  loadGeneralPrefs,
  saveGeneralPrefs,
  type GeneralPrefs,
} from '../generalPrefs'

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
  document.documentElement.style.setProperty('--font-scale', String(size / 13))
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
const SCROLLBACK_OPTIONS = [500, 1000, 2000]

const UI_FONT_FAMILIES = [
  { value: '', label: 'Default (Inter)' },
  { value: 'Inter', label: 'Inter' },
  { value: 'system-ui', label: 'System UI' },
  { value: 'Geist', label: 'Geist' },
  { value: '-apple-system', label: 'San Francisco (macOS)' },
  { value: 'Segoe UI', label: 'Segoe UI (Windows)' },
  { value: 'Roboto', label: 'Roboto' },
]

const TERM_FONT_FAMILIES = [
  { value: '',                 label: 'Default (JetBrains Mono)' },
  { value: 'JetBrains Mono',  label: 'JetBrains Mono' },
  { value: 'Cascadia Code',   label: 'Cascadia Code' },
  { value: 'Cascadia Mono',   label: 'Cascadia Mono' },
  { value: 'Fira Code',       label: 'Fira Code' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
  { value: 'Hack',            label: 'Hack' },
  { value: 'Inconsolata',     label: 'Inconsolata' },
  { value: 'Consolas',        label: 'Consolas' },
  { value: 'Courier New',     label: 'Courier New' },
  { value: 'monospace',       label: 'System Monospace' },
]

function FontFamilyDropdown({ value, options, onChange }: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0, maxHeight: 240 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const selected = options.find(o => o.value === value) ?? options[0]

  const handleToggle = () => {
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const menuW = Math.max(r.width, 200)
      const left = Math.min(r.left, window.innerWidth - menuW - 12)
      const maxH = Math.min(240, window.innerHeight - r.bottom - 12)
      setMenuPos({ top: r.bottom + 4, left, width: menuW, maxHeight: maxH })
    }
    setOpen(v => !v)
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="gen-select"
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: selected.value || 'inherit' }}
        onClick={handleToggle}
      >
        <span>{selected.label}</span>
        <span style={{ opacity: 0.5, fontSize: 10, marginLeft: 6 }}>▾</span>
      </button>
      {open && createPortal(
        <>
          {/* Backdrop — sits above modal, below menu; closes on click */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99998 }}
            onMouseDown={() => setOpen(false)}
          />
          <div style={{
            position: 'fixed',
            top: menuPos.top,
            left: menuPos.left,
            width: menuPos.width,
            zIndex: 99999,
            borderRadius: 6,
            border: '1px solid #3a3b3e',
            background: '#1e1f23',
            boxShadow: '0 8px 24px rgba(0,0,0,0.7)',
            maxHeight: menuPos.maxHeight,
            overflowY: 'auto',
          }}>
            {options.map(o => (
              <button
                key={o.value}
                type="button"
                onMouseDown={e => { e.stopPropagation(); onChange(o.value); setOpen(false) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '7px 12px', border: 'none', cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: o.value || 'inherit',
                  background: value === o.value ? '#2a2b2f' : 'transparent',
                  color: value === o.value ? '#e8e9ec' : '#9a9ba0',
                  whiteSpace: 'nowrap',
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  )
}

export default function GeneralSection({ onDirty }: { onDirty?: () => void }) {
  const [prefs, setPrefs_] = useState<GeneralPrefs>(loadGeneralPrefs)

  const set = (patch: Partial<GeneralPrefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs_(next); saveGeneralPrefs(next)
    onDirty?.()
    if (patch.zoomLevel !== undefined) applyZoom(patch.zoomLevel)
    if (patch.uiFontFamily !== undefined || patch.uiFontSize !== undefined) {
      applyUiFont(next.uiFontFamily, next.uiFontSize)
    }
    if (patch.termFontFamily !== undefined || patch.termFontSize !== undefined ||
        patch.termFontWeight !== undefined || patch.termLetterSpacing !== undefined ||
        patch.scrollbackLines !== undefined || patch.terminalUseWebglRenderer !== undefined) {
      window.dispatchEvent(new CustomEvent('betopia:term-prefs-change', { detail: next }))
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

      {/* Terminal & Logs Font */}
      <div className="gen-group">
        <div className="gen-group-label">Terminal & Logs Font</div>
        <div className="gen-rows">
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Font family</span>
              <span className="gen-row-desc">Monospace font for the Terminal & Logs panel. Applies immediately.</span>
            </div>
            <FontFamilyDropdown
              value={prefs.termFontFamily}
              options={TERM_FONT_FAMILIES}
              onChange={v => set({ termFontFamily: v })}
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
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Scrollback</span>
              <span className="gen-row-desc">Lines of history kept for chat input history and terminal output.</span>
            </div>
            <select className="gen-select"
              value={prefs.scrollbackLines}
              onChange={e => set({ scrollbackLines: Number(e.target.value) })}>
              {SCROLLBACK_OPTIONS.map(v => (
                <option key={v} value={v}>{v.toLocaleString()} lines</option>
              ))}
            </select>
          </div>
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Use WebGL renderer</span>
              <span className="gen-row-desc">Hardware-accelerated terminal rendering. Turn it off if text becomes corrupted or blank.</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={prefs.terminalUseWebglRenderer}
                  onChange={e => set({ terminalUseWebglRenderer: e.target.checked })}
                />
                <span className="toggle-slider" />
              </label>
              <span className="gen-row-desc" style={{ textAlign: 'right', maxWidth: 240 }}>
                Helpful if the terminal needs a fallback for corrupted or blank rendering.
              </span>
            </div>
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
