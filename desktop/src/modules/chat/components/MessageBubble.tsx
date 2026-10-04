import { useState, memo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Message, ToolCallData, ToolResultData, ReasoningData, ApprovalData, SubagentToolCallData, SubagentToolResultData, SubagentTextData } from '@/types'
import DiffViewer from '@/components/DiffViewer'
import { useChatStore } from '@/store/chatStore'
import { copyImageSourceToClipboard } from '@/lib/image-clipboard'

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

interface Props {
  message: Message
  onApprovalResponse?: (id: string, approved: boolean, content?: string) => void
  isLive?: boolean
  currentTool?: string | null
  onEdit?: (text: string) => void
  onBranchHere?: () => void
  projectPath?: string | null
}

function extractText(message: Message): string {
  const textParts = message.parts
    .filter(p => p.type === 'text')
    .map(p => (p.data as { text: string }).text)
    .filter(Boolean)
  if (textParts.length > 0) return textParts.join('\n')
  // During generation, fall back to tool call names so there's always something to copy
  const toolParts = message.parts
    .filter(p => p.type === 'tool_call')
    .map(p => (p.data as { name: string; input: string }).name)
    .filter(Boolean)
  return toolParts.length > 0 ? `[Running: ${toolParts.join(', ')}]` : ''
}

