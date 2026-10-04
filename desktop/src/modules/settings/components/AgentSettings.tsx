import React, { useState, useEffect } from 'react'
import ThemeSelector from './ThemeSelector'
import { getConfig, saveConfig, getApiKey, setApiKey } from '@/lib/config'
import type { AgentConfig, MCPServer } from '@/lib/config'
import { testMCPServer, type MCPTestResult } from '@/lib/mcp-manager'
import { MCP_PRESET_DATA } from '@/lib/mcp-presets'
import { PROVIDERS, getProvider } from '@/lib/providers'
import { useBetopiaModels } from '@/lib/useConfig'
import { useAgentsStore, newAgentId } from '@/store/agentsStore'
import { useSnippetsStore, newSnippetId } from '@/store/snippetsStore'
import { BUILTIN_AGENTS, type Agent, type AgentIconId } from '@/lib/agents'
import { normalizeHandle, isValidHandle, type Snippet } from '@/lib/snippets'
import { AgentIcon } from '@/modules/ai/components/AgentIcons'
import GeneralSection from './GeneralSection'
import ShortcutsSection from './ShortcutsSection'
import AboutSection from './AboutSection'

type Tab = 'model' | 'agents' | 'general' | 'shortcuts' | 'mcp' | 'behavior' | 'theme' | 'integrations' | 'about'

const ICON_OPTIONS: AgentIconId[] = ['coder', 'architect', 'reviewer', 'security', 'designer', 'spark']
const CUSTOM_LLM_PROVIDERS = PROVIDERS.filter(p => p.id === 'openai' || p.id === 'betopia')

function AgentEditorDialog({ agent, existing, onClose, onSave }: {
  agent: Agent | null; existing: Agent[]; onClose: () => void; onSave: (a: Agent) => void
}) {
  const [draft, setDraft] = useState<Agent | null>(agent)
  useEffect(() => setDraft(agent), [agent])
  if (!draft) return null
  const isNew = !existing.some(a => a.id === draft.id)
  const canSave = draft.name.trim().length > 0 && draft.instructions.trim().length > 0
  return (
    <div className="agent-editor-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="agent-editor-dialog">
        <div className="agent-editor-title">{isNew ? 'New agent' : 'Edit agent'}</div>
        <div className="agent-editor-field">
          <label className="agent-editor-label">Icon</label>
          <div className="icon-picker">
            {ICON_OPTIONS.map(id => (
              <button key={id} type="button" className={`icon-picker-btn${draft.icon === id ? ' selected' : ''}`}
                onClick={() => setDraft({ ...draft, icon: id })}>
                <AgentIcon icon={id} size={13} />
              </button>
            ))}
          </div>
        </div>
        <div className="agent-editor-field">
          <label className="agent-editor-label">Name</label>
          <input className="agent-editor-input" value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Test Engineer" />
        </div>
        <div className="agent-editor-field">
          <label className="agent-editor-label">Description</label>
          <input className="agent-editor-input" value={draft.description}
            onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="One line — shown in the agent picker" />
        </div>
        <div className="agent-editor-field">
          <label className="agent-editor-label">Instructions</label>
          <textarea className="agent-editor-textarea" value={draft.instructions}
            onChange={e => setDraft({ ...draft, instructions: e.target.value })}
            placeholder="Persona & rules. Appended to Betopia's core system prompt." rows={6} />
        </div>
        <div className="agent-editor-footer">
          <button className="agent-editor-cancel" onClick={onClose}>Cancel</button>
          <button className="agent-editor-save" disabled={!canSave}
            onClick={() => onSave({ ...draft, builtIn: false })}>Save</button>
        </div>
      </div>
    </div>
  )
}

// â"€â"€ Snippet Editor Dialog â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

function SnippetEditorDialog({ snippet, existing, onClose, onSave }: {
  snippet: Snippet | null; existing: Snippet[]; onClose: () => void; onSave: (s: Snippet) => void
}) {
  const [draft, setDraft] = useState<Snippet | null>(snippet)
  useEffect(() => setDraft(snippet), [snippet])
  if (!draft) return null
  const handleErr = !draft.handle ? 'Required.'
    : !isValidHandle(draft.handle) ? 'Lowercase letters, digits, dashes only.'
    : existing.some(s => s.id !== draft.id && s.handle === draft.handle) ? 'Already in use.'
    : null
  const canSave = !handleErr && draft.name.trim().length > 0 && draft.content.trim().length > 0
  const isEdit = existing.some(s => s.id === draft.id)
  return (
    <div className="agent-editor-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="agent-editor-dialog">
        <div className="agent-editor-title">{isEdit ? 'Edit snippet' : 'New snippet'}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="agent-editor-field" style={{ width: 130 }}>
            <label className="agent-editor-label">Handle</label>
            <div className="handle-input-wrap">
              <span className="handle-prefix">#</span>
              <input className="agent-editor-input handle-input" value={draft.handle}
                onChange={e => setDraft({ ...draft, handle: normalizeHandle(e.target.value) })}
                placeholder="review" style={{ width: '100%' }} />
            </div>
            {handleErr && <span className="agent-editor-hint">{handleErr}</span>}
          </div>
          <div className="agent-editor-field" style={{ flex: 1 }}>
            <label className="agent-editor-label">Name</label>
            <input className="agent-editor-input" value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Pre-merge review checklist" />
          </div>
        </div>
        <div className="agent-editor-field">
          <label className="agent-editor-label">Description</label>
          <input className="agent-editor-input" value={draft.description}
            onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="One line — shown in the # picker" />
        </div>
        <div className="agent-editor-field">
          <label className="agent-editor-label">Content</label>
          <textarea className="agent-editor-textarea mono" value={draft.content}
            onChange={e => setDraft({ ...draft, content: e.target.value })}
            placeholder="Inserted into the prompt as a <snippet> block when you use #handle." rows={6} />
        </div>
        <div className="agent-editor-footer">
          <button className="agent-editor-cancel" onClick={onClose}>Cancel</button>
          <button className="agent-editor-save" disabled={!canSave} onClick={() => onSave(draft)}>Save</button>
        </div>
      </div>
    </div>
  )
}

// â"€â"€ Agents Tab â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

