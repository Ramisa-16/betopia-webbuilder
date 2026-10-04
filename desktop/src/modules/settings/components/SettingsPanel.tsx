/**
 * SettingsPanel.tsx - Project settings (Manus-style two-column layout)
 */
import { useState } from 'react'

interface Props {
  onAskAI?: (msg: string) => void
  projectName?: string
  publishedUrl?: string | null
  isPublished?: boolean
  onMakeCopy?: () => void
}

type SettingsSection = 'general' | 'domains' | 'notifications' | 'payment' | 'seo' | 'secrets' | 'github' | 'schedules'

const NAV_ITEMS: { id: SettingsSection; label: string; icon: JSX.Element }[] = [
  {
    id: 'general', label: 'General',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
      </svg>
    ),
  },
  {
    id: 'domains', label: 'Domains',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    ),
  },
  {
    id: 'notifications', label: 'Notifications',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
    ),
  },
  {
    id: 'payment', label: 'Payment',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
        <line x1="1" y1="10" x2="23" y2="10"/>
      </svg>
    ),
  },
  {
    id: 'seo', label: 'SEO',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
    ),
  },
  {
    id: 'secrets', label: 'Secrets',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    ),
  },
  {
    id: 'github', label: 'GitHub',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
      </svg>
    ),
  },
  {
    id: 'schedules', label: 'Schedules',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
      </svg>
    ),
  },
]

export default function SettingsPanel({ projectName = 'My Project', publishedUrl, isPublished, onMakeCopy }: Props) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general')
  const [hideBadge, setHideBadge] = useState(false)
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')

  return (
    <div className="settings-panel">
      {/* Sidebar */}
      <div className="settings-sidebar">
        <div className="settings-sidebar-label">Project settings</div>
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            className={'settings-nav-item' + (activeSection === item.id ? ' active' : '')}
            onClick={() => setActiveSection(item.id)}
          >
            <span className="settings-nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="settings-content">
        {activeSection === 'general' && (
          <>
            {/* Project identity */}
            <div className="settings-section">
              <div className="settings-project-identity">
                <div className="settings-project-icon-lg">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <line x1="3" y1="9" x2="21" y2="9"/>
                    <line x1="9" y1="21" x2="9" y2="9"/>
                  </svg>
                </div>
                <div className="settings-project-meta">
                  <h2 className="settings-project-name">{projectName}</h2>
                  {publishedUrl && (
                    <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="settings-project-url">
                      {publishedUrl.replace(/^https?:\/\//, '')}
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{marginLeft: 3}}>
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                        <polyline points="15 3 21 3 21 9"/>
                        <line x1="10" y1="14" x2="21" y2="3"/>
                      </svg>
                    </a>
                  )}
                </div>
                {publishedUrl && (
                  <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="settings-open-btn">
                    Open website
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                      <polyline points="15 3 21 3 21 9"/>
                      <line x1="10" y1="14" x2="21" y2="3"/>
                    </svg>
                  </a>
                )}
              </div>
            </div>

            {/* Publish & Access */}
            <div className="settings-section">
              <h3 className="settings-section-title">Publish &amp; Access</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-row-name">Domains</span>
                    <span className="settings-row-desc">Manage custom domains for your project</span>
                  </div>
                  <button className="settings-row-btn">Manage</button>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-row-name">Status</span>
                    <span className="settings-row-desc">Current publish state of your project</span>
                  </div>
                  <span className={'settings-status-badge' + (isPublished ? ' published' : '')}>
                    <span className="settings-status-dot" />
                    {isPublished ? 'Published' : 'Unpublished'}
                  </span>
                </div>
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-row-name">Visibility</span>
                    <span className="settings-row-desc">Who can access your published website</span>
                  </div>
                  <select
                    className="settings-select"
                    value={visibility}
                    onChange={e => setVisibility(e.target.value as 'public' | 'private')}
                  >
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Project Actions */}
            <div className="settings-section">
              <h3 className="settings-section-title">Project Actions</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-row-name">Duplicate project</span>
                    <span className="settings-row-desc">Create a full copy of this project</span>
                  </div>
                  <button className="settings-row-btn" onClick={onMakeCopy}>Make a copy</button>
                </div>
              </div>
            </div>

            {/* Advanced */}
            <div className="settings-section">
              <h3 className="settings-section-title">Advanced</h3>
              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-row-name">Hide Builder Badge</span>
                    <span className="settings-row-desc">Remove the &quot;Built with Betopia&quot; badge from your site</span>
                  </div>
                  <button
                    className={'settings-toggle' + (hideBadge ? ' on' : '')}
                    onClick={() => setHideBadge(v => !v)}
                    aria-pressed={hideBadge}
                    role="switch"
                  >
                    <span className="settings-toggle-thumb" />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {activeSection !== 'general' && (
          <div className="settings-coming-soon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{opacity: 0.3, marginBottom: 12}}>
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
            </svg>
            <h3>{NAV_ITEMS.find(n => n.id === activeSection)?.label} settings</h3>
            <p>Configuration for this section is coming soon.</p>
          </div>
        )}
      </div>
    </div>
  )
}