function MessageBubble({ message, onApprovalResponse, isLive, currentTool, onEdit, onBranchHere }: Props) {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const [copied, setCopied] = useState(false)
  const [hasSelection, setHasSelection] = useState(false)
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [imageCtxMenu, setImageCtxMenu] = useState<{ x: number; y: number; src: string; alt: string } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [previewImg, setPreviewImg] = useState<string | null>(null)

  // Show floating copy button whenever user selects text that touches this message
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.toString() === '') {
        setHasSelection(false)
        setSelectionPos(null)
        return
      }
      const range = sel.getRangeAt(0)
      const container = containerRef.current
      if (!container || !range.intersectsNode(container)) {
        setHasSelection(false)
        setSelectionPos(null)
        return
      }
      setHasSelection(true)
      const rect = range.getBoundingClientRect()
      // Position button centered above the selection end
      setSelectionPos({ x: rect.right, y: rect.top })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  const handleCopy = useCallback(() => {
    const sel = window.getSelection()
    const selectedText = sel?.toString() ?? ''
    const text = selectedText || extractText(message)
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }, [message])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && window.getSelection()?.toString() === '') {
      e.preventDefault()
      handleCopy()
    }
  }, [handleCopy])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('img')) return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const handleImageContextMenu = useCallback((e: React.MouseEvent, src: string, alt: string) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu(null)
    setImageCtxMenu({ x: e.clientX, y: e.clientY, src, alt })
  }, [])

  const handleCopyImage = useCallback(async () => {
    if (!imageCtxMenu) return
    await copyImageSourceToClipboard(imageCtxMenu.src)
    setImageCtxMenu(null)
  }, [imageCtxMenu])

  // Close context menu on any click or Escape outside
  useEffect(() => {
    if (!ctxMenu && !imageCtxMenu) return
    const closeAll = () => {
      setCtxMenu(null)
      setImageCtxMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAll() }
    document.addEventListener('mousedown', closeAll)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', closeAll)
      document.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu, imageCtxMenu])

  const showCopyBtn = hasSelection && !!selectionPos && extractText(message)

  if (message.role !== 'user' && message.role !== 'assistant') return null

  return (
    <div
      ref={containerRef}
      className={`message message-${message.role}`}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      tabIndex={0}
      style={{ outline: 'none', position: 'relative' }}
    >
      {isAssistant && (
        <div className="msg-role assistant">Assistant</div>
      )}
      {isUser && onEdit && extractText(message) && (
        <button
          className="msg-edit-btn"
          title="Edit & resend"
          aria-label="Edit & resend"
          onClick={() => onEdit(extractText(message))}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
      )}
      {onBranchHere && !isLive && (
        <button
          className="msg-branch-btn"
          title="Branch from here"
          aria-label="Branch conversation from here"
          onClick={onBranchHere}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        </button>
      )}
      {showCopyBtn && selectionPos && createPortal(
        <button
          className="msg-copy-btn-float"
          onClick={handleCopy}
          title="Copy selection"
          aria-label="Copy selection"
          style={{ left: selectionPos.x, top: selectionPos.y }}
        >
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          )}
          <span>{copied ? 'Copied!' : 'Copy'}</span>
        </button>,
        document.body
      )}
      {ctxMenu && createPortal(
        <div
          className="msg-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button className="msg-ctx-item" onClick={() => { handleCopy(); setCtxMenu(null) }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            {window.getSelection()?.toString() ? 'Copy selection' : 'Copy message'}
          </button>
        </div>,
        document.body
      )}
      {imageCtxMenu && createPortal(
        <div
          className="msg-ctx-menu msg-ctx-menu--image"
          style={{ left: imageCtxMenu.x, top: imageCtxMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button className="msg-ctx-item msg-ctx-item--image" onClick={handleCopyImage}>
            <span className="msg-ctx-item-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8" cy="8" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </span>
            <span className="msg-ctx-item-label">Copy image</span>
            <span className="msg-ctx-item-shortcut">Copy</span>
          </button>
        </div>,
        document.body
      )}
      <div className="msg-content">
        {message.parts.map((part, i) => {
          if (part.type === 'text') {
            const text = (part.data as { text: string }).text
            if (!text) return null
            if (isUser) return <span key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</span>
            const markdownImageComponents = {
              img: ({ src, alt }: { src?: string; alt?: string }) => {
                if (!src) return null
                const label = alt || 'inline image'
                return (
                  <img
                    src={src}
                    alt={label}
                    style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 8, cursor: 'zoom-in', display: 'block', marginTop: 6 }}
                    onClick={() => setPreviewImg(src)}
                    onContextMenu={e => handleImageContextMenu(e, src, label)}
                    title="Click to enlarge"
                  />
                )
              },
            }
            return (
              <div key={i} className="msg-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={markdownImageComponents}
                >
                  {text}
                </ReactMarkdown>
              </div>
            )
          }

          if (part.type === 'reasoning') {
            const d = part.data as ReasoningData
            if (!d.thinking) return null
            return <ThinkingBlock key={i} thinking={d.thinking} defaultOpen={!hasFinish(message)} />
          }

          if (part.type === 'tool_call') {
            const d = part.data as ToolCallData
            if (d.name === 'update_plan') return null
            return <ToolCallBlock key={i} data={d} />
          }

          if (part.type === 'tool_result') {
            const d = part.data as ToolResultData
            if (d.name === 'update_plan') return null
            return <ToolResultBlock key={i} data={d} />
          }

          if (part.type === 'approval_request') {
            const d = part.data as ApprovalData
            return (
              <ApprovalCard
                key={i}
                data={d}
                onAccept={() => onApprovalResponse?.(d.id, true)}
                onReject={() => onApprovalResponse?.(d.id, false)}
                onAcceptContent={(content) => onApprovalResponse?.(d.id, true, content)}
              />
            )
          }

          if (part.type === 'subagent_tool_call') {
            const d = part.data as SubagentToolCallData
            return <SubagentToolCallBlock key={i} subagentType={d.subagentType} data={d.call} />
          }

          if (part.type === 'subagent_tool_result') {
            const d = part.data as SubagentToolResultData
            return <SubagentToolResultBlock key={i} subagentType={d.subagentType} data={d.result} />
          }

          if (part.type === 'subagent_text') {
            const d = part.data as SubagentTextData
            if (!d.text) return null
            return <SubagentTextBlock key={i} subagentType={d.subagentType} text={d.text} />
          }

          if (part.type === 'image_url') {
            const url = (part.data as { url: string }).url
            return (
              <img
                key={i}
                src={url}
                alt="attached image"
                style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 8, cursor: 'zoom-in', display: 'block', marginTop: 6 }}
                onClick={() => setPreviewImg(url)}
                onContextMenu={e => handleImageContextMenu(e, url, 'attached image')}
                title="Click to enlarge"
              />
            )
          }

          if (part.type === 'binary') {
            const d = part.data as { name: string; mimeType: string }
            return (
              <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, background: 'rgba(0,0,0,0.12)', fontSize: 13, marginTop: 4 }}>
                <span>📎</span>
                <span style={{ wordBreak: 'break-all' }}>{d.name}</span>
              </div>
            )
          }

          if (part.type === 'compaction') {
            const d = part.data as { summary: string; messageCount: number }
            return (
              <div key={i} style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(100,100,200,0.10)', border: '1px solid rgba(100,100,200,0.25)', fontSize: 12, color: 'var(--text-muted, #888)', marginBottom: 4 }}>
                <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text-secondary, #aaa)' }}>
                  Context compacted — {d.messageCount} earlier messages summarized
                </div>
                <details>
                  <summary style={{ cursor: 'pointer', userSelect: 'none' }}>Show summary</summary>
                  <div style={{ marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{d.summary}</div>
                </details>
              </div>
            )
          }

          if (part.type === 'finish') return null
          return null
        })}
        {previewImg && createPortal(
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
            onClick={() => setPreviewImg(null)}
          >
            <img
              src={previewImg}
              alt="Preview"
              style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.6)', objectFit: 'contain' }}
              onClick={e => e.stopPropagation()}
              onContextMenu={e => handleImageContextMenu(e, previewImg, 'preview image')}
            />
            <button
              style={{ position: 'absolute', top: 16, right: 20, background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', fontSize: 22, width: 36, height: 36, borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => setPreviewImg(null)}
              aria-label="Close preview"
            >×</button>
          </div>,
          document.body
        )}

        {/* Live status pill — shown inside the active assistant message */}
        {isLive && isAssistant && (
          <AgentStatusPill currentTool={currentTool} />
        )}

        {isAssistant && message.parts.length === 0 && !isLive && (
          <TypingIndicator />
        )}

        {isAssistant && message.parts.length > 0 && !hasFinish(message) && !hasText(message) && !isLive && (
          <TypingIndicator />
        )}

        {isAssistant && hasFinish(message) && !hasText(message) && hasToolCalls(message) && (
          <div className="msg-done-note">Done</div>
        )}
      </div>
    </div>
  )
}

