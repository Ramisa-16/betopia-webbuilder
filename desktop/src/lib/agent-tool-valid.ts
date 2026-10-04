import type { AgentAuditStatus, AgentAuditApproval } from './agent-types'
import type { MCPTool, ToolSchema, ToolLike } from './agent-tools'

// Max chars a tool result may occupy in OAI history
const TOOL_RESULT_OAI_MAX = 24_000

// ── Bash safety classification ─────────────────────────────────────────────────

export function isReadOnlyBashCommand(cmd: string): boolean {
  const t = cmd.trim().replace(/\s+/g, ' ')
  if (/^(ls|la|ll|pwd|env|printenv|whoami|hostname|uname|date|uptime|id)$/.test(t)) return true
  if (/^(ls|la|ll|cat|head|tail|grep|egrep|fgrep|rgrep|find|which|whereis|wc|diff|stat|du|df|echo|printf|type|file|lsof|ps|top|htop|lscpu|free|netstat|ss|nmap|curl -s|curl --silent)\s/.test(t)) return true
  if (/^git\s+(log|status|diff|show|branch|remote(\s+-v)?|tag|stash\s+list|shortlog|describe|config\s+--list|ls-files)(\s|$)/.test(t)) return true
  if (/(\s|^)(--version|-V|--help|-h)(\s|$)/.test(t)) return true
  if (/^(node|npm|npx|python3?|pip3?|cargo|rustc|go|bun|deno|java|ruby|php)\s+(--version|-V)$/.test(t)) return true
  return false
}

// ── MCP risk-scoring ──────────────────────────────────────────────────────────

const MCP_WRITE_VERBS = new Set(['create','update','delete','remove','destroy','write','send',
  'post','put','patch','push','insert','modify','set','add','edit','upload','publish','commit',
  'merge','close','open','move','rename','copy','reset','clear','drop','truncate','archive',
  'restore','deploy','cancel','revoke','disable','enable'])
const MCP_READ_VERBS = new Set(['get','list','search','find','fetch','read','show','view',
  'describe','check','inspect','query','retrieve','lookup','count','stat','diff','compare',
  'summarize','analyze','audit','report','preview','ping','test','validate'])

export function isMCPToolReadOnly(toolId: string, annotations: MCPTool['annotations']): boolean {
  if (annotations?.readOnlyHint === true) return true
  if (annotations?.destructiveHint === true) return false
  if (annotations?.readOnlyHint === false) return false

  const localName = toolId.includes('__') ? toolId.split('__').slice(1).join('__') : toolId
  const firstWord = localName.toLowerCase().split('_')[0]
  if (MCP_WRITE_VERBS.has(firstWord)) return false
  if (MCP_READ_VERBS.has(firstWord)) return true
  return false
}

// ── Argument redaction ────────────────────────────────────────────────────────

const SENSITIVE_KEY_RE = /(?:token|api[_-]?key|apikey|secret|password|passwd|pwd|auth(?:orization)?|credential|bearer|private[_-]?key|access[_-]?key)/i