function AgentsTab() {
  const customAgents = useAgentsStore(s => s.customAgents)
  const activeId     = useAgentsStore(s => s.activeId)
  const setActiveId  = useAgentsStore(s => s.setActiveId)
  const upsert       = useAgentsStore(s => s.upsert)
  const remove       = useAgentsStore(s => s.remove)

  const snippets     = useSnippetsStore(s => s.snippets)
  const upsertSnip   = useSnippetsStore(s => s.upsert)
  const removeSnip   = useSnippetsStore(s => s.remove)

  const [editingAgent, setEditingAgent]     = useState<Agent | null>(null)
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null)
  const [customInstructions, setCustomInstructions] = useState(() => {
    try { return localStorage.getItem('betopia:custom-instructions') ?? '' } catch { return '' }
  })

  const allAgents = [...BUILTIN_AGENTS, ...customAgents]

  return (
    <div className="agents-section">
      {/* Custom instructions */}
      <div className="custom-instructions-block">
        <div className="custom-instructions-header">
          <span className="agents-label">Custom Instructions</span>
          <button className="custom-instructions-save" onClick={() => {
            try { localStorage.setItem('betopia:custom-instructions', customInstructions) } catch {}
          }}>Save</button>
        </div>
        <textarea className="agent-editor-textarea" value={customInstructions}
          onChange={e => setCustomInstructions(e.target.value)}
          placeholder="e.g. Always reply in concise bullet points. Prefer TypeScript. My project uses React frontend and Django backend."
          rows={3} />
      </div>

      {/* Agents grid */}
      <div>
        <div className="agents-row">
          <span className="agents-label">Agents</span>
          <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
            onClick={() => setEditingAgent({ id: newAgentId(), name: 'New agent', description: '', instructions: '', icon: 'coder', builtIn: false })}>
            + New agent
          </button>
        </div>
        <div className="agents-grid">
          {allAgents.map(a => (
            <div key={a.id} className={`agent-card${a.id === activeId ? ' active' : ''}`}>
              <div className="agent-card-head">
                <div className="agent-card-icon"><AgentIcon icon={a.icon} size={14} /></div>
                <div className="agent-card-meta">
                  <span className="agent-card-name">
                    {a.name}
                    {a.builtIn && <span className="agent-card-badge">Built-in</span>}
                  </span>
                  <span className="agent-card-desc">{a.description}</span>
                </div>
              </div>
              <div className="agent-card-actions">
                <button className={`agent-card-use${a.id === activeId ? ' active-btn' : ''}`}
                  onClick={() => setActiveId(a.id)}>
                  {a.id === activeId ? (
                    <><svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="2,5 4.5,7.5 8.5,2.5" /></svg>Active</>
                  ) : 'Use agent'}
                </button>
                <div className="agent-card-btns">
                  {!a.builtIn && (
                    <button className="agent-icon-btn" title="Edit" onClick={() => setEditingAgent(a)}>
                      <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M9.5 2.5l2 2L5 11H3V9l6.5-6.5z" />
                      </svg>
                    </button>
                  )}
                  {!a.builtIn && (
                    <button className="agent-icon-btn danger" title="Delete" onClick={() => remove(a.id)}>
                      <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <polyline points="2,4 12,4" /><path d="M5 4V2h4v2" /><path d="M3 4l1 8h6l1-8" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Snippets */}
      <div>
        <div className="agents-row">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="agents-label">Snippets</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
              Reusable instructions inserted via <code style={{ fontFamily: 'var(--mono)', background: 'var(--surface-3)', padding: '1px 5px', borderRadius: 3 }}>#handle</code> in chat
            </span>
          </div>
          <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
            onClick={() => setEditingSnippet({ id: newSnippetId(), handle: '', name: '', description: '', content: '' })}>
            + New snippet
          </button>
        </div>
        {snippets.length === 0 ? (
          <div className="snippets-empty">
            No snippets yet. Create one and insert it with <code>#handle</code> in the AI input.
          </div>
        ) : (
          <div className="snippets-list">
            {snippets.map(s => (
              <div key={s.id} className="snippet-row">
                <code className="snippet-row-handle">#{s.handle}</code>
                <div className="snippet-row-info">
                  <span className="snippet-row-name">{s.name}</span>
                  {s.description && <span className="snippet-row-desc">{s.description}</span>}
                </div>
                <button className="agent-icon-btn" title="Edit" onClick={() => setEditingSnippet(s)}>
                  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M9.5 2.5l2 2L5 11H3V9l6.5-6.5z" />
                  </svg>
                </button>
                <button className="agent-icon-btn danger" title="Delete" onClick={() => removeSnip(s.id)}>
                  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <polyline points="2,4 12,4" /><path d="M5 4V2h4v2" /><path d="M3 4l1 8h6l1-8" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <AgentEditorDialog agent={editingAgent} existing={customAgents}
        onClose={() => setEditingAgent(null)} onSave={a => { upsert(a); setEditingAgent(null) }} />
      <SnippetEditorDialog snippet={editingSnippet} existing={snippets}
        onClose={() => setEditingSnippet(null)} onSave={s => { upsertSnip(s); setEditingSnippet(null) }} />
    </div>
  )
}

interface Props { onClose: () => void; initialTab?: string }

function uid() { return Math.random().toString(36).slice(2, 10) }

// ── MCP Preset gallery ────────────────────────────────────────────────────────

/* Brand SVG logos for preset cards */
const MCP_LOGOS: Record<string, React.ReactNode> = {
  Figma: (
    <svg viewBox="0 0 38 57" width="26" height="26" fill="none">
      <path d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" fill="#1ABCFE"/>
      <path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5A9.5 9.5 0 0 1 0 47.5z" fill="#0ACF83"/>
      <path d="M19 0v19h9.5a9.5 9.5 0 0 0 0-19H19z" fill="#FF7262"/>
      <path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" fill="#F24E1E"/>
      <path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" fill="#A259FF"/>
    </svg>
  ),
  GitHub: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
    </svg>
  ),
  Filesystem: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4.17a2 2 0 0 1 1.42.59l1.41 1.41A2 2 0 0 0 13.41 7H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
      <line x1="9" y1="13" x2="15" y2="13"/>
    </svg>
  ),
  PostgreSQL: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M12 2C8.5 2 5.5 4.5 5.5 8c0 1.4.5 2.7 1.3 3.7-.5.6-.8 1.4-.8 2.3 0 1.6.9 3 2.2 3.7-.1.4-.2.9-.2 1.3 0 1.7 1.3 3 3 3s3-1.3 3-3c0-.4-.1-.9-.2-1.3 1.3-.7 2.2-2.1 2.2-3.7 0-.9-.3-1.7-.8-2.3.8-1 1.3-2.3 1.3-3.7C18.5 4.5 15.5 2 12 2zm0 2c2.5 0 4.5 1.8 4.5 4 0 1-.4 2-1 2.7-1-.5-2.2-.7-3.5-.7s-2.5.2-3.5.7c-.6-.7-1-1.7-1-2.7C7.5 5.8 9.5 4 12 4zm0 8c1 0 2 .2 2.8.5.1.5.2 1 .2 1.5 0 1.7-1.3 3-3 3s-3-1.3-3-3c0-.5.1-1 .2-1.5.8-.3 1.8-.5 2.8-.5zm-1 8c0 .6-.4 1-1 1s-1-.4-1-1 .4-1 1-1 1 .4 1 1zm2 0c0 .6-.4 1-1 1s-1-.4-1-1 .4-1 1-1 1 .4 1 1z"/>
    </svg>
  ),
  'Brave Search': (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M20.09 7.39l-1.25-3.06A1.53 1.53 0 0 0 17.42 3.3l-5.4 1.41L6.6 3.3a1.53 1.53 0 0 0-1.42 1.03L3.91 7.39c-.58 1.41-.3 3.06.77 4.2l3.48 3.77c-.07.32-.12.65-.12.99 0 2.18 1.77 3.95 3.96 3.95s3.96-1.77 3.96-3.95c0-.34-.05-.67-.12-.99l3.48-3.77c1.07-1.14 1.35-2.79.77-4.2zM12 18.3c-1.1 0-1.98-.88-1.98-1.97S10.9 14.37 12 14.37s1.98.88 1.98 1.96S13.1 18.3 12 18.3zm5.46-7.27l-2.87 3.11a4.04 4.04 0 0 0-5.18 0L6.54 11.03a2.58 2.58 0 0 1-.52-2.85l1.04-2.57 4.94 1.29 4.94-1.29 1.04 2.57a2.58 2.58 0 0 1-.52 2.85z"/>
    </svg>
  ),
  Puppeteer: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="12" cy="12" r="4"/>
      <line x1="12" y1="2" x2="12" y2="8"/>
      <line x1="12" y1="16" x2="12" y2="22"/>
      <line x1="2" y1="12" x2="8" y2="12"/>
      <line x1="16" y1="12" x2="22" y2="12"/>
    </svg>
  ),
  Memory: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2"/>
      <path d="M6 6V4M10 6V4M14 6V4M18 6V4M6 18v2M10 18v2M14 18v2M18 18v2"/>
      <rect x="6" y="10" width="3" height="4" rx="0.5"/>
      <rect x="11" y="10" width="3" height="4" rx="0.5"/>
    </svg>
  ),
  Slack: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
      <path d="M5.76 14.72a2.88 2.88 0 1 1-2.88-2.88h2.88v2.88z" fill="#E01E5A"/>
      <path d="M7.2 14.72a2.88 2.88 0 0 1 5.76 0v7.2a2.88 2.88 0 1 1-5.76 0v-7.2z" fill="#E01E5A"/>
      <path d="M10.08 5.76a2.88 2.88 0 1 1 2.88-2.88v2.88h-2.88z" fill="#36C5F0"/>
      <path d="M10.08 7.2a2.88 2.88 0 0 1 0 5.76H2.88a2.88 2.88 0 1 1 0-5.76h7.2z" fill="#36C5F0"/>
      <path d="M19.04 10.08a2.88 2.88 0 1 1 2.88 2.88h-2.88v-2.88z" fill="#2EB67D"/>
      <path d="M17.6 10.08a2.88 2.88 0 0 1-5.76 0V2.88a2.88 2.88 0 1 1 5.76 0v7.2z" fill="#2EB67D"/>
      <path d="M14.72 19.04a2.88 2.88 0 1 1-2.88 2.88v-2.88h2.88z" fill="#ECB22E"/>
      <path d="M14.72 17.6a2.88 2.88 0 0 1 0-5.76h7.2a2.88 2.88 0 1 1 0 5.76h-7.2z" fill="#ECB22E"/>
    </svg>
  ),
  Notion: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466l1.823 1.447zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933l3.222-.187z"/>
    </svg>
  ),
  Linear: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M3.5 17.5L17.5 3.5M3.5 17.5h5M3.5 17.5v-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <path d="M10 3.5h10.5V14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  ),
}

interface MCPPreset {
  name: string
  desc: string
  category: string
  icon: string
  color: string
  partial: Partial<MCPServer>
  envKeys: string[]
}

// UI metadata (icon + color) keyed by preset name
const PRESET_UI: Record<string, { icon: string; color: string }> = {
  'Figma':       { icon: 'F',  color: '#a259ff' },
  'GitHub':      { icon: 'GH', color: '#4078c0' },
  'Filesystem':  { icon: 'FS', color: '#3b82f6' },
  'PostgreSQL':  { icon: 'PG', color: '#336791' },
  'Brave Search':{ icon: 'B',  color: '#fb542b' },
  'Puppeteer':   { icon: 'PP', color: '#00a8e8' },
  'Memory':      { icon: 'M',  color: '#f59e0b' },
  'Slack':       { icon: 'SL', color: '#611f69' },
  'Notion':      { icon: 'N',  color: '#37352f' },
  'Linear':      { icon: 'LN', color: '#5e6ad2' },
}

const FEATURED_MCPS: MCPPreset[] = MCP_PRESET_DATA.map(p => ({
  ...p,
  ...(PRESET_UI[p.name] ?? { icon: p.name.slice(0, 2).toUpperCase(), color: '#6366f1' }),
}))

const PRESET_COLORS = ['#6366f1','#3b82f6','#0ea5e9','#14b8a6','#22c55e','#f59e0b','#ef4444','#ec4899','#a855f7']

function serverIconColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PRESET_COLORS[h % PRESET_COLORS.length]
}

