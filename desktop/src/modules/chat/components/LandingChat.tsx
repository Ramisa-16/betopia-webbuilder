/**
 * LandingChat.tsx
 * Full-screen initial chat view shown before any code is generated.
 * Once the user submits their first prompt it collapses into the workspace.
 */

import { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react'

interface Props {
  isAgentBusy: boolean
  onSend: (text: string) => void
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
  const textareaRef                   = useRef<HTMLTextAreaElement>(null)

  // Auto-focus on mount
  useEffect(() => { textareaRef.current?.focus() }, [])

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [input])

  const submit = useCallback(() => {
    const text = input.trim()
    if (!text || isAgentBusy) return
    onSend(text)
    setInput('')
  }, [input, isAgentBusy, onSend])

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const useSuggestion = (desc: string) => {
    setInput(desc)
    textareaRef.current?.focus()
  }

  return (
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
      <div className="landing-input-wrap">
        <textarea
          ref={textareaRef}
          className="landing-textarea"
          placeholder="Describe the React + Django app you want to build..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={isAgentBusy}
          rows={3}
        />
        <div className="landing-input-footer">
          <span className="landing-hint">Enter to send · Shift+Enter for new line</span>
          <button
            className="landing-send-btn"
            onClick={submit}
            disabled={!input.trim() || isAgentBusy}
          >
            {isAgentBusy ? (
              <span className="landing-spinner" />
            ) : (
              'Build →'
            )}
          </button>
        </div>
      </div>

      {/* Suggestion chips */}
      <div className="landing-suggestions">
        {SUGGESTIONS.map(s => (
          <button
            key={s.title}
            className="landing-suggestion"
            onClick={() => useSuggestion(s.desc)}
            disabled={isAgentBusy}
          >
            <span className="landing-suggestion-icon">{s.icon}</span>
            <div className="landing-suggestion-text">
              <span className="landing-suggestion-title">{s.title}</span>
              <span className="landing-suggestion-desc">{s.desc}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