export default memo(MessageBubble)

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasFinish(msg: Message) { return msg.parts.some(p => p.type === 'finish') }
function hasText(msg: Message) { return msg.parts.some(p => p.type === 'text' && (p.data as { text: string }).text?.length > 0) }
function hasToolCalls(msg: Message) { return msg.parts.some(p => p.type === 'tool_call') }

// ── Agent status pill (shown live inside active message) ──────────────────────

const TOOL_STATUS_LABELS: Record<string, string> = {
  write_file: 'Writing file',
  edit: 'Editing file',
  read_file: 'Reading file',
  view_file: 'Reading file',
  list_dir: 'Listing directory',
  list_files: 'Listing files',
  grep_search: 'Searching',
  bash: 'Running command',
  web_fetch: 'Fetching URL',
  delete_file: 'Deleting file',
  rename_file: 'Renaming file',
  run_subagent: 'Running subagent',
  spawn_coding_agent: 'Spawning agent',
  send_to_agent: 'Sending to agent',
  read_agent_output: 'Reading agent output',
}

function statusLabel(tool: string | null | undefined): string {
  if (!tool) return 'Thinking'
  if (tool.includes('__')) {
    const [server, name] = tool.split('__')
    return `${server}: ${name.replace(/_/g, ' ')}`
  }
  return TOOL_STATUS_LABELS[tool] ?? tool.replace(/_/g, ' ')
}

function AgentStatusPill({ currentTool }: { currentTool?: string | null }) {
  const toolStartedAt = useChatStore(s => s.toolStartedAt)
  const lastRoundOutput = useChatStore(s => s.lastRoundOutput)
  const [elapsedSec, setElapsedSec] = useState(0)

  useEffect(() => {
    const start = toolStartedAt ?? Date.now()
    setElapsedSec(Math.floor((Date.now() - start) / 1000))
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(id)
  }, [toolStartedAt])

  const metaParts: string[] = []
  if (elapsedSec > 0) metaParts.push(`${elapsedSec}s`)
  if (lastRoundOutput > 0) metaParts.push(`↓ ${formatTokens(lastRoundOutput)}`)

  return (
    <div className="agent-status-pill">
      <span className="agent-status-spinner" />
      <span className="agent-status-label">{statusLabel(currentTool)}…</span>
      {metaParts.length > 0 && (
        <span className="agent-status-meta">{metaParts.join(' · ')}</span>
      )}
    </div>
  )
}

// ── Typing indicator ──────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="typing-indicator">
      <div className="typing-dot" />
      <div className="typing-dot" />
      <div className="typing-dot" />
    </div>
  )
}

// ── Thinking block ────────────────────────────────────────────────────────────

function ThinkingBlock({ thinking, defaultOpen }: { thinking: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div className="thinking-block">
      <div className="thinking-header" onClick={() => setOpen(o => !o)}>
        <span className="thinking-icon">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" />
          </svg>
        </span>
        <span>Reasoning{open ? ' ▾' : ' ▸'}</span>
      </div>
      {open && <div className="thinking-content">{thinking}</div>}
    </div>
  )
}