export function redactMCPArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (SENSITIVE_KEY_RE.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = '[REDACTED]'
    } else if (Array.isArray(v)) {
      out[k] = v.map(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? redactMCPArgs(item as Record<string, unknown>)
          : item,
      )
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactMCPArgs(v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

export function redactCommand(command: string): string {
  const redacted = command
    .replace(/(bearer\s+)[^\s'"]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/(--(?:api-key|token|secret|password)\s+)(("[^"]*")|('[^']*')|[^\s]+)/gi, '$1[REDACTED]')
  return redacted.length > 180 ? redacted.slice(0, 180) + '…' : redacted
}

// ── Path safety ───────────────────────────────────────────────────────────────

export function getUnsafeProjectPathReason(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed) return 'path is required'
  if (trimmed.includes('\0')) return 'null bytes are not allowed'
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return 'absolute paths are not allowed'
  const normalized = trimmed.replace(/\\/g, '/')
  if (normalized.split('/').some(part => part === '..')) return 'parent directory traversal is not allowed'
  return null
}

export function unsafeProjectPathResult(path: string): string {
  return `Error: unsafe path "${path}": ${getUnsafeProjectPathReason(path) ?? 'path is not allowed'}`
}

// ── Content normalization ─────────────────────────────────────────────────────

export function normalizeEscapedMultiline(input: unknown): string {
  if (typeof input !== 'string') return String(input ?? '')
  if (input.includes('\n')) return input

  const escapedNewlines = (input.match(/\\n/g) ?? []).length
  if (escapedNewlines < 2) return input

  const looksLikeCode =
    /(import\s+|export\s+|function\s+|const\s+|className=|return\s*\(|<\w+|{\s*$|;\s*$)/m.test(input)
  if (!looksLikeCode) return input

  return input
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
}

// ── Tool result serialization ─────────────────────────────────────────────────

function stripToolErrorPrefix(result: string): string {
  return result.replace(/^Error:\s*/i, '')
}

export function serializeToolResultForModel(
  toolName: string,
  result: string,
  isError: boolean,
  metadata: Record<string, unknown> = {},
): string {
  if (result.startsWith('__IMAGE_DATA__:')) return result

  const denied = /^Permission denied:/i.test(result)
  const aborted = result === 'Aborted'
  const status = isError ? 'error' : denied ? 'denied' : aborted ? 'aborted' : 'ok'
  const truncated = result.length > TOOL_RESULT_OAI_MAX
  const content = truncated
    ? result.slice(0, TOOL_RESULT_OAI_MAX) + `\n…[output truncated — ${result.length - TOOL_RESULT_OAI_MAX} chars omitted. Use grep_search or view_file for targeted reads.]`
    : result

  return JSON.stringify({
    ok: status === 'ok',
    ...(status === 'ok' ? { output: content } : { error: stripToolErrorPrefix(content) }),
    metadata: {
      tool: toolName,
      status,
      is_error: isError,
      output_chars: result.length,
      truncated,
      ...metadata,
    },
  })
}

// ── Tool argument validation ──────────────────────────────────────────────────

export function parseToolArgsForValidation(argsJson: string): { args: Record<string, unknown>; normalizedArgsJson: string } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsJson)
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
  } catch {
    return { error: 'arguments must be valid JSON object' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'arguments must be a JSON object' }
  }

  const args = { ...(parsed as Record<string, unknown>) }
  if (typeof args.edits === 'string') {
    try { args.edits = JSON.parse(args.edits) } catch { /* schema validation will reject it */ }
  }

  return { args, normalizedArgsJson: JSON.stringify(args) }
}

function schemaTypeMatches(value: unknown, schemaType: string): boolean {
  if (schemaType === 'array') return Array.isArray(value)
  if (schemaType === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  if (schemaType === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (schemaType === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (schemaType === 'string') return typeof value === 'string'
  if (schemaType === 'boolean') return typeof value === 'boolean'
  if (schemaType === 'null') return value === null
  return true
}

function validateAgainstSchema(value: unknown, schema: ToolSchema | undefined, path: string, errors: string[]): void {
  if (!schema) return

  if (schema.enum && !schema.enum.some(v => Object.is(v, value))) {
    errors.push(`${path} must be one of: ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`)
    return
  }

  const schemaTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (schemaTypes.length > 0 && !schemaTypes.some(type => schemaTypeMatches(value, type))) {
    errors.push(`${path} must be ${schemaTypes.join(' or ')}`)
    return
  }

  if (Array.isArray(value) && typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    errors.push(`${path} must contain at most ${schema.maxItems} items`)
    return
  }

  if (typeof value === 'string' && typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    errors.push(`${path} must be at most ${schema.maxLength} characters`)
    return
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, idx) => validateAgainstSchema(item, schema.items, `${path}[${idx}]`, errors))
    return
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const required of schema.required ?? []) {
      if (obj[required] === undefined) errors.push(`${path}.${required} is required`)
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined) validateAgainstSchema(obj[key], childSchema, `${path}.${key}`, errors)
    }
  }
}

function findToolSchema(toolName: string, tools: ToolLike[]): ToolSchema | null {
  const tool = tools.find(t => t.function?.name === toolName)
  return (tool?.function?.parameters as ToolSchema | undefined) ?? null
}

export function validateToolCallArguments(
  toolName: string,
  argsJson: string,
  tools: ToolLike[],
): { args: Record<string, unknown>; normalizedArgsJson: string } | { error: string } {
  const parsed = parseToolArgsForValidation(argsJson)
  if ('error' in parsed) return parsed

  const schema = findToolSchema(toolName, tools)
  if (!schema) return parsed

  const errors: string[] = []
  validateAgainstSchema(parsed.args, schema, 'arguments', errors)
  if (errors.length > 0) return { error: errors.join('; ') }

  return parsed
}

// ── Audit utilities ───────────────────────────────────────────────────────────

