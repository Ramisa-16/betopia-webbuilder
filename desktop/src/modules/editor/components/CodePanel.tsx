/**
 * CodePanel.tsx
 * Hosts the CodeViewer (editor area only).
 * The FileExplorer is now a separate panel in App.tsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { normalizeDialogPath } from '@/lib/path'
import { writeProjectFile } from '@/lib/fs'
import CodeViewer from './CodeViewer'
import TabBar from './TabBar'
import ReactMarkdown from 'react-markdown'
import DiffViewer, { type DiffStatus } from '@/components/DiffViewer'
import type { TabEntry, ApprovalData, ApprovalStatus } from '@/types'

type ActiveDiff = ApprovalData & { approvalId: string }

interface Props {
  selectedFile: string | null
  fileContent: string
  projectPath: string
  searchQuery?: string
  onFilesChanged?: () => void
  onMarkDirty?: (path: string, dirty: boolean) => void
  tabs?: TabEntry[]
  onSelectTab?: (path: string) => void
  onCloseTab?: (path: string) => void
  onInlineChat?: (selection: string, fileName: string) => void
  activeDiff?: ActiveDiff
  pendingDiffCount?: number
  onDiffAccept?: (approvalId: string, content?: string) => void
  onDiffReject?: (approvalId: string) => void
  onDiffAcceptAll?: () => void
  onDiffRejectAll?: () => void
  reviewableCount?: number
  onReviewChanges?: () => void
}

export default function CodePanel({
  selectedFile,
  fileContent,
  projectPath,
  searchQuery = '',
  onFilesChanged,
  onMarkDirty,
  tabs = [],
  onSelectTab,
  onCloseTab,
  onInlineChat,
  activeDiff,
  pendingDiffCount = 0,
  onDiffAccept,
  onDiffReject,
  onDiffAcceptAll,
  onDiffRejectAll,
  reviewableCount = 0,
  onReviewChanges,
}: Props) {
  const saveTimerRef    = useRef<number | null>(null)
  const selectedFileRef = useRef<string | null>(selectedFile)
  const projectPathRef  = useRef(projectPath)
  const [editorContent, setEditorContent] = useState(fileContent)
  const [mdView, setMdView] = useState<'code' | 'preview' | 'split'>('code')
  const [copiedPath, setCopiedPath] = useState(false)
  const [showDownloadMenu, setShowDownloadMenu] = useState(false)
  const downloadMenuRef = useRef<HTMLDivElement | null>(null)

  const isMarkdownFile = Boolean(selectedFile && /\.(md|mdx|markdown)$/i.test(selectedFile))
  const isImageFile    = Boolean(selectedFile && /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(selectedFile))
  const isPdfFile      = Boolean(selectedFile && /\.pdf$/i.test(selectedFile))
  const isDocFile      = Boolean(selectedFile && /\.(docx?|xlsx?|pptx?)$/i.test(selectedFile))
  const isBinaryFile   = isImageFile || isPdfFile || isDocFile

  const assetUrl = useMemo(() => {
    if (!selectedFile || (!isImageFile && !isPdfFile)) return null
    const fullPath = projectPath
      ? `${projectPath.replace(/\\/g, '/')}/${selectedFile.replace(/\\/g, '/')}`
      : selectedFile.replace(/\\/g, '/')
    return convertFileSrc(fullPath)
  }, [selectedFile, projectPath, isImageFile, isPdfFile])
  const pathParts = useMemo(() => {
    if (!selectedFile) return []
    return selectedFile.replace(/\\/g, '/').split('/').filter(Boolean)
  }, [selectedFile])
  const fileName = pathParts[pathParts.length - 1] ?? ''
  const fileBaseName = fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName
  const fileExt = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : 'txt'

  useEffect(() => {
    selectedFileRef.current = selectedFile
    projectPathRef.current  = projectPath
  }, [selectedFile, projectPath])

  useEffect(() => {
    setEditorContent(fileContent)
  }, [fileContent, selectedFile])

  useEffect(() => {
    if (!isMarkdownFile) setMdView('code')
  }, [isMarkdownFile, selectedFile])

  useEffect(() => {
    setCopiedPath(false)
  }, [selectedFile])

  const handleContentChange = useCallback(async (newContent: string) => {
    const currentFile = selectedFileRef.current
    const currentPath = projectPathRef.current
    if (!currentFile || !currentPath) return
    setEditorContent(newContent)

    onMarkDirty?.(currentFile, true)

    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        await writeProjectFile(currentPath, currentFile, newContent)
        onMarkDirty?.(currentFile, false)
        onFilesChanged?.()
      } catch (err) {
        console.error('[CodePanel] Failed to save file:', err)
      }
    }, 300)
  }, [onFilesChanged, onMarkDirty])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
  }, [])

  useEffect(() => {
    if (!showDownloadMenu) return
    const onPointerDown = (event: MouseEvent) => {
      if (!downloadMenuRef.current) return
      if (!downloadMenuRef.current.contains(event.target as Node)) {
        setShowDownloadMenu(false)
      }
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowDownloadMenu(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [showDownloadMenu])

  const handleCopyPath = useCallback(async () => {
    if (!selectedFile) return
    try {
      await navigator.clipboard.writeText(editorContent)
      setCopiedPath(true)
    } catch (err) {
      console.error('[CodePanel] Failed to copy file content:', err)
    }
  }, [selectedFile, editorContent])

  const handleDownloadCurrentFile = useCallback(async (asText: boolean) => {
    if (!selectedFile) return
    try {
      const defaultName = asText
        ? `${fileBaseName || 'file'}.txt`
        : (fileName || 'file.txt')
      const outputSelected = await save({
        defaultPath: defaultName,
        title: asText ? 'Download current file as .txt' : 'Download current file',
        filters: asText
          ? [{ name: 'Text File', extensions: ['txt'] }]
          : [{ name: `${fileExt.toUpperCase()} File`, extensions: [fileExt] }, { name: 'Text File', extensions: ['txt'] }],
      })
      const outputPath = normalizeDialogPath(outputSelected)
      if (!outputPath) return
      await invoke('export_project_file', {
        projectPath,
        filePath: selectedFile,
        outputPath,
      })
      setShowDownloadMenu(false)
    } catch (err) {
      console.error('[CodePanel] Failed to download current file:', err)
    }
  }, [selectedFile, fileBaseName, fileName, fileExt, projectPath])

  const handleDownloadAllFiles = useCallback(async () => {
    if (!projectPath) return
    const normalizedProjectRoot = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const currentDirRel = selectedFile?.replace(/\\/g, '/').split('/').slice(0, -1).join('/') ?? ''
    const sourceDir = currentDirRel
      ? `${normalizedProjectRoot}/${currentDirRel}`.replace(/\/+/g, '/')
      : normalizedProjectRoot
    const sourceName = (currentDirRel ? currentDirRel.split('/').pop() : normalizedProjectRoot.split('/').pop()) || 'project'
    try {
      const outputSelected = await save({
        defaultPath: `${sourceName}.zip`,
        title: 'Download all files from current folder',
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      })
      const outputPath = normalizeDialogPath(outputSelected)
      if (!outputPath) return
      const normalized = outputPath.toLowerCase().endsWith('.zip') ? outputPath : `${outputPath}.zip`
      await invoke('export_project_zip', { projectPath: sourceDir, outputPath: normalized })
      setShowDownloadMenu(false)
    } catch (err) {
      console.error('[CodePanel] Failed to download all files:', err)
    }
  }, [projectPath, selectedFile])

  return (
    <div className={'code-panel' + (isMarkdownFile ? ' code-panel-md' : '')}>
      {tabs.length > 0 && onSelectTab && onCloseTab && (
        <TabBar
          tabs={tabs}
          activeTab={selectedFile}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
        />
      )}
      {selectedFile && (
        <div className="code-file-path-bar">
          <div className="code-file-path-breadcrumb" title={selectedFile}>
            {pathParts.map((part, index) => (
              <span key={`${part}-${index}`} className="code-file-path-segment">
                <span className={index === pathParts.length - 1 ? 'code-file-path-name' : 'code-file-path-dir'}>{part}</span>
                {index < pathParts.length - 1 && <span className="code-file-path-sep"> / </span>}
              </span>
            ))}
          </div>
          <div className="code-file-path-actions">
            {isMarkdownFile && (
              <div className="code-file-path-md-modes" role="tablist" aria-label="Markdown view mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mdView === 'code'}
                  className={'code-file-path-md-btn' + (mdView === 'code' ? ' active' : '')}
                  onClick={() => setMdView('code')}
                  title="Markdown edit mode"
                >
                  Code
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mdView === 'preview'}
                  className={'code-file-path-md-btn' + (mdView === 'preview' ? ' active' : '')}
                  onClick={() => setMdView('preview')}
                  title="Markdown preview mode"
                >
                  Preview
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mdView === 'split'}
                  className={'code-file-path-md-btn' + (mdView === 'split' ? ' active' : '')}
                  onClick={() => setMdView('split')}
                  title="Markdown split mode"
                >
                  Split
                </button>
              </div>
            )}
            <button
              type="button"
              className={'code-file-path-btn code-file-path-btn-copy' + (copiedPath ? ' copied is-copied' : '')}
              onClick={handleCopyPath}
              title={copiedPath ? 'File copied' : 'Copy file content'}
              aria-label="Copy file content"
            >
              {copiedPath ? (
                <>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span className="code-file-path-btn-label">Copied</span>
                </>
              ) : (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
            <div className="code-file-path-menu-wrap" ref={downloadMenuRef}>
              <button
                type="button"
                className={'code-file-path-btn' + (showDownloadMenu ? ' copied' : '')}
                onClick={() => setShowDownloadMenu(prev => !prev)}
                title="Download options"
                aria-label="Download options"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
              {showDownloadMenu && (
                <div className="code-file-download-menu" role="menu" aria-label="Download menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="code-file-download-item"
                    onClick={() => handleDownloadCurrentFile(false)}
                    disabled={!selectedFile}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span>Download current file (.{fileExt})</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="code-file-download-item"
                    onClick={() => handleDownloadCurrentFile(true)}
                    disabled={!selectedFile}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span>Download current file (.txt)</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="code-file-download-item"
                    onClick={handleDownloadAllFiles}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                      <polyline points="8 12 12 16 16 12" />
                      <line x1="12" y1="16" x2="12" y2="9" />
                    </svg>
                    <span>Download all files in this folder</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Binary file viewers ── */}
      {isImageFile && assetUrl && (
        <div className="code-binary-viewer code-image-viewer">
          <img src={assetUrl} alt={fileName} />
        </div>
      )}

      {isPdfFile && assetUrl && (
        <div className="code-binary-viewer code-pdf-viewer">
          <iframe src={assetUrl} title={fileName} />
        </div>
      )}

      {isDocFile && (
        <div className="code-binary-viewer code-doc-viewer">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          <p className="code-doc-viewer-title">{fileName}</p>
          <p className="code-doc-viewer-sub">Word/Excel/PowerPoint files cannot be previewed here.<br />The file has been added to your project.</p>
        </div>
      )}

      {/* ── Review prompt bar: staged auto-accept diffs waiting for user review ── */}
      {reviewableCount > 0 && pendingDiffCount === 0 && (
        <div className="code-panel-diff-batch-bar code-panel-review-bar">
          <span className="code-panel-diff-batch-label">
            {reviewableCount} file{reviewableCount !== 1 ? 's' : ''} changed
          </span>
          <button className="diff-btn diff-btn-review" onClick={onReviewChanges}>
            Review in Editor
          </button>
        </div>
      )}

      {/* ── Multi-file diff batch bar (while reviewing) ── */}
      {pendingDiffCount > 1 && (
        <div className="code-panel-diff-batch-bar">
          <span className="code-panel-diff-batch-label">{pendingDiffCount} files changed</span>
          <button className="diff-btn diff-btn-accept" onClick={onDiffAcceptAll}>Accept All</button>
          <button className="diff-btn diff-btn-reject" onClick={onDiffRejectAll}>Reject All</button>
        </div>
      )}

      {/* ── Code / text viewers — replaced by inline diff when pending ── */}
      {!isBinaryFile && !isMarkdownFile && (
        activeDiff ? (
          <DiffViewer
            path={activeDiff.path}
            originalContent={activeDiff.originalContent}
            proposedContent={activeDiff.proposedContent}
            isNewFile={activeDiff.isNewFile}
            status={activeDiff.status as DiffStatus}
            onAccept={() => onDiffAccept?.(activeDiff.approvalId)}
            onReject={() => onDiffReject?.(activeDiff.approvalId)}
            onAcceptContent={content => onDiffAccept?.(activeDiff.approvalId, content)}
            fillHeight
          />
        ) : (
          <CodeViewer
            key={selectedFile ?? 'none'}
            path={selectedFile}
            content={editorContent}
            searchQuery={searchQuery}
            onContentChange={handleContentChange}
            onInlineChat={sel => onInlineChat?.(sel, selectedFile ?? '')}
          />
        )
      )}

      {!isBinaryFile && isMarkdownFile && mdView === 'code' && (
        activeDiff ? (
          <DiffViewer
            path={activeDiff.path}
            originalContent={activeDiff.originalContent}
            proposedContent={activeDiff.proposedContent}
            isNewFile={activeDiff.isNewFile}
            status={activeDiff.status as DiffStatus}
            onAccept={() => onDiffAccept?.(activeDiff.approvalId)}
            onReject={() => onDiffReject?.(activeDiff.approvalId)}
            onAcceptContent={content => onDiffAccept?.(activeDiff.approvalId, content)}
            fillHeight
          />
        ) : (
          <CodeViewer
            key={selectedFile ?? 'none'}
            path={selectedFile}
            content={editorContent}
            searchQuery={searchQuery}
            onContentChange={handleContentChange}
            onInlineChat={sel => onInlineChat?.(sel, selectedFile ?? '')}
          />
        )
      )}

      {!isBinaryFile && isMarkdownFile && mdView === 'preview' && (
        <div className="code-md-preview-wrap">
          <div className="code-md-preview msg-markdown">
            <ReactMarkdown>{editorContent}</ReactMarkdown>
          </div>
        </div>
      )}

      {!isBinaryFile && isMarkdownFile && mdView === 'split' && (
        <div className="code-md-split">
          <div className="code-md-split-editor">
            <CodeViewer
              key={(selectedFile ?? 'none') + '-split'}
              path={selectedFile}
              content={editorContent}
              searchQuery={searchQuery}
              onContentChange={handleContentChange}
            />
          </div>
          <div className="code-md-split-preview">
            <div className="code-md-preview msg-markdown">
              <ReactMarkdown>{editorContent}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
