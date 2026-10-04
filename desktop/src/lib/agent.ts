// Agent orchestration — main loop, subagent runner, inline-edit streamer.
// Types, tools, streaming, history, and tool execution live in dedicated modules.

import { getConfig, getModelInfo } from './config'
import { MCPManager } from './mcp-manager'
import { readProjectFile } from './fs'
import { resolveSubagent, SUBAGENT_MAX_STEPS } from './subagents'
import type { SubagentDef } from './subagents'
import { useManagedAgentsStore } from '../store/managedAgentsStore'
import type { Message, MessagePart, ToolCallData } from '../types'

import type { OAIMessage, OAIContentBlock, OAIToolCall, StreamToolCall, AgentCallbacks, AgentAuditApproval, AgentAuditStatus } from './agent-types'
import { makeId, DEFAULT_AGENT_MAX_ROUNDS } from './agent-types'
import {
  estimateHistoryTokens,
  estimateOAIHistoryTokens,
  compactHistory,
  COMPACT_KEEP_TAIL,
  COMPACT_THRESHOLD,
  historyToOAI,
  sanitizeHistorySize,
  trimInferenceContext,
} from './agent-history'
import { countTokens } from './tokenCounter'
import type { MCPTool, ToolLike } from './agent-tools'
import { BUILTIN_TOOLS, MAX_SUBAGENT_PROMPT_CHARS, MAX_SUBAGENT_TASKS } from './agent-tools'
import {
  normalizeEscapedMultiline,
  resolveEditList,
  applyEditListToContent,
  getUnsafeProjectPathReason,
  unsafeProjectPathResult,
  validateToolCallArguments,
  serializeToolResultForModel,
  isReadOnlyBashCommand,
  isMCPToolReadOnly,
  redactMCPArgs,
  shouldAuditToolCall,
  classifyAuditOutcome,
  summarizeToolArgs,
  touchedFilesForTool,
  auditArgsFromJson,
} from './agent-tool-valid'
import { buildSystemPrompt } from './agent-prompts'
import { streamChat, isInferenceError, isNetworkError, isOutputOverflowError } from './agent-stream'
import { loadProjectMemory, loadSkills, loadPersonalSkills, loadCustomSkillsForSettings } from './agent-project'
import { executeBuiltinTool } from './agent-tool-exec'
import { createFigmaTaskCache } from './figma-task-cache'

// ── Re-exports for backward compatibility ─────────────────────────────────────
export { compactHistory, historyToOAI } from './agent-history'
export { isReadOnlyBashCommand, isMCPToolReadOnly, redactMCPArgs } from './agent-tool-valid'
export { loadSkills, loadPersonalSkills, loadCustomSkillsForSettings, invalidateSkillsCache } from './agent-project'
export type { Skill } from './agent-project'
export type {
  OAIMessage,
  AgentUsage,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  AgentAuditStatus,
  AgentAuditApproval,
  AgentAuditEvent,
  ContextTransformFn,
  AgentCallbacks,
} from './agent-types'

// ── Local display constants ───────────────────────────────────────────────────
// Max chars stored in message state for diff display
const DIFF_DISPLAY_MAX = 20_000
// Max chars stored in message state for tool result display
const TOOL_RESULT_DISPLAY_MAX = 4_000
const MAX_PARALLEL_SUBAGENT_EXECUTIONS = 2

function normalizeSubagentProjectPath(projectPath: string): string {
  const normalized = (projectPath || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`)
  return normalized || '/'
}

function hashSubagentCacheSegment(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

function getSubagentDefinitionCacheHash(def: SubagentDef): string {
  return hashSubagentCacheSegment(JSON.stringify({
    id: def.id,
    label: def.label,
    description: def.description,
    writable: def.writable,
    model: def.model ?? '',
    systemPrompt: def.systemPrompt,
    tools: [...def.tools].sort(),
  }))
}

// ── Subagent result cache ──────────────────────────────────────────────────────
// Only caches read-only subagent types (explore, code-review, security, general).
// Write-capable subagents (coder, fixer) always bypass cache due to filesystem side effects.
class SubagentCache {
  private cache = new Map<string, { result: string; timestamp: number }>()
  private readonly TTL_MS = 60_000

  private buildKey(projectPath: string, def: SubagentDef, prompt: string): string | null {
    if (prompt.length > 500) return null // don't cache long prompts
    return [
      normalizeSubagentProjectPath(projectPath),
      String(def.id),
      getSubagentDefinitionCacheHash(def),
      hashSubagentCacheSegment(prompt),
    ].join('|')
  }

  get(projectPath: string, def: SubagentDef, prompt: string): string | null {
    const key = this.buildKey(projectPath, def, prompt)
    if (!key) return null
    const entry = this.cache.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > this.TTL_MS) {
      this.cache.delete(key)
      return null
    }
    return entry.result
  }

  set(projectPath: string, def: SubagentDef, prompt: string, result: string): void {
    const key = this.buildKey(projectPath, def, prompt)
    if (!key) return
    this.cache.set(key, { result, timestamp: Date.now() })
  }

  invalidate(): void {
    this.cache.clear()
  }
}

const subagentCache = new SubagentCache()

type SubagentTask = { type: string; prompt: string; label?: string }

function validateRunSubagentTasks(
  tasks: SubagentTask[],
  customSubagents: ReturnType<typeof getConfig>['customSubagents'],
): string | null {
  if (tasks.length > MAX_SUBAGENT_TASKS) {
    return `Error: run_subagents supports at most ${MAX_SUBAGENT_TASKS} tasks per call`
  }
  const malformed = tasks.find(task => typeof task?.type !== 'string' || typeof task?.prompt !== 'string')
  if (malformed) {
    return 'Error: each run_subagents task must include string type and prompt fields'
  }
  const oversized = tasks.find(task => task.prompt.length > MAX_SUBAGENT_PROMPT_CHARS)
  if (oversized) {
    return `Error: subagent prompt for "${oversized.label ?? oversized.type}" exceeds the ${MAX_SUBAGENT_PROMPT_CHARS}-character limit`
  }
  const invalid = tasks.find(task => !resolveSubagent(task.type, customSubagents))
  if (invalid) {
    return `Error: unknown subagent type "${invalid.type}"`
  }
  return null
}

async function runSubagentTasksWithLimit(
  projectPath: string,
  tasks: SubagentTask[],
  callbacks: AgentCallbacks,
  signal: AbortSignal | undefined,
  parentCallId: string | undefined,
): Promise<Array<{ label: string; out: string }>> {
  const results: Array<{ label: string; out: string }> = new Array(tasks.length)
  let nextIndex = 0
  const workerCount = Math.min(MAX_PARALLEL_SUBAGENT_EXECUTIONS, tasks.length)

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      if (signal?.aborted) return
      const index = nextIndex++
      if (index >= tasks.length) return
      const task = tasks[index]
      try {
        const out = await runSubagentInline(
          projectPath,
          task.type,
          task.prompt,
          callbacks,
          signal,
          parentCallId,
          callbacks.onSubagentPart,
        )
        results[index] = { label: task.label ?? task.type, out }
      } catch (err) {
        results[index] = {
          label: task.label ?? task.type,
          out: `Error: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
  }))

  return results.map((entry, index) => entry ?? {
    label: tasks[index].label ?? tasks[index].type,
    out: 'Aborted',
  })
}

