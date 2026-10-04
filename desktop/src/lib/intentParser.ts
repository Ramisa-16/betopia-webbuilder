/**
 * Natural-language intent parser for the settings search spotlight.
 * Pure functions — no side effects, no imports from React/stores.
 */

import { THEMES } from './themes'
import type { Theme, ThemeMode } from './themes'
import type { ViewMode } from '@/types'
import { findPresetByText, extractEnvKV, type MCPPresetData } from './mcp-presets'

// ── Intent types ──────────────────────────────────────────────────────────────

export type ThemeIntent = {
  type: 'apply-theme'
  themeId: string
  mode: ThemeMode
  theme: Theme
}

export type ViewIntent = {
  type: 'switch-view'
  view: ViewMode
  label: string
}

export type ApiKeyIntent = {
  type: 'set-api-key'
  providerId: string
  providerName: string
  key: string
}

export type McpIntent = {
  type: 'add-mcp'
  url: string
  name: string
  serverType: 'http' | 'sse'
}

export type McpPresetIntent = {
  type: 'setup-mcp-preset'
  preset: MCPPresetData
  providedEnv: Record<string, string>
  missingKeys: string[]
}

export type ParsedIntent = ThemeIntent | ViewIntent | ApiKeyIntent | McpIntent | McpPresetIntent

// ── Theme helpers ─────────────────────────────────────────────────────────────

const THEME_ALIASES: Record<string, string> = {
  'tokyo': 'tokyo-night',
  'tokyo night': 'tokyo-night',
  'rose pine': 'rose-pine',
  'rosepine': 'rose-pine',
  'mocha': 'catppuccin',
  'latte': 'catppuccin',
  'rose': 'rose-pine',
}

function findTheme(text: string): Theme | null {
  const t = text.trim().toLowerCase()
  if (!t) return null

  // Exact ID
  const byId = THEMES.find(th => th.id === t || th.id === t.replace(/\s+/g, '-'))
  if (byId) return byId

  // Exact name
  const byName = THEMES.find(th => th.name.toLowerCase() === t)
  if (byName) return byName

  // Alias map
  const aliased = ALIASES_RESOLVED[t]
  if (aliased) return aliased

  // Partial: theme name/id contains the search text or vice versa
  return THEMES.find(th =>
    th.name.toLowerCase().includes(t) ||
    t.includes(th.id) ||
    t.includes(th.name.toLowerCase()) ||
    th.id.replace(/-/g, ' ').includes(t)
  ) || null
}

// Resolve aliases once
const ALIASES_RESOLVED: Record<string, Theme> = Object.fromEntries(
  Object.entries(THEME_ALIASES).flatMap(([alias, id]) => {
    const theme = THEMES.find(t => t.id === id)
    return theme ? [[alias, theme]] : []
  })
)

function extractMode(text: string): ThemeMode | null {
  if (/\bdark\b/.test(text)) return 'dark'
  if (/\blight\b/.test(text)) return 'light'
  return null
}

function resolveMode(theme: Theme, requested: ThemeMode | null): ThemeMode {
  const mode = requested ?? 'dark'
  // Fallback: if light requested but not available → dark
  if (mode === 'light' && !theme.light) return 'dark'
  return mode
}

// Strip action/filler words to isolate the theme name
const FILLER_RE = /\b(change|set|apply|switch|use|theme|to|the|a|an|color|appearance|mode|my|make|go)\b/g

function stripFillers(text: string): string {
  return text.toLowerCase().replace(FILLER_RE, ' ').replace(/\s+/g, ' ').trim()
}

// ── View helpers ──────────────────────────────────────────────────────────────

const VIEW_MAP: [RegExp, ViewMode, string][] = [
  [/\b(code|editor|coding|files?)\b/, 'code', 'Code Editor'],
  [/\b(preview|live|browser|render|website)\b/, 'live', 'Live Preview'],
  [/\b(terminal|shell|bash|cli|console|command line)\b/, 'terminal', 'Terminal'],
  [/\b(dashboard|overview|project home)\b/, 'dashboard', 'Dashboard'],
  [/\b(database|db|sql|data)\b/, 'database', 'Database'],
  [/\b(storage|files|assets|media|uploads)\b/, 'storage', 'Storage'],
  [/\b(settings?|config|configure|project settings?)\b/, 'settings', 'Project Settings'],
]

