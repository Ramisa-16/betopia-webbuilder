import { invoke } from '@tauri-apps/api/core'
import { PROVIDERS, resolveProviderEndpoint, getProvider, fetchBetopiaModels } from './providers'
import { persistWrite, persistRead } from './persist'

const CONFIG_FILE = 'betopia_config.json'

// Cache for validated model — avoids re-fetching on every API call
let _validatedModel: { providerId: string; model: string; ts: number } | null = null
const MODEL_CACHE_TTL = 5 * 60 * 1000

async function resolveValidModel(providerId: string, configuredModel: string): Promise<string> {
  if (providerId !== 'betopia') return configuredModel

  const now = Date.now()
  if (_validatedModel?.providerId === providerId && now - _validatedModel.ts < MODEL_CACHE_TTL) {
    return _validatedModel.model
  }

  const models = await fetchBetopiaModels()
  if (!models.length) return configuredModel

  const exists = models.some(m => m.id === configuredModel)
  const validModel = exists ? configuredModel : models[0].id

  _validatedModel = { providerId, model: validModel, ts: now }

  if (!exists) {
    // Auto-fix config so next sync call also gets the right model
    const cfg = getConfig()
    saveConfig({ ...cfg, model: { ...cfg.model, model: validModel } })
    console.info(`[betopia] Model "${configuredModel}" not available — auto-switched to "${validModel}"`)
  }

  return validModel
}

export interface MCPServer {
  id: string
  name: string
  type: 'stdio' | 'sse' | 'http' | 'json'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
  disabledTools?: string[]
  timeout?: number
}

export interface ModelConfig {
  providerId: string
  model: string
  /** Per-provider API keys — stored together so switching providers is seamless */
  apiKeys: Record<string, string>
  customBaseUrl?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  thinkingMode?: boolean
}

export interface BehaviorConfig {
  cavemanEnabled: boolean
  cavemanIntensity: 'lite' | 'full' | 'ultra'
  systemPromptPrefix: string
  yoloMode: boolean
  autoAccept: boolean
  autoCompact: boolean
  autoCompactThreshold: number  // 0–1, fraction of context window that triggers auto-compact
}

export interface SandboxConfig {
  enabled: boolean
  endpoint: string
  apiKey: string
  image: string
  cpuLimit: number
  memoryMb: number
  timeoutSec: number
  allowNetwork: boolean
}

export interface AgentConfig {
  model: ModelConfig
  mcpServers: MCPServer[]
  behavior: BehaviorConfig
  sandbox: SandboxConfig
}

const DEFAULTS: AgentConfig = {
  model: {
    providerId: 'betopia',
    model: 'Qwen/Qwen3.6-35B-A3B',
    apiKeys: {},
  },
  mcpServers: [],
  behavior: {
    cavemanEnabled: false,
    cavemanIntensity: 'full',
    systemPromptPrefix: '',
    yoloMode: false,
    autoAccept: false,
    autoCompact: true,
    autoCompactThreshold: 0.75,
  },
  sandbox: {
    enabled: false,
    endpoint: 'http://127.0.0.1:7879',
    apiKey: '',
    image: 'node:20-alpine',
    cpuLimit: 1,
    memoryMb: 1024,
    timeoutSec: 120,
    allowNetwork: false,
  },
}

const KEY = 'betopia_agent_config'

export function getConfig(): AgentConfig {
  try {
    const s = localStorage.getItem(KEY)
    if (s) {
      const stored = JSON.parse(s) as Record<string, unknown>

      // Migration: old format had model.baseUrl / model.apiKey instead of providerId
      if (stored.model && typeof (stored.model as Record<string, unknown>).baseUrl === 'string') {
        const old = stored.model as { baseUrl?: string; apiKey?: string; model?: string }
        const matchedProvider = PROVIDERS.find(p => p.baseUrl === old.baseUrl)
        const providerId = matchedProvider?.id ?? 'openai'
        const apiKeys: Record<string, string> = {}
        if (old.apiKey && matchedProvider?.requiresApiKey) apiKeys[providerId] = old.apiKey
        stored.model = {
          providerId,
          model: old.model ?? DEFAULTS.model.model,
          apiKeys,
          customBaseUrl: matchedProvider?.baseUrl === old.baseUrl ? undefined : old.baseUrl,
        }
      }

      const m = (stored.model ?? {}) as Partial<ModelConfig>
      return {
        model: {
          ...DEFAULTS.model,
          ...m,
          apiKeys: { ...DEFAULTS.model.apiKeys, ...m.apiKeys },
        },
        mcpServers: (stored.mcpServers as MCPServer[] | undefined) ?? [],
        behavior: { ...DEFAULTS.behavior, ...(stored.behavior as Partial<BehaviorConfig> | undefined) },
        sandbox: { ...DEFAULTS.sandbox, ...(stored.sandbox as Partial<SandboxConfig> | undefined) },
      }
    }
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(DEFAULTS)) as AgentConfig
}

