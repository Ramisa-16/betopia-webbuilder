import type { SlashSkillOption } from './builtin-skills'

export type SkillRouteSource = 'explicit' | 'auto'

export interface SkillRouteResult {
  option: SlashSkillOption
  task: string
  visibleText: string
  agentPrompt: string
  source: SkillRouteSource
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function skillLabel(option: SlashSkillOption): string {
  return option.kind === 'subagent' ? 'Sub-agent' : 'Skill'
}

export function buildSkillVisibleText(option: SlashSkillOption, task = ''): string {
  return task
    ? `[${skillLabel(option)}: ${option.name}] ${task}`
    : `[${skillLabel(option)}: ${option.name}]`
}

export function buildSkillPrompt(option: SlashSkillOption, task = '', note = ''): string {
  const detail = task || 'If the user did not provide a concrete task yet, ask one concise clarifying question before acting.'
  const body = option.body?.trim() ?? ''

  if (option.kind === 'subagent') {
    const lines = [
      `[Sub-agent: ${option.name}]`,
      '',
      ...(note ? [note, ''] : []),
      body || `Use the existing \`run_subagent\` tool to consult this specialist helper before answering.`,
      '',
      '---',
      '',
      '1. Call `run_subagent` with this specialist helper when it fits the task.',
      '2. Pass the user task, relevant project context, and desired output format to the subagent.',
      '3. Keep the main Betopia agent in charge and synthesize the result for the user.',
      option.writable
        ? '4. This imported subagent may be write-capable. Use mutating tools only when justified and follow the normal approval flow.'
        : '4. This imported subagent is configured read-only. Keep it focused on analysis, planning, or specialist guidance.',
      '',
      `Task: ${detail}`,
    ]
    return lines.join('\n')
  }

  if (!body) {
    return `[Skill: ${option.name}] ${detail}`
  }

  return [
    `[Skill: ${option.name}]`,
    '',
    ...(note ? [note, ''] : []),
    body,
    '',
    '---',
    '',
    detail,
  ].join('\n')
}

function optionCandidates(option: SlashSkillOption): string[] {
  return [
    option.slash,
    option.slash.replace(/^\//, ''),
    option.name,
    option.subagentId ?? '',
  ].filter(Boolean)
}

function tryPrefixMatch(query: string, option: SlashSkillOption): string | null {
  const normalized = query.toLowerCase().trim()
  for (const candidate of optionCandidates(option)) {
    const candidateText = candidate.toLowerCase().trim()
    if (!candidateText) continue
    if (normalized === candidateText) return ''
    if (normalized.startsWith(`${candidateText} `)) {
      return query.slice(candidate.length).trim()
    }
  }
  return null
}

function scoreAutoMatch(prompt: string, option: SlashSkillOption): number {
  const promptNorm = normalize(prompt)
  const promptTokens = new Set(promptNorm.split(' ').filter(token => token.length >= 3))
  const corpora = [
    option.name,
    option.description,
    option.slash,
    option.subagentId ?? '',
    option.body?.slice(0, 400) ?? '',
  ]
    .filter(Boolean)
    .map(normalize)
    .join(' ')

  let score = 0
  const exactCandidates = [
    option.name,
    option.slash,
    option.subagentId ?? '',
  ].filter(Boolean).map(normalize)

  for (const exact of exactCandidates) {
    if (exact && promptNorm.includes(exact)) score += 8
  }

  for (const token of promptTokens) {
    if (corpora.includes(token)) score += token.length >= 6 ? 3 : 2
  }

  if (option.kind === 'subagent' && /\b(subagent|sub-agent|helper|assistant|review|security|explore|fix|coder)\b/.test(promptNorm)) {
    score += 1
  }

  return score
}

function resolveByScope(query: string, options: SlashSkillOption[], kind?: SlashSkillOption['kind']): SkillRouteResult | null {
  const scoped = kind ? options.filter(option => option.kind === kind) : options
  let best: { option: SlashSkillOption; task: string; score: number } | null = null

  for (const option of scoped) {
    const task = tryPrefixMatch(query, option)
    if (task !== null) {
      const score = option.name.length + option.slash.length + (option.subagentId?.length ?? 0)
      if (!best || score > best.score) {
        best = { option, task, score }
      }
    }
  }

  if (!best) return null
  return {
    option: best.option,
    task: best.task,
    visibleText: buildSkillVisibleText(best.option, best.task),
    agentPrompt: buildSkillPrompt(best.option, best.task),
    source: 'explicit',
  }
}

export function resolveSkillDirective(
  text: string,
  options: SlashSkillOption[],
  opts: { allowAuto?: boolean } = {},
): SkillRouteResult | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // Explicit namespace syntax: /skills X, /skill X, /subagents X, /sub agent X
  const namespaceMatch = trimmed.match(/^\/(?:(skills?)|(sub[\s-]*agents?))\s+([\s\S]+)$/i)
  if (namespaceMatch) {
    const scope = namespaceMatch[1] ? 'skill' : 'subagent'
    const query = namespaceMatch[3].trim()
    return resolveByScope(query, options, scope === 'skill' ? 'skill' : 'subagent')
  }

  // Flat slash syntax: /debug, /deploy-specialist, /review code...
  const slashMatch = trimmed.match(/^(\/[\w-]+)(?:\s+([\s\S]*))?$/i)
  if (slashMatch) {
    const query = slashMatch[1].slice(1)
    const task = (slashMatch[2] ?? '').trim()
    const resolved = resolveByScope(query, options)
    if (!resolved) return null
    return {
      ...resolved,
      task: task || resolved.task,
      visibleText: buildSkillVisibleText(resolved.option, task || resolved.task),
      agentPrompt: buildSkillPrompt(resolved.option, task || resolved.task),
      source: 'explicit',
    }
  }

  if (!opts.allowAuto) return null

  let best: { option: SlashSkillOption; score: number } | null = null
  let nextBest = 0
  for (const option of options) {
    if (option.disableModelInvocation) continue
    const score = scoreAutoMatch(trimmed, option)
    if (score <= 0) continue
    if (!best || score > best.score) {
      nextBest = best?.score ?? 0
      best = { option, score }
    } else if (score > nextBest) {
      nextBest = score
    }
  }

  if (!best || best.score < 4 || best.score - nextBest < 2) return null

  return {
    option: best.option,
    task: trimmed,
    visibleText: buildSkillVisibleText(best.option, trimmed),
    agentPrompt: buildSkillPrompt(best.option, trimmed),
    source: 'auto',
  }
}
