import { describe, it, expect, vi } from 'vitest'
import { parseIntent, describeIntent, extractApiKey, extractUrl } from '../intentParser'

vi.mock('../themes', () => ({
  THEMES: [
    { id: 'betopia',      name: 'Betopia',      description: 'Default dark', preview: ['#0a', '#da', '#14'], dark: { bg: '#0a', surface: '#14', surface2: '#1c', surface3: '#25', border: '', border2: '', text: '', text2: '', text3: '', accent: '', accentBg: '', accentHover: '', codeBg: '', red: '' }, light: { bg: '#f6', surface: '#ff', surface2: '#f3', surface3: '#ee', border: '', border2: '', text: '', text2: '', text3: '', accent: '', accentBg: '', accentHover: '', codeBg: '', red: '' } },
    { id: 'nord',         name: 'Nord',         description: 'Arctic',       preview: ['#2e', '#88', '#3b'], dark: { bg: '#2e', surface: '#3b', surface2: '#43', surface3: '#43', border: '', border2: '', text: '', text2: '', text3: '', accent: '', accentBg: '', accentHover: '', codeBg: '', red: '' } },
    { id: 'tokyo-night',  name: 'Tokyo Night',  description: 'Blue',         preview: ['#1a', '#7a', '#1f'], dark: { bg: '#1a', surface: '#1f', surface2: '#29', surface3: '#29', border: '', border2: '', text: '', text2: '', text3: '', accent: '', accentBg: '', accentHover: '', codeBg: '', red: '' } },
    { id: 'catppuccin',   name: 'Catppuccin',   description: 'Pastel',       preview: ['#1e', '#cb', '#18'], dark: { bg: '#1e', surface: '#18', surface2: '#31', surface3: '#31', border: '', border2: '', text: '', text2: '', text3: '', accent: '', accentBg: '', accentHover: '', codeBg: '', red: '' }, light: { bg: '#ef', surface: '#ff', surface2: '#e6', surface3: '#dc', border: '', border2: '', text: '', text2: '', text3: '', accent: '', accentBg: '', accentHover: '', codeBg: '', red: '' } },
    { id: 'rose-pine',    name: 'Rosé Pine',    description: 'Soho',         preview: ['#19', '#c4', '#1f'], dark: { bg: '#19', surface: '#1f', surface2: '#26', surface3: '#26', border: '', border2: '', text: '', text2: '', text3: '', accent: '', accentBg: '', accentHover: '', codeBg: '', red: '' }, light: { bg: '#fa', surface: '#ff', surface2: '#f2', surface3: '#f2', border: '', border2: '', text: '', text2: '', text3: '', accent: '', accentBg: '', accentHover: '', codeBg: '', red: '' } },
  ],
}))

// ── extractApiKey ─────────────────────────────────────────────────────────────

