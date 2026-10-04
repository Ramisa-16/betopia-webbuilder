export type SubagentType = 'explore' | 'code-review' | 'security' | 'general' | 'coder' | 'fixer'

export type SubagentDef = {
  id: SubagentType | string
  label: string
  description: string
  /** Betopia built-in tool names this subagent may call. */
  tools: string[]
  systemPrompt: string
  /** If true, subagent can write files and run bash. Requires user approval per write. */
  writable: boolean
  /** Optional model override. Inherits global model when absent. */
  model?: string
}

export const READ_ONLY_TOOLS = [
  'view_file',
  'list_dir',
  'grep_search',
  'list_files',
  'project_structure',
  'read_files',
  'read_with_deps',
  'web_fetch',
]

export const WRITE_TOOLS = [
  ...READ_ONLY_TOOLS,
  'write_file',
  'edit',
  'bash',
  'delete_file',
  'rename_file',
]

export const SUBAGENTS: Record<string, SubagentDef> = {
  explore: {
    id: 'explore',
    label: 'Explore',
    description: 'Read-only codebase explorer. Locates files, traces references, summarizes architecture.',
    tools: READ_ONLY_TOOLS,
    writable: false,
    systemPrompt: `You are an exploration subagent. Your job is to answer the spawn question by READING the codebase only — no edits, no commands. Use grep_search/list_files/list_dir/view_file/read_with_deps. Be terse. Return a concise summary suitable for the main agent to act on (file paths, key findings, line numbers). Stop as soon as you can answer.`,
  },
  'code-review': {
    id: 'code-review',
    label: 'Code review',
    description: 'Reviews changed code for correctness, architecture, performance, security.',
    tools: READ_ONLY_TOOLS,
    writable: false,
    systemPrompt: `You are a code-review subagent. Inspect the requested code and report only ACTIONABLE findings: correctness bugs, architecture violations, performance issues, security risks. Skip style/formatting. Format each finding as: "[MUST/SHOULD/NIT] file:line — issue → fix". If nothing is wrong, say "Looks good." Do NOT propose unrelated cleanups.`,
  },
  security: {
    id: 'security',
    label: 'Security review',
    description: 'Audits code/configuration for security risks (auth, injection, secrets, etc).',
    tools: READ_ONLY_TOOLS,
    writable: false,
    systemPrompt: `You are a security-review subagent. Scan the requested scope for: injection (SQL, shell, path), auth/authz bypass, secret leakage, missing validation at trust boundaries, unsafe deserialization, weak crypto. Report concrete findings with file:line and severity. Be conservative — false positives hurt more than missed nits. If nothing is wrong, say "No security issues found."`,
  },
  general: {
    id: 'general',
    label: 'General research',
    description: 'General-purpose worker for multi-step research questions that span many files.',
    tools: READ_ONLY_TOOLS,
    writable: false,
    systemPrompt: `You are a general-purpose research subagent. Answer the spawn question by reading the codebase. Don't speculate — verify. Return a tight summary with the evidence you used (paths, line numbers).`,
  },
  coder: {
    id: 'coder',
    label: 'Coder',
    description: 'Full write-access subagent that implements code changes. Can write files and run commands.',
    tools: WRITE_TOOLS,
    writable: true,
    systemPrompt: `You are a coder subagent. Implement the task described in the prompt using write_file, edit, bash, and read tools. Be precise — only change what is necessary. After completing, summarize what you did: which files were written/edited and why. Do not exceed the scope of the task. If you are uncertain about a design decision, make the simplest correct choice and note it in your summary.`,
  },
  fixer: {
    id: 'fixer',
    label: 'Fixer',
    description: 'Focused bug-fixer. Reads the failing code, diagnoses the root cause, applies the minimal fix.',
    tools: WRITE_TOOLS,
    writable: true,
    systemPrompt: `You are a fixer subagent. Your only job is to fix the specific bug described in the prompt. Steps: 1) read the failing file(s) 2) diagnose root cause 3) apply the MINIMAL fix using edit or write_file 4) verify by reading the changed section. Do NOT refactor, do NOT fix unrelated issues. Return a concise summary: what was wrong and what you changed.`,
  },
}

export const SUBAGENT_MAX_STEPS = 20

export type CustomSubagentDef = {
  id: string
  label: string
  description: string
  systemPrompt: string
  writable: boolean
  /** Optional model override (e.g. "claude-haiku-4-5-20251001"). Inherits global model when absent. */
  model?: string
  /** Explicit tool whitelist. Falls back to writable flag when absent. */
  tools?: string[]
  sourceType?: 'manual' | 'repo'
  sourceUrl?: string
  sourcePath?: string
  linkedSkills?: string[]
  importNotes?: string[]
  manifestsDetected?: string[]
}

function normalizeSubagentId(id: string): string {
  return id.trim().toLowerCase()
}

/** Merge built-in and user-defined custom subagents into a lookup map. */
export function resolveSubagent(id: string, custom?: CustomSubagentDef[]): SubagentDef | undefined {
  const normalizedId = normalizeSubagentId(id)
  const builtin = Object.values(SUBAGENTS).find(subagent => normalizeSubagentId(String(subagent.id)) === normalizedId)
  if (builtin) return builtin
  const c = custom?.find(s => normalizeSubagentId(s.id) === normalizedId)
  if (!c) return undefined
  const allowedTools = new Set(c.writable ? WRITE_TOOLS : READ_ONLY_TOOLS)
  const tools = c.tools?.length
    ? c.tools.filter(t => allowedTools.has(t))
    : c.writable ? WRITE_TOOLS : READ_ONLY_TOOLS
  return { ...c, id: c.id.trim(), tools, model: c.model || undefined }
}

/**
 * Validate custom subagent definitions at config-load time.
 * Returns a list of human-readable error strings; empty = all valid.
 */
export function validateCustomSubagents(custom: CustomSubagentDef[]): string[] {
  const errors: string[] = []
  const allAllowed = new Set(WRITE_TOOLS)
  const writeOnlyTools = new Set(WRITE_TOOLS.filter(tool => !READ_ONLY_TOOLS.includes(tool)))
  const seenIds = new Map<string, string>()
  const builtinIds = new Set(Object.keys(SUBAGENTS).map(normalizeSubagentId))
  for (const c of custom) {
    const trimmedId = c.id?.trim() ?? ''
    if (!trimmedId) { errors.push('Custom subagent missing id'); continue }
    const normalizedId = normalizeSubagentId(trimmedId)
    const existing = seenIds.get(normalizedId)
    if (existing) {
      errors.push(`Subagent "${trimmedId}": duplicate id conflicts with "${existing}"`)
    } else {
      seenIds.set(normalizedId, trimmedId)
    }
    if (!c.label?.trim()) errors.push(`Subagent "${c.id}": label is required`)
    if (!c.systemPrompt?.trim()) errors.push(`Subagent "${c.id}": systemPrompt is required`)
    if (c.tools?.length) {
      const bad = c.tools.filter(t => !allAllowed.has(t))
      if (bad.length) errors.push(`Subagent "${c.id}": unknown tools [${bad.join(', ')}]`)
      if (!c.writable) {
        const disallowedWrites = c.tools.filter(t => writeOnlyTools.has(t))
        if (disallowedWrites.length) {
          errors.push(`Subagent "${c.id}": read-only subagents cannot enable write tools [${disallowedWrites.join(', ')}]`)
        }
      }
    }
    if (builtinIds.has(normalizedId)) errors.push(`Subagent "${c.id}": id conflicts with built-in subagent`)
  }
  return errors
}
