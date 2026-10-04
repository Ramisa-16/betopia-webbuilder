import { useState, useMemo, useEffect, useRef } from 'react'
import type { FileEntry } from '@/types'
import { flattenFiles } from '@/lib/project-scaffold'
import { fuzzyFilter } from '@/lib/fuzzy'
import { getFileIcon } from '@/lib/file-icons'

// VS Code-style Quick Open (Ctrl+P): fuzzy-jump to any project file.
export default function QuickOpen({ files, onSelect, onClose }: {
  files: FileEntry[]
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const all = useMemo(() => flattenFiles(files).filter(f => !f.is_dir), [files])
  const results = useMemo(() => fuzzyFilter(q, all, f => [f.name, f.path]).slice(0, 50), [q, all])
  useEffect(() => { setIdx(0) }, [q])

  const pick = (f?: FileEntry) => { if (f) { onSelect(f.path); onClose() } }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return onClose()
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(results[idx]) }
  }

  return (
    <div className="quickopen-overlay" onClick={onClose}>
      <div className="quickopen" onClick={e => e.stopPropagation()}>
        <input ref={inputRef} className="quickopen-input" placeholder="Go to file…"
          value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} />
        <div className="quickopen-list">
          {results.length === 0 ? (
            <div className="quickopen-empty">No matching files</div>
          ) : results.map((f, i) => (
            <button key={f.path} className={'quickopen-item' + (i === idx ? ' active' : '')}
              onMouseEnter={() => setIdx(i)} onClick={() => pick(f)}>
              <img src={getFileIcon(f.name)} alt="" width={15} height={15} />
              <span className="quickopen-name">{f.name}</span>
              <span className="quickopen-path">{f.path}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
