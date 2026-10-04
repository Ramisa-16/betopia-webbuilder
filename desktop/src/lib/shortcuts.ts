import { IS_MAC, MOD_PROP } from './platform'

export type ShortcutId =
  | 'settings.open'
  | 'settings.search'
  | 'ai.send'
  | 'ai.cancel'
  | 'ai.newLine'
  | 'view.code'
  | 'view.preview'
  | 'view.terminal'
  | 'view.toggleCode'
  | 'view.togglePreview'
  | 'preview.reload'
  | 'chat.toggle'
  | 'chat.focus'
  | 'file.new'
  | 'file.quickOpen'
  | 'project.open'
  | 'explorer.search'
  | 'editor.save'
  | 'editor.undo'
  | 'editor.redo'
  | 'tab.next'
  | 'tab.prev'
  | 'tab.close'
  | 'tab.reopen'
  | 'home.goHome'

export type ShortcutGroup = 'General' | 'AI Chat' | 'View' | 'Editor' | 'Explorer'

export type KeyBinding = {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
}

export type Shortcut = {
  id: ShortcutId
  label: string
  group: ShortcutGroup
  defaultBindings: KeyBinding[]
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'settings.open',   label: 'Open settings',         group: 'General',   defaultBindings: [{ [MOD_PROP]: true, key: ',' }] },
  { id: 'settings.search', label: 'Search settings',       group: 'General',   defaultBindings: [{ [MOD_PROP]: true, key: 'k' }] },
  { id: 'home.goHome',     label: 'Go to home / projects', group: 'General',   defaultBindings: [{ [MOD_PROP]: true, key: 'h' }] },
  { id: 'file.new',        label: 'New file',              group: 'General',   defaultBindings: [{ [MOD_PROP]: true, key: 'n' }] },
  { id: 'file.quickOpen',  label: 'Quick Open file',       group: 'General',   defaultBindings: [{ [MOD_PROP]: true, key: 'p' }] },
  { id: 'project.open',    label: 'Open project folder',   group: 'General',   defaultBindings: [{ [MOD_PROP]: true, key: 'o' }] },
  { id: 'ai.send',         label: 'Send message',          group: 'AI Chat',   defaultBindings: [{ key: 'Enter' }] },
  { id: 'ai.newLine',      label: 'New line in input',     group: 'AI Chat',   defaultBindings: [{ shift: true, key: 'Enter' }] },
  { id: 'ai.cancel',       label: 'Cancel generation',     group: 'AI Chat',   defaultBindings: [{ key: 'Escape' }] },
  { id: 'chat.focus',      label: 'Focus chat input',      group: 'AI Chat',   defaultBindings: [{ [MOD_PROP]: true, key: 'l' }] },
  { id: 'view.code',       label: 'Switch to Code view',   group: 'View',      defaultBindings: [{ [MOD_PROP]: true, key: '1' }] },
  { id: 'view.preview',    label: 'Switch to Preview',     group: 'View',      defaultBindings: [{ [MOD_PROP]: true, key: '2' }] },
  { id: 'view.terminal',   label: 'Toggle terminal',       group: 'View',      defaultBindings: [{ [MOD_PROP]: true, key: '`' }] },
  { id: 'view.toggleCode', label: 'Toggle code panel',     group: 'View',      defaultBindings: [{ [MOD_PROP]: true, key: 'b' }] },
  { id: 'view.togglePreview', label: 'Toggle preview panel', group: 'View',    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: 'p' }] },
  { id: 'preview.reload',  label: 'Reload preview',        group: 'View',      defaultBindings: [{ [MOD_PROP]: true, shift: true, key: 'r' }] },
  { id: 'chat.toggle',     label: 'Toggle chat panel',     group: 'View',      defaultBindings: [{ [MOD_PROP]: true, key: 'i' }] },
  { id: 'explorer.search', label: 'Search files',          group: 'Explorer',  defaultBindings: [{ [MOD_PROP]: true, shift: true, key: 'f' }] },
  { id: 'editor.save',     label: 'Save file',             group: 'Editor',    defaultBindings: [{ [MOD_PROP]: true, key: 's' }] },
  { id: 'editor.undo',     label: 'Undo',                  group: 'Editor',    defaultBindings: [{ [MOD_PROP]: true, key: 'z' }] },
  { id: 'editor.redo',     label: 'Redo',                  group: 'Editor',    defaultBindings: [{ [MOD_PROP]: true, key: 'y' }] },
  { id: 'tab.next',        label: 'Next tab',              group: 'Editor',    defaultBindings: [{ ctrl: true, key: 'Tab' }] },
  { id: 'tab.prev',        label: 'Previous tab',          group: 'Editor',    defaultBindings: [{ ctrl: true, shift: true, key: 'Tab' }] },
  { id: 'tab.close',       label: 'Close tab',             group: 'Editor',    defaultBindings: [{ [MOD_PROP]: true, key: 'w' }] },
  { id: 'tab.reopen',      label: 'Reopen closed tab',     group: 'Editor',    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: 't' }] },
]

export const SHORTCUT_GROUPS: ShortcutGroup[] = ['General', 'AI Chat', 'View', 'Explorer', 'Editor']

const LS_KEY = 'betopia:shortcuts'

export function loadUserShortcuts(): Partial<Record<ShortcutId, KeyBinding[]>> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') } catch { return {} }
}

export function saveUserShortcuts(map: Partial<Record<ShortcutId, KeyBinding[]>>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(map)) } catch {}
}

// Effective bindings = user override if present, else factory defaults.
export function effectiveBindings(
  id: ShortcutId,
  user: Partial<Record<ShortcutId, KeyBinding[]>>,
): KeyBinding[] {
  const u = user[id]
  if (u !== undefined) return u
  return SHORTCUTS.find(s => s.id === id)?.defaultBindings ?? []
}

function bindingMatches(b: KeyBinding, e: KeyboardEvent): boolean {
  const bk = b.key.length === 1 ? b.key.toLowerCase() : b.key
  const ek = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (bk !== ek) return false
  return Boolean(b.ctrl)  === e.ctrlKey
      && Boolean(b.shift) === e.shiftKey
      && Boolean(b.alt)   === e.altKey
      && Boolean(b.meta)  === e.metaKey
}

// Return the shortcut id matching this keyboard event (or null).
export function matchEvent(
  e: KeyboardEvent,
  user: Partial<Record<ShortcutId, KeyBinding[]>>,
): ShortcutId | null {
  for (const s of SHORTCUTS) {
    for (const b of effectiveBindings(s.id, user)) {
      if (bindingMatches(b, e)) return s.id
    }
  }
  return null
}

export function getBindingTokens(binding?: KeyBinding): string[] {
  if (!binding) return []
  const t: string[] = []
  if (IS_MAC) {
    if (binding.ctrl)  t.push('⌃')
    if (binding.alt)   t.push('⌥')
    if (binding.shift) t.push('⇧')
    if (binding.meta)  t.push('⌘')
  } else {
    if (binding.ctrl)  t.push('Ctrl')
    if (binding.alt)   t.push('Alt')
    if (binding.shift) t.push('Shift')
    if (binding.meta)  t.push('Win')
  }
  let key = binding.key
  if (key === ' ')           key = 'Space'
  else if (key === 'ArrowUp')    key = '↑'
  else if (key === 'ArrowDown')  key = '↓'
  else if (key === 'ArrowLeft')  key = '←'
  else if (key === 'ArrowRight') key = '→'
  else if (key.length === 1)     key = key.toUpperCase()
  t.push(key)
  return t
}
