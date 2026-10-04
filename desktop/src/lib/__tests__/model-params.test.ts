import { describe, expect, it } from 'vitest'
import { getDefaultCompletionTokenLimit, getReducedCompletionTokenLimit, isGPTFamilyModel, usesMaxCompletionTokens } from '../model-params'

describe('usesMaxCompletionTokens', () => {
  it('detects lowercase GPT and o-series model ids', () => {
    expect(usesMaxCompletionTokens('gpt-5.4')).toBe(true)
    expect(usesMaxCompletionTokens('gpt-4o')).toBe(true)
    expect(usesMaxCompletionTokens('o4-mini')).toBe(true)
  })

  it('detects capitalized GPT model ids from dynamic providers', () => {
    expect(usesMaxCompletionTokens('GPT-5.4')).toBe(true)
    expect(usesMaxCompletionTokens('GPT-5.4-Mini')).toBe(true)
    expect(usesMaxCompletionTokens('ChatGPT-4o')).toBe(true)
  })

  it('does not match unrelated model ids', () => {
    expect(usesMaxCompletionTokens('Qwen/Qwen3.6-35B-A3B')).toBe(false)
    expect(usesMaxCompletionTokens('claude-haiku-4-5')).toBe(false)
  })

  it('detects GPT-family ids for Betopia compatibility guards', () => {
    expect(isGPTFamilyModel('gpt-5.4')).toBe(true)
    expect(isGPTFamilyModel('GPT-5.4-Mini')).toBe(true)
    expect(isGPTFamilyModel('claude-haiku-4-5')).toBe(false)
  })

  it('uses a safer default completion budget for GPT models', () => {
    expect(getDefaultCompletionTokenLimit('gpt-5.4')).toBe(2048)
    expect(getDefaultCompletionTokenLimit('GPT-5.4-MINI')).toBe(2048)
    expect(getDefaultCompletionTokenLimit('gpt-4.1')).toBe(8192)
    expect(getDefaultCompletionTokenLimit('Qwen/Qwen3.6-35B-A3B')).toBe(32768)
  })

  it('reduces GPT budgets more aggressively on retry', () => {
    expect(getReducedCompletionTokenLimit('gpt-5.4', 8192)).toBe(1024)
    expect(getReducedCompletionTokenLimit('gpt-4.1', 8192)).toBe(2048)
    expect(getReducedCompletionTokenLimit('Qwen/Qwen3.6-35B-A3B', 8192)).toBe(8192)
  })
})
