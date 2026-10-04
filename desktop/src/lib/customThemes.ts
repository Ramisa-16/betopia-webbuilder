import type { Theme } from './themes'

const CUSTOM_THEMES_LS = 'betopia:custom:themes'

export function listCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_LS)
    if (!raw) return []
    return JSON.parse(raw) as Theme[]
  } catch { return [] }
}

export function saveCustomTheme(theme: Theme): void {
  const existing = listCustomThemes()
  const idx = existing.findIndex(t => t.id === theme.id)
  if (idx >= 0) existing[idx] = theme
  else existing.push(theme)
  try { localStorage.setItem(CUSTOM_THEMES_LS, JSON.stringify(existing)) } catch {}
}

export function deleteCustomTheme(id: string): void {
  const filtered = listCustomThemes().filter(t => t.id !== id)
  try { localStorage.setItem(CUSTOM_THEMES_LS, JSON.stringify(filtered)) } catch {}
}

// ── Validation ────────────────────────────────────────────────────────────────

export type ValidationResult = { ok: true; theme: Theme } | { ok: false; error: string }

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

export function validateTheme(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Must be a JSON object' }
  const obj = raw as Record<string, unknown>

  if (typeof obj.id !== 'string' || !ID_RE.test(obj.id))
    return { ok: false, error: 'id must be lowercase kebab-case (a-z, 0-9, hyphen)' }
  if (typeof obj.name !== 'string' || !obj.name.trim())
    return { ok: false, error: 'name must be a non-empty string' }
  if (!obj.dark && !obj.light)
    return { ok: false, error: 'Must have at least one of: dark, light' }

  const checkVars = (vars: unknown, key: string): string | null => {
    if (typeof vars !== 'object' || vars === null) return `${key} must be an object`
    const v = vars as Record<string, unknown>
    const required = ['bg','surface','surface2','surface3','border','border2','text','text2','text3','accent','accentBg','accentHover','codeBg','red']
    for (const k of required) {
      if (typeof v[k] !== 'string') return `${key}.${k} must be a string color`
    }
    return null
  }

  if (obj.dark) { const e = checkVars(obj.dark, 'dark'); if (e) return { ok: false, error: e } }
  if (obj.light) { const e = checkVars(obj.light, 'light'); if (e) return { ok: false, error: e } }

  return { ok: true, theme: obj as unknown as Theme }
}

export function parseThemeFile(text: string): ValidationResult {
  try { return validateTheme(JSON.parse(text)) }
  catch { return { ok: false, error: 'Invalid JSON' } }
}

export function exportTheme(theme: Theme): string {
  return JSON.stringify(theme, null, 2)
}

export const STARTER_THEME: Theme = {
  id: 'my-theme',
  name: 'My Theme',
  description: 'A custom theme',
  preview: ['#0f1117', '#7c6bff', '#1a1d27'],
  dark: {
    bg: '#0f1117', surface: '#1a1d27', surface2: '#20232f', surface3: '#262939',
    border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
    text: '#e8eaf0', text2: '#8a90a8', text3: '#50556a',
    accent: '#7c6bff', accentBg: 'rgba(124,107,255,0.12)', accentHover: 'rgba(124,107,255,0.20)',
    codeBg: '#0b0d14', red: '#f87171', radius: '8px',
  },
}
