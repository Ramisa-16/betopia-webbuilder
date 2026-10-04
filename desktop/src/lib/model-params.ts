export function usesMaxCompletionTokens(model: string): boolean {
  // OpenAI GPT-4.x / GPT-5.x and o-series models use max_completion_tokens.
  // Normalize case so capitalized model ids from dynamic providers still match.
  const normalized = model.trim().toLowerCase()
  return /^(o[1345]|gpt-4(?:o|\.)|gpt-5(?:[.-].*)?|chatgpt-)/.test(normalized)
}

export function isGPTFamilyModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return /^(gpt-|chatgpt-)/.test(normalized)
}

export function getDefaultCompletionTokenLimit(model: string): number {
  const normalized = model.trim().toLowerCase()
  // GPT models on the Betopia router have been more reliable with a smaller
  // default completion budget than the generic 32k fallback.
  if (/^gpt-5(?:[.-].*)?/.test(normalized)) return 2048
  if (/^gpt-4(?:o|\.)/.test(normalized)) return 8192
  if (/^o[1345]/.test(normalized)) return 8192
  return 32768
}

export function getReducedCompletionTokenLimit(model: string, currentLimit: number): number {
  const normalized = model.trim().toLowerCase()
  const safeFloor = 512
  const cappedCurrent = Math.max(safeFloor, currentLimit)

  if (/^gpt-5(?:[.-].*)?/.test(normalized)) {
    return Math.max(safeFloor, Math.min(cappedCurrent, 1024))
  }

  if (/^gpt-4(?:o|\.)/.test(normalized) || /^o[1345]/.test(normalized)) {
    return Math.max(safeFloor, Math.min(cappedCurrent, 2048))
  }

  return Math.max(1024, Math.min(cappedCurrent, 8192))
}
