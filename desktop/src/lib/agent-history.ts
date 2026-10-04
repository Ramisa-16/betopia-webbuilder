import { getResolvedEndpointAsync } from './config'
import { usesMaxCompletionTokens } from './model-params'
import { getDefaultCompletionTokenLimit } from './model-params'
import { proxyFetch as tauriFetch } from './proxyFetch'
import { countTokens } from './tokenCounter'
import { makeId } from './agent-types'
import type { OAIMessage, OAIContentBlock } from './agent-types'
import type { Message, CompactionData } from '../types'

// ── Constants ─────────────────────────────────────────────────────────────────

export const COMPACT_THRESHOLD = 0.70
export const COMPACT_KEEP_TAIL = 20
export const COMPACTION_VERSION = 1
export const HISTORY_MAX_MESSAGES = 60

// Max chars a tool result may occupy when replayed from historyToOAI
const TOOL_RESULT_MAX = 12000

const SYSTEM_OVERHEAD_TOKENS = 32_000

const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified. Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.'

const SUMMARIZATION_FORMAT = `## Goal
[What the user is trying to accomplish — one or two sentences]

## Constraints & Preferences
- [Technical or stylistic constraints the user has expressed]

## Progress
### Done
- [x] [Completed tasks]
### In Progress
- [ ] [Tasks currently being worked on]
### Blocked
- [Blockers, errors, or unresolved questions]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what to do next]

## Critical Context
- [Data, file paths, error messages, code snippets, or references that must survive compaction]`

// ── Token estimation ──────────────────────────────────────────────────────────

export function estimateHistoryTokens(history: Message[]): number {
  let tokens = 0
  for (const m of history) {
    for (const p of m.parts) {
      if (p.type === 'text') {
        tokens += countTokens((p.data as { text?: string }).text ?? '')
      } else if (p.type === 'tool_call') {
        tokens += Math.ceil(((p.data as { input?: string }).input ?? '').length / 4)
      } else if (p.type === 'tool_result') {
        const content = (p.data as { content?: string }).content ?? ''
        tokens += Math.ceil(Math.min(content.length, 4000) / 4)
      }
    }
  }
  return tokens + 32_000
}

export function estimateOAIHistoryTokens(history: OAIMessage[]): number {
  let tokens = 0
  for (const m of history) {
    if (typeof m.content === 'string') tokens += countTokens(m.content)
    const tc = (m as any).tool_calls
    if (tc) for (const t of tc) tokens += Math.ceil((t.function?.arguments?.length ?? 0) / 4)
  }
  return tokens
}

// ── Safe cut point ────────────────────────────────────────────────────────────

function findSafeCutPoint(history: Message[], keepTail: number): number {
  if (history.length === 0) return 0
  if (keepTail <= 0) return history.length

  const desired = Math.max(0, history.length - keepTail)
  let cut = desired
  while (cut > 0 && history[cut].role !== 'user') cut--
  return cut > 0 ? cut : Math.min(1, history.length)
}

// ── File extraction for compaction summary ────────────────────────────────────

function extractModifiedFiles(messages: Message[]): string[] {
  const seen = new Set<string>()
  const files: string[] = []
  const WRITE_TOOL_NAMES = new Set(['write_file', 'edit', 'delete_file', 'rename_file'])
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== 'tool_call') continue
      const d = p.data as { name?: string; input?: string }
      if (!d.name || !WRITE_TOOL_NAMES.has(d.name)) continue
      try {
        const args = JSON.parse(d.input ?? '{}') as Record<string, string>
        const path = args.path ?? args.from ?? args.to ?? ''
        if (path && !seen.has(path)) { seen.add(path); files.push(path) }
      } catch { /* ignore parse errors */ }
    }
  }
  return files
}

// ── Compaction (Pi-style iterative) ──────────────────────────────────────────

