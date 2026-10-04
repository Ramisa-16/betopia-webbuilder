export interface ProviderModel {
  id: string
  name: string
  description?: string
  supportsThinking?: boolean
  contextLength?: number
  smallOutputWindow?: boolean
  providerId?: string
  providerName?: string
}

export interface Provider {
  id: string
  name: string
  shortName?: string
  baseUrl: string
  requiresApiKey: boolean
  description?: string
  models: ProviderModel[]
  allowCustomModel?: boolean
}

export const BETOPIA_BASE_URL = 'https://api.betopia.ai'
export const BETOPIA_API_BASE_URL = `${BETOPIA_BASE_URL}/v1`
export const BETOPIA_PLATFORM_URL = 'https://platform.betopia.ai/api-keys'
const BETOPIA_MODELS_URL = `${BETOPIA_API_BASE_URL}/public/models`

export const PROVIDERS: Provider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    shortName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    description: 'OpenAI API',
    models: [
      { id: 'gpt-5.4',       name: 'gpt-5.4',       description: 'Flagship',         contextLength: 128000 },
      { id: 'gpt-5.4-mini',  name: 'gpt-5.4-mini',  description: 'Fast & efficient', contextLength: 128000 },
      { id: 'gpt-5.4-nano',  name: 'gpt-5.4-nano',  description: 'Ultra fast',       contextLength: 64000 },
      { id: 'o4-mini',       name: 'o4-mini',       description: 'Reasoning',        contextLength: 128000 },
      { id: 'gpt-4.1',       name: 'gpt-4.1',       description: 'Balanced',         contextLength: 128000 },
      { id: 'gpt-4.1-mini',  name: 'gpt-4.1-mini',  description: 'Low latency',      contextLength: 128000 },
    ],
    allowCustomModel: true,
  },
  {
    id: 'betopia',
    name: 'Betopia AI',
    shortName: 'Betopia',
    baseUrl: BETOPIA_API_BASE_URL,
    requiresApiKey: true,
    description: 'Betopia platform',
    models: [],
    allowCustomModel: true,
  },
]

export const THINKING_MODELS = new Set(['Qwen/Qwen3.6-35B-A3B'])
// Models with limited output generation capacity - use skeleton-first workflow to prevent OOM crashes
export const SMALL_OUTPUT_MODELS = new Set(['Qwen/Qwen3.6-35B-A3B'])
// Models that support Anthropic prompt caching (cache_control + anthropic-beta header)
// but not the thinking extensions (enable_thinking etc.)
export const CACHE_MODELS = new Set(['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'])

/**
 * Fetch available Betopia models from the public API.
 * No API key required - public endpoint.
 * Uses tauriFetch to bypass webview CORS/network restrictions.
 */
export async function fetchBetopiaModels(): Promise<ProviderModel[]> {
  try {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    const res = await tauriFetch(BETOPIA_MODELS_URL) as any
    if (!res.ok) return []

    const data = await res.json() as any
    const list: any[] =
      data.models ??
      data.data ??
      data.items ??
      (Array.isArray(data) ? data : [])

    if (!list.length) return []

    return list.map((m) => {
      const rawId = String(m.id ?? m.model ?? m.model_id ?? m.slug ?? '').trim()
      const displayName = String(m.display_name ?? m.displayName ?? m.name ?? m.title ?? rawId).trim()
      const modelId = normalizeBetopiaModelId(rawId || displayName, displayName, String(m.provider ?? '').trim())
      const providerId = normalizeProviderId(String(m.provider ?? '').trim())
      const providerName = providerLabel(m.provider)
      const displayLabel = displayName || rawId || modelId
      return {
        id: modelId,
        name: displayLabel,
        description: String(
          m.description ??
          m.provider_name ??
          m.provider ??
          m.family ??
          m.owned_by ??
          '',
        ).trim() || providerLabel(m.provider),
        contextLength: m.context_length ?? m.contextLength ?? m.max_tokens ?? m.maxTokens ?? m.max_context_length ?? undefined,
        supportsThinking: THINKING_MODELS.has(modelId),
        smallOutputWindow: SMALL_OUTPUT_MODELS.has(modelId),
        providerId,
        providerName,
      }
    })
  } catch {
    return []
  }
}

function normalizeProviderId(provider: string): string | undefined {
  const normalized = provider.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'self-hosted' || normalized === 'betopia' || normalized === 'default' || normalized === 'local') {
    return 'betopia'
  }
  if (normalized === 'openai' || normalized === 'anthropic' || normalized === 'google' || normalized === 'mistral' || normalized === 'cohere') {
    return normalized
  }
  return normalized
}

