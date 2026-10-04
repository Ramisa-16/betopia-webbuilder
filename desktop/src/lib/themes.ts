export type ThemeMode = 'dark' | 'light'

export type ThemeVars = {
  bg: string
  surface: string
  surface2: string
  surface3: string
  border: string
  border2: string
  text: string
  text2: string
  text3: string
  accent: string
  accentBg: string
  accentHover: string
  codeBg: string
  red: string
  radius?: string
}

export type Theme = {
  id: string
  name: string
  description: string
  preview: [string, string, string]  // bg, accent, surface swatch
  dark?: ThemeVars
  light?: ThemeVars
  editorTheme?: { dark?: string; light?: string }  // auto editor theme pairing
  custom?: boolean  // user-created
}

const hex = (h: string, opacity: number) => {
  const r = parseInt(h.slice(1,3),16)
  const g = parseInt(h.slice(3,5),16)
  const b = parseInt(h.slice(5,7),16)
  return `rgba(${r},${g},${b},${opacity})`
}

export const THEMES: Theme[] = [
  {
    id: 'betopia',
    name: 'Betopia',
    description: 'Default dark — deep black with orange accent.',
    preview: ['#0a0a0b', '#da7756', '#141416'],
    editorTheme: { dark: 'atomone', light: 'github-light' },
    dark: {
      bg: '#0a0a0b', surface: '#141416', surface2: '#1c1c1f', surface3: '#252528',
      border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
      text: '#ececed', text2: '#9b9ba0', text3: '#55555a',
      accent: '#da7756', accentBg: 'rgba(218,119,86,0.10)', accentHover: 'rgba(218,119,86,0.18)',
      codeBg: '#0f0f11', red: '#f87171', radius: '8px',
    },
    light: {
      bg: '#f6f7fb', surface: '#ffffff', surface2: '#f3f4f6', surface3: '#eef0f3',
      border: 'rgba(0,0,0,0.06)', border2: 'rgba(0,0,0,0.09)',
      text: '#0f1724', text2: '#6b7280', text3: '#9ca3af',
      accent: '#0066cc', accentBg: 'rgba(0,102,204,0.08)', accentHover: 'rgba(0,102,204,0.12)',
      codeBg: '#f3f4f6', red: '#e53e3e', radius: '8px',
    },
  },
  {
    id: 'claude',
    name: 'Claude',
    description: 'Warm clay accent on paper.',
    preview: ['#1f1e1d', '#d97757', '#262624'],
    editorTheme: { dark: 'copilot', light: 'github-light' },
    dark: {
      bg: '#1f1e1d', surface: '#262624', surface2: '#2a2926', surface3: '#2f2d2a',
      border: 'rgba(245,244,238,0.10)', border2: 'rgba(245,244,238,0.14)',
      text: '#f5f4ee', text2: '#b0a89a', text3: '#6e6860',
      accent: '#d97757', accentBg: 'rgba(217,119,87,0.12)', accentHover: 'rgba(217,119,87,0.20)',
      codeBg: '#1a1918', red: '#e5634d', radius: '0.5rem',
    },
    light: {
      bg: '#faf9f5', surface: '#ffffff', surface2: '#f0eee6', surface3: '#f0ede4',
      border: 'rgba(61,58,47,0.12)', border2: 'rgba(61,58,47,0.16)',
      text: '#3d3a2f', text2: '#73705f', text3: '#a09d90',
      accent: '#c15f3c', accentBg: 'rgba(193,95,60,0.10)', accentHover: 'rgba(193,95,60,0.16)',
      codeBg: '#f5f4ee', red: '#c0392b', radius: '0.5rem',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Calm, blue-leaning dark theme.',
    preview: ['#1a1b26', '#7aa2f7', '#1f2030'],
    editorTheme: { dark: 'tokyo-night' },
    dark: {
      bg: '#1a1b26', surface: '#1f2030', surface2: '#292e42', surface3: '#292e42',
      border: 'rgba(255,255,255,0.08)', border2: 'rgba(255,255,255,0.12)',
      text: '#c0caf5', text2: '#9aa5ce', text3: '#5c6490',
      accent: '#7aa2f7', accentBg: 'rgba(122,162,247,0.12)', accentHover: 'rgba(122,162,247,0.20)',
      codeBg: '#16161e', red: '#f7768e', radius: '0.375rem',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic, north-bluish palette.',
    preview: ['#2e3440', '#88c0d0', '#3b4252'],
    editorTheme: { dark: 'nord', light: 'xcode-light' },
    dark: {
      bg: '#2e3440', surface: '#3b4252', surface2: '#434c5e', surface3: '#434c5e',
      border: 'rgba(255,255,255,0.08)', border2: 'rgba(255,255,255,0.12)',
      text: '#d8dee9', text2: '#9aa6bd', text3: '#636f88',
      accent: '#88c0d0', accentBg: 'rgba(136,192,208,0.12)', accentHover: 'rgba(136,192,208,0.20)',
      codeBg: '#242932', red: '#bf616a', radius: '0.375rem',
    },
    light: {
      bg: '#eceff4', surface: '#ffffff', surface2: '#e5e9f0', surface3: '#e5e9f0',
      border: 'rgba(46,52,64,0.12)', border2: 'rgba(46,52,64,0.16)',
      text: '#2e3440', text2: '#4c566a', text3: '#7b889e',
      accent: '#5e81ac', accentBg: 'rgba(94,129,172,0.10)', accentHover: 'rgba(94,129,172,0.16)',
      codeBg: '#e5e9f0', red: '#bf616a', radius: '0.375rem',
    },
  },
  {
    id: 'tide',
    name: 'Tide',
    description: 'Deep slate with muted teal.',
    preview: ['#14191c', '#6cb6b0', '#1a2024'],
    editorTheme: { dark: 'one-dark', light: 'default-light' },
    dark: {
      bg: '#14191c', surface: '#1a2024', surface2: '#232c30', surface3: '#283330',
      border: 'rgba(205,217,218,0.09)', border2: 'rgba(205,217,218,0.13)',
      text: '#cdd9da', text2: '#93a3a4', text3: '#5a6a6b',
      accent: '#6cb6b0', accentBg: 'rgba(108,182,176,0.12)', accentHover: 'rgba(108,182,176,0.20)',
      codeBg: '#101517', red: '#e07a6a', radius: '0.5rem',
    },
    light: {
      bg: '#f2f6f5', surface: '#ffffff', surface2: '#e3ecea', surface3: '#e3ecea',
      border: 'rgba(43,58,57,0.12)', border2: 'rgba(43,58,57,0.16)',
      text: '#2b3a39', text2: '#5f6e6d', text3: '#94a4a3',
      accent: '#2f7d76', accentBg: 'rgba(47,125,118,0.10)', accentHover: 'rgba(47,125,118,0.16)',
      codeBg: '#e9efed', red: '#c0392b', radius: '0.5rem',
    },
  },
  {
    id: 'sage',
    name: 'Sage',
    description: 'Muted forest green — calm and soft.',
    preview: ['#1c211e', '#a7c080', '#222824'],
    editorTheme: { dark: 'everforest', light: 'everforest-light' },
    dark: {
      bg: '#1c211e', surface: '#222824', surface2: '#2a322c', surface3: '#2d362f',
      border: 'rgba(216,224,210,0.09)', border2: 'rgba(216,224,210,0.13)',
      text: '#d8e0d2', text2: '#9aa597', text3: '#5f6b5d',
      accent: '#a7c080', accentBg: 'rgba(167,192,128,0.12)', accentHover: 'rgba(167,192,128,0.20)',
      codeBg: '#181c1a', red: '#e67e80', radius: '0.5rem',
    },
    light: {
      bg: '#f4f6f0', surface: '#ffffff', surface2: '#e6ecdd', surface3: '#e6ecdd',
      border: 'rgba(54,66,47,0.12)', border2: 'rgba(54,66,47,0.16)',
      text: '#36422f', text2: '#6b7563', text3: '#9aa593',
      accent: '#5a7a3f', accentBg: 'rgba(90,122,63,0.10)', accentHover: 'rgba(90,122,63,0.16)',
      codeBg: '#eef1e8', red: '#c0392b', radius: '0.5rem',
    },
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    description: 'Mocha + Latte — soothing pastel.',
    preview: ['#1e1e2e', '#cba6f7', '#181825'],
    editorTheme: { dark: 'catppuccin-mocha', light: 'catppuccin-latte' },
    dark: {
      bg: '#1e1e2e', surface: '#181825', surface2: '#313244', surface3: '#313244',
      border: 'rgba(205,214,244,0.10)', border2: 'rgba(205,214,244,0.14)',
      text: '#cdd6f4', text2: '#a6adc8', text3: '#6c7086',
      accent: '#cba6f7', accentBg: 'rgba(203,166,247,0.12)', accentHover: 'rgba(203,166,247,0.20)',
      codeBg: '#11111b', red: '#f38ba8', radius: '0.375rem',
    },
    light: {
      bg: '#eff1f5', surface: '#ffffff', surface2: '#e6e9ef', surface3: '#dce0e8',
      border: 'rgba(76,79,105,0.12)', border2: 'rgba(76,79,105,0.16)',
      text: '#4c4f69', text2: '#6c6f85', text3: '#9ca0b0',
      accent: '#8839ef', accentBg: 'rgba(136,57,239,0.10)', accentHover: 'rgba(136,57,239,0.16)',
      codeBg: '#e6e9ef', red: '#d20f39', radius: '0.375rem',
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    description: 'Warm, earthy retro palette.',
    preview: ['#282828', '#fabd2f', '#32302f'],
    editorTheme: { dark: 'gruvbox-dark' },
    dark: {
      bg: '#282828', surface: '#32302f', surface2: '#3c3836', surface3: '#3c3836',
      border: 'rgba(235,219,178,0.10)', border2: 'rgba(235,219,178,0.14)',
      text: '#ebdbb2', text2: '#a89984', text3: '#665c54',
      accent: '#fabd2f', accentBg: 'rgba(250,189,47,0.12)', accentHover: 'rgba(250,189,47,0.20)',
      codeBg: '#1d2021', red: '#fb4934', radius: '0.25rem',
    },
    light: {
      bg: '#fbf1c7', surface: '#f9f5d7', surface2: '#ebdbb2', surface3: '#ebdbb2',
      border: 'rgba(60,56,54,0.12)', border2: 'rgba(60,56,54,0.16)',
      text: '#3c3836', text2: '#7c6f64', text3: '#a89984',
      accent: '#b57614', accentBg: 'rgba(181,118,20,0.12)', accentHover: 'rgba(181,118,20,0.20)',
      codeBg: '#f2e5bc', red: '#9d0006', radius: '0.25rem',
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    description: 'Soho vibes — all-natural pine and rose.',
    preview: ['#191724', '#c4a7e7', '#1f1d2e'],
    editorTheme: { dark: 'rose-pine', light: 'rose-pine-dawn' },
    dark: {
      bg: '#191724', surface: '#1f1d2e', surface2: '#26233a', surface3: '#26233a',
      border: 'rgba(224,222,244,0.10)', border2: 'rgba(224,222,244,0.14)',
      text: '#e0def4', text2: '#908caa', text3: '#524f67',
      accent: '#c4a7e7', accentBg: 'rgba(196,167,231,0.12)', accentHover: 'rgba(196,167,231,0.20)',
      codeBg: '#121120', red: '#eb6f92', radius: '0.375rem',
    },
    light: {
      bg: '#faf4ed', surface: '#fffaf3', surface2: '#f2e9e1', surface3: '#f2e9e1',
      border: 'rgba(87,82,121,0.12)', border2: 'rgba(87,82,121,0.16)',
      text: '#575279', text2: '#797593', text3: '#b9b7cf',
      accent: '#907aa9', accentBg: 'rgba(144,122,169,0.10)', accentHover: 'rgba(144,122,169,0.16)',
      codeBg: '#f2e9e1', red: '#b4637a', radius: '0.375rem',
    },
  },
  {
    id: 'kanagawa',
    name: 'Kanagawa',
    description: 'Inky dark inspired by Hokusai; warm Lotus light.',
    preview: ['#1f1f28', '#7e9cd8', '#16161d'],
    editorTheme: { dark: 'kanagawa', light: 'kanagawa-lotus' },
    dark: {
      bg: '#1f1f28', surface: '#16161d', surface2: '#2a2a37', surface3: '#363646',
      border: 'rgba(220,215,186,0.08)', border2: 'rgba(220,215,186,0.12)',
      text: '#dcd7ba', text2: '#a09f96', text3: '#54546d',
      accent: '#7e9cd8', accentBg: 'rgba(126,156,216,0.12)', accentHover: 'rgba(126,156,216,0.20)',
      codeBg: '#13131a', red: '#c34043', radius: '0.375rem',
    },
    light: {
      bg: '#f2ecbc', surface: '#e5ddb0', surface2: '#dcd5ac', surface3: '#d4cba0',
      border: 'rgba(84,84,100,0.14)', border2: 'rgba(84,84,100,0.20)',
      text: '#545464', text2: '#8a8980', text3: '#a8a7a0',
      accent: '#4d699b', accentBg: 'rgba(77,105,155,0.12)', accentHover: 'rgba(77,105,155,0.20)',
      codeBg: '#ece5b6', red: '#c84053', radius: '0.375rem',
    },
  },
  {
    id: 'kanagawa-dragon',
    name: 'Kanagawa Dragon',
    description: 'The muted, near-black Dragon variant of Kanagawa.',
    preview: ['#181616', '#8ba4b0', '#0d0c0c'],
    editorTheme: { dark: 'kanagawa-dragon' },
    dark: {
      bg: '#181616', surface: '#0d0c0c', surface2: '#282727', surface3: '#393836',
      border: 'rgba(197,201,197,0.08)', border2: 'rgba(197,201,197,0.12)',
      text: '#c5c9c5', text2: '#a6a69c', text3: '#6a6a65',
      accent: '#8ba4b0', accentBg: 'rgba(139,164,176,0.12)', accentHover: 'rgba(139,164,176,0.20)',
      codeBg: '#0a0a0a', red: '#c4746e', radius: '0.375rem',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: 'Classic high-contrast purple dark theme.',
    preview: ['#282a36', '#bd93f9', '#21222c'],
    editorTheme: { dark: 'dracula' },
    dark: {
      bg: '#282a36', surface: '#21222c', surface2: '#343746', surface3: '#44475a',
      border: 'rgba(248,248,242,0.08)', border2: 'rgba(248,248,242,0.12)',
      text: '#f8f8f2', text2: '#a9acc0', text3: '#6272a4',
      accent: '#bd93f9', accentBg: 'rgba(189,147,249,0.12)', accentHover: 'rgba(189,147,249,0.20)',
      codeBg: '#1e1f29', red: '#ff5555', radius: '0.375rem',
    },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    description: "Ethan Schoonover's precision low-glare palette.",
    preview: ['#002b36', '#268bd2', '#073642'],
    editorTheme: { dark: 'solarized-dark', light: 'solarized-light' },
    dark: {
      bg: '#002b36', surface: '#073642', surface2: '#09404d', surface3: '#0a4754',
      border: 'rgba(131,148,150,0.12)', border2: 'rgba(131,148,150,0.16)',
      text: '#839496', text2: '#657b83', text3: '#586e75',
      accent: '#268bd2', accentBg: 'rgba(38,139,210,0.12)', accentHover: 'rgba(38,139,210,0.20)',
      codeBg: '#001f2b', red: '#dc322f', radius: '0.375rem',
    },
    light: {
      bg: '#fdf6e3', surface: '#eee8d5', surface2: '#e3ddca', surface3: '#dcd7bf',
      border: 'rgba(101,123,131,0.14)', border2: 'rgba(101,123,131,0.20)',
      text: '#657b83', text2: '#93a1a1', text3: '#839496',
      accent: '#268bd2', accentBg: 'rgba(38,139,210,0.10)', accentHover: 'rgba(38,139,210,0.16)',
      codeBg: '#f5efd5', red: '#dc322f', radius: '0.375rem',
    },
  },
  {
    id: 'everforest',
    name: 'Everforest',
    description: 'Soft, low-contrast green forest palette.',
    preview: ['#2d353b', '#a7c080', '#272e33'],
    editorTheme: { dark: 'everforest', light: 'everforest-light' },
    dark: {
      bg: '#2d353b', surface: '#272e33', surface2: '#343f44', surface3: '#3d484d',
      border: 'rgba(211,198,170,0.08)', border2: 'rgba(211,198,170,0.12)',
      text: '#d3c6aa', text2: '#9da9a0', text3: '#7a8478',
      accent: '#a7c080', accentBg: 'rgba(167,192,128,0.12)', accentHover: 'rgba(167,192,128,0.20)',
      codeBg: '#232a2e', red: '#e67e80', radius: '0.375rem',
    },
    light: {
      bg: '#fdf6e3', surface: '#f4f0d9', surface2: '#efebd4', surface3: '#e6e2cc',
      border: 'rgba(92,106,114,0.12)', border2: 'rgba(92,106,114,0.18)',
      text: '#5c6a72', text2: '#829181', text3: '#939f91',
      accent: '#8da101', accentBg: 'rgba(141,161,1,0.10)', accentHover: 'rgba(141,161,1,0.16)',
      codeBg: '#f0ead6', red: '#f85552', radius: '0.375rem',
    },
  },
  {
    id: 'caffeine',
    name: 'Caffeine',
    description: 'Warm coffee tones — cream and espresso.',
    preview: ['#111111', '#ffe0c2', '#191919'],
    editorTheme: { dark: 'atomone', light: 'xcode-light' },
    dark: {
      bg: '#111111', surface: '#191919', surface2: '#222222', surface3: '#2a2a2a',
      border: '#201e18', border2: '#484848',
      text: '#eeeeee', text2: '#b4b4b4', text3: '#666666',
      accent: '#ffe0c2', accentBg: 'rgba(255,224,194,0.10)', accentHover: 'rgba(255,224,194,0.18)',
      codeBg: '#18181b', red: '#e54d2e', radius: '0.5rem',
    },
    light: {
      bg: '#f9f9f9', surface: '#fcfcfc', surface2: '#efefef', surface3: '#e8e8e8',
      border: '#d8d8d8', border2: '#d8d8d8',
      text: '#202020', text2: '#646464', text3: '#999999',
      accent: '#644a40', accentBg: 'rgba(100,74,64,0.10)', accentHover: 'rgba(100,74,64,0.16)',
      codeBg: '#f0f0f0', red: '#e54d2e', radius: '0.5rem',
    },
  },
]

const THEME_LS = 'betopia:theme:id'
const MODE_LS  = 'betopia:theme:mode'

export function getSavedThemeId(): string {
  try { return localStorage.getItem(THEME_LS) ?? 'betopia' } catch { return 'betopia' }
}
export function getSavedMode(): ThemeMode {
  try { return (localStorage.getItem(MODE_LS) as ThemeMode) ?? 'dark' } catch { return 'dark' }
}
export function saveThemeId(id: string)      { try { localStorage.setItem(THEME_LS, id) } catch {} }
export function saveMode(mode: ThemeMode)    { try { localStorage.setItem(MODE_LS, mode) } catch {} }

export function applyTheme(themeId: string, mode: ThemeMode) {
  let theme: Theme | undefined = THEMES.find(t => t.id === themeId)
  if (!theme) {
    try {
      const custom: Theme[] = JSON.parse(localStorage.getItem('betopia:custom:themes') ?? '[]')
      theme = custom.find(t => t.id === themeId)
    } catch {}
  }
  theme = theme ?? THEMES[0]
  const vars = mode === 'light' ? (theme.light ?? theme.dark) : (theme.dark ?? theme.light)
  if (!vars) return

  const el = document.documentElement
  // Clear old data-theme overrides
  el.removeAttribute('data-theme')

  const set = (k: string, v: string) => el.style.setProperty(k, v)
  set('--bg',           vars.bg)
  set('--surface',      vars.surface)
  set('--surface-2',    vars.surface2)
  set('--surface-3',    vars.surface3)
  set('--border',       vars.border)
  set('--border-2',     vars.border2)
  set('--text',         vars.text)
  set('--text-2',       vars.text2)
  set('--text-3',       vars.text3)
  set('--accent',       vars.accent)
  set('--accent-bg',    vars.accentBg)
  set('--accent-hover', vars.accentHover)
  set('--code-bg',           vars.codeBg)
  set('--red',               vars.red)
  set('--chat-input-text',        vars.text)
  set('--chat-input-placeholder', vars.text3)
  if (vars.radius) set('--radius', vars.radius)
}

export function initTheme() {
  applyTheme(getSavedThemeId(), getSavedMode())
}

// Lightweight signal — increments when theme/mode changes so consumers can re-read
const listeners = new Set<() => void>()
export function onThemeChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export function notifyThemeChange() {
  listeners.forEach(cb => cb())
}

// Override applyTheme to also notify
const _applyTheme = applyTheme
export function applyThemeAndNotify(themeId: string, mode: ThemeMode) {
  _applyTheme(themeId, mode)
  notifyThemeChange()
}
