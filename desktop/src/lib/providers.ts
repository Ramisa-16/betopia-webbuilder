export interface ProviderModel {
  id: string
  name: string
  description?: string
  supportsThinking?: boolean
  contextLength?: number
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

export const PROVIDERS: Provider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    shortName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    description: 'OpenAI API',
    models: [
      { id: 'gpt-5.4',       name: 'GPT-5.4',       description: 'Flagship',         contextLength: 128000 },
      { id: 'gpt-5.4-mini',   name: 'GPT-5.4 Mini',  description: 'Fast & efficient', contextLength: 128000 },
      { id: 'gpt-5.4-nano',   name: 'GPT-5.4 Nano',  description: 'Ultra fast',       contextLength: 64000 },
      { id: 'o4-mini',        name: 'o4-mini',       description: 'Reasoning',        contextLength: 128000 },
      { id: 'gpt-4.1',        name: 'GPT-4.1',       description: 'Balanced',         contextLength: 128000 },
      { id: 'gpt-4.1-mini',   name: 'GPT-4.1 Mini',  description: 'Low latency',      contextLength: 128000 },
    ],
    allowCustomModel: true,
  },
  {
    id: 'betopia',
    name: 'Betopia AI',
    shortName: 'Betopia',
    baseUrl: 'https://api.betopia.ai/v1',
    requiresApiKey: true,
    description: 'Betopia platform',
    models: [
      { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen3.6 35B A3B', description: 'Default · Thinking', supportsThinking: true, contextLength: 262144 },
      { id: 'gpt-5.4',              name: 'GPT-5.4',          description: 'Flagship',            contextLength: 128000 },
      { id: 'gpt-5.4-mini',         name: 'GPT-5.4 Mini',     description: 'Fast & efficient',    contextLength: 128000 },
      { id: 'claude-sonnet-4-6',    name: 'Claude Sonnet 4.6', description: 'Anthropic',          contextLength: 128000 },
      { id: 'claude-haiku-4-5',     name: 'Claude Haiku 4.5',  description: 'Anthropic · Fast',   contextLength: 64000  },
    ],
    allowCustomModel: true,
  },
]

const BETOPIA_MODELS_URL = 'https://platform-backend.betopia.ai/v1/public/models'
export const THINKING_MODELS = new Set(['Qwen/Qwen3.6-35B-A3B'])

/**
 * Fetch available Betopia models from the public API.
 * No API key required — public endpoint.
 * Uses tauriFetch to bypass webview CORS/network restrictions.
 */
export async function fetchBetopiaModels(): Promise<ProviderModel[]> {
  try {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    const res = await tauriFetch(BETOPIA_MODELS_URL) as any
    if (!res.ok) return []
    const data = await res.json() as any
    const list: any[] = data.models ?? data.data ?? (Array.isArray(data) ? data : [])
    if (!list.length) return []
    return list.map(m => {
      const modelName = String(m.name ?? m.id)
      return {
        id: modelName,
        name: friendlyModelName(modelName),
        description: providerLabel(m.provider),
        contextLength: m.max_tokens ?? undefined,
        supportsThinking: THINKING_MODELS.has(modelName),
      }
    })
  } catch {
    return []
  }
}

function friendlyModelName(id: string): string {
  const MAP: Record<string, string> = {
    'Qwen/Qwen3.6-35B-A3B': 'Qwen3.6 35B A3B',
    'gpt-5.4':              'GPT-5.4',
    'gpt-5.4-mini':         'GPT-5.4 Mini',
    'claude-sonnet-4-6':    'Claude Sonnet 4.6',
    'claude-haiku-4-5':     'Claude Haiku 4.5',
  }
  return MAP[id] ?? id
}

function providerLabel(provider: string): string {
  const MAP: Record<string, string> = {
    openai:       'OpenAI',
    anthropic:    'Anthropic',
    'self-hosted': 'Default · Thinking',
  }
  return MAP[provider] ?? provider
}

// ── Global dynamic model cache ─────────────────────────────────────────────────

let _cachedModels: ProviderModel[] | null = null
let _fetchPromise: Promise<ProviderModel[]> | null = null

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