// ── Tool call block ───────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, JSX.Element> = {
  write_file: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  edit:       <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>,
  read_file:  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  view_file:  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  list_dir:   <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  list_files: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  grep_search:<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  bash:       <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
  web_fetch:  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  delete_file:<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>,
}

const CHECK_ICON = <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
const SPIN_ICON  = <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="tool-spin"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>

const TOOL_LABELS: Record<string, string> = {
  write_file: 'write', edit: 'edit', read_file: 'read', view_file: 'view',
  list_dir: 'list dir', list_files: 'list files', grep_search: 'search',
  bash: 'bash', web_fetch: 'fetch', delete_file: 'delete', rename_file: 'rename',
  run_subagent: 'subagent', spawn_coding_agent: 'spawn agent',
}

function ToolCallBlock({ data }: { data: ToolCallData }) {
  const isMcp = data.name.includes('__')
  const isFigma = isMcp && data.name.toLowerCase().includes('figma')
  const label = isMcp
    ? (() => { const [s, t] = data.name.split('__'); return isFigma ? `Figma: ${t.replace(/_/g, ' ')}` : `${s}: ${t.replace(/_/g, ' ')}` })()
    : (TOOL_LABELS[data.name] ?? data.name.replace(/_/g, ' '))
  const shortInput = getShortInput(data.name, data.input)
  const icon = isFigma ? (
    <svg width="11" height="11" viewBox="0 0 38 57" fill="none">
      <path d="M19 28.5A9.5 9.5 0 1 1 28.5 19 9.5 9.5 0 0 1 19 28.5z" fill="#1ABCFE"/>
      <path d="M9.5 47.5A9.5 9.5 0 0 1 19 38h9.5v9.5A9.5 9.5 0 1 1 9.5 47.5z" fill="#0ACF83"/>
      <path d="M19 0H9.5A9.5 9.5 0 0 0 9.5 19H19z" fill="#FF7262"/>
      <path d="M28.5 0H19v19h9.5a9.5 9.5 0 0 0 0-19z" fill="#F24E1E"/>
      <path d="M19 19H9.5a9.5 9.5 0 0 0 0 19H19z" fill="#A259FF"/>
    </svg>
  ) : (TOOL_ICONS[data.name] ?? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>)

  const progressLabel = !data.finished && data.progress ? data.progress : null

  return (
    <div className={`tool-call${data.finished ? ' finished' : ''}`}>
      <span className="tool-call-icon">{icon}</span>
      <span className="tool-call-name">{label}</span>
      {shortInput && <span className="tool-call-input">{shortInput}</span>}
      {progressLabel && <span className="tool-call-progress">{progressLabel}</span>}
      <span className="tool-call-status">{data.finished ? CHECK_ICON : SPIN_ICON}</span>
    </div>
  )
}

function ToolResultBlock({ data }: { data: ToolResultData }) {
  const [show, setShow] = useState(false)
  if (!data.content) return null
  return (
    <div style={{ marginBottom: 2 }}>
      <span className="text-sm text-muted" style={{ cursor: 'pointer', padding: '2px 0', display: 'inline-block' }}
        onClick={() => setShow(s => !s)}>
        {show ? '▾' : '▸'} {data.is_error ? '⚠ Error' : 'Output'}
      </span>
      {show && (
        <div className={`tool-call-result${data.is_error ? ' error' : ''}`}>
          {data.content.slice(0, 2000)}
          {data.content.length > 2000 && '\n…(truncated)'}
        </div>
      )}
    </div>
  )
}

// ── PlanPanel ─────────────────────────────────────────────────────────────────

// ── ApprovalCard ──────────────────────────────────────────────────────────────

