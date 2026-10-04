import { useState, useEffect } from 'react'
import { getConfig, saveConfig } from './config'
import type { AgentConfig } from './config'
import { getBetopiaModels } from './providers'
import type { ProviderModel } from './providers'

/** Reactive config — re-renders whenever saveConfig() is called anywhere. */
export function useConfig(): [AgentConfig, (cfg: AgentConfig) => void] {
  const [cfg, setCfg] = useState<AgentConfig>(getConfig)

  useEffect(() => {
    const handler = () => setCfg(getConfig())
    window.addEventListener('betopia:config-changed', handler)
    return () => window.removeEventListener('betopia:config-changed', handler)
  }, [])

  return [cfg, saveConfig]
}

/** Returns dynamically-fetched Betopia models (empty while loading). */
export function useBetopiaModels(): { models: ProviderModel[]; loading: boolean } {
  const [models, setModels] = useState<ProviderModel[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getBetopiaModels().then(m => { setModels(m); setLoading(false) }).catch(() => setLoading(false))
    const handler = () => getBetopiaModels().then(m => setModels(m)).catch(() => {})
    window.addEventListener('betopia:models-loaded', handler)
    return () => window.removeEventListener('betopia:models-loaded', handler)
  }, [])

  return { models, loading }
}
