import { useState, useRef, useEffect, useCallback, useMemo, KeyboardEvent, Fragment, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  selection: string
  fileName: string
  onSend: (text: string, fileName: string, onChunk: (chunk: string, done: boolean, err?: string) => void) => void
  onClose: () => void
}

const QUICK_ACTIONS = [
  { label: 'Explain', prompt: 'Explain this code briefly in 3-6 bullet points. Do not rewrite the file or add extra theory.' },
  { label: 'Refactor', prompt: 'Refactor this code to be cleaner and more readable, then write the changes to the file.' },
  { label: 'Fix bugs', prompt: 'Find and fix any bugs in this code, then write the corrected version to the file.' },
  { label: 'Add types', prompt: 'Add proper TypeScript types to this code, then write the updated version to the file.' },
  { label: 'Add comments', prompt: 'Add clear inline comments to this code, then write the commented version to the file.' },
]

type ResponseBlock =
  | { type: 'p'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'h'; level: number; text: string }
  | { type: 'code'; lang: string; lines: string[] }

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const tokens = text.split(/(`[^`]+`)/g).filter(Boolean)
  for (const [idx, token] of tokens.entries()) {
    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      parts.push(
        <code key={`code-${idx}`} className="ic-inline-code">
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      const boldSegments = token.split(/(\*\*[^*]+\*\*)/g).filter(Boolean)
      for (const [bIdx, seg] of boldSegments.entries()) {
        if (seg.startsWith('**') && seg.endsWith('**') && seg.length >= 4) {
          parts.push(
            <strong key={`bold-${idx}-${bIdx}`}>
              {seg.slice(2, -2)}
            </strong>,
          )
        } else {
          parts.push(<Fragment key={`text-${idx}-${bIdx}`}>{seg}</Fragment>)
        }
      }
    }
  }
  return parts
}

function normalizeResponseText(text: string): string {
  return text.replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n')
}

function parseResponseBlocks(text: string): ResponseBlock[] {
  const normalized = normalizeResponseText(text)
  if (!normalized) return []

  const lines = normalized.split(/\r?\n/)
  const blocks: ResponseBlock[] = []
  let paragraph: string[] = []
  let bullets: string[] = []
  let ordered: string[] = []
  let code: string[] = []
  let codeLang = ''
  let inCode = false

  const flushParagraph = () => {
    const trimmed = paragraph.join(' ').trim()
    if (trimmed) blocks.push({ type: 'p', lines: [trimmed] })
    paragraph = []
  }
  const flushBullets = () => {
    if (bullets.length) blocks.push({ type: 'ul', items: bullets })
    bullets = []
  }
  const flushOrdered = () => {
    if (ordered.length) blocks.push({ type: 'ol', items: ordered })
    ordered = []
  }
  const flushCode = () => {
    if (code.length) blocks.push({ type: 'code', lang: codeLang, lines: code })
    code = []
    codeLang = ''
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      if (inCode) {
        flushParagraph()
        flushBullets()
        flushOrdered()
        flushCode()
        inCode = false
      } else {
        flushParagraph()
        flushBullets()
        flushOrdered()
        inCode = true
        codeLang = trimmed.slice(3).trim()
      }
      continue
    }

    if (inCode) {
      code.push(line)
      continue
    }

    if (!trimmed) {
      flushParagraph()
      flushBullets()
      flushOrdered()
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      flushParagraph()
      flushBullets()
      flushOrdered()
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2].trim() })
      continue
    }

    const bullet = trimmed.match(/^[-*•]\s+(.*)$/)
    if (bullet) {
      flushParagraph()
      flushOrdered()
      bullets.push(bullet[1].trim())
      continue
    }

    const orderedMatch = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (orderedMatch) {
      flushParagraph()
      flushBullets()
      ordered.push(orderedMatch[1].trim())
      continue
    }

    if (bullets.length) flushBullets()
    if (ordered.length) flushOrdered()
    paragraph.push(trimmed)
  }

  flushParagraph()
  flushBullets()
  flushOrdered()
  flushCode()
  return blocks
}

export default function InlineChatPopup({ selection, fileName, onSend, onClose }: Props) {
  const [input, setInput] = useState('')
  const [response, setResponse] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const responseRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 30)
  }, [])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (responseRef.current) responseRef.current.scrollTop = responseRef.current.scrollHeight
  }, [response])

  const buildMessage = useCallback((instruction: string) => {
    const lang = fileName.split('.').pop() ?? ''
    const normFile = fileName.replace(/\\/g, '/')
    const fileHint = normFile ? ` The file is \`${normFile}\`.` : ''
    if (selection.trim()) {
      const codeBlock = `\`\`\`${lang}\n${selection.trim()}\n\`\`\``
      return `${codeBlock}\n\n${instruction}${fileHint}`
    }
    return normFile
      ? `${instruction} Read and modify \`${normFile}\` directly.`
      : instruction
  }, [selection, fileName])

  const dispatch = useCallback((msg: string) => {
    setSent(true)
    setIsStreaming(true)
    setResponse('')
    setError('')
    onSend(msg, fileName, (chunk, done, err) => {
      if (chunk) setResponse(prev => prev + chunk)
      if (done) {
        setIsStreaming(false)
        if (err) setError(err)
      }
    })
  }, [onSend])

  const handleSend = useCallback(() => {
    const text = input.trim()
    if (!text || sent) return
    dispatch(buildMessage(text))
  }, [input, sent, buildMessage, dispatch])

  const handleQuick = useCallback((prompt: string) => {
    if (sent) return
    dispatch(buildMessage(prompt))
  }, [sent, buildMessage, dispatch])

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const previewLines = selection.trim().split('\n').slice(0, 5)
  const hasMore = selection.trim().split('\n').length > 5
  const renderedBlocks = useMemo(() => parseResponseBlocks(response), [response])

  return createPortal(
    <>
      <div className="ic-overlay" onClick={onClose} />
      <div className="ic-popup" ref={popupRef}>
        <div className="ic-header">
          <div className="ic-header-left">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z"/>
            </svg>
            <span>Inline Chat</span>
            {fileName && <span className="ic-filename">{fileName.split(/[/\\]/).pop()}</span>}
          </div>
          <button className="ic-close" onClick={onClose}>
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="2" y1="2" x2="12" y2="12"/><line x1="12" y1="2" x2="2" y2="12"/></svg>
          </button>
        </div>

        {!sent && (
          <div className="ic-body">
            {selection.trim() && (
              <div className="ic-selection-preview">
                <pre className="ic-code-preview">
                  {previewLines.join('\n')}
                  {hasMore && <span className="ic-code-more">{'\n'}…</span>}
                </pre>
              </div>
            )}
            <div className="ic-quick-actions">
              {QUICK_ACTIONS.map(a => (
                <button key={a.label} className="ic-quick-btn" onClick={() => handleQuick(a.prompt)}>
                  {a.label}
                </button>
              ))}
            </div>
            <div className="ic-input-wrap">
              <textarea
                ref={textareaRef}
                className="ic-textarea"
                placeholder={selection.trim() ? 'Ask about this code…' : 'Ask the agent…'}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKey}
                rows={2}
              />
              <button className="ic-send-btn" onClick={handleSend} disabled={!input.trim()}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 1 7.5 8.5"/><path d="M15 1 10 15l-2.5-6.5L1 6l14-5z"/>
                </svg>
              </button>
            </div>
            <div className="ic-hint">Enter to send · Shift+Enter for new line · Esc to close</div>
          </div>
        )}

        {sent && (
          <div className="ic-response-wrap" ref={responseRef}>
            {isStreaming && !response && (
              <div className="ic-response-loading">
                <span className="ic-dot" /><span className="ic-dot" /><span className="ic-dot" />
              </div>
            )}
            {renderedBlocks.length > 0 && (
              <div className="ic-response-content">
                {renderedBlocks.map((block, idx) => {
                  if (block.type === 'h') {
                    const level = Math.min(Math.max(block.level, 1), 3)
                    const headingClass = `ic-response-heading ic-response-heading--${level}`
                    if (level === 1) return <h1 key={idx} className={headingClass}>{renderInlineMarkdown(block.text)}</h1>
                    if (level === 2) return <h2 key={idx} className={headingClass}>{renderInlineMarkdown(block.text)}</h2>
                    return <h3 key={idx} className={headingClass}>{renderInlineMarkdown(block.text)}</h3>
                  }
                  if (block.type === 'ul') {
                    return (
                      <ul key={idx} className="ic-response-list">
                        {block.items.map((item, itemIdx) => <li key={itemIdx}>{renderInlineMarkdown(item)}</li>)}
                      </ul>
                    )
                  }
                  if (block.type === 'ol') {
                    return (
                      <ol key={idx} className="ic-response-list ic-response-list--ordered">
                        {block.items.map((item, itemIdx) => <li key={itemIdx}>{renderInlineMarkdown(item)}</li>)}
                      </ol>
                    )
                  }
                  if (block.type === 'code') {
                    return (
                      <pre key={idx} className="ic-response-code">
                        {block.lines.join('\n')}
                      </pre>
                    )
                  }
                  return <p key={idx} className="ic-response-paragraph">{renderInlineMarkdown(block.lines.join(' '))}</p>
                })}
              </div>
            )}
            {response && renderedBlocks.length === 0 && (
              <div className="ic-response-text">{renderInlineMarkdown(normalizeResponseText(response))}</div>
            )}
            {error && <div className="ic-response-error">{error}</div>}
            {!isStreaming && (response || error) && (
              <button className="ic-done-btn" onClick={onClose}>Close</button>
            )}
            {!isStreaming && !response && !error && sent && (
              <div className="ic-response-error">No response received. Check your API key or try again.</div>
            )}
          </div>
        )}
      </div>
    </>,
    document.body
  )
}