export async function compactHistory(
  history: Message[],
  keepTail = COMPACT_KEEP_TAIL,
  signal?: AbortSignal,
): Promise<{ compactionMsg: Message; keptMessages: Message[] }> {
  const cutPoint = findSafeCutPoint(history, keepTail)
  const toCompact = history.slice(0, cutPoint)
  const keptMessages = history.slice(cutPoint)
  if (toCompact.length === 0) throw new Error('Nothing to compact')

  const priorCompaction = toCompact.find(m => m.parts.some(p => p.type === 'compaction'))
  const priorCompactionData = priorCompaction
    ? (priorCompaction.parts.find(p => p.type === 'compaction')?.data as unknown as CompactionData) ?? null
    : null
  if (priorCompactionData && priorCompactionData.version !== undefined && priorCompactionData.version > COMPACTION_VERSION) {
    console.warn(`[compaction] stored summary version ${priorCompactionData.version} > current ${COMPACTION_VERSION} — may be unreadable`)
  }
  const priorSummary = priorCompactionData?.summary ?? null

  const transcript = toCompact.map(m => {
    if (m.role === 'user') {
      const compaction = m.parts.find(p => p.type === 'compaction')
      if (compaction) return null
      const text = m.parts.find(p => p.type === 'text')
      return `User: ${((text?.data as { text?: string })?.text ?? '').slice(0, 800)}`
    }
    if (m.role === 'assistant') {
      const text = m.parts.find(p => p.type === 'text')
      const toolCalls = m.parts.filter(p => p.type === 'tool_call')
      const parts: string[] = []
      const textStr = ((text?.data as { text?: string })?.text ?? '').slice(0, 600)
      if (textStr) parts.push(`Assistant: ${textStr}`)
      if (toolCalls.length > 0) parts.push(`[Tools used: ${toolCalls.map(t => (t.data as { name?: string }).name ?? '').join(', ')}]`)
      return parts.join('\n')
    }
    return null
  }).filter(Boolean).join('\n\n')

  if (!transcript.trim() && priorCompaction) {
    return { compactionMsg: priorCompaction, keptMessages }
  }

  const modifiedFiles = extractModifiedFiles(toCompact)
  const filesSection = modifiedFiles.length > 0
    ? `\n\n## Files Modified\n${modifiedFiles.map(f => `- ${f}`).join('\n')}`
    : ''

  const userContent = priorSummary
    ? `You previously produced this summary:\n\n${priorSummary}\n\nNow update it to incorporate the following new conversation events. Preserve all still-relevant content from the previous summary. Add new progress, decisions, files, and next steps. Use the same format.\n\nNEW EVENTS:\n${transcript}${filesSection}`
    : `Produce a structured summary of this conversation using EXACTLY this format (omit any section with nothing to report):\n\n${SUMMARIZATION_FORMAT}${filesSection}\n\n---\n\nCONVERSATION:\n${transcript}`

  const { baseUrl, apiKey, model } = await getResolvedEndpointAsync()
  const res = await tauriFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      ...(usesMaxCompletionTokens(model)
        ? { max_completion_tokens: Math.min(2048, getDefaultCompletionTokenLimit(model)) }
        : { max_tokens: Math.min(2048, getDefaultCompletionTokenLimit(model)) }),
    }),
    signal,
  } as any)

  if (!res.ok) throw new Error(`Compaction LLM call failed: ${res.status}`)
  const data = await (res as any).json() as { choices?: { message?: { content?: string } }[] }
  const summary = data.choices?.[0]?.message?.content?.trim() || priorSummary || ''
  if (!summary) throw new Error('Empty compaction summary')

  const compactionMsg: Message = {
    id: makeId(),
    session_id: history[0]?.session_id ?? '',
    role: 'user',
    parts: [{
      type: 'compaction',
      data: {
        version: COMPACTION_VERSION,
        summary,
        messageCount: toCompact.length,
        fromTs: toCompact[0]?.created_at ?? 0,
        toTs: toCompact[toCompact.length - 1]?.created_at ?? 0,
      } satisfies CompactionData,
    }],
    created_at: Date.now(),
    updated_at: Date.now(),
  }
  return { compactionMsg, keptMessages }
}

// ── History → OAI conversion ──────────────────────────────────────────────────

export function historyToOAI(history: Message[]): OAIMessage[] {
  const result: OAIMessage[] = []
  const recent = history.length > HISTORY_MAX_MESSAGES
    ? history.slice(-HISTORY_MAX_MESSAGES)
    : history
  const compactedMemory = history.length > HISTORY_MAX_MESSAGES
    ? history
      .slice(0, -HISTORY_MAX_MESSAGES)
      .filter(msg => msg.parts.some(p => p.type === 'compaction'))
      .slice(-1)
    : []
  for (const msg of [...compactedMemory, ...recent]) {
    if (msg.role === 'user') {
      const compactionPart = msg.parts.find(p => p.type === 'compaction')
      if (compactionPart) {
        const d = compactionPart.data as unknown as CompactionData
        if (d.version !== undefined && d.version > COMPACTION_VERSION) {
          console.warn(`[compaction] reading summary version ${d.version} > current ${COMPACTION_VERSION} — fields may be missing`)
        }
        result.push({
          role: 'user',
          content: `[COMPACTED CONVERSATION SUMMARY — ${d.messageCount} earlier messages condensed]\n\n${d.summary}\n\n[END SUMMARY — conversation continues below]`,
        })
        continue
      }
      const textPart = msg.parts.find(p => p.type === 'text')
      const imgParts = msg.parts.filter(p => p.type === 'image_url')
      const text = (textPart?.data as { text: string })?.text ?? ''
      if (imgParts.length > 0) {
        const blocks: OAIContentBlock[] = []
        if (text) blocks.push({ type: 'text', text })
        for (const img of imgParts) {
          blocks.push({ type: 'image_url', image_url: { url: (img.data as { url: string }).url } })
        }
        result.push({ role: 'user', content: blocks })
      } else {
        result.push({ role: 'user', content: text })
      }
    } else if (msg.role === 'assistant') {
      const text = msg.parts.find(p => p.type === 'text')
      const toolCalls = msg.parts.filter(p => p.type === 'tool_call')
      const toolResults = msg.parts.filter(p => p.type === 'tool_result')
      const textContent = (text?.data as { text: string })?.text || ''
      const parsedToolCalls = toolCalls.map(p => {
        const d = p.data as { id: string; name: string; input: string }
        return { id: d.id, type: 'function' as const, function: { name: d.name, arguments: d.input } }
      })
      const parsedToolResults = toolResults.map(p => {
        const d = p.data as { tool_call_id: string; name: string; content: string }
        const modelContent = (p.data as { modelContent?: string }).modelContent ?? d.content
        if (modelContent.startsWith('__IMAGE_DATA__:')) {
          const dataUrl = modelContent.slice('__IMAGE_DATA__:'.length)
          return {
            role: 'tool' as const,
            content: [
              { type: 'text' as const, text: `Image file: ${d.name}` },
              { type: 'image_url' as const, image_url: { url: dataUrl } },
            ] as any,
            tool_call_id: d.tool_call_id,
            name: d.name,
          }
        }
        const content = modelContent.length > TOOL_RESULT_MAX
          ? modelContent.slice(0, TOOL_RESULT_MAX) + '\n…[truncated]'
          : modelContent
        return { role: 'tool' as const, content, tool_call_id: d.tool_call_id, name: d.name }
      })

      const resultIds = new Set(parsedToolResults.map(t => t.tool_call_id).filter(Boolean))
      const validToolCalls = parsedToolCalls.filter(tc => Boolean(tc.id) && resultIds.has(tc.id))
      const validCallIds = new Set(validToolCalls.map(tc => tc.id))
      const validToolResults = parsedToolResults.filter(tr => Boolean(tr.tool_call_id) && validCallIds.has(tr.tool_call_id))

      const oai: OAIMessage = { role: 'assistant', content: textContent || null }
      if (validToolCalls.length > 0) {
        oai.tool_calls = validToolCalls
      }
      if (textContent || validToolCalls.length > 0) {
        result.push(oai)
      }
      for (const tr of validToolResults) {
        result.push(tr)
      }
    }
  }
  return result
}

