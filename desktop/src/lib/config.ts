import { invoke } from '@tauri-apps/api/core'
import { PROVIDERS, resolveProviderEndpoint, getProvider, fetchBetopiaModels, SMALL_OUTPUT_MODELS, getCachedBetopiaModels, findModelAcrossProviders } from './providers'
import { normalizeBetopiaModelId } from './providers'
import { persistWrite, persistRead } from './persist'
import type { CustomSubagentDef } from './subagents'
import type { PluginConfigEntry } from './plugin'

const CONFIG_FILE = 'betopia_config.json'

// Cache for validated model — avoids re-fetching on every API call
let _validatedModel: { providerId: string; model: string; ts: number } | null = null
const MODEL_CACHE_TTL = 5 * 60 * 1000

function resolveModelRouting(providerId: string, configuredModel: string): { providerId: string; model: string } {
  const modelMatch = findModelAcrossProviders(configuredModel)
  if (modelMatch) {
    return { providerId, model: modelMatch.model.id }
  }

  if (providerId === 'betopia') {
    const normalizedConfiguredModel = normalizeBetopiaModelId(configuredModel, configuredModel, providerId).toLowerCase()
    const staticMatch = PROVIDERS
      .find(p => p.id !== 'betopia')
      ?.models.find(m =>
        normalizeBetopiaModelId(m.id, m.name, m.providerId ?? '').toLowerCase() === normalizedConfiguredModel ||
        normalizeBetopiaModelId(m.name, m.name, m.providerId ?? '').toLowerCase() === normalizedConfiguredModel
      )
    if (staticMatch) {
      return { providerId, model: staticMatch.id }
    }
  }

  return { providerId, model: configuredModel }
}

async function resolveValidModel(providerId: string, configuredModel: string): Promise<string> {
  const routing = resolveModelRouting(providerId, configuredModel)
  providerId = routing.providerId
  configuredModel = routing.model

  if (providerId !== 'betopia') return configuredModel

  const now = Date.now()
  if (_validatedModel?.providerId === providerId && _validatedModel.model === configuredModel && now - _validatedModel.ts < MODEL_CACHE_TTL) {
    return _validatedModel.model
  }

  const models = await fetchBetopiaModels()
  if (!models.length) return configuredModel

  const normalizedConfiguredModel = normalizeBetopiaModelId(configuredModel, configuredModel, providerId).toLowerCase()
  const matchedModel = models.find(m => {
    const normalizedId = normalizeBetopiaModelId(m.id, m.name, m.providerId ?? '').toLowerCase()
    const normalizedName = normalizeBetopiaModelId(m.name, m.name, m.providerId ?? '').toLowerCase()
    return normalizedId === normalizedConfiguredModel || normalizedName === normalizedConfiguredModel
  })
  const validModel = matchedModel?.id ?? models[0].id

  _validatedModel = { providerId, model: validModel, ts: now }

  if (validModel !== configuredModel) {
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
  /** Explicit thinking intensity: off=none, low/medium/high map to reasoning_effort or budget_tokens */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high'
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
  customSubagents: CustomSubagentDef[]
  plugins?: PluginConfigEntry[]
}

export type { CustomSubagentDef }

const DEFAULTS: AgentConfig = {
  model: {
    providerId: 'betopia',
    model: 'Qwen/Qwen3.6-35B-A3B',
    apiKeys: {},
  },
  mcpServers: [],
  customSubagents: [],
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
  plugins: [
    { id: 'builtin:core', enabled: true, source: 'core' },
  ],
}

const KEY = 'betopia_agent_config'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  [key: string]: unknown
}

function getLocalStorageSafe(): StorageLike | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) return null
  const storage = (globalThis as { localStorage?: StorageLike | null }).localStorage
  if (!storage) return null
  if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return null
  return storage
}

function dispatchConfigChanged(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return
  window.dispatchEvent(new CustomEvent('betopia:config-changed'))
}

function migrateLegacySingleKeyConfig(storage: StorageLike): void {
  const old = storage.getItem('betopia_ai_config')
  if (!old || storage.getItem(KEY)) return
  try {
    const o = JSON.parse(old) as { baseUrl?: string; apiKey?: string; model?: string }
    const apiKeys: Record<string, string> = {}
    if (o.apiKey) apiKeys.betopia = o.apiKey
    const cfg: AgentConfig = {
      ...JSON.parse(JSON.stringify(DEFAULTS)) as AgentConfig,
      model: {
        providerId: 'betopia',
        model: o.model ?? DEFAULTS.model.model,
        apiKeys,
      },
    }
    storage.setItem(KEY, JSON.stringify(cfg))
    _validatedModel = null
    dispatchConfigChanged()
    persistWrite(CONFIG_FILE, cfg).catch(() => {})
  } catch { /* ignore */ }
}

export function getConfig(): AgentConfig {
  try {
    const storage = getLocalStorageSafe()
    const s = storage?.getItem(KEY)
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
        customSubagents: (stored.customSubagents as CustomSubagentDef[] | undefined) ?? [],
        behavior: { ...DEFAULTS.behavior, ...(stored.behavior as Partial<BehaviorConfig> | undefined) },
        sandbox: { ...DEFAULTS.sandbox, ...(stored.sandbox as Partial<SandboxConfig> | undefined) },
      }
    }
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(DEFAULTS)) as AgentConfig
}

