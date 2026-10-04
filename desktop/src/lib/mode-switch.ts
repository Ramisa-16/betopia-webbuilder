const TASK_ACTION_WORDS = [
  'add',
  'fix',
  'implement',
  'update',
  'change',
  'edit',
  'delete',
  'remove',
  'refactor',
  'rename',
  'replace',
  'modify',
  'insert',
] as const

const TASK_TARGET_WORDS = [
  'component',
  'section',
  'button',
  'page',
  'screen',
  'card',
  'form',
  'feature',
  'testimonial',
  'review',
  'comment',
  'style',
  'layout',
  'ui',
  'code',
  'file',
  'api',
  'backend',
  'frontend',
  'dashboard',
  'route',
  'skill',
  'mode',
  'setting',
  'tab',
  'terminal',
  'preview',
  'chat',
  'project',
  'panel',
  'text',
  'theme',
  'icon',
  'image',
  'list',
  'item',
] as const

function buildWordPattern(words: readonly string[]): RegExp {
  return new RegExp(`\\b(?:${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')
}

function buildWordPatternWithSuffixes(words: readonly string[]): RegExp {
  return new RegExp(
    `\\b(?:${
      words.map(word => `${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:ing|ed|es|s)?`).join('|')
    })\\b`,
    'i',
  )
}

export const TASK_ACTION_PATTERN = buildWordPatternWithSuffixes(TASK_ACTION_WORDS)
const TASK_TARGET_PATTERN = buildWordPattern(TASK_TARGET_WORDS)

export function shouldUsePlanningForPrompt(prompt: string): boolean {
  const p = prompt.toLowerCase()
  return (
    /\b(plan|roadmap|architecture|design review|design plan|step by step)\b/.test(p) ||
    (/\b(build|create|make|generate|develop|scaffold|construct)\b/.test(p) &&
      (/\b(project|app|application|website|web app|system|platform|dashboard|portal|api|backend|frontend|full stack|fullstack|database|store|shop|e-?commerce|portfolio|landing page|blog|saas)\b/.test(p) ||
       /\b(react|next\.?js|node|express|go|rust|python|django|flask|postgres|mongodb|mysql|api|frontend|backend|fullstack|full stack)\b/.test(p))) ||
    /\b(step by step|architecture|module|plan then build|analyze ui|design analysis)\b/.test(p)
  )
}

export function shouldSkipPlanning(prompt: string): boolean {
  return /\b(stop orchestration|disable orchestration|normal mode|agentic mode|quick fix|single fix)\b/.test(prompt)
}

export function shouldPromptModeSwitch(prompt: string): boolean {
  if (shouldUsePlanningForPrompt(prompt)) return true

  const p = prompt.trim().toLowerCase()
  if (/^(start|begin)\s+(the\s+)?build(ing)?(\s+now)?$/.test(p)) return true
  if (/^(run|execute|kick off)\s+(the\s+)?build(ing)?(\s+now)?$/.test(p)) return true
  if (/^(continue|proceed|go ahead|confirm)\s+(with\s+)?(the\s+)?build(ing)?$/.test(p)) return true

  return TASK_ACTION_PATTERN.test(prompt) && TASK_TARGET_PATTERN.test(prompt)
}
