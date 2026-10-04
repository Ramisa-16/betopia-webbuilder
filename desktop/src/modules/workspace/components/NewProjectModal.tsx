import { useState, useEffect } from 'react'
import { ensureProjectDir } from '@/lib/fs'

interface Props {
  defaultDir?: string | null
  onClose: () => void
  onCreated: (path: string) => void
}

export default function NewProjectModal({ defaultDir, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [targetBase, setTargetBase] = useState(defaultDir ?? 'C:\\Users\\Betopia\\Desktop\\Web_builder')

  useEffect(() => {
    setTargetBase(defaultDir ?? 'C:\\Users\\Betopia\\Desktop\\Web_builder')
  }, [defaultDir])

  const create = async () => {
    const n = name.trim()
    if (!n) return setError('Please enter a project name')
    if (/[<>:"/\\|?*]/.test(n)) return setError('Project name contains invalid characters')
    setError('')
    setLoading(true)
    try {
      const parent = targetBase
      if (!parent) throw new Error('No parent folder chosen')
      const candidate = parent.replace(/[/\\]+$/, '') + '/' + n
      await ensureProjectDir(candidate)
      onCreated(candidate)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project')
      setLoading(false)
    }
  }

  return (
    <div className="picker-new-modal">
      <div className="picker-new-card">
        <button
          className="picker-new-close"
          onClick={onClose}
          aria-label="Close new project dialog"
          title="Close"
        >
          ×
        </button>
        <h3>Create New Project</h3>
        <label className="picker-new-label">Project Name</label>
        <input
          className="picker-input picker-new-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="my-project"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !loading) void create()
          }}
          autoFocus
        />

        <div className="picker-new-meta">
          <div className="picker-new-meta-label">Default project path</div>
          <div className="picker-new-meta-path">
            {targetBase}
          </div>
        </div>

        <div className="picker-new-actions">
          <button className="picker-new-primary" onClick={create} disabled={loading}>{loading ? 'Creating…' : 'Done'}</button>
        </div>
        {error && <div className="picker-new-error">{error}</div>}
      </div>
    </div>
  )
}
