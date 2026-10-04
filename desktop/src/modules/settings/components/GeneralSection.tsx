import { useState, useEffect } from 'react'
import { getConfig, saveConfig } from '@/lib/config'

const PREFS_KEY = 'betopia:general-prefs'

interface GeneralPrefs {
  showHidden: boolean
  autoSave: boolean
  autoSaveDelay: number
  zoomLevel: number
  projectsFolder: string
}

function loadPrefs(): GeneralPrefs {
  try { return { showHidden: false, autoSave: true, autoSaveDelay: 500, zoomLevel: 1, projectsFolder: '', ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') } }
  catch { return { showHidden: false, autoSave: true, autoSaveDelay: 500, zoomLevel: 1, projectsFolder: '' } }
}

function savePrefs(p: GeneralPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch {}
}

function applyZoom(level: number) {
  document.documentElement.style.setProperty('--zoom', String(level))
  ;(document.documentElement.style as any).zoom = String(level)
}

export default function GeneralSection() {
  const [prefs, setPrefs_] = useState<GeneralPrefs>(loadPrefs)
  const [cfg, setCfg]       = useState(getConfig)

  const set = (patch: Partial<GeneralPrefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs_(next); savePrefs(next)
    if (patch.zoomLevel !== undefined) applyZoom(patch.zoomLevel)
  }

  useEffect(() => { applyZoom(prefs.zoomLevel) }, [])

  const browseProjectsFolder = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: 'Choose projects folder' })
      if (selected && typeof selected === 'string') set({ projectsFolder: selected })
    } catch {}
  }

  const clearProjectsFolder = () => set({ projectsFolder: '' })

  const setYolo = (v: boolean) => {
    const next = { ...cfg, behavior: { ...cfg.behavior, yoloMode: v } }
    setCfg(next); saveConfig(next)
  }
  const setSystemPrefix = (v: string) => {
    const next = { ...cfg, behavior: { ...cfg.behavior, systemPromptPrefix: v } }
    setCfg(next); saveConfig(next)
  }

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

      {/* UI */}
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

      {/* Agent */}
      <div className="gen-group">
        <div className="gen-group-label">Agent</div>
        <div className="gen-rows">
          <div className="gen-row">
            <div className="gen-row-info">
              <span className="gen-row-title">Yolo mode</span>
              <span className="gen-row-desc">Skip all permission prompts. Agent writes files freely without confirmation.</span>
            </div>
            <label className="toggle">
              <input type="checkbox" checked={cfg.behavior.yoloMode} onChange={e => setYolo(e.target.checked)} />
              <span className="toggle-slider" />
            </label>
          </div>
          <div className="gen-row gen-row-col">
            <div className="gen-row-info">
              <span className="gen-row-title">System prompt prefix</span>
              <span className="gen-row-desc">Prepended before the built-in system prompt every message.</span>
            </div>
            <textarea
              className="gen-textarea"
              value={cfg.behavior.systemPromptPrefix}
              onChange={e => setSystemPrefix(e.target.value)}
              placeholder="e.g. Always use TypeScript. My project uses React frontend and Django backend."
              rows={3}
            />
          </div>
        </div>
      </div>

    </div>
  )
}
