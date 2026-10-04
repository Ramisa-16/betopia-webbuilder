import type { FileEntry } from '@/types'
import { getWorkspaceSummary } from '@/lib/manifest'

interface Props {
  files: FileEntry[]
  selectedFile: string | null
}

export default function WorkspaceManifest({ files, selectedFile }: Props) {
  const summary = getWorkspaceSummary(files)

  return (
    <div className="workspace-manifest">
      <div className="workspace-manifest-header">
        <div>
          <div className="workspace-manifest-title">Workspace review</div>
          <div className="workspace-manifest-subtitle">A fast summary of the current project structure.</div>
        </div>
      </div>

      <div className="workspace-manifest-grid">
        <div className="workspace-manifest-card">
          <span className="workspace-manifest-label">Files</span>
          <strong>{summary.fileCount}</strong>
        </div>
        <div className="workspace-manifest-card">
          <span className="workspace-manifest-label">Folders</span>
          <strong>{summary.dirCount}</strong>
        </div>
        <div className="workspace-manifest-card">
          <span className="workspace-manifest-label">Entry</span>
          <strong>{summary.entryFile || 'Not found'}</strong>
        </div>
        <div className="workspace-manifest-card">
          <span className="workspace-manifest-label">Styles</span>
          <strong>{summary.cssCount}</strong>
        </div>
      </div>

      <div className="workspace-manifest-list">
        <div className="workspace-manifest-row"><span>HTML</span><strong>{summary.htmlCount}</strong></div>
        <div className="workspace-manifest-row"><span>JS/TS</span><strong>{summary.jsCount}</strong></div>
        <div className="workspace-manifest-row"><span>JSON</span><strong>{summary.jsonCount}</strong></div>
        <div className="workspace-manifest-row"><span>Selected</span><strong>{selectedFile || 'None'}</strong></div>
      </div>

      {summary.styleFiles.length > 0 && (
        <div className="workspace-manifest-files">
          <div className="workspace-manifest-label">Style files</div>
          {summary.styleFiles.slice(0, 6).map(path => (
            <div key={path} className="workspace-manifest-file">{path}</div>
          ))}
        </div>
      )}
    </div>
  )
}
