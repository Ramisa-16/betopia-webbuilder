const ORCH_APPROVAL_SIGNALS = new Set([
  'approved', 'approve', 'confirm', 'confirmed', 'continue', 'done', 'go', 'go ahead',
  'looks good', 'lgtm', 'next', 'ok', 'okay', 'perfect', 'proceed', 'start', 'yes', 'yep',
  'retry', 'redo', 'regenerate', 'try again', 'rerun', 'do it', 'do that', 'make it happen',
])

export function isPlanApprovalPrompt(prompt: string): boolean {
  const raw = prompt.toLowerCase().trim()
  const p = raw.replace(/[!?.]+$/, '').trim()
  if (/^(start|begin)\s+(the\s+)?build(ing)?\b/.test(p)) return true
  if (/^(continue|resume)\s+(where\s+(you|we)\s+left\s+off|the\s+build|build(ing)?|implementation)\b/.test(p)) return true
  if (/^(implement|build)\s+(it|this|that|now)\b/.test(p)) return true
  if (/\?/.test(raw)) return false
  if (/\b(before|question|what|why|how|which|when|where|who|can|could|should|would|edit|change|revise|modify|update|not yet|wait|hold|stop|don't|dont|do not)\b/.test(p)) return false
  if (ORCH_APPROVAL_SIGNALS.has(p)) return true
  return /^(yes|yep|yeah|ok|okay|approved|approve|confirm|confirmed|continue|proceed|go ahead|looks good|lgtm|perfect)(\s|,|$)/.test(p)
}

export function isPlanEditPrompt(prompt: string): boolean {
  const p = prompt.toLowerCase().trim()
  if (!p) return false
  const explicitPlanEdit =
    /\b(edit|change|revise|modify|update|adjust|rewrite|refine)\b[\s\S]{0,80}\bplan\b/.test(p) ||
    /\bplan\b[\s\S]{0,80}\b(edit|change|revise|modify|update|adjust|rewrite|refine)\b/.test(p)
  if (explicitPlanEdit) return true

  return /\b(add|remove|replace|swap)\b[\s\S]{0,80}\b(plan|step|task)\b/.test(p)
}