export function saveConfig(cfg: AgentConfig) {
  localStorage.setItem(KEY, JSON.stringify(cfg))
  _validatedModel = null
  window.dispatchEvent(new CustomEvent('betopia:config-changed'))
  persistWrite(CONFIG_FILE, cfg).catch(() => {})
}

/** Call once on app mount — restores config from file if localStorage is empty. */
export async function initConfig(): Promise<void> {
  if (localStorage.getItem(KEY)) return
  const saved = await persistRead<AgentConfig>(CONFIG_FILE)
  if (saved) localStorage.setItem(KEY, JSON.stringify(saved))
}

export function getResolvedEndpoint(): { baseUrl: string; apiKey: string; model: string } {
  const cfg = getConfig()
  const { baseUrl, apiKey } = resolveProviderEndpoint(
    cfg.model.providerId,
    cfg.model.apiKeys,
    cfg.model.customBaseUrl,
  )
  return { baseUrl, apiKey, model: cfg.model.model }
}

/** Async version that reads API key from OS keychain first and validates the model. */
export async function getResolvedEndpointAsync(): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  const cfg = getConfig()
  const { baseUrl } = resolveProviderEndpoint(cfg.model.providerId, {}, cfg.model.customBaseUrl)
  const [apiKey, model] = await Promise.all([
    getApiKey(cfg.model.providerId),
    resolveValidModel(cfg.model.providerId, cfg.model.model),
  ])
  return { baseUrl, apiKey, model }
}

export function getModelInfo(): { name: string; contextLength: number; providerName: string } {
  const cfg = getConfig()
  const provider = getProvider(cfg.model.providerId)
  const modelDef = provider?.models.find(m => m.id === cfg.model.model)
  const name = modelDef?.name ?? cfg.model.model
  const contextLength = modelDef?.contextLength ?? 0
  const providerName =
    cfg.model.providerId === 'openai' && cfg.model.customBaseUrl?.trim() && cfg.model.customBaseUrl.trim() !== provider?.baseUrl
      ? 'OpenAI compatible'
      : provider?.shortName ?? provider?.name ?? cfg.model.providerId
  return { name, contextLength, providerName }
}

// ── API key storage ───────────────────────────────────────────────────────────
// Primary: localStorage (always works, Tauri app data dir is user-only).
// Secondary: OS keychain (bonus secure layer when available).

export async function getApiKey(providerId: string): Promise<string> {
  // Try keychain first (more secure when available)
  try {
    const val = await invoke<string | null>('secrets_get', { key: `${providerId}_api_key` })
    if (val) return val
  } catch { /* keychain unavailable */ }
  // Always fall back to localStorage
  const cfg = getConfig()
  return cfg.model.apiKeys[providerId] ?? ''
}

export async function setApiKey(providerId: string, key: string): Promise<void> {
  // Always save to localStorage (primary — reliable, always works)
  const cfg = getConfig()
  if (key) {
    saveConfig({ ...cfg, model: { ...cfg.model, apiKeys: { ...cfg.model.apiKeys, [providerId]: key } } })
  } else {
    const { [providerId]: _, ...rest } = cfg.model.apiKeys
    saveConfig({ ...cfg, model: { ...cfg.model, apiKeys: rest } })
  }
  // Also try keychain (secondary — bonus security layer)
  try {
    if (key) {
      await invoke('secrets_set', { key: `${providerId}_api_key`, value: key })
    } else {
      await invoke('secrets_delete', { key: `${providerId}_api_key` })
    }
  } catch { /* keychain unavailable — localStorage already saved above */ }
}

export async function deleteApiKey(providerId: string): Promise<void> {
  try { await invoke('secrets_delete', { key: `${providerId}_api_key` }) } catch { /* ignore */ }
  const cfg = getConfig()
  const { [providerId]: _, ...rest } = cfg.model.apiKeys
  saveConfig({ ...cfg, model: { ...cfg.model, apiKeys: rest } })
}

// Copy API keys to OS keychain (bonus security layer — localStorage remains the primary store)
export async function migrateApiKeysToKeychain(): Promise<void> {
  const cfg = getConfig()
  const keys = cfg.model.apiKeys
  if (!keys || Object.keys(keys).length === 0) return
  for (const [providerId, apiKey] of Object.entries(keys)) {
    if (apiKey) {
      try { await invoke('secrets_set', { key: `${providerId}_api_key`, value: apiKey }) } catch { /* ignore */ }
    }
  }
  // Do NOT clear from localStorage — keep it as the reliable fallback
}

// ── Migrate old single-key config ─────────────────────────────────────────────
;(() => {
  const old = localStorage.getItem('betopia_ai_config')
  if (old && !localStorage.getItem(KEY)) {
    try {
      const o = JSON.parse(old) as { baseUrl?: string; apiKey?: string; model?: string }
      const cfg = getConfig()
      const apiKeys: Record<string, string> = {}
      if (o.apiKey) apiKeys['betopia'] = o.apiKey
      cfg.model = {
        providerId: 'betopia',
        model: o.model ?? cfg.model.model,
        apiKeys,
      }
      saveConfig(cfg)
    } catch { /* ignore */ }
  }
})()