function serverInitials(name: string): string {
  return name.replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || name.slice(0, 2).toUpperCase()
}

// ── MCP Edit Form ─────────────────────────────────────────────────────────────

interface MCPFormProps {
  initial?: Partial<MCPServer>
  onSave: (s: MCPServer) => void
  onCancel: () => void
}

function MCPForm({ initial, onSave, onCancel }: MCPFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<MCPServer['type']>(initial?.type ?? 'stdio')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [argsText, setArgsText] = useState((initial?.args ?? []).join('\n'))
  const [envText, setEnvText] = useState(
    Object.entries(initial?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  )
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headersText, setHeadersText] = useState(
    Object.entries(initial?.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
  )
  const [timeout, setTimeout_] = useState(String(initial?.timeout ?? 15))
  const [error, setError] = useState('')
  const [testResult, setTestResult] = useState<(MCPTestResult & { testing?: boolean }) | null>(null)

  const parseKV = (text: string, sep: string): Record<string, string> => {
    const r: Record<string, string> = {}
    for (const rawLine of text.split('\n')) {
      let t = rawLine.trim(); if (!t) continue
      // Auto-detect bare known API tokens missing KEY= prefix
      if (sep === '=' && !t.includes('=')) {
        if (/^figd_/.test(t)) t = `FIGMA_API_KEY=${t}`
        else if (/^sk-/.test(t)) t = `OPENAI_API_KEY=${t}`
        else if (/^ghp_|^github_pat_/.test(t)) t = `GITHUB_PERSONAL_ACCESS_TOKEN=${t}`
        else continue
      }
      const idx = t.indexOf(sep); if (idx === -1) continue
      r[t.slice(0, idx).trim()] = t.slice(idx + sep.length).trim()
    }
    return r
  }

  const buildServer = (): MCPServer => {
    const s: MCPServer = { id: initial?.id ?? uid(), name: name.trim(), type, disabled: initial?.disabled ?? false, timeout: Number(timeout) || 15 }
    if (type === 'stdio') {
      s.command = command.trim()
      s.args = argsText.split('\n').map(l => l.trim()).filter(Boolean)
      s.env = parseKV(envText, '=')
    } else {
      s.url = url.trim()
      s.headers = parseKV(headersText, ':')
    }
    return s
  }

  const isValid = () => {
    if (!name.trim()) return false
    if (type === 'stdio' && !command.trim()) return false
    if ((type === 'sse' || type === 'http' || type === 'json') && !url.trim()) return false
    return true
  }

  const handleTest = async () => {
    if (!isValid()) { setError('Fill all required fields to test'); return }
    setError('')
    setTestResult({ testing: true, ok: false, toolCount: 0 })
    const result = await testMCPServer(buildServer())
    setTestResult({ ...result, testing: false })
  }

  const submit = () => {
    if (!name.trim()) { setError('Name required'); return }
    if (type === 'stdio' && !command.trim()) { setError('Command required for stdio'); return }
    if ((type === 'sse' || type === 'http' || type === 'json') && !url.trim()) { setError('URL required'); return }
    setError('')
    onSave(buildServer())
  }

  const isEdit = !!initial?.id

  return (
    <div className="mcp-edit-box">
      <div className="mcp-form-header">
        <button className="mcp-form-back" onClick={onCancel} title="Back">←</button>
        <div>
          <div className="mcp-form-title">{isEdit ? `Edit: ${initial?.name ?? ''}` : 'Configure MCP Server'}</div>
          <div className="mcp-form-subtitle">
            {type === 'stdio' ? 'Runs a local process (npx, node, python…)' : 'Connects over the network (http / sse / json-rpc)'}
          </div>
        </div>
      </div>

      <div className="mcp-form">
        <div className="settings-field">
          <label className="settings-label">Name</label>
          <input className="settings-input" value={name} onChange={e => setName(e.target.value)} placeholder="my-mcp-server" />
        </div>
        <div className="settings-field">
          <label className="settings-label">Type</label>
          <div className="settings-radio-group">
            {(['stdio', 'sse', 'http', 'json'] as const).map(t => (
              <button key={t} className={`settings-radio${type === t ? ' active' : ''}`} onClick={() => setType(t)}>{t}</button>
            ))}
          </div>
        </div>
        {type === 'stdio' ? (
          <>
            <div className="settings-field">
              <label className="settings-label">Command</label>
              <input className="settings-input" value={command} onChange={e => setCommand(e.target.value)} placeholder="npx" />
            </div>
            <div className="settings-field">
              <label className="settings-label">Arguments <span className="settings-hint-inline">(one per line)</span></label>
              <textarea className="settings-textarea" value={argsText} onChange={e => setArgsText(e.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/home/user'} rows={3} />
            </div>
            <div className="settings-field">
              <label className="settings-label">Environment <span className="settings-hint-inline">(KEY=VALUE per line)</span></label>
              <textarea className="settings-textarea" value={envText} onChange={e => setEnvText(e.target.value)} placeholder="API_KEY=abc123" rows={2} />
            </div>
          </>
        ) : (
          <>
            <div className="settings-field">
              <label className="settings-label">URL</label>
              <input className="settings-input" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:3000" />
            </div>
            <div className="settings-field">
              <label className="settings-label">Headers <span className="settings-hint-inline">(Key: Value per line)</span></label>
              <textarea className="settings-textarea" value={headersText} onChange={e => setHeadersText(e.target.value)} placeholder="Authorization: Bearer token" rows={2} />
            </div>
          </>
        )}
        <div className="settings-field">
          <label className="settings-label">Timeout (seconds)</label>
          <input className="settings-input" style={{ width: 90 }} value={timeout} onChange={e => setTimeout_(e.target.value)} type="number" min={1} max={300} />
        </div>

        {testResult && !testResult.testing && (
          <div className={`mcp-test-banner ${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.ok
              ? `✓ Connected — ${testResult.toolCount} tool${testResult.toolCount !== 1 ? 's' : ''} available`
              : `✗ ${testResult.error ?? 'Connection failed'}`}
          </div>
        )}

        {error && <p style={{ fontSize: 12, color: 'var(--red)', margin: 0 }}>{error}</p>}

        <div className="mcp-form-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-ghost" onClick={handleTest} disabled={testResult?.testing} data-testid="mcp-test-btn">
            {testResult?.testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn-primary" onClick={submit}>{isEdit ? 'Update' : 'Add server'}</button>
        </div>
      </div>
    </div>
  )
}

// â"€â"€ Model Tab â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

interface ModelTabProps {
  cfg: AgentConfig
  onChange: (m: AgentConfig['model']) => void
}

function ModelTab({ cfg, onChange }: ModelTabProps) {
  const [providerId, setProviderId] = useState(cfg.model.providerId ?? 'openai')
  const [apiKey, setApiKeyState] = useState('')
  const [model, setModel] = useState(cfg.model.model ?? '')
  const [customBaseUrl, setCustomBaseUrl] = useState(cfg.model.customBaseUrl ?? '')
  const [temperature, setTemperature] = useState(cfg.model.temperature !== undefined ? String(cfg.model.temperature) : '')
  const [maxTokens, setMaxTokens] = useState(cfg.model.maxTokens !== undefined ? String(cfg.model.maxTokens) : '')
  const [topP, setTopP] = useState(cfg.model.topP !== undefined ? String(cfg.model.topP) : '')
  const [thinkingMode, setThinkingMode] = useState(cfg.model.thinkingMode ?? false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const { models: betopiaModels, loading: fetchingBetopiaModels } = useBetopiaModels()

  const provider = getProvider(providerId) ?? CUSTOM_LLM_PROVIDERS[0] ?? PROVIDERS[0]
  const modelOptions = providerId === 'betopia' && betopiaModels.length > 0 ? betopiaModels : (provider?.models ?? [])

  useEffect(() => {
    setProviderId(cfg.model.providerId ?? 'openai')
    setModel(cfg.model.model ?? '')
    setCustomBaseUrl(cfg.model.customBaseUrl ?? '')
    setTemperature(cfg.model.temperature !== undefined ? String(cfg.model.temperature) : '')
    setMaxTokens(cfg.model.maxTokens !== undefined ? String(cfg.model.maxTokens) : '')
    setTopP(cfg.model.topP !== undefined ? String(cfg.model.topP) : '')
    setThinkingMode(cfg.model.thinkingMode ?? false)
  }, [cfg.model.providerId, cfg.model.model, cfg.model.customBaseUrl, cfg.model.temperature, cfg.model.maxTokens, cfg.model.topP, cfg.model.thinkingMode])

  useEffect(() => {
    let active = true
    getApiKey(providerId).then(k => {
      if (active) setApiKeyState(k)
    }).catch(() => {
      if (active) setApiKeyState('')
    })
    return () => { active = false }
  }, [providerId])

  const persist = (next: Partial<AgentConfig['model']> = {}) => {
    const nextProviderId = next.providerId ?? providerId
    const nextModel = next.model ?? model
    const nextBaseUrl = next.customBaseUrl !== undefined ? next.customBaseUrl : customBaseUrl
    const nextTemperature = next.temperature !== undefined ? next.temperature : (temperature !== '' ? Number(temperature) : undefined)
    const nextMaxTokens = next.maxTokens !== undefined ? next.maxTokens : (maxTokens !== '' ? Number(maxTokens) : undefined)
    const nextTopP = next.topP !== undefined ? next.topP : (topP !== '' ? Number(topP) : undefined)
    const nextThinkingMode = next.thinkingMode ?? thinkingMode
    const nextApiKeys = { ...cfg.model.apiKeys, ...(next.apiKeys ?? {}) }
    const keyToSave = next.apiKeys && Object.prototype.hasOwnProperty.call(next.apiKeys, nextProviderId)
      ? next.apiKeys[nextProviderId]
      : apiKey

    if (keyToSave) nextApiKeys[nextProviderId] = keyToSave
    else delete nextApiKeys[nextProviderId]

    onChange({
      ...cfg.model,
      ...next,
      providerId: nextProviderId,
      model: nextModel,
      customBaseUrl: nextBaseUrl.trim() ? nextBaseUrl.trim() : undefined,
      apiKeys: nextApiKeys,
      temperature: nextTemperature,
      maxTokens: nextMaxTokens,
      topP: nextTopP,
      thinkingMode: nextThinkingMode,
    })
  }

  const handleProviderChange = async (nextProviderId: string) => {
    const nextProvider = getProvider(nextProviderId) ?? PROVIDERS.find(p => p.id === nextProviderId) ?? provider
    const nextModels = nextProviderId === 'betopia' && betopiaModels.length > 0 ? betopiaModels : (nextProvider?.models ?? [])
    const nextModel = nextModels.some(m => m.id === model) ? model : (nextModels[0]?.id ?? model)
    const nextKey = await getApiKey(nextProviderId).catch(() => '')

    setProviderId(nextProviderId)
    setModel(nextModel)
    setCustomBaseUrl('')
    setApiKeyState(nextKey)

    const nextApiKeys = { ...cfg.model.apiKeys }
    if (nextKey) nextApiKeys[nextProviderId] = nextKey
    else delete nextApiKeys[nextProviderId]

    onChange({
      ...cfg.model,
      providerId: nextProviderId,
      model: nextModel,
      customBaseUrl: undefined,
      apiKeys: nextApiKeys,
      temperature: temperature !== '' ? Number(temperature) : undefined,
      maxTokens: maxTokens !== '' ? Number(maxTokens) : undefined,
      topP: topP !== '' ? Number(topP) : undefined,
      thinkingMode,
    })
  }

  const handleSetKey = (k: string) => {
    setApiKeyState(k)
    setApiKey(providerId, k).catch(() => {})
    persist({ apiKeys: { [providerId]: k } })
  }

  const handleSetModel = (nextModel: string) => {
    setModel(nextModel)
    persist({ model: nextModel })
  }

  const handleSetBaseUrl = (value: string) => {
    setCustomBaseUrl(value)
    persist({ customBaseUrl: value })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="settings-section">
        <div className="settings-section-title">Custom LLM</div>
        <div className="provider-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', marginBottom: 14 }}>
          {CUSTOM_LLM_PROVIDERS.map(p => (
            <button
              key={p.id}
              type="button"
              className={`provider-card${providerId === p.id ? ' active' : ''}`}
              onClick={() => handleProviderChange(p.id)}
            >
              <span className="provider-card-name">{p.name}</span>
              <span className="provider-card-desc">{p.description}</span>
              <span className="provider-card-desc" style={{ fontFamily: 'var(--mono)' }}>{p.baseUrl}</span>
            </button>
          ))}
        </div>

        <div className="settings-field">
          <label className="settings-label">Provider base URL</label>
          <input
            className="settings-input"
            value={customBaseUrl}
            onChange={e => handleSetBaseUrl(e.target.value)}
            placeholder={provider.baseUrl}
          />
          <span className="settings-hint">Leave blank to use the default endpoint for {provider.shortName ?? provider.name}.</span>
        </div>

        <div className="settings-field">
          <div className="settings-label" style={{ marginBottom: 6 }}>Model</div>
          {providerId === 'betopia' && fetchingBetopiaModels && (
            <div className="settings-hint" style={{ marginBottom: 8 }}>Fetching Betopia models...</div>
          )}

          {modelOptions.length > 0 && (
            <div className="model-list">
              {modelOptions.map(m => (
                <button
                  key={m.id}
                  type="button"
                  className={`model-card${model === m.id ? ' active' : ''}`}
                  onClick={() => handleSetModel(m.id)}
                >
                  <div className="model-card-header">
                    <span className="model-card-name">{m.name}</span>
                    {m.supportsThinking && <span className="model-badge think">thinking</span>}
                  </div>
                  {m.description && <span className="model-card-desc">{m.description}</span>}
                  <span className="model-card-id">{m.id}</span>
                </button>
              ))}
            </div>
          )}

          {provider.allowCustomModel && (
            <div className="settings-field" style={{ marginTop: 10 }}>
              <label className="settings-label">Or type a custom model ID</label>
              <input
                className="settings-input"
                value={model}
                onChange={e => handleSetModel(e.target.value)}
                placeholder={providerId === 'openai' ? 'gpt-4.1-mini' : 'model-id'}
              />
            </div>
          )}
        </div>

        <div className="settings-field">
          <label className="settings-label">{provider.shortName ?? provider.name} API Key</label>
          <input
            className="settings-input"
            type="password"
            value={apiKey}
            onChange={e => handleSetKey(e.target.value)}
            placeholder={providerId === 'openai' ? 'sk-...' : `Your ${provider.shortName ?? provider.name} API key`}
          />
          <span className="settings-hint">Stored in OS keychain and local config. The builder uses this key for chat and generation.</span>
        </div>
      </div>

      <div className="settings-section">
        <button
          className="settings-advanced-toggle"
          onClick={() => setShowAdvanced(v => !v)}
        >
          <span>{showAdvanced ? 'v' : '>'} Advanced Parameters</span>
          {(temperature || maxTokens || topP || thinkingMode) && (
            <span className="settings-badge">configured</span>
          )}
        </button>

        {showAdvanced && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
            <div className="settings-row">
              <div className="settings-field">
                <label className="settings-label">Temperature</label>
                <input className="settings-input" value={temperature} onChange={e => { setTemperature(e.target.value); persist({ temperature: e.target.value !== '' ? Number(e.target.value) : undefined }) }} type="number" step="0.1" min={0} max={2} placeholder="default" />
                <span className="settings-hint">0 = deterministic · 2 = creative</span>
              </div>
              <div className="settings-field">
                <label className="settings-label">Max Tokens</label>
                <input className="settings-input" value={maxTokens} onChange={e => { setMaxTokens(e.target.value); persist({ maxTokens: e.target.value !== '' ? Number(e.target.value) : undefined }) }} type="number" min={1} max={200000} placeholder="default" />
              </div>
              <div className="settings-field">
                <label className="settings-label">Top P</label>
                <input className="settings-input" value={topP} onChange={e => { setTopP(e.target.value); persist({ topP: e.target.value !== '' ? Number(e.target.value) : undefined }) }} type="number" step="0.05" min={0} max={1} placeholder="default" />
              </div>
            </div>

            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Thinking Mode</span>
                <span className="settings-toggle-desc">Extended reasoning before answering (works best with reasoning-capable models).</span>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={thinkingMode} onChange={e => { setThinkingMode(e.target.checked); persist({ thinkingMode: e.target.checked }) }} />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Integrations Tab ──────────────────────────────────────────────────────────

type IntegrationProvider = 'github' | 'gitlab'

function IntegrationsTab() {
  const [provider, setProvider] = useState<IntegrationProvider>('github')
  const [ghConnected, setGhConnected] = useState(() => localStorage.getItem('betopia_gh') === '1')
  const [glConnected, setGlConnected] = useState(() => localStorage.getItem('betopia_gl') === '1')
  const [ghRepo, setGhRepo] = useState(() => localStorage.getItem('betopia_gh_repo') ?? '')
  const [glRepo, setGlRepo] = useState(() => localStorage.getItem('betopia_gl_repo') ?? '')

  const isGH = provider === 'github'
  const connected = isGH ? ghConnected : glConnected
  const repo = isGH ? ghRepo : glRepo
  const providerLabel = isGH ? 'GitHub' : 'GitLab'

  const setRepo = (v: string) => {
    if (isGH) { setGhRepo(v); localStorage.setItem('betopia_gh_repo', v) }
    else { setGlRepo(v); localStorage.setItem('betopia_gl_repo', v) }
  }
  const connect = () => {
    const url = isGH ? 'https://github.com/new' : 'https://gitlab.com/projects/new'
    if (isGH) { localStorage.setItem('betopia_gh', '1'); setGhConnected(true) }
    else { localStorage.setItem('betopia_gl', '1'); setGlConnected(true) }
    window.open(url, '_blank', 'noopener')
  }
  const disconnect = () => {
    if (isGH) { localStorage.removeItem('betopia_gh'); setGhConnected(false) }
    else { localStorage.removeItem('betopia_gl'); setGlConnected(false) }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title">Git Integrations</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {(['github', 'gitlab'] as IntegrationProvider[]).map(p => (
          <button
            key={p}
            className={'settings-tab' + (provider === p ? ' active' : '')}
            style={{ fontSize: 12 }}
            onClick={() => setProvider(p)}
          >
            {p === 'github' ? 'GitHub' : 'GitLab'}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label className="settings-label">Repository name</label>
          <input
            className="settings-input"
            value={repo}
            onChange={e => setRepo(e.target.value)}
            placeholder={isGH ? 'username/repo-name' : 'group/repo-name'}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" onClick={connect} style={{ flex: 1 }}>
            {connected ? 'Re-connect ' + providerLabel : 'Connect ' + providerLabel}
          </button>
          {connected && (
            <button className="btn-danger" onClick={disconnect} style={{ flex: 1 }}>
              Disconnect
            </button>
          )}
        </div>
        {connected && (
          <p style={{ fontSize: 11, color: 'var(--text-3)', margin: 0 }}>
            {'Connected to ' + providerLabel}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Main Settings Panel ───────────────────────────────────────────────────────

export default function AgentSettings({ onClose, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>((initialTab as Tab) ?? 'model')
  const [cfg, setCfg] = useState<AgentConfig>(() => getConfig())
  const [addingTemplate, setAddingTemplate] = useState<Partial<MCPServer> | null>(null)
  const [editingMCP, setEditingMCP] = useState<MCPServer | null>(null)
  const [saved, setSaved] = useState(false)
  const [mcpTestStates, setMcpTestStates] = useState<Record<string, MCPTestResult & { testing?: boolean }>>({})

  const testMCPItem = async (server: MCPServer) => {
    setMcpTestStates(s => ({ ...s, [server.id]: { testing: true, ok: false, toolCount: 0 } }))
    const result = await testMCPServer(server)
    setMcpTestStates(s => ({ ...s, [server.id]: { ...result, testing: false } }))
  }
  const [importJson, setImportJson] = useState('')
  const [showImportModal, setShowImportModal] = useState(false)

  const [cavemanEnabled, setCavemanEnabled] = useState(cfg.behavior.cavemanEnabled)
  const [cavemanIntensity, setCavemanIntensity] = useState(cfg.behavior.cavemanIntensity)
  const [systemPromptPrefix, setSystemPromptPrefix] = useState(cfg.behavior.systemPromptPrefix)
  const [yoloMode, setYoloMode] = useState(cfg.behavior.yoloMode)
  const [autoAccept, setAutoAccept] = useState(cfg.behavior.autoAccept ?? false)
  const [autoCompact, setAutoCompact] = useState(cfg.behavior.autoCompact ?? true)
  const [autoCompactThreshold, setAutoCompactThreshold] = useState(cfg.behavior.autoCompactThreshold ?? 0.75)
  const [sandboxEnabled, setSandboxEnabled] = useState(cfg.sandbox.enabled)
  const [sandboxEndpoint, setSandboxEndpoint] = useState(cfg.sandbox.endpoint)
  const [sandboxApiKey, setSandboxApiKey] = useState(cfg.sandbox.apiKey)
  const [sandboxImage, setSandboxImage] = useState(cfg.sandbox.image)
  const [sandboxCpuLimit, setSandboxCpuLimit] = useState(String(cfg.sandbox.cpuLimit))
  const [sandboxMemoryMb, setSandboxMemoryMb] = useState(String(cfg.sandbox.memoryMb))
  const [sandboxTimeoutSec, setSandboxTimeoutSec] = useState(String(cfg.sandbox.timeoutSec))
  const [sandboxAllowNetwork, setSandboxAllowNetwork] = useState(cfg.sandbox.allowNetwork)

  const exportMCPServers = () => {
    const mcpConfig = {
      mcpServers: cfg.mcpServers.reduce(
        (acc, s) => {
          acc[s.name] = {
            type: s.type,
            ...(s.command && { command: s.command }),
            ...(s.args && { args: s.args }),
            ...(s.env && { env: s.env }),
            ...(s.url && { url: s.url }),
            ...(s.headers && { headers: s.headers }),
          }
          return acc
        },
        {} as Record<string, any>,
      ),
    }
    const json = JSON.stringify(mcpConfig, null, 2)
    navigator.clipboard.writeText(json)
    alert('MCP configuration copied to clipboard!')
  }

  const importMCPServers = () => {
    try {
      const json = JSON.parse(importJson) as { mcpServers?: Record<string, any> }
      const servers = json.mcpServers ?? json
      let imported = 0

      for (const [name, config] of Object.entries(servers)) {
        const server: MCPServer = {
          id: Math.random().toString(36).slice(2, 10),
          name,
          type: (config as any).type ?? 'http',
          command: (config as any).command,
          args: (config as any).args,
          env: (config as any).env,
          url: (config as any).url,
          headers: (config as any).headers,
          timeout: (config as any).timeout ?? 15,
        }
        setCfg(prev => ({ ...prev, mcpServers: [...prev.mcpServers, server] }))
        imported++
      }

      setImportJson('')
      setShowImportModal(false)
      alert(`Imported ${imported} MCP server(s)!`)
    } catch (err) {
      alert(`Error importing: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleModelChange = (m: AgentConfig['model']) => {
    const next = { ...cfg, model: m }
    setCfg(next)
    saveConfig(next)
  }

  const handleSave = () => {
    const cpuLimit = Number(sandboxCpuLimit)
    const memoryMb = Number(sandboxMemoryMb)
    const timeoutSec = Number(sandboxTimeoutSec)

    const updated: AgentConfig = {
      ...cfg,
      behavior: { cavemanEnabled, cavemanIntensity, systemPromptPrefix, yoloMode, autoAccept, autoCompact, autoCompactThreshold },
      sandbox: {
        enabled: sandboxEnabled,
        endpoint: sandboxEndpoint.trim() || 'http://127.0.0.1:7879',
        apiKey: sandboxApiKey.trim(),
        image: sandboxImage.trim() || 'node:20-alpine',
        cpuLimit: Number.isFinite(cpuLimit) && cpuLimit > 0 ? cpuLimit : 1,
        memoryMb: Number.isFinite(memoryMb) && memoryMb >= 256 ? Math.round(memoryMb) : 1024,
        timeoutSec: Number.isFinite(timeoutSec) && timeoutSec >= 5 ? Math.round(timeoutSec) : 120,
        allowNetwork: sandboxAllowNetwork,
      },
    }
    saveConfig(updated)
    setCfg(updated)
    setSaved(true)
    setTimeout(() => setSaved(false), 1600)
  }

  const addMCP = (s: MCPServer) => {
    setCfg(p => { const n = { ...p, mcpServers: [...p.mcpServers, s] }; saveConfig(n); return n })
    setAddingTemplate(null)
  }
  const updateMCP = (s: MCPServer) => {
    setCfg(p => { const n = { ...p, mcpServers: p.mcpServers.map(m => m.id === s.id ? s : m) }; saveConfig(n); return n })
    setEditingMCP(null)
  }
  const deleteMCP = (id: string) => {
    setCfg(p => { const n = { ...p, mcpServers: p.mcpServers.filter(m => m.id !== id) }; saveConfig(n); return n })
    setMcpTestStates(s => { const c = { ...s }; delete c[id]; return c })
  }
  const toggleMCPDisabled = (id: string) => {
    setCfg(p => { const n = { ...p, mcpServers: p.mcpServers.map(m => m.id === id ? { ...m, disabled: !m.disabled } : m) }; saveConfig(n); return n })
  }

  useEffect(() => {
    const handler = () => setCfg(getConfig())
    window.addEventListener('betopia:config-changed', handler)
    return () => window.removeEventListener('betopia:config-changed', handler)
  }, [])

  // Auto-test all enabled servers when MCP tab is opened
  useEffect(() => {
    if (tab !== 'mcp') return
    const untested = cfg.mcpServers.filter(s => !s.disabled && !mcpTestStates[s.id])
    if (untested.length === 0) return
    untested.forEach(s => testMCPItem(s))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="settings-panel">

        <div className="settings-header">
          <div>
            <div className="settings-title">Agent Settings</div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>Configure AI model, MCP servers, and agent behavior</div>
          </div>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-tabs">
          {([['model', 'Model'], ['integrations', 'Integrations'], ['agents', 'Agents'], ['general', 'General'], ['shortcuts', 'Shortcuts'], ['mcp', 'MCP'], ['behavior', 'Behavior'], ['theme', 'Appearance'], ['about', 'About']] as [Tab, string][]).map(([t, label]) => (
            <button key={t} className={'settings-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>

        <div className="settings-body">

          {tab === 'model'        && <ModelTab cfg={cfg} onChange={handleModelChange} />}
          {tab === 'agents'       && <AgentsTab />}
          {tab === 'general'      && <GeneralSection />}
          {tab === 'shortcuts'    && <ShortcutsSection />}
          {tab === 'integrations' && <IntegrationsTab />}
          {tab === 'about'        && <AboutSection />}

          {tab === 'mcp' && (
            <>
              {/* ── Form mode: adding or editing ── */}
              {(addingTemplate !== null || editingMCP !== null) ? (
                editingMCP ? (
                  <MCPForm initial={editingMCP} onSave={updateMCP} onCancel={() => setEditingMCP(null)} />
                ) : (
                  <MCPForm initial={addingTemplate ?? {}} onSave={addMCP} onCancel={() => setAddingTemplate(null)} />
                )
              ) : (
                /* ── Browse mode: gallery + list ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

                  {/* Popular presets */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <span className="mcp-section-label">Popular integrations</span>
                    </div>
                    <div className="mcp-gallery">
                      {FEATURED_MCPS.map(preset => (
                        <button
                          key={preset.name}
                          className="mcp-preset-card"
                          onClick={() => setAddingTemplate(preset.partial)}
                          type="button"
                        >
                          <div className="mcp-preset-row">
                            <div className="mcp-preset-icon" style={{ background: preset.color + '1a', color: preset.color }}>
                              {MCP_LOGOS[preset.name] ?? preset.icon}
                            </div>
                            <div className="mcp-preset-body">
                              <div className="mcp-preset-name-row">
                                <span className="mcp-preset-name">{preset.name}</span>
                                <span className="mcp-preset-category">{preset.category}</span>
                              </div>
                              <div className="mcp-preset-desc">{preset.desc}</div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Configured servers */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <span className="mcp-section-label">Your servers {cfg.mcpServers.length > 0 && `(${cfg.mcpServers.length})`}</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }} onClick={() => setShowImportModal(true)}>Import</button>
                        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }} onClick={exportMCPServers}>Export</button>
                        <button className="btn-primary" style={{ fontSize: 11, padding: '3px 9px' }} onClick={() => setAddingTemplate({})}>+ Custom</button>
                      </div>
                    </div>

                    {cfg.mcpServers.length === 0 ? (
                      <div className="mcp-empty">
                        <span style={{ fontSize: 26 }}>🔌</span>
                        <span style={{ fontWeight: 500, color: 'var(--text-2)' }}>No servers yet</span>
                        <span>Pick a preset above or add a custom server.</span>
                      </div>
                    ) : (
                      <div className="mcp-list">
                        {cfg.mcpServers.map(s => {
                          const ts = mcpTestStates[s.id]
                          const color = serverIconColor(s.name)
                          const initials = serverInitials(s.name)
                          return (
                            <div key={s.id} className={`mcp-item${s.disabled ? ' mcp-item-disabled' : ''}`}>
                              <div className="mcp-item-icon" style={{ background: color + '22', color }}>
                                {initials}
                              </div>
                              <div className="mcp-item-body">
                                <div className="mcp-item-row1">
                                  <span className="mcp-item-name">{s.name}</span>
                                  <span className="mcp-item-type">{s.type}</span>
                                  {s.disabled
                                    ? <span className="mcp-item-status disabled">Disabled</span>
                                    : ts?.testing
                                      ? <span className="mcp-item-status testing">Testing…</span>
                                      : ts
                                        ? <span className={`mcp-item-status ${ts.ok ? 'ok' : 'err'}`}>
                                            {ts.ok ? `✓ ${ts.toolCount} tools` : '✗ Failed'}
                                          </span>
                                        : <span className="mcp-item-status configured">Configured</span>
                                  }
                                </div>
                                <span className="mcp-item-cmd">{s.type === 'stdio' ? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ') : s.url}</span>
                              </div>
                              <div className="mcp-item-actions">
                                <button className="icon-btn" onClick={() => testMCPItem(s)} title="Test connection" disabled={ts?.testing} data-testid={`mcp-test-${s.id}`}>
                                  {ts?.testing ? '…' : '⚡'}
                                </button>
                                <button className="icon-btn" onClick={() => toggleMCPDisabled(s.id)} title={s.disabled ? 'Enable' : 'Disable'}>{s.disabled ? '▶' : '⏸'}</button>
                                <button className="icon-btn" onClick={() => setEditingMCP(s)} title="Edit">✎</button>
                                <button className="icon-btn danger" onClick={() => deleteMCP(s.id)} title="Delete">✕</button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'behavior' && (
            <>
              <div className="settings-section">
                <div className="settings-section-title">Response Style</div>
                <div className="settings-toggle-row">
                  <div className="settings-toggle-info">
                    <span className="settings-toggle-label">Caveman Mode</span>
                    <span className="settings-toggle-desc">Agent responds with terse, minimal language. Drops filler, articles, and fluff.</span>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={cavemanEnabled} onChange={e => setCavemanEnabled(e.target.checked)} />
                    <span className="toggle-slider" />
                  </label>
                </div>
                {cavemanEnabled && (
                  <div className="settings-field" style={{ marginTop: -6 }}>
                    <label className="settings-label">Intensity</label>
                    <div className="settings-radio-group">
                      {([['lite', 'Keep articles, drop pleasantries'], ['full', 'Fragments OK, short synonyms'], ['ultra', 'Maximum compression']] as const).map(([val, desc]) => (
                        <button key={val} className={`settings-radio${cavemanIntensity === val ? ' active' : ''}`} onClick={() => setCavemanIntensity(val)} title={desc}>{val}</button>
                      ))}
                    </div>
                    <span className="settings-hint">
                      {cavemanIntensity === 'lite' && 'Keep articles. Drop: just/really/basically/certainly/pleasantries.'}
                      {cavemanIntensity === 'full' && 'Drop articles + filler. Fragments OK. Short synonyms (fix not "implement a solution").'}
                      {cavemanIntensity === 'ultra' && 'Maximum compression. Single-word answers where possible. Pure information only.'}
                    </span>
                  </div>
                )}
              </div>

              <div className="settings-section">
                <div className="settings-section-title">System Prompt</div>
                <div className="settings-field">
                  <label className="settings-label">Prefix <span className="settings-hint-inline">(prepended before built-in prompt)</span></label>
                  <textarea className="settings-textarea" value={systemPromptPrefix} onChange={e => setSystemPromptPrefix(e.target.value)} placeholder="You are building a React app. Always use TypeScript. Prefer shadcn/ui components." rows={4} />
                  <span className="settings-hint">Persistent context about your project, stack preferences, or coding style.</span>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">Permissions</div>
                <div className="settings-toggle-row">
                  <div className="settings-toggle-info">
                    <span className="settings-toggle-label">Yolo Mode</span>
                    <span className="settings-toggle-desc">Agent writes all files and runs bash commands freely — no diffs, no confirmations.</span>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={yoloMode} onChange={e => { setYoloMode(e.target.checked); if (e.target.checked) setAutoAccept(false) }} />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="settings-toggle-row">
                  <div className="settings-toggle-info">
                    <span className="settings-toggle-label">Auto Accept</span>
                    <span className="settings-toggle-desc">Agent writes all code first without prompting. Review and accept or reject changes in the editor when done.</span>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={autoAccept} onChange={e => { setAutoAccept(e.target.checked); if (e.target.checked) setYoloMode(false) }} />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="settings-toggle-row">
                  <div className="settings-toggle-info">
                    <span className="settings-toggle-label">Auto Compact</span>
                    <span className="settings-toggle-desc">Automatically summarize and compress the conversation when context usage exceeds the threshold. Prevents inference failures on long sessions.</span>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={autoCompact} onChange={e => setAutoCompact(e.target.checked)} />
                    <span className="toggle-slider" />
                  </label>
                </div>
                {autoCompact && (
                  <div className="settings-field" style={{ paddingTop: 0 }}>
                    <label className="settings-label">
                      Compact threshold — {Math.round(autoCompactThreshold * 100)}% of context window
                    </label>
                    <input
                      type="range" min="0.5" max="0.95" step="0.05"
                      value={autoCompactThreshold}
                      onChange={e => setAutoCompactThreshold(Number(e.target.value))}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                      <span>50%</span><span>75% (default)</span><span>95%</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="settings-section">
                <div className="settings-section-title">Isolated Sandbox</div>
                <div className="settings-toggle-row">
                  <div className="settings-toggle-info">
                    <span className="settings-toggle-label">Run bash in container sandbox</span>
                    <span className="settings-toggle-desc">When enabled, agent bash commands run in an isolated Docker session instead of your host shell.</span>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={sandboxEnabled} onChange={e => setSandboxEnabled(e.target.checked)} />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="settings-field">
                  <label className="settings-label">Sandbox endpoint</label>
                  <input
                    className="settings-input"
                    value={sandboxEndpoint}
                    onChange={e => setSandboxEndpoint(e.target.value)}
                    placeholder="http://127.0.0.1:7879"
                  />
                </div>

                <div className="settings-field">
                  <label className="settings-label">Sandbox API key <span className="settings-hint-inline">(optional)</span></label>
                  <input
                    className="settings-input"
                    value={sandboxApiKey}
                    onChange={e => setSandboxApiKey(e.target.value)}
                    placeholder="Bearer token for sandbox API"
                  />
                </div>

                <div className="settings-field">
                  <label className="settings-label">Container image</label>
                  <input
                    className="settings-input"
                    value={sandboxImage}
                    onChange={e => setSandboxImage(e.target.value)}
                    placeholder="node:20-alpine"
                  />
                </div>

                <div className="settings-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                  <div className="settings-field">
                    <label className="settings-label">CPU</label>
                    <input className="settings-input" type="number" min="0.25" step="0.25" value={sandboxCpuLimit} onChange={e => setSandboxCpuLimit(e.target.value)} />
                  </div>
                  <div className="settings-field">
                    <label className="settings-label">Memory (MB)</label>
                    <input className="settings-input" type="number" min="256" step="128" value={sandboxMemoryMb} onChange={e => setSandboxMemoryMb(e.target.value)} />
                  </div>
                  <div className="settings-field">
                    <label className="settings-label">Timeout (s)</label>
                    <input className="settings-input" type="number" min="5" step="5" value={sandboxTimeoutSec} onChange={e => setSandboxTimeoutSec(e.target.value)} />
                  </div>
                </div>

                <div className="settings-toggle-row">
                  <div className="settings-toggle-info">
                    <span className="settings-toggle-label">Allow outbound network</span>
                    <span className="settings-toggle-desc">Disabled is safer and closer to Claude/ChatGPT-style locked execution.</span>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={sandboxAllowNetwork} onChange={e => setSandboxAllowNetwork(e.target.checked)} />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>
            </>
          )}

          {tab === 'theme' && (
            <div className="settings-section">
              <div className="settings-section-title">Color Theme</div>
              <div className="settings-section-body">
                <ThemeSelector />
              </div>
            </div>
          )}        </div>

        <div className="settings-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}>{saved ? '✓ Saved' : 'Save Settings'}</button>
        </div>
      </div>

      {showImportModal && (
        <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) setShowImportModal(false) }}>
          <div className="settings-panel" style={{ maxWidth: 600 }}>
            <div className="settings-header">
              <div>
                <div className="settings-title">Import MCP Servers</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>Paste your MCP configuration JSON</div>
              </div>
              <button className="settings-close" onClick={() => setShowImportModal(false)}>✕</button>
            </div>

            <div className="settings-body" style={{ padding: 16 }}>
              <textarea
                className="settings-textarea"
                value={importJson}
                onChange={e => setImportJson(e.target.value)}
                placeholder={`{
  "mcpServers": {
    "figma": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--stdio"],
      "env": {"FIGMA_API_KEY": "your-token"}
    }
  }
}`}
                rows={12}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
                <button className="btn-ghost" onClick={() => setShowImportModal(false)}>Cancel</button>
                <button
                  className="btn-primary"
                  onClick={importMCPServers}
                  disabled={!importJson.trim()}
                >
                  Import
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


