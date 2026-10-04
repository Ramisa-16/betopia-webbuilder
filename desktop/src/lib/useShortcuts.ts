import { useEffect, useRef } from 'react'
import { matchEvent, loadUserShortcuts, type ShortcutId } from './shortcuts'

export type ShortcutHandlers = Partial<Record<ShortcutId, (e: KeyboardEvent) => void>>

/**
 * Single source of truth for keyboard shortcuts. Reads the live binding map
 * (defaults + user overrides) on every keystroke so rebinds take effect with
 * no reload, matches against the registry, and fires the mapped handler.
 *
 * Editor shortcuts (editor.*) defer to CodeMirror when the editor is focused
 * so we never double-trigger undo/redo/save.
 */
export function useShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = matchEvent(e, loadUserShortcuts())
      if (!id) return
      const fn = ref.current[id]
      if (!fn) return // e.g. ai.send / ai.newLine handled natively by the chat input

      // Editor shortcuts defer to native handling whenever a text surface is
      // focused (CodeMirror, input, textarea, contenteditable) so we never
      // hijack undo/redo/save from the field the user is typing in.
      if (id.startsWith('editor.')) {
        const el = document.activeElement as HTMLElement | null
        const tag = el?.tagName
        if (el && (el.closest('.cm-editor') || tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable)) return
      }

      e.preventDefault()
      e.stopPropagation()
      fn(e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
