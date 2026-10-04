import { useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label: string
  shortcut?: string
  action: () => void
  danger?: boolean
  disabled?: boolean
}

interface Props {
  x: number
  y: number
  sections: ContextMenuItem[][]
  onClose: () => void
}

export default function ContextMenu({ x, y, sections, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.bottom > window.innerHeight - 8)
      el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`
    if (r.right > window.innerWidth - 8)
      el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`
  }, [])

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: x, top: y }}
      onContextMenu={e => e.preventDefault()}
    >
      {sections.map((section, si) => (
        <div key={si}>
          {si > 0 && <div className="ctx-menu-sep" />}
          {section.map((item, ii) => (
            <button
              key={ii}
              className={`ctx-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`}
              disabled={item.disabled}
              onClick={() => { if (!item.disabled) { item.action(); onClose() } }}
            >
              <span className="ctx-menu-label">{item.label}</span>
              {item.shortcut && <span className="ctx-menu-shortcut">{item.shortcut}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body
  )
}
