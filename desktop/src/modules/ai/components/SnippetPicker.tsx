import { useEffect, useRef } from 'react'
import { useSnippetsStore } from '@/store/snippetsStore'
import type { Snippet } from '@/lib/snippets'

interface Props {
  query: string           // text after the # trigger
  onSelect: (handle: string) => void
  onClose: () => void
}

export function SnippetPicker({ query, onSelect, onClose }: Props) {
  const snippets = useSnippetsStore(s => s.snippets)
  const ref = useRef<HTMLDivElement>(null)

  const filtered = snippets.filter(s =>
    !query || s.handle.startsWith(query.toLowerCase()) || s.name.toLowerCase().includes(query.toLowerCase()),
  )

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  if (filtered.length === 0) return null

  return (
    <div ref={ref} className="snippet-picker">
      <div className="snippet-picker-header">Snippets</div>
      {filtered.map(s => (
        <button
          key={s.id}
          className="snippet-picker-item"
          onMouseDown={e => { e.preventDefault(); onSelect(s.handle) }}
        >
          <code className="snippet-picker-handle">#{s.handle}</code>
          <span className="snippet-picker-info">
            <span className="snippet-picker-name">{s.name}</span>
            {s.description && <span className="snippet-picker-desc">{s.description}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

/** Detect if caret is inside a #handle token in a textarea */
export function getSnippetQuery(text: string, caretPos: number): string | null {
  const before = text.slice(0, caretPos)
  const match = before.match(/(^|\s)#([a-z0-9-]*)$/)
  if (!match) return null
  return match[2] ?? ''
}