function matchView(text: string): { view: ViewMode; label: string } | null {
  for (const [re, view, label] of VIEW_MAP) {
    if (re.test(text)) return { view, label }
  }
  return null
}

// ── Provider helpers ──────────────────────────────────────────────────────────

const PROVIDER_MAP: [RegExp, string, string][] = [
  [/\b(openai|open ai|gpt|chatgpt)\b/, 'openai', 'OpenAI'],
  [/\b(betopia)\b/, 'betopia', 'Betopia AI'],
  [/\b(anthropic|claude)\b/, 'anthropic', 'Anthropic'],
  [/\b(gemini|google)\b/, 'google', 'Google'],
  [/\b(mistral)\b/, 'mistral', 'Mistral'],
  [/\b(cohere)\b/, 'cohere', 'Cohere'],
]

function matchProvider(text: string): { providerId: string; providerName: string } {
  for (const [re, id, name] of PROVIDER_MAP) {
    if (re.test(text)) return { providerId: id, providerName: name }
  }
  return { providerId: 'openai', providerName: 'OpenAI' }
}

// ── Key / URL extraction ──────────────────────────────────────────────────────

// Matches common API key formats
const KEY_PATTERNS = [
  /sk-proj-[A-Za-z0-9_-]{20,}/,    // OpenAI project key
  /sk-[A-Za-z0-9]{20,}/,           // OpenAI classic key
  /figd_[A-Za-z0-9_-]{20,}/,       // Figma personal access token
  /[A-Za-z0-9_-]{32,}/,            // Generic long key (last resort)
]

export function extractApiKey(text: string): string | null {
  for (const pattern of KEY_PATTERNS) {
    const match = text.match(pattern)
    if (match) return match[0]
  }
  return null
}

export function extractFigmaKey(text: string): string | null {
  const match = text.match(/figd_[A-Za-z0-9_-]{20,}/)
  return match ? match[0] : null
}

export function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s,;'"]+/)
  return match ? match[0] : null
}

