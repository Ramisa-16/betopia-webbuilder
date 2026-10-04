/**
 * LandingChat.tsx
 * Full-screen initial chat view shown before any code is generated.
 * Once the user submits their first prompt it collapses into the workspace.
 */

import { useState, useRef, useCallback, useEffect, useMemo, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { allSlashOptions, isCustomSkillPath } from '@/lib/builtin-skills'
import { resolveSkillDirective } from '@/lib/skill-routing'
import { getConfig, type CustomSubagentDef } from '@/lib/config'
import { loadCustomSkillsForSettings, type Skill } from '@/lib/agent'
import { SKILLS_CHANGED_EVENT } from '@/lib/skill-events'
import { getRecentProjectPaths } from '@/lib/recent-projects'
import type { Attachment } from '@/types'
import {
  MAX_IMAGES,
  getAttachmentKind,
  readClipboardImageAttachment,
  resolveAttachmentMimeType,
} from '@/lib/attachments'

interface Props {
  isAgentBusy: boolean
  onSend: (text: string, attachments?: Attachment[], options?: { agentPrompt?: string }) => void
}

const SUGGESTIONS = [
  { icon: '⚛',  title: 'React + Django',     desc: 'Build a full-stack app with React frontend and Django backend' },
  { icon: '📊',  title: 'Dashboard App',      desc: 'Admin dashboard with React UI and Django APIs' },
  { icon: '🛍',  title: 'Store App',          desc: 'E-commerce experience with React storefront and Django backend' },
  { icon: '✍',  title: 'Blog Platform',      desc: 'Content site with React frontend and Django CMS-style backend' },
  { icon: '🔐',  title: 'Auth Portal',        desc: 'Login, dashboard, and protected routes with Django APIs' },
  { icon: '🧩',  title: 'Custom Stack',       desc: 'React frontend plus Django backend tailored to my product' },
]

export default function LandingChat({ isAgentBusy, onSend }: Props) {
  const [input, setInput]             = useState('')
  const [ctxMenu, setCtxMenu]         = useState<{ x: number; y: number } | null>(null)
  const [slashQuery, setSlashQuery]   = useState<string | null>(null)
  const [customSkills, setCustomSkills] = useState<Skill[]>([])
  const [customSubagents, setCustomSubagents] = useState<CustomSubagentDef[]>(() => getConfig().customSubagents ?? [])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [previewImg, setPreviewImg]   = useState<string | null>(null)
  const textareaRef                   = useRef<HTMLTextAreaElement>(null)
  const composerUndoRef = useRef<Array<{
    input: string
    attachments: Attachment[]
    slashQuery: string | null
  }>>([])
  const composerStateRef = useRef({
    input,
    attachments,
    slashQuery,
  })
  useEffect(() => {
    composerStateRef.current = {
      input,
      attachments,
      slashQuery,
    }
  }, [input, attachments, slashQuery])

  // Auto-focus on mount
  useEffect(() => { textareaRef.current?.focus() }, [])

  useEffect(() => {
    const refreshCustomSkills = () => {
      loadCustomSkillsForSettings('', getRecentProjectPaths())
        .then(skills => setCustomSkills(skills.filter(skill => isCustomSkillPath(skill.path))))
        .catch(() => setCustomSkills([]))
    }
    refreshCustomSkills()
    window.addEventListener(SKILLS_CHANGED_EVENT, refreshCustomSkills)
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, refreshCustomSkills)
  }, [])

  useEffect(() => {
    const syncSubagents = () => setCustomSubagents(getConfig().customSubagents ?? [])
    syncSubagents()
    window.addEventListener('betopia:config-changed', syncSubagents)
    return () => window.removeEventListener('betopia:config-changed', syncSubagents)
  }, [])

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [input])

  const slashOptions = useMemo(() => allSlashOptions(customSkills, customSubagents), [customSkills, customSubagents])
  const slashResults = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    if (q === '/') return slashOptions
    return slashOptions.filter(o => o.slash.toLowerCase().startsWith(q) || o.name.toLowerCase().includes(q.slice(1)))
  }, [slashOptions, slashQuery])

  const slashResultGroups = useMemo(() => {
    const system = slashResults.filter(option => option.source === 'system')
    const custom = slashResults.filter(option => option.source === 'custom')
    const subagents = slashResults.filter(option => option.source === 'subagent')
    return [
      { key: 'system', title: 'System skills', options: system },
      { key: 'custom', title: 'Custom skills', options: custom },
      { key: 'subagent', title: 'Sub-agents', options: subagents },
    ].filter(group => group.options.length > 0)
  }, [slashResults])

  const pushComposerUndo = useCallback(() => {
    const state = composerStateRef.current
    composerUndoRef.current.push({
      input: state.input,
      attachments: state.attachments.map(att => ({ ...att })),
      slashQuery: state.slashQuery,
    })
    if (composerUndoRef.current.length > 200) composerUndoRef.current.shift()
  }, [])

  const restoreComposerState = useCallback((state: {
    input: string
    attachments: Attachment[]
    slashQuery: string | null
  }) => {
    setInput(state.input)
    setAttachments(state.attachments)
    setSlashQuery(state.slashQuery)
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = state.input.length
      }
    })
  }, [])
  const insertSlash = (slash: string) => {
    const ta = textareaRef.current
    const pos = ta?.selectionStart ?? input.length
    const before = input.slice(0, pos)
    const after = input.slice(pos)
    const replaced = before.replace(/(^|\s)(\/[\w-]*)$/, (_m, lead) => `${lead}${slash} `)
    pushComposerUndo()
    setInput(replaced + after)
    setSlashQuery(null)
    requestAnimationFrame(() => { if (textareaRef.current) { textareaRef.current.focus(); textareaRef.current.selectionStart = textareaRef.current.selectionEnd = replaced.length } })
  }

  const submit = useCallback(() => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || isAgentBusy) return
    const route = resolveSkillDirective(text, slashOptions, { allowAuto: true })
    if (route) {
      onSend(route.visibleText, attachments.length > 0 ? attachments : undefined, { agentPrompt: route.agentPrompt })
      pushComposerUndo()
      setInput('')
      setAttachments([])
      setSlashQuery(null)
      return
    }
    onSend(text, attachments.length > 0 ? attachments : undefined)
    pushComposerUndo()
    setInput('')
    setAttachments([])
    setSlashQuery(null)
  }, [input, attachments, isAgentBusy, onSend, slashOptions, pushComposerUndo])

  const appendAttachment = useCallback((attachment: Attachment) => {
    pushComposerUndo()
    setAttachments(prev => {
      if (attachment.type === 'image' && prev.filter(a => a.type === 'image').length >= MAX_IMAGES) {
        return prev
      }
      return [...prev, attachment]
    })
  }, [pushComposerUndo])

  const addBrowserFileAttachment = useCallback((file: File, idPrefix: 'paste' | 'file') => {
    const mimeType = resolveAttachmentMimeType(file.name, file.type)
    if (!mimeType) return false
    const reader = new FileReader()
    reader.onload = event => {
      const data = (event.target?.result as string) ?? ''
      appendAttachment({
        id: `${idPrefix}-${Date.now()}`,
        type: getAttachmentKind(mimeType),
        name: file.name || 'pasted-screenshot.png',
        data: data.split(',')[1] || data,
        mimeType,
        size: file.size,
      })
    }
    reader.readAsDataURL(file)
    return true
  }, [appendAttachment])

  const handleSmartPaste = useCallback(async () => {
    try {
      const imageAttachment = await readClipboardImageAttachment('paste')
      if (imageAttachment) {
        appendAttachment(imageAttachment)
        return
      }
    } catch { /* clipboard image unavailable - fall through */ }

    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        pushComposerUndo()
        document.execCommand('insertText', false, text)
      }
    } catch {}
  }, [appendAttachment, pushComposerUndo])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const attachmentFileItem = items.find(item => {
      if (item.kind !== 'file') return false
      const file = item.getAsFile()
      return !!file && !!resolveAttachmentMimeType(file.name, file.type)
    })
    if (attachmentFileItem) {
      const file = attachmentFileItem.getAsFile()
      if (!file) return
      e.preventDefault()
      addBrowserFileAttachment(file, 'paste')
      return
    }

    const hasImageType = Array.from(e.clipboardData?.types ?? []).some(type => type.startsWith('image/'))
    if (!hasImageType) return

    e.preventDefault()
    void handleSmartPaste()
  }, [addBrowserFileAttachment, handleSmartPaste])

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      const prev = composerUndoRef.current.pop()
      if (prev) {
        e.preventDefault()
        restoreComposerState(prev)
      }
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      e.preventDefault()
      handleSmartPaste()
      return
    }
    if (slashQuery !== null) {
      if (e.key === 'Escape') { e.preventDefault(); setSlashQuery(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const useSuggestion = (desc: string) => {
    pushComposerUndo()
    setInput(desc)
    textareaRef.current?.focus()
  }
  return (
    <>
    <div className="landing-chat">
      {/* Brand */}
      <div className="landing-brand">
        <div className="landing-logo">B</div>
        <h1 className="landing-title">Betopia WebBuilder</h1>
        <p className="landing-subtitle">
          Describe what you want to build. The builder generates a React frontend and Django backend.
        </p>
      </div>

      {/* Input */}
      <div className="landing-input-wrap" style={{ position: 'relative' }}>
        {slashQuery !== null && (
          <div className="chat-at-picker" style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6, zIndex: 50 }}>
            {slashResultGroups.map((group, groupIndex) => (
              <div key={group.key}>
                <div className="chat-at-section-label">{group.title}</div>
                {group.options.map((opt, i) => (
                  <button key={opt.slash} className={'chat-at-item' + (groupIndex === 0 && i === 0 ? ' active' : '')} onClick={() => insertSlash(opt.slash)}>
                    <span className="chat-at-name" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{opt.slash}</span>
                    <span className="chat-at-path">{opt.description}</span>
                    {opt.source === 'custom' && <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 'auto', flexShrink: 0 }}>custom</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 12px 0' }}>
            {attachments.map(att => (
              <div key={att.id} style={{ position: 'relative', width: 64, height: 64 }}>
                {att.type === 'image' ? (
                  <img
                    src={`data:${att.mimeType};base64,${att.data}`}
                    alt={att.name}
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, cursor: 'zoom-in' }}
                    onClick={() => setPreviewImg(`data:${att.mimeType};base64,${att.data}`)}
                  />
                ) : (
                  <div style={{ width: 64, height: 64, borderRadius: 8, border: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>
                    FILE
                  </div>
                )}
                <button
                  onClick={() => {
                    pushComposerUndo()
                    setAttachments(prev => prev.filter(a => a.id !== att.id))
                  }}
                  style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', background: '#ef4444', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer' }}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="landing-textarea"
          placeholder="Describe your app or type / for skills..."
          value={input}
          onChange={e => {
            pushComposerUndo()
            setInput(e.target.value)
            const pos = e.target.selectionStart ?? e.target.value.length
            const m = e.target.value.slice(0, pos).match(/(^|\s)(\/[\w-]*)$/)
            setSlashQuery(m ? m[2] : null)
          }}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }) }}
          disabled={isAgentBusy}
          rows={3}
        />
        <div className="landing-input-footer">
          <span className="landing-hint">Enter to send · Shift+Enter for new line</span>
          <button
            className="landing-send-btn"
            onClick={submit}
            disabled={(!input.trim() && attachments.length === 0) || isAgentBusy}
          >
            {isAgentBusy ? (
              <span className="landing-spinner" />
            ) : (
              'Build →'
            )}
          </button>
        </div>
      </div>

    </div>
    {previewImg && createPortal(
      <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }} onClick={() => setPreviewImg(null)}>
        <img src={previewImg} alt="Preview" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8, boxShadow: '0 8px 40px rgba(0,0,0,0.6)', objectFit: 'contain' }} onClick={e => e.stopPropagation()} />
      </div>,
      document.body
    )}
    {ctxMenu && createPortal(

      <>
        <div style={{ position: 'fixed', inset: 0, zIndex: 99998 }} onClick={() => setCtxMenu(null)} />
        <div style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 99999, background: 'var(--bg-elevated,#1e1e2e)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '4px 0', minWidth: 140, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', fontSize: 13 }}>
          {([
            { label: 'Paste', icon: '⌘V', action: () => { setCtxMenu(null); textareaRef.current?.focus(); handleSmartPaste() } },
            { label: 'Copy',  icon: '⌘C', action: () => { setCtxMenu(null); const ta = textareaRef.current; if (ta) { const s = ta.value.slice(ta.selectionStart??0, ta.selectionEnd??ta.value.length); if (s) navigator.clipboard.writeText(s).catch(()=>{}) } } },
            { label: 'Cut',   icon: '⌘X', action: () => { setCtxMenu(null); const ta = textareaRef.current; if (!ta) return; ta.focus(); const sel = ta.value.slice(ta.selectionStart??0, ta.selectionEnd??ta.value.length); if (sel) { navigator.clipboard.writeText(sel).catch(()=>{}); document.execCommand('delete') } } },
          ] as const).map(item => (
            <button key={item.label} onClick={item.action} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',padding:'6px 14px',background:'none',border:'none',color:'var(--text-primary,#e2e8f0)',cursor:'pointer',gap:24 }}
              onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,255,255,0.08)')} onMouseLeave={e=>(e.currentTarget.style.background='none')}>
              <span>{item.label}</span><span style={{opacity:0.45,fontSize:11}}>{item.icon}</span>
            </button>
          ))}
        </div>
      </>,
      document.body
    )}
    </>
  )
}