function ApprovalCard({ data, onAccept, onReject, onAcceptContent }: {
  data: ApprovalData
  onAccept: () => void
  onReject: () => void
  onAcceptContent: (content: string) => void
}) {
  const isBash = data.toolName === 'bash'

  const statusColors: Record<string, string> = {
    pending: 'approval-card--pending',
    approved: 'approval-card--approved',
    rejected: 'approval-card--rejected',
  }

  // ── Bash approval card — runs in chat, blocks agent ────────────────────────
  if (isBash) {
    return (
      <div className={`approval-card approval-card-bash ${statusColors[data.status] ?? ''}`}>
        <div className="approval-card-header">
          <span className="approval-card-indicator" />
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--yellow)', flexShrink: 0 }}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          <span className="approval-card-label">Run terminal command</span>
          {data.status === 'pending' && <span className="approval-card-needs-label">waiting for approval</span>}
          {data.status !== 'pending' && (
            <span className={`approval-card-done-label approval-done-${data.status}`}>
              {data.status === 'approved' ? 'Approved' : 'Rejected'}
            </span>
          )}
        </div>
        <div className="approval-bash-command">
          <code>{data.command ?? ''}</code>
        </div>
        {data.status === 'pending' && (
          <div className="approval-bash-actions">
            <button className="diff-btn diff-btn-reject" onClick={onReject}>✕ Reject</button>
            <button className="diff-btn diff-btn-accept" onClick={onAccept}>✓ Allow</button>
          </div>
        )}
      </div>
    )
  }

  // ── File change card — agent already wrote the file, user can revert ───────
  const toolIcon = data.toolName === 'write_file' ? (data.isNewFile ? '✦' : '✎') : '✏'
  const label = data.toolName === 'write_file' ? (data.isNewFile ? 'Create file' : 'Write file') : 'Edit file'
  const isApplied = data.status === 'approved'

  return (
    <div className={`approval-card ${statusColors[data.status] ?? ''}`}>
      <div className="approval-card-header">
        <span className="approval-card-indicator" />
        <span className="approval-card-icon">{toolIcon}</span>
        <span className="approval-card-label">{label}</span>
        {isApplied && <span className="approval-card-done-label approval-done-approved">Applied</span>}
        {data.status === 'rejected' && <span className="approval-card-done-label approval-done-rejected">Reverted</span>}
        {data.status === 'pending' && <span className="approval-card-needs-label">awaiting review</span>}
      </div>

      <DiffViewer
        path={data.path}
        originalContent={data.originalContent}
        proposedContent={data.proposedContent}
        status={data.status}
        isNewFile={data.isNewFile}
        onAccept={onAccept}
        onReject={onReject}
        onAcceptContent={onAcceptContent}
      />
    </div>
  )
}

// ── Subagent blocks (nested tool visibility) ──────────────────────────────────

function SubagentToolCallBlock({ subagentType, data }: { subagentType: string; data: ToolCallData }) {
  const label = TOOL_LABELS[data.name] ?? data.name.replace(/_/g, ' ')
  const icon = TOOL_ICONS[data.name] ?? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
  return (
    <div className="subagent-block">
      <div className="subagent-tool-call">
        <span className="tool-call-icon">{icon}</span>
        <span className="subagent-label">{subagentType}</span>
        <span className="tool-call-name">{label}</span>
        {data.input && <span className="tool-call-input">{getShortInput(data.name, data.input)}</span>}
        <span className="tool-call-status">{data.finished ? CHECK_ICON : SPIN_ICON}</span>
      </div>
    </div>
  )
}

function SubagentToolResultBlock({ subagentType, data }: { subagentType: string; data: ToolResultData }) {
  const [show, setShow] = useState(false)
  if (!data.content) return null
  return (
    <div className="subagent-block">
      <span className="text-sm text-muted subagent-result-toggle" onClick={() => setShow(s => !s)}>
        {show ? '▾' : '▸'} {subagentType}: {data.is_error ? '⚠ Error' : 'Output'}
      </span>
      {show && (
        <div className={`tool-call-result${data.is_error ? ' error' : ''}`}>
          {data.content.slice(0, 2000)}
          {data.content.length > 2000 && '\n…(truncated)'}
        </div>
      )}
    </div>
  )
}

function SubagentTextBlock({ subagentType, text }: { subagentType: string; text: string }) {
  const [show, setShow] = useState(text.length > 200)
  return (
    <div className="subagent-block subagent-text-block">
      <span className="text-sm text-muted subagent-text-toggle" onClick={() => setShow(s => !s)}>
        {show ? '▾' : '▸'} {subagentType} thinking
      </span>
      {show && <div className="subagent-text-content">{text}</div>}
    </div>
  )
}

function getShortInput(toolName: string, input: string): string {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>
    if (toolName.includes('__')) {
      const fileKey = parsed.fileKey ?? parsed.file_key ?? parsed.key ?? parsed.nodeId ?? parsed.node_id
      if (fileKey) return String(fileKey).slice(0, 40)
      return ''
    }
    if (toolName === 'bash') return String(parsed.command ?? '').slice(0, 60)
    if (['write_file', 'edit', 'view_file', 'read_file', 'delete_file', 'rename_file'].includes(toolName))
      return String(parsed.path ?? '')
    if (toolName === 'list_dir') return String(parsed.path ?? '.')
    if (toolName === 'grep_search') return String(parsed.query ?? '').slice(0, 40)
    return ''
  } catch {
    return input.slice(0, 60)
  }
}