// ── Context size management ───────────────────────────────────────────────────

function capToolResults(history: OAIMessage[], cap: number): OAIMessage[] {
  return history.map(m => {
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > cap) {
      return { ...m, content: m.content.slice(0, cap) + '\n…[truncated for context budget]' }
    }
    return m
  })
}

export function sanitizeHistorySize(history: OAIMessage[], contextLengthTokens = 0): OAIMessage[] {
  const safeHistoryTokens = contextLengthTokens > 0
    ? Math.max(10_000, Math.floor(contextLengthTokens * 0.75) - SYSTEM_OVERHEAD_TOKENS)
    : 50_000
  if (estimateOAIHistoryTokens(history) <= safeHistoryTokens) return history

  let h = capToolResults(history, 2_000)
  if (estimateOAIHistoryTokens(h) <= safeHistoryTokens) return h

  return trimInferenceContext(h)
}

export function trimInferenceContext(history: OAIMessage[]): OAIMessage[] {
  const KEEP_TAIL = 6
  const systemMsgs = history.filter(m => m.role === 'system')
  const rest = history.filter(m => m.role !== 'system')
  if (rest.length === 0) return history

  const groups: OAIMessage[][] = []
  let droppedOrphanTools = false

  for (let i = 0; i < rest.length; i++) {
    const msg = rest[i] as any
    if (msg.role === 'assistant' && msg.tool_calls?.length > 0) {
      const group: OAIMessage[] = [rest[i]]
      const toolCallIds = new Set(
        (msg.tool_calls as Array<{ id?: string }>).map(call => call.id).filter(Boolean),
      )
      let j = i + 1
      while (j < rest.length && rest[j].role === 'tool') {
        const toolMsg = rest[j] as any
        if (toolMsg.tool_call_id && toolCallIds.has(toolMsg.tool_call_id)) {
          group.push(rest[j])
        } else {
          droppedOrphanTools = true
        }
        j++
      }
      groups.push(group)
      i = j - 1
      continue
    }

    if (msg.role === 'tool') {
      droppedOrphanTools = true
      continue
    }

    groups.push([rest[i]])
  }

  const flattenedGroups = groups.flat()
  if (flattenedGroups.length <= KEEP_TAIL + 2) {
    return droppedOrphanTools ? [...systemMsgs, ...flattenedGroups] : history
  }

  const firstUserGroupIdx = groups.findIndex(group => group[0]?.role === 'user')
  const targetRemove = Math.max(2, Math.floor(flattenedGroups.length * 0.50))
  let tailCount = 0
  let tailStartGroupIdx = groups.length
  while (tailStartGroupIdx > 0 && tailCount < KEEP_TAIL) {
    tailStartGroupIdx--
    tailCount += groups[tailStartGroupIdx].length
  }

  let removed = 0
  const keptGroups: OAIMessage[][] = []
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    if (i === firstUserGroupIdx || i >= tailStartGroupIdx) {
      keptGroups.push(group)
      continue
    }
    if (removed < targetRemove) {
      removed += group.length
      continue
    }
    keptGroups.push(group)
  }

  const trimmed = keptGroups.flat()
  if (!droppedOrphanTools && trimmed.length >= rest.length) return history
  return [...systemMsgs, ...trimmed]
}
