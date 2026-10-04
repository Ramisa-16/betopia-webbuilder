export type SubagentType = 'explore' | 'code-review' | 'security' | 'general'

export type SubagentDef = {
  id: SubagentType
  label: string
  description: string
  /** Betopia built-in tool names this subagent may call (read-only). */
  tools: string[]
  systemPrompt: string
}

const READ_ONLY_TOOLS = [
  'view_file',
  'list_dir',
  'grep_search',
  'list_files',
  'project_structure',
  'read_files',
  'read_with_deps',
]

export const SUBAGENTS: Record<SubagentType, SubagentDef> = {
  explore: {
    id: 'explore',
    label: 'Explore',
    description: 'Read-only codebase explorer. Locates files, traces references, summarizes architecture.',
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are an exploration subagent. Your job is to answer the spawn question by READING the codebase only — no edits, no commands. Use grep_search/list_files/list_dir/view_file/read_with_deps. Be terse. Return a concise summary suitable for the main agent to act on (file paths, key findings, line numbers). Stop as soon as you can answer.`,
  },
  'code-review': {
    id: 'code-review',
    label: 'Code review',
    description: 'Reviews changed code for correctness, architecture, performance, security.',
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a code-review subagent. Inspect the requested code and report only ACTIONABLE findings: correctness bugs, architecture violations, performance issues, security risks. Skip style/formatting. Format each finding as: "[MUST/SHOULD/NIT] file:line — issue → fix". If nothing is wrong, say "Looks good." Do NOT propose unrelated cleanups.`,
  },
  security: {
    id: 'security',
    label: 'Security review',
    description: 'Audits code/configuration for security risks (auth, injection, secrets, etc).',
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a security-review subagent. Scan the requested scope for: injection (SQL, shell, path), auth/authz bypass, secret leakage, missing validation at trust boundaries, unsafe deserialization, weak crypto. Report concrete findings with file:line and severity. Be conservative — false positives hurt more than missed nits. If nothing is wrong, say "No security issues found."`,
  },
  general: {
    id: 'general',
    label: 'General research',
    description: 'General-purpose worker for multi-step research questions that span many files.',
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a general-purpose research subagent. Answer the spawn question by reading the codebase. Don't speculate — verify. Return a tight summary with the evidence you used (paths, line numbers).`,
  },
}

export const SUBAGENT_MAX_STEPS = 12
