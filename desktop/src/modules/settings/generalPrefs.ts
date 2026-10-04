export const PREFS_KEY = 'betopia:general-prefs'

export interface GeneralPrefs {
  showHidden: boolean
  autoSave: boolean
  autoSaveDelay: number
  zoomLevel: number
  projectsFolder: string
  terminalUseWebglRenderer: boolean
  // UI font
  uiFontFamily: string
  uiFontSize: number
  // Terminal font
  termFontFamily: string
  termFontSize: number
  termLetterSpacing: number
  termFontWeight: string
  // Chat and terminal history / output retention
  scrollbackLines: number
}

export const DEFAULT_GENERAL_PREFS: GeneralPrefs = {
  showHidden: false,
  autoSave: true,
  autoSaveDelay: 500,
  zoomLevel: 1,
  projectsFolder: '',
  terminalUseWebglRenderer: true,
  uiFontFamily: '',
  uiFontSize: 13,
  termFontFamily: '',
  termFontSize: 13,
  termLetterSpacing: 0,
  termFontWeight: 'normal',
  scrollbackLines: 1000,
}

export function loadGeneralPrefs(): GeneralPrefs {
  try {
    return { ...DEFAULT_GENERAL_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return { ...DEFAULT_GENERAL_PREFS }
  }
}

export function saveGeneralPrefs(prefs: GeneralPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {}
  window.dispatchEvent(new CustomEvent('betopia:general-prefs-change', { detail: prefs }))
}

export function getScrollbackLines(): number {
  const value = loadGeneralPrefs().scrollbackLines
  return [500, 1000, 2000].includes(value) ? value : DEFAULT_GENERAL_PREFS.scrollbackLines
}

export function getTerminalWebglRenderer(): boolean {
  return loadGeneralPrefs().terminalUseWebglRenderer
}