export function saveConfig(cfg: AgentConfig) {
  const storage = getLocalStorageSafe()
  try {
    storage?.setItem(KEY, JSON.stringify(cfg))
  } catch {
    // QuotaExceededError — evict bulky session/chat data and retry
    if (storage) {
      try {
        for (const k of Object.keys(storage)) {
        if (k.startsWith('betopia:sessions:') || k.startsWith('betopia:project-chat:')) {
            storage.removeItem(k)
        }
      }
        storage.setItem(KEY, JSON.stringify(cfg))
      } catch { /* give up — config saved to file below */ }
    }
  }
  _validatedModel = null
  dispatchConfigChanged()
  persistWrite(CONFIG_FILE, cfg).catch(() => {})
}

/** Call once on app mount — restores config from file if localStorage is empty. */
export async function initConfig(): Promise<void> {
  const storage = getLocalStorageSafe()
  if (!storage) return
  migrateLegacySingleKeyConfig(storage)
  if (storage.getItem(KEY)) return
  const saved = await persistRead<AgentConfig>(CONFIG_FILE)
  if (saved) storage.setItem(KEY, JSON.stringify(saved))
}

export function getResolvedEndpoint(): { baseUrl: string; apiKey: string; model: string } {
  const cfg = getConfig()
  const routing = resolveModelRouting(cfg.model.providerId, cfg.model.model)
  const { baseUrl, apiKey } = resolveProviderEndpoint(
    routing.providerId,
    cfg.model.apiKeys,
    cfg.model.customBaseUrl,
  )
  return { baseUrl, apiKey, model: routing.model }
}

/** Async version that reads API key from OS keychain first and validates the model. */
export async function getResolvedEndpointAsync(): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  const cfg = getConfig()
  const routing = resolveModelRouting(cfg.model.providerId, cfg.model.model)
  const { baseUrl } = resolveProviderEndpoint(routing.providerId, {}, cfg.model.customBaseUrl)
  const [apiKey, model] = await Promise.all([
    getApiKey(routing.providerId),
    resolveValidModel(routing.providerId, routing.model),
  ])
  return { baseUrl, apiKey, model }
}

export function getModelInfo(modelOverride?: string): { name: string; contextLength: number; providerName: string; smallOutput: boolean } {
  const cfg = getConfig()
  const modelId = modelOverride ?? cfg.model.model
  const routing = resolveModelRouting(cfg.model.providerId, modelId)
  const configuredProvider = getProvider(cfg.model.providerId)
  let provider = getProvider(routing.providerId) ?? configuredProvider
  const normalizedModelId = normalizeBetopiaModelId(routing.model, routing.model, routing.providerId).toLowerCase()
  let modelDef = provider?.id === 'betopia'
    ? getCachedBetopiaModels().find(m =>
        normalizeBetopiaModelId(m.id, m.name, m.providerId ?? '').toLowerCase() === normalizedModelId ||
        normalizeBetopiaModelId(m.name, m.name, m.providerId ?? '').toLowerCase() === normalizedModelId
      )
    : provider?.models.find(m =>
        normalizeBetopiaModelId(m.id, m.name, provider?.id ?? '').toLowerCase() === normalizedModelId ||
        normalizeBetopiaModelId(m.name, m.name, provider?.id ?? '').toLowerCase() === normalizedModelId
      )

  if (!modelDef && modelOverride) {
    const betopiaMatch = getCachedBetopiaModels().find(m => m.id === modelId)
    if (cfg.model.providerId === 'betopia' && betopiaMatch) {
      modelDef = betopiaMatch
    } else {
      const providerMatch = PROVIDERS.find(p => p.models.some(m =>
        normalizeBetopiaModelId(m.id, m.name, p.id).toLowerCase() === normalizedModelId ||
        normalizeBetopiaModelId(m.name, m.name, p.id).toLowerCase() === normalizedModelId
      ))
      const modelMatch = providerMatch?.models.find(m =>
        normalizeBetopiaModelId(m.id, m.name, providerMatch.id).toLowerCase() === normalizedModelId ||
        normalizeBetopiaModelId(m.name, m.name, providerMatch.id).toLowerCase() === normalizedModelId
      )
      if (providerMatch && modelMatch) {
        modelDef = modelMatch
      }
    }
  }

  const name = modelDef?.name ?? routing.model
  const betopiaFallbackContext = provider?.id === 'betopia' && /^gpt-|^chatgpt-/.test(normalizedModelId)
    ? 24_000
    : 0
  const contextLength = modelDef?.contextLength ?? betopiaFallbackContext
  const smallOutput = modelDef?.smallOutputWindow ?? SMALL_OUTPUT_MODELS.has(routing.model)
  const providerName =
    !modelOverride && routing.providerId === 'openai' && cfg.model.customBaseUrl?.trim() && cfg.model.customBaseUrl.trim() !== configuredProvider?.baseUrl
      ? 'OpenAI compatible'
      : provider?.shortName ?? provider?.name ?? routing.providerId
  return { name, contextLength, providerName, smallOutput }
}

// ── API key storage ───────────────────────────────────────────────────────────
// Primary: localStorage (always works, Tauri app data dir is user-only).
// Secondary: OS keychain (bonus secure layer when available).

export async function getApiKey(providerId: string): Promise<string> {
  // Local config is the reliable source of truth; keychain is a secondary copy.
  // Reading keychain first can resurrect stale provider keys after config changes.
  const cfg = getConfig()
  const localKey = cfg.model.apiKeys[providerId]?.trim()
  if (localKey) return localKey

  // Fall back to keychain when local config has not been initialized yet.
  try {
    const val = await invoke<string | null>('secrets_get', { key: `${providerId}_api_key` })
    if (val) return val
  } catch { /* keychain unavailable */ }
  return ''
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
