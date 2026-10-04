import type { FileEntry } from '@/types'

interface Props {
  files: FileEntry[]
  onSelect: (path: string) => void
  onCancel?: () => void
}

function collectHtmlFiles(entries: FileEntry[], result: string[] = []): string[] {
  for (const e of entries) {
    if (e.is_dir && e.children) {
      collectHtmlFiles(e.children, result)
    } else if (e.name.endsWith('.html') || e.name.endsWith('.htm')) {
      result.push(e.path)
    }
  }
  return result
}

export default function EntryFilePicker({ files, onSelect, onCancel }: Props) {
  const htmlFiles = collectHtmlFiles(files)

  return (
    <div className="entry-picker-overlay">
      <div className="entry-picker-card">
        <div className="entry-picker-header">
          <span className="entry-picker-icon">🌐</span>
          <h2 className="entry-picker-title">Select Entry File</h2>
          <p className="entry-picker-sub">
            No <code>index.html</code> found. Pick the HTML file to use as the live preview entry point.
          </p>
        </div>

        {htmlFiles.length === 0 ? (
          <div className="entry-picker-empty">
            <span>No HTML files in this folder yet.</span>
            <span>Ask the AI to generate your website first.</span>
          </div>
        ) : (
          <ul className="entry-picker-list">
            {htmlFiles.map(p => (
              <li key={p}>
                <button className="entry-picker-item" onClick={() => onSelect(p)}>
                  <span className="entry-picker-item-icon">🌐</span>
                  <span className="entry-picker-item-path">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {onCancel && (
          <button className="entry-picker-cancel" onClick={onCancel}>
            Skip for now
          </button>
        )}
      </div>
    </div>
  )
}