export function normalizeBetopiaModelId(candidate: string, displayName: string, provider: string): string {
  const raw = candidate.trim()
  const display = displayName.trim()
  const aliases = new Map<string, string>([
    ['gpt 5.4', 'gpt-5.4'],
    ['gpt-5.4', 'gpt-5.4'],
    ['gpt 5.4 mini', 'gpt-5.4-mini'],
    ['gpt-5.4 mini', 'gpt-5.4-mini'],
    ['gpt-5.4-mini', 'gpt-5.4-mini'],
    ['gpt 5.4 nano', 'gpt-5.4-nano'],
    ['gpt-5.4 nano', 'gpt-5.4-nano'],
    ['gpt-5.4-nano', 'gpt-5.4-nano'],
    ['gpt 4o', 'gpt-4o'],
    ['gpt-4o', 'gpt-4o'],
    ['claude sonnet 4.6', 'claude-sonnet-4-6'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['claude haiku 4.5', 'claude-haiku-4-5'],
    ['claude-haiku-4-5', 'claude-haiku-4-5'],
    ['qwen3.6 35b a3b', 'Qwen/Qwen3.6-35B-A3B'],
    ['qwen3.6-35b-a3b', 'Qwen/Qwen3.6-35B-A3B'],
    ['qwen/qwen3.6-35b-a3b', 'Qwen/Qwen3.6-35B-A3B'],
    ['qwen3 coder 480b it', 'qwen3-coder-480b-it'],
    ['qwen3-coder-480b-it', 'qwen3-coder-480b-it'],
  ])

  const candidates = [raw, display, raw.toLowerCase(), display.toLowerCase()]
    .map(s => s.trim())
    .filter(Boolean)

  for (const item of candidates) {
    const normalized = item.toLowerCase().replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-')
    const alias = aliases.get(normalized) ?? aliases.get(normalized.replace(/\s+/g, ' '))
    if (alias) return alias
  }

  if (raw.includes('/')) return raw
  if (provider === 'openai') return raw.toLowerCase().replace(/\s+/g, '-')
  if (provider === 'anthropic') return raw.toLowerCase().replace(/\s+/g, '-')

  return raw || display
}

function providerLabel(provider: string): string {
  const MAP: Record<string, string> = {
    openai:        'OpenAI',
    anthropic:     'Anthropic',
    'self-hosted':  'Default · Thinking',
  }
  return MAP[provider] ?? provider
}

// Global dynamic model cache
let _cachedModels: ProviderModel[] | null = null
let _fetchPromise: Promise<ProviderModel[]> | null = null

export function getCachedBetopiaModels(): ProviderModel[] {
  return _cachedModels ?? []
}

/** Fetch once, then serve from cache for the process lifetime. */
export async function getBetopiaModels(): Promise<ProviderModel[]> {
  if (_cachedModels) return _cachedModels
  if (_fetchPromise) return _fetchPromise
  _fetchPromise = fetchBetopiaModels().then(models => {
    _cachedModels = models
    _fetchPromise = null
    window.dispatchEvent(new CustomEvent('betopia:models-loaded'))
    return models
  })
  return _fetchPromise
}

/** Kick off a background prefetch (call on app start). */
export function prefetchBetopiaModels(): void {
  getBetopiaModels().catch(() => {})
}

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find(p => p.id === id)
}

export function getProviderModels(id: string): ProviderModel[] {
  if (id === 'betopia') return getCachedBetopiaModels()
  return getProvider(id)?.models ?? []
}

export function findModelAcrossProviders(modelId: string): { providerId: string; model: ProviderModel } | null {
  const normalizedTarget = normalizeBetopiaModelId(modelId, modelId, '').toLowerCase()
  for (const provider of PROVIDERS) {
    for (const model of getProviderModels(provider.id)) {
      const normalizedId = normalizeBetopiaModelId(model.id, model.name, model.providerId ?? provider.id).toLowerCase()
      const normalizedName = normalizeBetopiaModelId(model.name, model.name, model.providerId ?? provider.id).toLowerCase()
      if (normalizedId === normalizedTarget || normalizedName === normalizedTarget) {
        return { providerId: model.providerId ?? provider.id, model }
      }
    }
  }
  return null
}

export function resolveProviderEndpoint(
  providerId: string,
  apiKeys: Record<string, string>,
  customBaseUrl?: string,
): { baseUrl: string; apiKey: string } {
  const provider = getProvider(providerId)
  return {
    baseUrl: customBaseUrl?.trim() || provider?.baseUrl || 'https://api.openai.com/v1',
    apiKey: apiKeys[providerId] ?? '',
  }
}