export function summarizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'write_file') {
    return { path: String(args.path ?? ''), contentChars: String(args.content ?? '').length }
  }
  if (toolName === 'edit') {
    const edits = Array.isArray(args.edits) ? args.edits : null
    return {
      path: String(args.path ?? ''),
      editCount: edits?.length ?? (args.old_string !== undefined || args.new_string !== undefined ? 1 : 0),
    }
  }
  if (toolName === 'delete_file') return { path: String(args.path ?? '') }
  if (toolName === 'rename_file') return { from: String(args.from ?? ''), to: String(args.to ?? '') }
  if (toolName === 'web_fetch') return { url: String(args.url ?? ''), maxChars: typeof args.max_chars === 'number' ? args.max_chars : undefined }
  if (toolName === 'update_memory') return { mode: String(args.mode ?? 'append'), contentChars: String(args.content ?? '').length }
  if (toolName === 'bash') {
    return {
      command: typeof args.command === 'string' ? redactCommand(args.command) : '[invalid]',
      runInBackground: Boolean(args.run_in_background),
      timeout: typeof args.timeout === 'number' ? args.timeout : undefined,
    }
  }
  if (toolName === 'spawn_coding_agent') return { promptChars: String(args.prompt ?? '').length }
  if (toolName === 'send_to_agent') return { instructionChars: String(args.instruction ?? '').length }
  if (toolName.includes('__')) {
    const redacted = JSON.stringify(redactMCPArgs(args))
    return { args: redacted.length > 500 ? redacted.slice(0, 500) + '…' : redacted }
  }
  return {}
}

export function touchedFilesForTool(toolName: string, args: Record<string, unknown>): string[] {
  const files: string[] = []
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) files.push(value)
  }
  if (toolName === 'write_file' || toolName === 'edit' || toolName === 'delete_file') add(args.path)
  if (toolName === 'rename_file') { add(args.from); add(args.to) }
  if (toolName === 'update_memory') files.push('.betopia/memory.md')
  return [...new Set(files)]
}

export function shouldAuditToolCall(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName.includes('__')) return true
  if (['write_file', 'edit', 'delete_file', 'rename_file', 'update_memory', 'spawn_coding_agent', 'send_to_agent'].includes(toolName)) return true
  if (toolName === 'web_fetch') return true
  if (toolName !== 'bash') return false
  return typeof args.command === 'string' ? !isReadOnlyBashCommand(args.command) : true
}

export function classifyAuditOutcome(result: string, isError: boolean): { status: AgentAuditStatus; errorCategory?: string } {
  if (result === 'Aborted') return { status: 'aborted', errorCategory: 'aborted' }
  if (/^Permission denied:/i.test(result)) return { status: 'denied', errorCategory: 'permission_denied' }
  if (/^Error: invalid arguments/i.test(result)) return { status: 'invalid', errorCategory: 'invalid_arguments' }
  if (/^Error: unsafe path/i.test(result)) return { status: 'error', errorCategory: 'unsafe_path' }
  if (isError || /^Error[:(]/i.test(result)) return { status: 'error', errorCategory: 'tool_error' }
  return { status: 'success' }
}

export function auditArgsFromJson(argsJson: string): Record<string, unknown> {
  const parsed = parseToolArgsForValidation(argsJson)
  return 'error' in parsed ? {} : parsed.args
}

// ── Edit list helpers ─────────────────────────────────────────────────────────

type EditPair = { old_string: unknown; new_string: unknown }

export function resolveEditList(args: Record<string, unknown>): EditPair[] | null {
  let edits = (args as any).edits
  if (typeof edits === 'string') {
    try { edits = JSON.parse(edits) } catch { /* executor will report missing edits below */ }
  }
  if (Array.isArray(edits) && edits.length > 0) return edits as EditPair[]
  if (args.old_string !== undefined && args.new_string !== undefined) {
    return [{ old_string: args.old_string, new_string: args.new_string }]
  }
  return null
}

export function applyEditListToContent(originalContent: string, editList: EditPair[]): { content: string } | { error: string } {
  const BOM = '﻿'
  const hasBOM = originalContent.startsWith(BOM)
  let content = hasBOM ? originalContent.slice(1) : originalContent

  for (let i = 0; i < editList.length; i++) {
    const { old_string: rawOld, new_string: rawNew } = editList[i]
    if (rawOld === undefined || rawNew === undefined) return { error: `Error: edit[${i}] missing old_string or new_string` }
    const normalizedOld = normalizeEscapedMultiline(String(rawOld))
    const normalizedNew = normalizeEscapedMultiline(String(rawNew))

    let matchOld = String(rawOld)
    let replaceWith = String(rawNew)
    let index = content.indexOf(matchOld)
    if (index === -1 && normalizedOld !== matchOld) {
      matchOld = normalizedOld
      replaceWith = normalizedNew
      index = content.indexOf(matchOld)
    }
    if (index === -1) return { error: `Error: edit[${i}] old_string not found. Make sure it matches exactly, including whitespace.` }
    const lastIndex = content.lastIndexOf(matchOld)
    if (index !== lastIndex) return { error: `Error: edit[${i}] old_string appears multiple times. Provide more context to make it unique.` }
    content = content.slice(0, index) + replaceWith + content.slice(index + matchOld.length)
  }

  return { content: hasBOM ? BOM + content : content }
}