describe('extractApiKey', () => {
  it('extracts OpenAI classic key', () => {
    expect(extractApiKey('sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('sk-abcdefghijklmnopqrstuvwxyz123456')
  })
  it('extracts OpenAI project key', () => {
    expect(extractApiKey('sk-proj-abc123DEF456ghi789JKL')).toBe('sk-proj-abc123DEF456ghi789JKL')
  })
  it('returns null for short strings', () => {
    expect(extractApiKey('hello world')).toBeNull()
  })
})

// ── extractUrl ────────────────────────────────────────────────────────────────

describe('extractUrl', () => {
  it('extracts https URL', () => {
    expect(extractUrl('add mcp https://api.example.com/mcp')).toBe('https://api.example.com/mcp')
  })
  it('extracts http URL', () => {
    expect(extractUrl('connect http://localhost:3000')).toBe('http://localhost:3000')
  })
  it('returns null when no URL', () => {
    expect(extractUrl('just text here')).toBeNull()
  })
})

// ── parseIntent — theme ───────────────────────────────────────────────────────

describe('parseIntent — theme', () => {
  it('detects "change theme to nord dark"', () => {
    const r = parseIntent('change theme to nord dark')
    expect(r?.type).toBe('apply-theme')
    expect((r as any)?.themeId).toBe('nord')
    expect((r as any)?.mode).toBe('dark')
  })

  it('detects "set theme betopia light"', () => {
    const r = parseIntent('set theme betopia light')
    expect(r?.type).toBe('apply-theme')
    expect((r as any)?.themeId).toBe('betopia')
    expect((r as any)?.mode).toBe('light')
  })

  it('detects "apply catppuccin dark"', () => {
    const r = parseIntent('apply catppuccin dark')
    expect(r?.type).toBe('apply-theme')
    expect((r as any)?.themeId).toBe('catppuccin')
    expect((r as any)?.mode).toBe('dark')
  })

  it('detects "nord dark" (no action word, has mode)', () => {
    const r = parseIntent('nord dark')
    expect(r?.type).toBe('apply-theme')
    expect((r as any)?.themeId).toBe('nord')
    expect((r as any)?.mode).toBe('dark')
  })

  it('detects "tokyo night light" (no light variant → fallback dark)', () => {
    const r = parseIntent('tokyo night light')
    expect(r?.type).toBe('apply-theme')
    expect((r as any)?.themeId).toBe('tokyo-night')
    expect((r as any)?.mode).toBe('dark')
  })

  it('uses alias "tokyo" for tokyo-night', () => {
    const r = parseIntent('switch theme to tokyo dark')
    expect((r as any)?.themeId).toBe('tokyo-night')
  })

  it('uses alias "mocha" for catppuccin', () => {
    const r = parseIntent('apply mocha theme')
    expect((r as any)?.themeId).toBe('catppuccin')
  })

  it('uses alias "rose pine" for rose-pine', () => {
    const r = parseIntent('change theme to rose pine light')
    expect((r as any)?.themeId).toBe('rose-pine')
    expect((r as any)?.mode).toBe('light')
  })

  it('returns null for short or unrelated query', () => {
    expect(parseIntent('he')).toBeNull()
    expect(parseIntent('')).toBeNull()
  })

  it('does not fire theme intent for bare "nord" (no mode/action)', () => {
    // "nord" alone has no mode word and no action word → should not detect intent
    const r = parseIntent('nord')
    // Could be null or not apply-theme without signal
    if (r) expect(r.type).not.toBe('apply-theme')
  })
})

// ── parseIntent — view ────────────────────────────────────────────────────────

describe('parseIntent — view', () => {
  it('detects "go to terminal"', () => {
    const r = parseIntent('go to terminal')
    expect(r?.type).toBe('switch-view')
    expect((r as any)?.view).toBe('terminal')
  })

  it('detects "open code editor"', () => {
    const r = parseIntent('open code editor')
    expect(r?.type).toBe('switch-view')
    expect((r as any)?.view).toBe('code')
  })

  it('detects "switch to live preview"', () => {
    const r = parseIntent('switch to live preview')
    expect(r?.type).toBe('switch-view')
    expect((r as any)?.view).toBe('live')
  })

  it('detects "open dashboard"', () => {
    const r = parseIntent('open dashboard')
    expect(r?.type).toBe('switch-view')
    expect((r as any)?.view).toBe('dashboard')
  })

  it('detects "go to database"', () => {
    const r = parseIntent('go to database')
    expect(r?.type).toBe('switch-view')
    expect((r as any)?.view).toBe('database')
  })

  it('detects "navigate to settings"', () => {
    const r = parseIntent('navigate to settings')
    expect(r?.type).toBe('switch-view')
    expect((r as any)?.view).toBe('settings')
  })
})

// ── parseIntent — API key ─────────────────────────────────────────────────────

describe('parseIntent — API key', () => {
  it('detects API key with "api key" signal', () => {
    const r = parseIntent('set openai api key sk-abcdefghijklmnopqrstuvwxyz1234567890')
    expect(r?.type).toBe('set-api-key')
    expect((r as any)?.providerId).toBe('openai')
    expect((r as any)?.key).toContain('sk-')
  })

  it('detects API key with sk- prefix only', () => {
    const r = parseIntent('sk-proj-myLongOpenAIKeyHereAbcdef123456')
    expect(r?.type).toBe('set-api-key')
    expect((r as any)?.key).toContain('sk-proj-')
  })

  it('detects provider from context', () => {
    const r = parseIntent('betopia api key sk-abcdefghijklmnopqrstuvwxyz1234')
    expect(r?.type).toBe('set-api-key')
    expect((r as any)?.providerId).toBe('betopia')
  })

  it('defaults to openai if no provider mentioned', () => {
    const r = parseIntent('add api key sk-abcdefghijklmnopqrstuvwxyz1234')
    expect(r?.type).toBe('set-api-key')
    expect((r as any)?.providerId).toBe('openai')
  })
})

// ── parseIntent — MCP ─────────────────────────────────────────────────────────

describe('parseIntent — MCP', () => {
  it('detects "add mcp https://api.example.com/mcp"', () => {
    const r = parseIntent('add mcp https://api.example.com/mcp')
    expect(r?.type).toBe('add-mcp')
    expect((r as any)?.url).toBe('https://api.example.com/mcp')
  })

  it('detects "connect mcp server http://localhost:3001"', () => {
    const r = parseIntent('connect mcp server http://localhost:3001')
    expect(r?.type).toBe('add-mcp')
    expect((r as any)?.url).toBe('http://localhost:3001')
  })

  it('uses SSE type when "sse" mentioned', () => {
    const r = parseIntent('add sse mcp server https://myserver.com/sse')
    expect(r?.type).toBe('add-mcp')
    expect((r as any)?.serverType).toBe('sse')
  })

  it('defaults to http type', () => {
    const r = parseIntent('add mcp https://example.com/mcp')
    expect((r as any)?.serverType).toBe('http')
  })

  it('does not detect mcp without url', () => {
    const r = parseIntent('add mcp server')
    expect(r).toBeNull()
  })
})

// ── describeIntent ────────────────────────────────────────────────────────────

describe('describeIntent', () => {
  it('describes theme intent', () => {
    const intent = parseIntent('change theme to nord dark')!
    const { label, description } = describeIntent(intent)
    expect(label).toContain('Nord')
    expect(label).toContain('Dark')
    expect(description).toBeTruthy()
  })

  it('describes view intent', () => {
    const intent = parseIntent('go to terminal')!
    const { label } = describeIntent(intent)
    expect(label).toContain('Terminal')
  })

  it('describes API key intent with masked key', () => {
    const intent = parseIntent('set openai api key sk-abcdefghijklmnopqrstuvwxyz1234567890')!
    const { label, description } = describeIntent(intent)
    expect(label).toContain('OpenAI')
    expect(description).toContain('sk-abcde')
    expect(description).toContain('•')
  })

  it('describes MCP intent', () => {
    const intent = parseIntent('add mcp https://example.com/mcp')!
    const { label } = describeIntent(intent)
    expect(label).toContain('MCP')
  })
})
