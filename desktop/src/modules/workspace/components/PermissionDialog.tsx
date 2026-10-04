import { useEffect } from 'react'

interface Props {
  tool: string
  args: string
  onAllow: () => void
  onDeny: () => void
  onAllowAll: () => void
  allowSession?: () => void
}

const TOOL_ICONS: Record<string, string> = {
  bash: '⚡',
  write_file: '📝',
  edit: '✏️',
}

const TOOL_LABELS: Record<string, string> = {
  bash: 'Run shell command',
  write_file: 'Write file',
  edit: 'Edit file',
}

function formatPreview(tool: string, argsJson: string): { label: string; value: string }[] {
  try {
    const args = JSON.parse(argsJson) as Record<string, string>
    if (tool === 'bash') {
      return [{ label: 'Command', value: args.command ?? '' }]
    }
    if (tool === 'write_file') {
      const lines = (args.content ?? '').split('\n')
      const preview = lines.slice(0, 6).join('\n') + (lines.length > 6 ? `\n… (${lines.length} lines total)` : '')
      return [
        { label: 'Path', value: args.path ?? '' },
        { label: 'Content', value: preview },
      ]
    }
    if (tool === 'edit') {
      return [
        { label: 'Path', value: args.path ?? '' },
        { label: 'Replace', value: (args.old_string ?? '').slice(0, 120) + ((args.old_string ?? '').length > 120 ? '…' : '') },
        { label: 'With', value: (args.new_string ?? '').slice(0, 120) + ((args.new_string ?? '').length > 120 ? '…' : '') },
      ]
    }
    return []
  } catch {
    return [{ label: 'Args', value: argsJson.slice(0, 200) }]
  }
}

export default function PermissionDialog({ tool, args, onAllow, onDeny, onAllowAll, allowSession }: Props) {
  const preview = formatPreview(tool, args)
  const icon = TOOL_ICONS[tool] ?? '⚡'
  const label = TOOL_LABELS[tool] ?? tool

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onAllow()
      if (e.key === 'Escape') onDeny()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onAllow, onDeny])

  return (
    <div className="perm-overlay">
      <div className="perm-dialog">
        <div className="perm-header">
          <div className="perm-icon-wrap">{icon}</div>
          <div className="perm-title-area">
            <div className="perm-title">Permission Required</div>
            <div className="perm-sub">Agent wants to: <strong>{label}</strong></div>
          </div>
        </div>

        <div className="perm-preview">
          {preview.map(({ label: l, value }) => (
            <div key={l} className="perm-row">
              <span className="perm-row-label">{l}</span>
              <pre className="perm-row-value">{value}</pre>
            </div>
          ))}
        </div>

        <div className="perm-hint">
          Press <kbd>Enter</kbd> to allow · <kbd>Esc</kbd> to deny
        </div>

        <div className="perm-actions">
          <button className="perm-btn-deny" onClick={onDeny}>Deny</button>
          {allowSession && (
            <button className="perm-btn-yolo" onClick={allowSession} title="Allow this tool for the rest of the session">Allow Session</button>
          )}
          <button className="perm-btn-yolo" onClick={onAllowAll} title="Enable Yolo Mode and skip future prompts">Allow All</button>
          <button className="perm-btn-allow" onClick={onAllow}>Allow</button>
        </div>
      </div>
    </div>
  )
}