// ── Subagent runner ───────────────────────────────────────────────────────────

async function runSubagentInline(
  projectPath: string,
  type: string,
  prompt: string,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  parentCallId?: string,
  onSubagentPart?: (subagentType: string, part: MessagePart) => void,
): Promise<string> {
  const cfg = getConfig()
  const def = resolveSubagent(type, cfg.customSubagents)
  if (!def) return `Error: unknown subagent type "${type}"`

  // Cache check for read-only subagents
  if (!def.writable) {
    const cached = subagentCache.get(projectPath, def, prompt)
    if (cached !== null) {
      console.log(`[subagent] cache hit for ${type}`)
      return cached
    }
  }

  const subagentTools = BUILTIN_TOOLS.filter(t => def.tools.includes(t.function.name))

  const messages: OAIMessage[] = [
    { role: 'system', content: def.systemPrompt },
    { role: 'user', content: prompt },
  ]

  // Write-capable subagents use the inline permission callback. The richer approval
  // request flow needs a rendered message part owned by the main agent loop.
  let subagentAuditApproval: AgentAuditApproval = 'not_required'
  const subagentApproval: ((tool: string, args: string) => Promise<boolean>) | undefined =
    def.writable && callbacks.onPermissionRequest
      ? async (tool, args) => {
          subagentAuditApproval = 'requested'
          const approved = await callbacks.onPermissionRequest!(tool, args)
          subagentAuditApproval = approved ? 'approved' : 'rejected'
          return approved
        }
      : undefined

  let stepCount = 0
  let finalText = ''

  const { contextLength: subagentContextLength, smallOutput: subagentSmallOutput } = getModelInfo(def.model)

  while (stepCount < SUBAGENT_MAX_STEPS) {
    if (signal?.aborted) break

    // Guard against context overflow in long subagent runs
    const sanitized = sanitizeHistorySize(messages, subagentContextLength)

    let text = ''
    let toolCalls: StreamToolCall[] = []
    let finishReason = ''

    for await (const chunk of streamChat(sanitized, subagentTools, signal, def.model, callbacks.effortLevel)) {
      if (signal?.aborted) break
      if (chunk.text) {
        text += chunk.text
        if (onSubagentPart && chunk.text) {
          onSubagentPart(type, { type: 'subagent_text', data: { subagentType: type, text: chunk.text } })
        }
      }
      if (chunk.toolCalls) toolCalls = chunk.toolCalls
      if (chunk.finishReason) finishReason = chunk.finishReason
    }

    finalText = text

    const assistantMsg: OAIMessage = { role: 'assistant', content: text || null }
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((tc, i) => ({
        id: tc.id || `call_${stepCount}_${i}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
    }
    messages.push(assistantMsg)

    if (finishReason !== 'tool_calls' || toolCalls.length === 0) break

    // Enforce tool whitelist — model sees only whitelisted tools, double-check here
    const allowedSubagentTools = new Set(def.tools)
    for (const tc of toolCalls) {
      const tcId = tc.id || `call_${stepCount}_${makeId()}`
      const auditStartedAt = Date.now()
      let auditArgs = auditArgsFromJson(tc.arguments)
      subagentAuditApproval = 'not_required'
      const emitSubagentAudit = (
        auditResult: string,
        auditIsError: boolean,
        overrides: { status?: AgentAuditStatus; errorCategory?: string } = {},
      ) => {
        if (!callbacks.onAuditEvent || !shouldAuditToolCall(tc.name, auditArgs)) return
        const classified = classifyAuditOutcome(auditResult, auditIsError)
        callbacks.onAuditEvent({
          id: `audit-${Date.now()}-${makeId()}`,
          timestamp: Date.now(),
          toolName: tc.name,
          argsSummary: { ...summarizeToolArgs(tc.name, auditArgs), subagent: type },
          touchedFiles: touchedFilesForTool(tc.name, auditArgs),
          approval: subagentAuditApproval,
          status: overrides.status ?? classified.status,
          errorCategory: overrides.errorCategory ?? classified.errorCategory,
          durationMs: Date.now() - auditStartedAt,
          parentCallId,
        })
      }

      const SUBAGENT_SPAWN_TOOLS = new Set(['run_subagent', 'run_subagents', 'run_subagent_chain'])
      if (SUBAGENT_SPAWN_TOOLS.has(tc.name)) {
        const denied = `Error: subagents cannot spawn other subagents`
        messages.push({ role: 'tool', content: serializeToolResultForModel(tc.name, denied, true), tool_call_id: tcId, name: tc.name })
        emitSubagentAudit(denied, true, { status: 'blocked', errorCategory: 'tool_not_allowed' })
        continue
      }

      if (!allowedSubagentTools.has(tc.name)) {
        const denied = `Error: tool "${tc.name}" is not permitted for subagent type "${type}". Allowed: ${def.tools.join(', ')}`
        messages.push({ role: 'tool', content: serializeToolResultForModel(tc.name, denied, true), tool_call_id: tcId, name: tc.name })
        emitSubagentAudit(denied, true, { status: 'blocked', errorCategory: 'tool_not_allowed' })
        continue
      }
      const validation = validateToolCallArguments(tc.name, tc.arguments, subagentTools as ToolLike[])
      if ('error' in validation) {
        const invalid = `Error: invalid arguments for ${tc.name}: ${validation.error}`
        messages.push({ role: 'tool', content: serializeToolResultForModel(tc.name, invalid, true), tool_call_id: tcId, name: tc.name })
        emitSubagentAudit(invalid, true, { status: 'invalid', errorCategory: 'invalid_arguments' })
        continue
      }
      auditArgs = validation.args
      if (onSubagentPart) {
        onSubagentPart(type, { type: 'subagent_tool_call', data: { subagentType: type, call: { id: tcId, name: tc.name, input: tc.arguments, finished: false } } })
      }
      const result = await executeBuiltinTool(projectPath, tc.name, validation.normalizedArgsJson, callbacks.onFilesChanged, subagentApproval, callbacks.onServerStarted, undefined, subagentSmallOutput)
      messages.push({ role: 'tool', content: serializeToolResultForModel(tc.name, result, result.startsWith('Error:')), tool_call_id: tcId, name: tc.name })
      if (onSubagentPart) {
        onSubagentPart(type, { type: 'subagent_tool_result', data: { subagentType: type, result: { tool_call_id: tcId, name: tc.name, content: result, is_error: result.startsWith('Error:') } } })
      }
      emitSubagentAudit(result, result.startsWith('Error:'))
    }

    stepCount++
  }

  if (!def.writable && finalText) {
    subagentCache.set(projectPath, def, prompt, finalText)
  }
  return finalText || '(subagent returned no output)'
}

// ── Main agent loop ───────────────────────────────────────────────────────────

export async function runAgent(
  projectPath: string,
  history: Message[],
  userText: string,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
  imageUrls?: string[],
): Promise<void> {
  const cfg = getConfig()
  const { contextLength: modelContextLength, smallOutput: modelSmallOutput } = getModelInfo(callbacks.modelOverride)
  let useSmallOutput = modelSmallOutput

  // Auto-compact if history token count exceeds threshold (Pi-style).
  // Summarizes oldest messages into a single compaction entry so the agent
  // always has headroom — no silent truncation or 502 context-overflow errors.
  if (callbacks.onCompactionDone) {
    const windowTokens = modelContextLength > 0 ? modelContextLength : 128_000
    const histTokens = estimateHistoryTokens(history) + countTokens(userText)
    if (histTokens > windowTokens * (cfg.behavior.autoCompactThreshold ?? COMPACT_THRESHOLD)) {
      try {
        const { compactionMsg, keptMessages } = await compactHistory(history, COMPACT_KEEP_TAIL, signal)
        callbacks.onCompactionDone(compactionMsg, keptMessages)
        history = [compactionMsg, ...keptMessages]
      } catch (e) {
        console.warn('[compaction] failed, proceeding with full history:', e)
      }
    }
  }

  const mcpManager = new MCPManager(projectPath)
  try {
    const figmaTask = createFigmaTaskCache({
      sessionId: callbacks.getSessionId?.() ?? null,
      taskId: makeId(),
      userText,
    })
    const enabledServers = (cfg.mcpServers ?? []).filter(s => !s.disabled)
    const mcpToolsFlat: MCPTool[] = []
    const serverMap = new Map<string, string>() // toolId -> toolRawName
    const mcpAnnotations = new Map<string, MCPTool['annotations']>() // toolId -> annotations

    const MCP_INIT_TIMEOUT_MS = 15_000

    for (const server of enabledServers) {
      try {
        const mcpInitAbort = new AbortController()
        const mcpInitTimer = setTimeout(() => mcpInitAbort.abort(), MCP_INIT_TIMEOUT_MS)
        const serverInstance = await mcpManager.initServer(server, mcpInitAbort.signal)
          .finally(() => clearTimeout(mcpInitTimer))
        if (!serverInstance) throw new Error(`MCP "${server.name}" init timed out or failed after ${MCP_INIT_TIMEOUT_MS / 1000}s`)
        if (serverInstance && serverInstance.tools.length > 0) {
          for (const tool of serverInstance.tools) {
            const toolId = `${server.name}__${tool.name}`
            mcpToolsFlat.push({
              serverId: server.id,
              serverName: server.name,
              name: toolId,
              description: `[${server.name}] ${tool.description ?? tool.name}`,
              inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
              annotations: tool.annotations,
            })
            serverMap.set(toolId, tool.name)
            if (tool.annotations) mcpAnnotations.set(toolId, tool.annotations)
          }
          console.log(`✓ Loaded ${serverInstance.tools.length} tools from ${server.type} server: ${server.name}`)
        } else if (serverInstance) {
          console.warn(`Server "${server.name}" (${server.type}) initialized but no tools discovered`)
        }
      } catch (err) {
        console.error(`Failed to initialize MCP server ${server.name} (${server.type}):`, err)
      }
    }

    // Build full tool list: built-ins + MCP, then restrict by agent's allowedTools if set.
    // This enforces tool restrictions in code — not just via prompt instructions — so
    // planning/design agents cannot accidentally call write_file or bash even under
    // ambiguous prompts.
    const allowedSet = callbacks.agentAllowedTools ? new Set(callbacks.agentAllowedTools) : null
    const pluginTools = callbacks.pluginHookRegistry
      ? callbacks.pluginManagerRef?.getPluginToolDefinitions() ?? []
      : []
    const allTools = [
      ...BUILTIN_TOOLS,
      ...mcpToolsFlat.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      ...pluginTools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    ].filter(t => !allowedSet || allowedSet.has(t.function.name))

    // Load project memory (BETOPIA.md / CLAUDE.md / AGENTS.md) — cached 30s
    const projectMemory = await loadProjectMemory(projectPath)
    // Load skills from .betopia/skills/ — cached 30s
    const skills = await loadSkills(projectPath)

    let finalUserContent: string | OAIContentBlock[]
    if (imageUrls && imageUrls.length > 0) {
      const blocks: OAIContentBlock[] = []
      if (userText) blocks.push({ type: 'text', text: userText })
      for (const url of imageUrls) {
        blocks.push({ type: 'image_url', image_url: { url } })
      }
      finalUserContent = blocks
    } else {
      finalUserContent = userText
    }

    let oaiHistory: OAIMessage[] = [
      { role: 'system', content: buildSystemPrompt(callbacks.agentPersona, callbacks.customInstructions, projectMemory, mcpToolsFlat, callbacks.permissionMode, skills, projectPath, useSmallOutput) },
      ...historyToOAI(history),
      { role: 'user', content: finalUserContent },
    ]

    const parts: MessagePart[] = []

  // Throttle streaming updates — only flush to React every 80ms during text/think
  // chunks to avoid hundreds of re-renders/sec freezing the WebView.
  let _flushTimer: ReturnType<typeof setTimeout> | null = null
  let _pendingFlush = false
  const flushParts = () => { callbacks.onPartsUpdate([...parts]); _pendingFlush = false; _flushTimer = null }
  const scheduledFlush = () => {
    if (_pendingFlush) return
    _pendingFlush = true
    _flushTimer = setTimeout(flushParts, 80)
  }
  const immediateFlush = () => {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
    flushParts()
  }

  const pushPart = (p: MessagePart) => { parts.push(p); immediateFlush() }

  const updateLastText = (text: string) => {
    const last = parts[parts.length - 1]
    if (last?.type === 'text') {
      ;(last.data as { text: string }).text += text
    } else {
      parts.push({ type: 'text', data: { text } })
    }
    scheduledFlush()
  }

  const updateLastThink = (text: string) => {
    const last = parts[parts.length - 1]
    if (last?.type === 'reasoning') {
      ;(last.data as { thinking: string }).thinking += text
    } else {
      parts.push({ type: 'reasoning', data: { thinking: text } })
    }
    scheduledFlush()
  }

  let inferenceFailedRounds = 0  // rounds where inference needed at least one retry
  let inferenceExtraBackoffMs = 0 // grows when consecutive flaky rounds detected

  for (let round = 0; round < (callbacks.maxRounds ?? DEFAULT_AGENT_MAX_ROUNDS); round++) {
    if (signal?.aborted) {
      await mcpManager.shutdownAll()
      break
    }

    // Circuit breaker: if the API has been consistently flaky, add backoff before each round
    if (inferenceExtraBackoffMs > 0) {
      await new Promise<void>(r => setTimeout(r, inferenceExtraBackoffMs))
    }

    let collectedToolCalls: StreamToolCall[] = []
    let finishReason = ''
    let roundInputTokens = 0
    let roundOutputTokens = 0
    let roundUsedRetry = false
    let roundCachedTokens = 0

    // Pre-sanitize: cap tool results and remove old pairs if history is too large.
    // Always done before the first attempt to prevent 502s proactively.
    const sanitized = sanitizeHistorySize(oaiHistory, modelContextLength)

    // Retry up to 3 times on inference/502 or transient network errors.
    // 502 "Unterminated string" means the backend truncated the model output
    // mid-JSON (usually a large tool call argument). Trimming context gives the
    // backend more output headroom.
    // Network errors (e.g. "error decoding response body") retry with a short
    // delay — these are usually transient connection drops.
    for (let attempt = 0; attempt < 3; attempt++) {
      let histToSend = attempt === 0 ? sanitized : sanitizeHistorySize(oaiHistory, modelContextLength)
      // transformContext: caller can prune, inject RAG context, etc. — runs every LLM call
      if (callbacks.transformContext) {
        try { histToSend = await callbacks.transformContext(histToSend) } catch (e) {
          console.warn('[transformContext] hook threw, proceeding with original context:', e)
        }
      }
      // ── Plugin transformContext hooks ──────────────────────────────────────────
      if (callbacks.pluginHookRegistry) {
        try {
          histToSend = (await callbacks.pluginHookRegistry.dispatchTransformContext(
            histToSend,
            { sessionId: callbacks.getSessionId?.() ?? null, projectPath, pluginId: 'agent' },
          )) as OAIMessage[]
        } catch (e) {
          console.warn('[plugin transformContext] hook threw, proceeding with original context:', e)
        }
      }
      let streamErr: unknown = null
      try {
        for await (const chunk of streamChat(histToSend, allTools, signal, callbacks.modelOverride, callbacks.effortLevel)) {
          if (signal?.aborted) break
          if (chunk.thinkText) updateLastThink(chunk.thinkText)
          if (chunk.text) updateLastText(chunk.text)
          if (chunk.toolCalls) collectedToolCalls = chunk.toolCalls
          if (chunk.finishReason) finishReason = chunk.finishReason
          if (chunk.usage) {
            roundInputTokens = chunk.usage.inputTokens
            roundOutputTokens = chunk.usage.outputTokens
            roundCachedTokens = chunk.usage.cachedInputTokens
          }
        }
      } catch (e) {
        streamErr = e
        console.error(`[inference] attempt ${attempt + 1} error:`, e)
      }

      if (!streamErr) break  // success

      if (isInferenceError(streamErr)) {
        if (attempt < 2) {
          // Aggressively trim oaiHistory so next attempt sends less
          oaiHistory = trimInferenceContext(oaiHistory)
          collectedToolCalls = []; finishReason = ''; roundInputTokens = 0; roundOutputTokens = 0; roundCachedTokens = 0
          if (attempt === 0) {
            roundUsedRetry = true
            const isOverflow = isOutputOverflowError(streamErr)
            const retryMsg = isOverflow
              ? '\n[Retrying — inference crashed mid-output, trimming context…]'
              : '\n[Retrying — backend error, trimming context…]'
            pushPart({ type: 'text', data: { text: retryMsg } })
            immediateFlush()
            // Escalate to skeleton-first mode for unclassified models that hit an output OOM
            if (isOverflow && !useSmallOutput) {
              useSmallOutput = true
              oaiHistory[0] = { role: 'system', content: buildSystemPrompt(callbacks.agentPersona, callbacks.customInstructions, projectMemory, mcpToolsFlat, callbacks.permissionMode, skills, projectPath, useSmallOutput) }
            }
          }
          continue
        }
        // After 3 attempts, classify the failure for a precise user message.
        const approxTokens = estimateOAIHistoryTokens(oaiHistory) + 32_000
        const windowTokens = modelContextLength > 0 ? modelContextLength : 128_000
        const rawDetail = streamErr instanceof Error ? streamErr.message : String(streamErr)
        if (approxTokens > windowTokens * 0.85) {
          throw new Error(`Inference failed — context too large. Use /compact to summarize the conversation, then try again.`)
        }
        if (isOutputOverflowError(streamErr)) {
          throw new Error(`The model crashed generating the response — the output was too large for the inference backend. Try asking for a smaller piece at a time, or switch to a model with a larger output window.\n[${rawDetail}]`)
        }
        throw new Error(`Inference failed after ${attempt + 1} attempts — the backend returned an error. If this keeps happening, try a different model or wait a moment.\n[${rawDetail}]`)
      }

      if (isNetworkError(streamErr)) {
        if (attempt < 2) {
          // Brief wait before retry — transient connection drops usually recover in seconds
          await new Promise<void>(r => setTimeout(r, 2000 * (attempt + 1)))
          collectedToolCalls = []; finishReason = ''; roundInputTokens = 0; roundOutputTokens = 0; roundCachedTokens = 0
          if (attempt === 0) {
            roundUsedRetry = true
            pushPart({ type: 'text', data: { text: '\n[Retrying — network error, waiting for connection…]' } })
            immediateFlush()
          }
          continue
        }
        throw new Error(`Network error after ${attempt + 1} attempts: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`)
      }

      throw streamErr
    }

    // Cross-round circuit breaker: track consecutive rounds that needed retries.
    // After 3, alert user and add inter-round backoff (caps at 5s).
    if (roundUsedRetry) {
      inferenceFailedRounds++
      if (inferenceFailedRounds === 3) {
        pushPart({ type: 'text', data: { text: '\n⚠️ The AI service has been unstable for several rounds. Check your API key, network, or try a different model.' } })
        immediateFlush()
      }
      inferenceExtraBackoffMs = Math.min(inferenceExtraBackoffMs + 1000, 5000)
    } else {
      inferenceFailedRounds = 0
      inferenceExtraBackoffMs = 0
    }

    if (roundInputTokens > 0 && callbacks.onUsage) {
      callbacks.onUsage({
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cachedInputTokens: roundCachedTokens,
        lastInputTokens: roundInputTokens,
      })
    }
    // Flush any buffered text before processing tool calls
    immediateFlush()

    if (signal?.aborted) break

    if (collectedToolCalls.length === 0) {
      pushPart({ type: 'finish', data: { reason: finishReason, time: Date.now() } })
      // Cleanup MCP servers
      await mcpManager.shutdownAll()
      break
    }

    // Normalize tool call IDs once so assistant/tool messages always match.
    const normalizedToolCalls = collectedToolCalls.map(tc => ({
      ...tc,
      id: tc.id || `call_${makeId()}`,
    }))

    // Append assistant message with tool_calls to history
    oaiHistory.push({
      role: 'assistant',
      content: null,
      tool_calls: normalizedToolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    // ── Parallel Tool Execution (Pi-style) ───────────────────────────────────────
    // 1. Show all tool_call placeholders immediately so the user sees the full batch.
    for (const tc of normalizedToolCalls) {
      const displayInput = tc.arguments.length > TOOL_RESULT_DISPLAY_MAX
        ? tc.arguments.slice(0, TOOL_RESULT_DISPLAY_MAX) + '…[truncated]'
        : tc.arguments
      pushPart({ type: 'tool_call', data: { id: tc.id, name: tc.name, input: displayInput, finished: false } })
      callbacks.onToolStart?.(tc.name, tc.arguments)
    }
    immediateFlush()

    // Mutate an existing tool_call part in-place for live progress updates (elapsed, preview).
    const mutateToolCallPart = (callId: string, patch: Partial<ToolCallData>) => {
      const idx = parts.findIndex(p => p.type === 'tool_call' && (p.data as ToolCallData).id === callId)
      if (idx !== -1) Object.assign(parts[idx].data, patch)
      scheduledFlush()
    }

    // Per-file write serializer: mutations to the same path run in-order even when
    // the rest of the batch runs in parallel. Prevents partial-overwrite races.
    const fileQueues = new Map<string, Promise<void>>()
    function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
      const prev = fileQueues.get(filePath) ?? Promise.resolve()
      let release!: () => void
      const held = new Promise<void>(r => { release = r })
      fileQueues.set(filePath, prev.then(() => held))
      return prev.then(() => fn().finally(() => release())) as Promise<T>
    }

    // 2. Execute all tools concurrently.
    //    UI parts (tool_result) are pushed as each tool finishes (completion order).
    //    oaiHistory is committed in source order after all complete (OAI API requirement).
    type ToolExecutionOutcome = { result: string; modelContent: string; terminate: boolean }
    const makeToolOutcome = (toolName: string, result: string, isError: boolean, terminate = false): ToolExecutionOutcome => ({
      result,
      modelContent: serializeToolResultForModel(toolName, result, isError),
      terminate,
    })

    // Per-tool execution logic (used by both parallel and sequential modes)
    const executeTool = async (tc: StreamToolCall): Promise<ToolExecutionOutcome> => {
      // Yield to the event loop between tool starts so React can flush pending updates.
      await new Promise<void>(r => setTimeout(r, 0))

      const callId = tc.id
      const isMCPTool = serverMap.has(tc.name)
      const yoloMode = callbacks.permissionMode === 'full_access'
        ? true
        : callbacks.permissionMode
          ? false
          : getConfig().behavior.yoloMode
      let result = ''
      let shouldTerminate = false
      const auditStartedAt = Date.now()
      let auditArgs = auditArgsFromJson(tc.arguments)
      let auditApproval: AgentAuditApproval = 'not_required'

      const emitAudit = (
        auditResult: string,
        auditIsError: boolean,
        overrides: { status?: AgentAuditStatus; errorCategory?: string } = {},
      ) => {
        if (!callbacks.onAuditEvent || !shouldAuditToolCall(tc.name, auditArgs)) return
        const classified = classifyAuditOutcome(auditResult, auditIsError)
        callbacks.onAuditEvent({
          id: `audit-${Date.now()}-${makeId()}`,
          timestamp: Date.now(),
          toolName: tc.name,
          argsSummary: summarizeToolArgs(tc.name, auditArgs),
          touchedFiles: touchedFilesForTool(tc.name, auditArgs),
          approval: auditApproval,
          status: overrides.status ?? classified.status,
          errorCategory: overrides.errorCategory ?? classified.errorCategory,
          durationMs: Date.now() - auditStartedAt,
        })
      }

      if (signal?.aborted) {
        const outcome = makeToolOutcome(tc.name, 'Aborted', true)
        emitAudit('Aborted', true, { status: 'aborted', errorCategory: 'aborted' })
        return outcome
      }

      try {
        // ── beforeToolCall hook (agent-level) ────────────────────────────────────
        // Runs before approval checks and execution. Can block or mutate args.
        if (callbacks.beforeToolCall) {
          let parsedArgs: Record<string, unknown> = {}
          try { parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown> } catch { /* ok */ }
          const beforeResult = await callbacks.beforeToolCall({ toolName: tc.name, toolArgs: tc.arguments, parsedArgs })
          if (beforeResult?.block) {
            const reason = beforeResult.reason ?? 'Tool call blocked.'
            const outcome = makeToolOutcome(tc.name, reason, true)
            const tcIdx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
            if (tcIdx !== -1) (parts[tcIdx].data as { finished: boolean }).finished = true
            pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: reason, is_error: true, modelContent: outcome.modelContent } })
            immediateFlush()
            emitAudit(reason, true, { status: 'blocked', errorCategory: 'blocked_by_hook' })
            return outcome
          }
          if (beforeResult?.args) {
            tc = { ...tc, arguments: beforeResult.args }
            auditArgs = auditArgsFromJson(tc.arguments)
          }
        }

        // ── Plugin beforeToolCall hooks ─────────────────────────────────────────
        if (callbacks.pluginHookRegistry) {
          let parsedArgs: Record<string, unknown> = {}
          try { parsedArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const pluginResult = await callbacks.pluginHookRegistry.dispatchBeforeToolCall(
            { toolName: tc.name, toolArgs: tc.arguments, parsedArgs },
            { sessionId: callbacks.getSessionId?.() ?? null, projectPath, pluginId: 'agent' },
          )
          if (pluginResult?.type === 'block') {
            const reason = pluginResult.reason
            const outcome = makeToolOutcome(tc.name, reason, true)
            const tcIdx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
            if (tcIdx !== -1) (parts[tcIdx].data as { finished: boolean }).finished = true
            pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: reason, is_error: true, modelContent: outcome.modelContent } })
            immediateFlush()
            emitAudit(reason, true, { status: 'blocked', errorCategory: 'blocked_by_plugin' })
            return outcome
          }
          if (pluginResult?.type === 'modify') {
            tc = { ...tc, arguments: JSON.stringify(pluginResult.toolCall.parsedArgs) }
            auditArgs = auditArgsFromJson(tc.arguments)
          }
        }

        const validation = validateToolCallArguments(tc.name, tc.arguments, allTools as ToolLike[])
        if ('error' in validation) {
          const validationResult = `Error: invalid arguments for ${tc.name}: ${validation.error}`
          const outcome = makeToolOutcome(tc.name, validationResult, true)
          const tcIdx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
          if (tcIdx !== -1) (parts[tcIdx].data as { finished: boolean }).finished = true
          pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: validationResult, is_error: true, modelContent: outcome.modelContent } })
          immediateFlush()
          emitAudit(validationResult, true, { status: 'invalid', errorCategory: 'invalid_arguments' })
          return outcome
        }
        tc = { ...tc, arguments: validation.normalizedArgsJson }
        auditArgs = validation.args

        // ── Approval: write_file / edit ──────────────────────────────────────────
        if (!yoloMode && callbacks.onApprovalRequired && !isMCPTool && (tc.name === 'write_file' || tc.name === 'edit')) {
          let toolArgs: Record<string, any> = {}
          try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const filePath = String(toolArgs.path ?? '')
          const unsafeReason = getUnsafeProjectPathReason(filePath)
          if (unsafeReason) {
            const unsafeResult = unsafeProjectPathResult(filePath)
            const outcome = makeToolOutcome(tc.name, unsafeResult, true)
            const tcIdx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
            if (tcIdx !== -1) (parts[tcIdx].data as { finished: boolean }).finished = true
            pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: unsafeResult, is_error: true, modelContent: outcome.modelContent } })
            immediateFlush()
            emitAudit(unsafeResult, true, { status: 'error', errorCategory: 'unsafe_path' })
            return outcome
          }

          const originalContent = filePath ? await readProjectFile(projectPath, filePath).catch(() => '') : ''
          let proposedContent = originalContent

          if (tc.name === 'write_file') {
            proposedContent = normalizeEscapedMultiline(String(toolArgs.content ?? ''))
          } else if (tc.name === 'edit') {
            const editList = resolveEditList(toolArgs)
            if (editList) {
              const applied = applyEditListToContent(originalContent, editList)
              if (!('error' in applied)) proposedContent = applied.content
            }
          }

          const approvalId = makeId()
          pushPart({
            type: 'approval_request',
            data: {
              id: approvalId, toolName: tc.name, path: filePath,
              originalContent: originalContent.length > DIFF_DISPLAY_MAX ? originalContent.slice(0, DIFF_DISPLAY_MAX) + '\n…(truncated for display)' : originalContent,
              proposedContent: proposedContent.length > DIFF_DISPLAY_MAX ? proposedContent.slice(0, DIFF_DISPLAY_MAX) + '\n…(truncated for display)' : proposedContent,
              isNewFile: !originalContent, status: 'pending',
            },
          })
          immediateFlush()

          const fileMode = callbacks.permissionMode ?? 'default'
          if (fileMode !== 'auto_review' && fileMode !== 'full_access') {
            auditApproval = 'requested'
            const fileApproved = Boolean(await callbacks.onApprovalRequired(approvalId, tc.name))
            const apprIdx = parts.findIndex(p => p.type === 'approval_request' && (p.data as { id: string }).id === approvalId)
            if (apprIdx !== -1) (parts[apprIdx].data as { status: string }).status = fileApproved ? 'approved' : 'rejected'
            immediateFlush()
            if (!fileApproved) {
              auditApproval = 'rejected'
              const tcIdx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
              if (tcIdx !== -1) (parts[tcIdx].data as { finished: boolean }).finished = true
              const rejectResult = `Permission denied: user declined to write: ${filePath}`
              const outcome = makeToolOutcome(tc.name, rejectResult, false)
              pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: rejectResult, is_error: false, modelContent: outcome.modelContent } })
              immediateFlush()
              emitAudit(rejectResult, false, { status: 'denied', errorCategory: 'permission_denied' })
              return outcome
            }
            auditApproval = 'approved'
          } else {
            auditApproval = 'auto_approved'
            void callbacks.onApprovalRequired(approvalId, tc.name)
            const apprIdx = parts.findIndex(p => p.type === 'approval_request' && (p.data as { id: string }).id === approvalId)
            if (apprIdx !== -1) (parts[apprIdx].data as { status: string }).status = 'approved'
          }
        }

        // ── Approval: bash ───────────────────────────────────────────────────────
        if (!yoloMode && callbacks.onApprovalRequired && !isMCPTool && tc.name === 'bash') {
          let bashArgs: Record<string, any> = {}
          try { bashArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const bashCommand = String(bashArgs.command ?? '')

          if (!isReadOnlyBashCommand(bashCommand)) {
            auditApproval = 'requested'
            const approvalId = makeId()
            pushPart({
              type: 'approval_request',
              data: {
                id: approvalId, toolName: 'bash', path: '', command: bashCommand,
                originalContent: '', proposedContent: '', isNewFile: false, status: 'pending',
              },
            })
            immediateFlush()

            const bashApproved = Boolean(await callbacks.onApprovalRequired(approvalId, 'bash'))
            const bapprIdx = parts.findIndex(p => p.type === 'approval_request' && (p.data as { id: string }).id === approvalId)
            if (bapprIdx !== -1) (parts[bapprIdx].data as { status: string }).status = bashApproved ? 'approved' : 'rejected'
            immediateFlush()

            if (!bashApproved) {
              auditApproval = 'rejected'
              const tcIdx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
              if (tcIdx !== -1) (parts[tcIdx].data as { finished: boolean }).finished = true
              const rejectResult = `Permission denied: user declined to run: ${bashCommand}`
              const outcome = makeToolOutcome(tc.name, rejectResult, false)
              pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: rejectResult, is_error: false, modelContent: outcome.modelContent } })
              immediateFlush()
              emitAudit(rejectResult, false, { status: 'denied', errorCategory: 'permission_denied' })
              return outcome
            }
            auditApproval = 'approved'
          }
        }

        // ── Approval: MCP tools ──────────────────────────────────────────────────
        // Read-only tools (by annotation or name heuristic) skip approval, like read-only bash.
        if (!yoloMode && callbacks.onApprovalRequired && isMCPTool &&
            !isMCPToolReadOnly(tc.name, mcpAnnotations.get(tc.name))) {
          let parsedArgs: Record<string, any> = {}
          try { parsedArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const mcpCommand = `${tc.name}(${JSON.stringify(redactMCPArgs(parsedArgs), null, 2)})`
          const approvalId = makeId()

          auditApproval = 'requested'
          pushPart({
            type: 'approval_request',
            data: { id: approvalId, toolName: tc.name, path: '', command: mcpCommand, originalContent: '', proposedContent: '', isNewFile: false, status: 'pending' },
          })
          immediateFlush()

          const mcpApproved = Boolean(await callbacks.onApprovalRequired(approvalId, tc.name))
          const mapprIdx = parts.findIndex(p => p.type === 'approval_request' && (p.data as { id: string }).id === approvalId)
          if (mapprIdx !== -1) (parts[mapprIdx].data as { status: string }).status = mcpApproved ? 'approved' : 'rejected'
          immediateFlush()

          if (!mcpApproved) {
            auditApproval = 'rejected'
            const tcIdx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
            if (tcIdx !== -1) (parts[tcIdx].data as { finished: boolean }).finished = true
            const rejectResult = `Permission denied: user declined MCP tool: ${tc.name}`
            const outcome = makeToolOutcome(tc.name, rejectResult, false)
            pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: rejectResult, is_error: false, modelContent: outcome.modelContent } })
            immediateFlush()
            emitAudit(rejectResult, false, { status: 'denied', errorCategory: 'permission_denied' })
            return outcome
          }
          auditApproval = 'approved'
        }

        // ── Execute ──────────────────────────────────────────────────────────────
        if (isMCPTool) {
          let parsedArgs: unknown = {}
          try { parsedArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const serverName = tc.name.split('__')[0] ?? ''
          const rawToolName = serverMap.get(tc.name) ?? tc.name
          result = await figmaTask.run(
            {
              kind: 'tool',
              serverName,
              toolName: rawToolName,
              args: parsedArgs as Record<string, unknown>,
              rawArgsJson: tc.arguments,
            },
            () => mcpManager.callTool(tc.name, parsedArgs),
          )
        } else if (tc.name === 'mcp_list_resources') {
          let toolArgs: Record<string, any> = {}
          try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const serverName = String(toolArgs.server_name ?? '')
          const mcpServer = enabledServers.find(s => s.name === serverName)
          if (!mcpServer) {
            result = `Error: MCP server "${serverName}" not found or not enabled`
          } else {
            try {
              result = await figmaTask.run(
                {
                  kind: 'resource',
                  serverName,
                  toolName: 'resources/list',
                  args: toolArgs,
                  rawArgsJson: tc.arguments,
                },
                async () => {
                  const resources = await mcpManager.listResources(mcpServer.id)
                  return resources.length > 0
                    ? resources.map(r => `- ${r.name} (${r.uri})${r.description ? `: ${r.description}` : ''}`).join('\n')
                    : 'No resources found on this server.'
                },
              )
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          }
        } else if (tc.name === 'mcp_read_resource') {
          let toolArgs: Record<string, any> = {}
          try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const serverName = String(toolArgs.server_name ?? '')
          const uri = String(toolArgs.uri ?? '')
          const mcpServer = enabledServers.find(s => s.name === serverName)
          if (!mcpServer) {
            result = `Error: MCP server "${serverName}" not found or not enabled`
          } else if (!uri) {
            result = `Error: uri is required`
          } else {
            try {
              result = await figmaTask.run(
                {
                  kind: 'resource',
                  serverName,
                  toolName: 'resources/read',
                  args: toolArgs,
                  rawArgsJson: tc.arguments,
                  resourceUri: uri,
                },
                () => mcpManager.readResource(mcpServer.id, uri),
              )
            } catch (err) {
              result = `Error: ${err instanceof Error ? err.message : String(err)}`
            }
          }
        } else if (tc.name === 'run_subagent') {
          let toolArgs: Record<string, any> = {}
          try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const saType = String(toolArgs.type ?? '')
          const saPrompt = String(toolArgs.prompt ?? '')
          if (!saType || !saPrompt) {
            result = 'Error: run_subagent requires type and prompt'
          } else if (!resolveSubagent(saType, cfg.customSubagents)) {
            result = `Error: unknown subagent type "${saType}". Built-in: explore, code-review, security, general, coder, fixer`
          } else {
            result = await runSubagentInline(projectPath, saType, saPrompt, callbacks, signal, callId, callbacks.onSubagentPart)
          }
        } else if (tc.name === 'run_subagents') {
          let toolArgs: Record<string, any> = {}
          try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const tasks = toolArgs.tasks as SubagentTask[] | undefined
          if (!tasks?.length) {
            result = 'Error: run_subagents requires tasks array'
          } else {
            const validationError = validateRunSubagentTasks(tasks, cfg.customSubagents)
            if (validationError) {
              result = validationError
            } else {
              const results = await runSubagentTasksWithLimit(projectPath, tasks, callbacks, signal, callId)
              result = results.map(r => `## ${r.label}\n${r.out}`).join('\n\n---\n\n')
            }
          }
        } else if (tc.name === 'run_subagent_chain') {
          let toolArgs: Record<string, any> = {}
          try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const steps = toolArgs.steps as Array<{ type: string; prompt: string; label?: string }> | undefined
          if (!steps?.length) {
            result = 'Error: run_subagent_chain requires steps array'
          } else {
            const invalid = steps.find(s => !resolveSubagent(s.type, cfg.customSubagents))
            if (invalid) {
              result = `Error: unknown subagent type "${invalid.type}"`
            } else {
              const stepResults: { label: string; out: string }[] = []
              let previous = ''
              for (const step of steps) {
                if (signal?.aborted) break
                const prompt = step.prompt.replace(/\{previous\}/g, previous)
                try {
                  previous = await runSubagentInline(projectPath, step.type, prompt, callbacks, signal, callId, callbacks.onSubagentPart)
                } catch (err) {
                  previous = `Error: ${err instanceof Error ? err.message : String(err)}`
                }
                stepResults.push({ label: step.label ?? step.type, out: previous })
              }
              result = stepResults.map(r => `## ${r.label}\n${r.out}`).join('\n\n---\n\n')
            }
          }
        } else if (tc.name === 'spawn_coding_agent') {
          let toolArgs: Record<string, any> = {}
          try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const prompt = String(toolArgs.prompt ?? '').trim()
          if (!prompt) {
            result = 'Error: prompt is required'
          } else if (!callbacks.spawnAgentInTerminal) {
            result = 'Error: terminal not available'
          } else {
            const sessionId = callbacks.getSessionId?.() ?? makeId()
            const spawned = await callbacks.spawnAgentInTerminal(prompt)
            if (!spawned) {
              result = 'Error: could not spawn agent in terminal'
            } else {
              useManagedAgentsStore.getState().register({ sessionId, terminalSessionId: spawned.sessionId, task: prompt, maxRounds: 3 })
              result = `Claude Code agent spawned in terminal (session: ${spawned.sessionId}). It will start working shortly.`
            }
          }
        } else if (tc.name === 'send_to_agent') {
          let toolArgs: Record<string, any> = {}
          try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const instruction = String(toolArgs.instruction ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()
          if (!instruction) {
            result = 'Error: instruction is required'
          } else if (!callbacks.sendToTerminal) {
            result = 'Error: terminal not available'
          } else {
            const sessionId = callbacks.getSessionId?.() ?? ''
            const managed = useManagedAgentsStore.getState().getBySessionId(sessionId)
            if (!managed) {
              result = 'Error: no Claude Code agent active in this session; spawn one with spawn_coding_agent'
            } else {
              const ok = await callbacks.sendToTerminal(managed.terminalSessionId, instruction + '\r')
              if (!ok) {
                result = 'Error: agent terminal is no longer available'
              } else {
                useManagedAgentsStore.getState().bumpRound(sessionId)
                result = `Instruction sent to agent: ${instruction}`
              }
            }
          }
        } else if (tc.name === 'read_agent_output') {
          let toolArgs: Record<string, any> = {}
          try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
          const lines = Number(toolArgs.lines ?? 120)
          const sessionId = callbacks.getSessionId?.() ?? ''
          const managed = useManagedAgentsStore.getState().getBySessionId(sessionId)
          if (!managed) {
            result = JSON.stringify({ active: false })
          } else if (!callbacks.readTerminalOutput) {
            result = JSON.stringify({ active: true, phase: managed.phase, rounds: managed.rounds, output: '' })
          } else {
            const raw = callbacks.readTerminalOutput(managed.terminalSessionId, lines)
            result = JSON.stringify({ active: true, phase: managed.phase, rounds: managed.rounds, output: raw ?? '' })
          }
        } else {
          const permReq = (yoloMode || (callbacks.onApprovalRequired && (tc.name === 'write_file' || tc.name === 'edit' || tc.name === 'bash')))
            ? undefined : callbacks.onPermissionRequest
          // Progress callback: updates the tool_call part live (elapsed time for bash, line delta for edit)
          const onProgress = (progress: string) => mutateToolCallPart(callId, { progress })

          // Serialize same-file mutations; all other tools run freely in parallel
          if (tc.name === 'write_file' || tc.name === 'edit' || tc.name === 'delete_file' || tc.name === 'rename_file') {
            let filePath = ''
            try { filePath = String(JSON.parse(tc.arguments).path ?? '') } catch { /* ok */ }
            result = filePath
              ? await withFileLock(filePath, () => executeBuiltinTool(projectPath, tc.name, tc.arguments, callbacks.onFilesChanged, permReq, callbacks.onServerStarted, onProgress, useSmallOutput))
              : await executeBuiltinTool(projectPath, tc.name, tc.arguments, callbacks.onFilesChanged, permReq, callbacks.onServerStarted, onProgress, useSmallOutput)
          } else {
            // Plugin tool dispatch — check if a plugin registered this tool
            const pluginExecMap = callbacks.pluginManagerRef?.getPluginToolExecutionMap()
            const pluginExec = pluginExecMap?.get(tc.name)
            if (pluginExec) {
              let args: Record<string, unknown> = {}
              try { args = JSON.parse(tc.arguments) } catch { /* ok */ }
              const pluginResult = await pluginExec(args, {
                sessionId: callbacks.getSessionId?.() ?? null,
                projectPath,
                signal,
              })
              result = pluginResult.content
              if (pluginResult.isError) result = `Error: ${result}`
            } else {
              result = await executeBuiltinTool(projectPath, tc.name, tc.arguments, callbacks.onFilesChanged, permReq, callbacks.onServerStarted, onProgress, useSmallOutput)
            }
          }
        }
      } catch (e) {
        result = `Error: ${e instanceof Error ? e.message : String(e)}`
      }

      // ── afterToolCall hook ───────────────────────────────────────────────────
      // Runs after execution. Can override result, flip isError, or terminate loop.
      let finalIsError = result.startsWith('Error:')
      if (callbacks.afterToolCall) {
        try {
          const afterResult = await callbacks.afterToolCall({ toolName: tc.name, toolArgs: tc.arguments, result, isError: finalIsError })
          if (afterResult?.result !== undefined) result = afterResult.result
          if (afterResult?.isError !== undefined) finalIsError = afterResult.isError
          if (afterResult?.terminate) shouldTerminate = true
        } catch (e) {
          console.warn(`[afterToolCall] hook threw on tool "${tc.name}":`, e instanceof Error ? e.message : e)
        }
      }

      // ── Plugin afterToolCall hooks ────────────────────────────────────────────
      if (callbacks.pluginHookRegistry) {
        try {
          const pluginAfterResult = await callbacks.pluginHookRegistry.dispatchAfterToolCall(
            { toolName: tc.name, toolArgs: tc.arguments, result, isError: finalIsError },
            { sessionId: callbacks.getSessionId?.() ?? null, projectPath, pluginId: 'agent' },
          )
          if (pluginAfterResult) {
            if (pluginAfterResult.result !== undefined) result = pluginAfterResult.result
            if (pluginAfterResult.isError !== undefined) finalIsError = pluginAfterResult.isError
            if (pluginAfterResult.terminate) shouldTerminate = true
          }
        } catch (e) {
          console.warn(`[plugin afterToolCall] hook threw on tool "${tc.name}":`, e instanceof Error ? e.message : e)
        }
      }

      // update_plan replaces the single live plan panel instead of rendering as a normal tool result
      if (tc.name === 'update_plan' && !result.startsWith('Error:')) {
        try {
          const { plan, explanation } = JSON.parse(tc.arguments)
          const planData = { steps: plan, explanation }
          const planIdx = parts.findIndex(p => p.type === 'plan')
          if (planIdx !== -1) parts[planIdx].data = planData
          else parts.push({ type: 'plan', data: planData })
          scheduledFlush()
        } catch { /* already validated in executeBuiltinTool */ }
      }

      // Push result immediately as this tool finishes (Pi-style: completion order for UI)
      const tcIdx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
      if (tcIdx !== -1) (parts[tcIdx].data as { finished: boolean }).finished = true
      const displayContent = result.length > TOOL_RESULT_DISPLAY_MAX
        ? result.slice(0, TOOL_RESULT_DISPLAY_MAX) + '\n…(truncated for display)'
        : result
      const outcome = makeToolOutcome(tc.name, result, finalIsError, shouldTerminate)
      pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: displayContent, is_error: finalIsError, modelContent: outcome.modelContent } })
      emitAudit(result, finalIsError)

      return outcome
    }

    // Await tool executions — parallel (default) or sequential order
    const toolOutcomes: ToolExecutionOutcome[] = callbacks.toolExecutionOrder === 'sequential'
      ? await (async () => {
          const results: ToolExecutionOutcome[] = []
          for (const tc of normalizedToolCalls) {
            results.push(await executeTool(tc))
          }
          return results
        })()
      : await Promise.all(normalizedToolCalls.map(tc => executeTool(tc)))

    // Guard against duplicate plan parts if concurrent update_plan calls ever race
    // (e.g. a future afterToolCall hook introduces an await between find and push)
    const planIndices = parts.reduce<number[]>((acc, p, i) => { if (p.type === 'plan') acc.push(i); return acc }, [])
    if (planIndices.length > 1) {
      for (let i = planIndices.length - 2; i >= 0; i--) parts.splice(planIndices[i], 1)
      scheduledFlush()
    }

    callbacks.onToolEnd?.()

    // Commit results to oaiHistory in SOURCE ORDER (required by OAI API — must match tool_calls order)
    let terminateAfterRound = false
    for (let i = 0; i < normalizedToolCalls.length; i++) {
      const tc = normalizedToolCalls[i]
      const { modelContent, terminate } = toolOutcomes[i]
      if (terminate) terminateAfterRound = true
      oaiHistory.push({ role: 'tool', content: modelContent, tool_call_id: tc.id, name: tc.name })
    }

    // afterToolCall hook requested termination — stop the loop cleanly
    if (terminateAfterRound) {
      pushPart({ type: 'finish', data: { reason: 'terminate', time: Date.now() } })
      await mcpManager.shutdownAll()
      break
    }
  }
  } finally {
    await mcpManager.shutdownAll()
  }
}

const INLINE_EDIT_SYSTEM =
  [
    'You are an expert inline code assistant.',
    'If the user asks to explain code, respond briefly and directly:',
    '- 3 to 6 short bullet points maximum',
    '- do not rewrite the file',
    '- do not output large tutorials, essays, or code blocks unless explicitly asked',
    '- keep the explanation focused on the selected code only',
    'If the user asks to modify code, output the COMPLETE modified file content inside a single markdown code block.',
  ].join(' ')

/**
 * Simple streaming text call for inline chat — no tools, no agent loop.
 * Calls onChunk for each text delta; resolves with the full accumulated text.
 */
export async function streamInlineEdit(
  prompt: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const messages: OAIMessage[] = [
    { role: 'system', content: INLINE_EDIT_SYSTEM },
    { role: 'user', content: prompt },
  ]
  let full = ''
  for await (const chunk of streamChat(messages, [], signal)) {
    if (chunk.text) { full += chunk.text; onChunk(chunk.text) }
  }
  return full
}
