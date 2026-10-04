/**
 * StoragePanel.tsx - Empty state for file storage (Manus-style)
 */

interface Props {
  onAskAI?: (msg: string) => void
  projectName?: string
  publishedUrl?: string | null
  isPublished?: boolean
  onMakeCopy?: () => void
}

export default function StoragePanel({ onAskAI }: Props) {
  return (
    <div className="empty-panel">
      <div className="empty-panel-icon">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M36 8H16a4 4 0 0 0-4 4v40a4 4 0 0 0 4 4h32a4 4 0 0 0 4-4V24L36 8z"/>
          <polyline points="36 8 36 24 52 24"/>
          <rect x="22" y="32" width="20" height="16" rx="2" strokeWidth="1.5"/>
          <path d="M29 32v-3a3 3 0 0 1 6 0v3"/>
          <circle cx="32" cy="39" r="1.5" fill="currentColor" stroke="none"/>
          <line x1="32" y1="40.5" x2="32" y2="43" strokeWidth="1.5"/>
        </svg>
      </div>
      <h3 className="empty-panel-title">File Storage not enabled</h3>
      <p className="empty-panel-desc">
        Enable file storage to let your users upload images, documents, and other files.
        AI will configure the storage bucket and update your project automatically.
      </p>
      <button
        className="empty-panel-btn"
        onClick={() => onAskAI?.('Please enable file storage for my project so users can upload files.')}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14"/><path d="M5 12l7-7 7 7"/>
        </svg>
        Ask AI to enable File Storage
      </button>
    </div>
  )
}
