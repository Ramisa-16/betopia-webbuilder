/**
 * DatabasePanel.tsx - Empty state for database connection (Manus-style)
 */

interface Props {
  onAskAI?: (msg: string) => void
  projectName?: string
  publishedUrl?: string | null
  isPublished?: boolean
  onMakeCopy?: () => void
}

export default function DatabasePanel({ onAskAI }: Props) {
  return (
    <div className="empty-panel">
      <div className="empty-panel-icon">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="32" cy="14" rx="22" ry="8"/>
          <path d="M10 14v12c0 4.4 9.8 8 22 8s22-3.6 22-8V14"/>
          <path d="M10 26v12c0 4.4 9.8 8 22 8s22-3.6 22-8V26"/>
          <path d="M10 38v8c0 4.4 9.8 8 22 8s22-3.6 22-8v-8"/>
        </svg>
      </div>
      <h3 className="empty-panel-title">No Database connected</h3>
      <p className="empty-panel-desc">
        Let AI create and connect one for your website. It will set up tables,
        relationships, and API endpoints automatically.
      </p>
      <button
        className="empty-panel-btn"
        onClick={() => onAskAI?.('Please add a database to my project. Set up the tables, relationships, and API endpoints.')}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14"/><path d="M5 12l7-7 7 7"/>
        </svg>
        Ask AI to add a Database
      </button>
    </div>
  )
}
