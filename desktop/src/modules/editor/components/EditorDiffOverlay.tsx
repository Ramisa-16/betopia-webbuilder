import DiffViewer, { type DiffStatus } from '@/components/DiffViewer'
import type { ApprovalStatus } from '@/types'

interface Props {
  approvalId: string
  path: string
  originalContent: string
  proposedContent: string
  isNewFile: boolean
  status: ApprovalStatus
  onAccept: (id: string) => void
  onReject: (id: string) => void
  onAcceptContent: (id: string, content: string) => void
}

export default function EditorDiffOverlay({
  approvalId, path, originalContent, proposedContent, isNewFile, status,
  onAccept, onReject, onAcceptContent,
}: Props) {
  return (
    <div className="editor-diff-overlay">
      <div className="editor-diff-overlay-banner">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        AI proposed changes
        <span className="editor-diff-overlay-banner-file">{path.split('/').pop()}</span>
      </div>
      <DiffViewer
        path={path}
        originalContent={originalContent}
        proposedContent={proposedContent}
        isNewFile={isNewFile}
        status={status as DiffStatus}
        onAccept={() => onAccept(approvalId)}
        onReject={() => onReject(approvalId)}
        onAcceptContent={content => onAcceptContent(approvalId, content)}
        fillHeight
      />
    </div>
  )
}
