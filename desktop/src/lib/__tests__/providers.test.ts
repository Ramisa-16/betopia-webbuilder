import { describe, expect, it } from 'vitest'
import { PROVIDERS, normalizeBetopiaModelId } from '../providers'

describe('normalizeBetopiaModelId', () => {
  it('normalizes common GPT display names to canonical ids', () => {
    expect(normalizeBetopiaModelId('GPT-5.4 Mini', 'GPT-5.4 Mini', 'openai')).toBe('gpt-5.4-mini')
    expect(normalizeBetopiaModelId('GPT-5.4', 'GPT-5.4', 'openai')).toBe('gpt-5.4')
    expect(normalizeBetopiaModelId('gpt-5.4-nano', 'GPT-5.4 Nano', 'openai')).toBe('gpt-5.4-nano')
  })

  it('keeps qwen and other canonical ids stable', () => {
    expect(normalizeBetopiaModelId('Qwen/Qwen3.6-35B-A3B', 'Qwen3.6 35B A3B', 'self-hosted')).toBe('Qwen/Qwen3.6-35B-A3B')
    expect(normalizeBetopiaModelId('qwen3-coder-480b-it', 'Qwen3 Coder 480B IT', 'self-hosted')).toBe('qwen3-coder-480b-it')
  })

  it('keeps the built-in OpenAI display names aligned with the platform labels', () => {
    const openai = PROVIDERS.find(p => p.id === 'openai')
    expect(openai?.models.map(m => m.name)).toEqual([
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'o4-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
    ])
  })
})