function deriveMcpName(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^(www|api)\./, '') || 'MCP Server'
  } catch {
    return 'MCP Server'
  }
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseIntent(query: string): ParsedIntent | null {
  const q = query.trim()
  if (q.length < 2) return null
  const lower = q.toLowerCase()

  // ── 0. Figma API key — figd_ prefix auto-routes to MCP preset setup ──
  const figmaKey = extractFigmaKey(q)
  if (figmaKey) {
    const figmaPreset = findPresetByText('figma')
    if (figmaPreset) {
      return {
        type: 'setup-mcp-preset',
        preset: figmaPreset,
        providedEnv: { FIGMA_API_KEY: figmaKey },
        missingKeys: [],
      }
    }
  }

  // ── 1. API key intent (highest priority — explicit key pasted) ──
  // Must have either "api", "key", "secret", "token" keyword OR recognizable key prefix
  const hasKeySignal = /\b(api|key|secret|token)\b/.test(lower) || /\bsk-/.test(q)
    || /\bfigma\b/.test(lower)
  if (hasKeySignal) {
    const key = extractApiKey(q)
    if (key && key.length >= 20) {
      // Figma key with "figma" keyword → MCP preset
      if (/\bfigma\b/.test(lower)) {
        const figmaPreset2 = findPresetByText('figma')
        if (figmaPreset2) {
          return {
            type: 'setup-mcp-preset',
            preset: figmaPreset2,
            providedEnv: { FIGMA_API_KEY: key },
            missingKeys: [],
          }
        }
      }
      const provider = matchProvider(lower)
      return { type: 'set-api-key', ...provider, key }
    }
  }

  // ── 2a. MCP preset setup — named service detected ──
  const hasMcpSetupSignal = /\b(setup|set\s+up|add|configure|install|connect|enable|use|activate)\b/.test(lower)
    || /\bmcp\b/.test(lower)
  if (hasMcpSetupSignal) {
    const preset = findPresetByText(lower)
    if (preset) {
      const providedEnv = extractEnvKV(q)
      const missingKeys = preset.envKeys.filter(k => !providedEnv[k])
      return { type: 'setup-mcp-preset', preset, providedEnv, missingKeys }
    }
  }

  // ── 2b. MCP intent — URL present with mcp/server/add signal ──
  const url = extractUrl(q)
  if (url && /\b(mcp|server|add|connect|install|endpoint)\b/.test(lower)) {
    const nameMatch = lower.match(/(?:name[d]?\s+|called?\s+)["']?([a-zA-Z0-9][a-zA-Z0-9\s-]{1,30})["']?/)
    const name = nameMatch ? nameMatch[1].trim() : deriveMcpName(url)
    const serverType: 'sse' | 'http' = /\bsse\b/.test(lower) ? 'sse' : 'http'
    return { type: 'add-mcp', url, name, serverType }
  }

  // ── 3. Theme intent ──
  // Trigger on: action word OR "dark"/"light" word
  const hasThemeSignal = /\b(theme|color|appearance)\b/.test(lower)
  const hasActionWord = /\b(change|set|apply|switch|use|enable|activate)\b/.test(lower)
  const hasModeWord = /\b(dark|light)\b/.test(lower)

  if (hasThemeSignal || hasActionWord || hasModeWord) {
    const mode = extractMode(lower)
    const stripped = stripFillers(lower).replace(/\b(dark|light)\b/g, '').trim()
    if (stripped) {
      const theme = findTheme(stripped)
      if (theme) {
        return { type: 'apply-theme', themeId: theme.id, mode: resolveMode(theme, mode), theme }
      }
    }
    // Also try without stripping (e.g., user types "nord dark")
    const modeRemoved = lower.replace(/\b(dark|light)\b/g, '').trim()
    const theme2 = modeRemoved ? findTheme(modeRemoved) : null
    if (theme2) {
      return { type: 'apply-theme', themeId: theme2.id, mode: resolveMode(theme2, mode), theme: theme2 }
    }
  }

  // ── 4. View / navigation intent ──
  const hasNavSignal = /\b(go|open|switch|show|navigate|view|launch|take me)\b/.test(lower)
  if (hasNavSignal) {
    const viewMatch = matchView(lower)
    if (viewMatch) return { type: 'switch-view', ...viewMatch }
  }

  return null
}

// ── Human-readable intent descriptions ───────────────────────────────────────

export function describeIntent(intent: ParsedIntent): { label: string; description: string } {
  switch (intent.type) {
    case 'apply-theme':
      return {
        label: `Apply ${intent.theme.name} — ${intent.mode === 'dark' ? 'Dark' : 'Light'}`,
        description: `Switch color theme immediately`,
      }
    case 'switch-view':
      return {
        label: `Open ${intent.label}`,
        description: `Switch the workspace to ${intent.label}`,
      }
    case 'set-api-key': {
      const masked = intent.key.slice(0, 8) + '•'.repeat(Math.min(12, intent.key.length - 8))
      return {
        label: `Set ${intent.providerName} API Key`,
        description: `Save key: ${masked}`,
      }
    }
    case 'add-mcp':
      return {
        label: `Add MCP Server — ${intent.name}`,
        description: `Connect ${intent.serverType.toUpperCase()} server at ${intent.url}`,
      }
    case 'setup-mcp-preset':
      if (intent.missingKeys.length > 0) {
        return {
          label: `Set up ${intent.preset.name} MCP`,
          description: `Needs: ${intent.missingKeys.join(', ')}`,
        }
      }
      return {
        label: `Add ${intent.preset.name} MCP`,
        description: `${intent.preset.desc}`,
      }
  }
}
