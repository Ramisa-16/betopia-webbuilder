import type { PublishVisibility } from '@/lib/publish'

interface Props {
  projectPath: string
  isPublished: boolean
  visibility: PublishVisibility
  hideBuilderBadge: boolean
  publishedUrl?: string | null
  isPublishing: boolean
  onClose: () => void
  onPublishNow: () => void
  onVisibilityChange: (visibility: PublishVisibility) => void
  onHideBadgeChange: (value: boolean) => void
  onDuplicateProject: () => void
}

export default function PublishDialog({
  projectPath,
  isPublished,
  visibility,
  hideBuilderBadge,
  publishedUrl,
  isPublishing,
  onClose,
  onPublishNow,
  onVisibilityChange,
  onHideBadgeChange,
  onDuplicateProject,
}: Props) {
  const projectName = projectPath.split(/[/\\]/).pop() || 'Project'

  return (
    <div className="publish-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="publish-settings-dialog">
        <div className="publish-settings-header">
          <div className="publish-settings-title">Publish & Access</div>
          <button className="publish-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="publish-settings-body">
          <section className="publish-settings-section">
            <div className="publish-settings-project">
              <div className="publish-project-icon">⚙</div>
              <div>
                <div className="publish-project-name">{projectName}</div>
                <div className="publish-project-path" title={projectPath}>{projectPath}</div>
              </div>
            </div>
          </section>

          <section className="publish-settings-section">
            <div className="publish-section-title">Publish</div>
            <div className="publish-visibility-row">
              <span>Visibility</span>
              <select
                className="publish-select"
                value={visibility}
                onChange={e => onVisibilityChange(e.target.value as PublishVisibility)}
              >
                <option value="anyone">Anyone with the link</option>
                <option value="invited">Only people invited</option>
              </select>
            </div>

            <div className="publish-status-card">
              <div className="publish-status-row">
                <span>Status</span>
                <span className={'publish-status-pill' + (isPublished ? ' published' : '')}>
                  {isPublished ? 'Published' : 'Not published'}
                </span>
              </div>

              {publishedUrl && (
                <div className="publish-url-row">
                  <span>URL</span>
                  <a href={publishedUrl} target="_blank" rel="noreferrer">{publishedUrl}</a>
                </div>
              )}

              <button className="publish-btn-primary" onClick={onPublishNow} disabled={isPublishing}>
                {isPublishing ? 'Publishing…' : (isPublished ? 'Republish' : 'Publish')}
              </button>
            </div>
          </section>

          <section className="publish-settings-section">
            <div className="publish-section-title">Project Actions</div>
            <div className="publish-action-card">
              <div>
                <div className="publish-action-title">Duplicate project</div>
                <div className="publish-action-sub">Create an independent copy in a sibling folder.</div>
              </div>
              <button className="publish-btn-ghost" onClick={onDuplicateProject}>Make a copy</button>
            </div>
          </section>

          <section className="publish-settings-section">
            <div className="publish-section-title">Advanced</div>
            <div className="publish-toggle-card">
              <div>
                <div className="publish-action-title">Hide Betopia badge</div>
                <div className="publish-action-sub">Remove the "Made with Betopia" badge from preview.</div>
              </div>
              <label className="publish-switch">
                <input
                  type="checkbox"
                  checked={hideBuilderBadge}
                  onChange={e => onHideBadgeChange(e.target.checked)}
                />
                <span className="publish-switch-slider" />
              </label>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
