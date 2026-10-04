import { getConfig, getResolvedEndpointAsync } from './config'
import { THINKING_MODELS, CACHE_MODELS, BETOPIA_BASE_URL } from './providers'
import { usesMaxCompletionTokens, getDefaultCompletionTokenLimit, getReducedCompletionTokenLimit, isGPTFamilyModel } from './model-params'
import { proxyFetch as tauriFetch } from './proxyFetch'
import type { OAIMessage, OAIContentBlock, StreamToolCall } from './agent-types'

// ── Prompt caching ────────────────────────────────────────────────────────────

const CACHE_MIN_CHARS = 1024

export function injectPromptCaching(messages: OAIMessage[]): OAIMessage[] {
  const out: OAIMessage[] = []
  let cacheSlotsUsed = 0

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (msg.role === 'system' && cacheSlotsUsed < 4) {
      const text = typeof msg.content === 'string' ? msg.content : ''
      if (text.length >= CACHE_MIN_CHARS) {
        out.push({
          ...msg,
          content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] as any,
        })
        cacheSlotsUsed++
        continue
      }
    }

    const isSecondToLastUser = msg.role === 'user' && i === messages.length - 2 && cacheSlotsUsed < 4
    if (isSecondToLastUser && typeof msg.content === 'string' && msg.content.length >= CACHE_MIN_CHARS) {
      out.push({
        ...msg,
        content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] as any,
      })
      cacheSlotsUsed++
      continue
    }

    out.push(msg)
  }

  return out
}

// ── Per-model capability cache (process lifetime) ────────────────────────────

type ModelCap = 'stream' | 'nostream' | 'notoolstream'
const MODEL_CAP_TTL = 5 * 60 * 1000
const _modelCap = new Map<string, { cap: ModelCap; ts: number }>()

// ── Inference error classification ────────────────────────────────────────────

export function isInferenceError(err: unknown): boolean {
  const msg = String(err)
  return /AI API error 5\d\d/.test(msg) && (
    msg.includes('inference') ||
    msg.includes('Unterminated') ||
    msg.includes('inference failed') ||
    msg.includes('empty choices') ||
    msg.includes('model returned an error')
  )
}

/** True when the backend OOMed or timed out mid-generation (output too large). */
export function isOutputOverflowError(err: unknown): boolean {
  const msg = String(err)
  return isInferenceError(err) && (
    msg.includes('Unterminated') || msg.includes('unterminated') ||
    msg.includes('out of memory') || msg.includes('OOM') ||
    msg.includes('context length') || msg.includes('max_tokens')
  )
}

export function isNetworkError(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  return (
    msg.includes('error decoding response body') ||
    msg.includes('connection reset') ||
    msg.includes('connection closed') ||
    msg.includes('broken pipe') ||
    msg.includes('unexpected eof') ||
    msg.includes('network error') ||
    msg.includes('stream error') ||
    msg.includes('hyper::error')
  )
}

// ── Streaming SSE parser ──────────────────────────────────────────────────────

export async function* streamChat(
  messages: OAIMessage[],
  tools: unknown[],
  signal?: AbortSignal,
  modelOverride?: string,
  effortLevel?: 'low' | 'medium' | 'high',
): AsyncGenerator<{ text?: string; thinkText?: string; toolCalls?: StreamToolCall[]; finishReason?: string; usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }> {
  const cfg = getConfig()
  const modelCfg = cfg.model
  const { baseUrl, apiKey, model: resolvedModel } = await getResolvedEndpointAsync()
  const model = modelOverride ?? resolvedModel

  const useAnthropicCaching = THINKING_MODELS.has(model) || CACHE_MODELS.has(model)
  const cachedMessages = useAnthropicCaching ? injectPromptCaching(messages) : messages

  const completionTokenLimit = modelCfg.maxTokens ?? getDefaultCompletionTokenLimit(model)
  const reducedCompletionTokenLimit = getReducedCompletionTokenLimit(model, completionTokenLimit)
  const completionKey = usesMaxCompletionTokens(model) ? 'max_completion_tokens' : 'max_tokens'

  const baseBody: Record<string, unknown> = {
    model,
    messages: cachedMessages,
  }
  if (tools.length > 0) {
    baseBody.tools = tools
    baseBody.tool_choice = 'auto'
  }
  if (modelCfg.temperature !== undefined) baseBody.temperature = modelCfg.temperature
  if (modelCfg.topP !== undefined) baseBody.top_p = modelCfg.topP

  const isBetopiaRouter = baseUrl.startsWith(BETOPIA_BASE_URL)
  const level = (isBetopiaRouter && isGPTFamilyModel(model))
    ? 'off'
    : (effortLevel ?? modelCfg.thinkingLevel ?? (modelCfg.thinkingMode ? 'high' : 'off'))
  const showThinking = level !== 'off'
  if (level !== 'off') {
    if (THINKING_MODELS.has(model)) {
      baseBody.enable_thinking = true
      const budgetMap: Record<string, number> = { low: 4096, medium: 8192, high: 16384 }
      baseBody.thinking_budget_tokens = budgetMap[level] ?? 8192
    } else {
      baseBody.reasoning_effort = level
    }
  }

  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
  if (useAnthropicCaching) {
    reqHeaders['anthropic-beta'] = 'prompt-caching-2024-07-31'
  }

  const doFetch = (body: Record<string, unknown>) =>
    tauriFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal,
    } as any)

  const makeBody = (opts: { includeTools: boolean; stream: boolean; tokenLimit: number }): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      ...baseBody,
      stream: opts.stream,
      [completionKey]: opts.tokenLimit,
    }
    if (opts.includeTools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    } else {
      delete body.tools
      delete body.tool_choice
    }
    return body
  }

  const capKey = `${baseUrl}::${model}`
  const cached = _modelCap.get(capKey)
  const knownCap = cached && (Date.now() - cached.ts < MODEL_CAP_TTL) ? cached.cap : undefined

  const setCapability = (cap: ModelCap) => _modelCap.set(capKey, { cap, ts: Date.now() })

  let res: Awaited<ReturnType<typeof doFetch>>
  let streaming: boolean

  if (knownCap === 'notoolstream') {
    res = await doFetch(makeBody({ includeTools: false, stream: false, tokenLimit: completionTokenLimit }))
    streaming = false
  } else if (knownCap === 'nostream') {
    res = await doFetch(makeBody({ includeTools: true, stream: false, tokenLimit: completionTokenLimit }))
    streaming = false
  } else {
    res = await doFetch(makeBody({ includeTools: true, stream: true, tokenLimit: completionTokenLimit }))
    streaming = true

    if (!res.ok && res.status >= 500) {
      const tier2 = await doFetch(makeBody({ includeTools: true, stream: false, tokenLimit: completionTokenLimit }))
      if (tier2.ok) setCapability('nostream')
      res = tier2
      streaming = false
    }

    if (!res.ok && res.status >= 500) {
      const tier3 = await doFetch(makeBody({ includeTools: false, stream: false, tokenLimit: completionTokenLimit }))
      if (tier3.ok) setCapability('notoolstream')
      res = tier3
      streaming = false
    }

    if (!res.ok && res.status >= 500 && isGPTFamilyModel(model) && reducedCompletionTokenLimit < completionTokenLimit) {
      const tier4 = await doFetch(makeBody({ includeTools: false, stream: false, tokenLimit: reducedCompletionTokenLimit }))
      if (tier4.ok) setCapability('notoolstream')
      res = tier4
      streaming = false
    }
  }

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`AI API error ${res.status}: ${err}`)
  }

  if (!knownCap) setCapability(streaming ? 'stream' : 'nostream')

  async function* yieldFromJson(body: string): AsyncGenerator<{ text?: string; thinkText?: string; toolCalls?: StreamToolCall[]; finishReason?: string; usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }> {
    let data: any
    try { data = JSON.parse(body.trimStart()) } catch { return }

    const rawContent: string = data.content ?? data.choices?.[0]?.message?.content ?? ''
    const rawToolCalls: any[] = data.tool_calls ?? data.choices?.[0]?.message?.tool_calls ?? []

    if (rawContent) {
      if (rawContent.includes('<think>') || rawContent.includes('</think>')) {
        let remainder = rawContent
        const thinkMatches = rawContent.match(/<think>([\s\S]*?)<\/think>/g)
        if (thinkMatches) {
          for (const block of thinkMatches) {
            const inner = block.slice(7, -8)
            if (inner.trim() && showThinking) yield { thinkText: inner }
            remainder = remainder.replace(block, '')
          }
        } else if (rawContent.includes('<think>')) {
          const idx = rawContent.indexOf('<think>')
          if (showThinking) yield { thinkText: rawContent.slice(idx + 7) }
          remainder = rawContent.slice(0, idx)
        } else if (rawContent.includes('</think>')) {
          const idx = rawContent.indexOf('</think>')
          if (showThinking) yield { thinkText: rawContent.slice(0, idx) }
          remainder = rawContent.slice(idx + 8)
        }
        if (remainder.trim()) yield { text: remainder }
      } else {
        yield { text: rawContent }
      }
    }

    if (rawToolCalls.length > 0) {
      const calls: StreamToolCall[] = rawToolCalls.map((tc: any, i: number) => ({
        index: i,
        id: tc.id ?? `call_${i}`,
        name: tc.function?.name ?? tc.name ?? '',
        arguments: typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
      }))
      yield { finishReason: 'tool_calls', toolCalls: calls }
    } else {
      yield { finishReason: 'stop' }
    }
  }

  if (!streaming) {
    const fullText: string = res.body
      ? await (async () => {
          const rdr = (res.body as ReadableStream<Uint8Array>).getReader()
          const dec = new TextDecoder()
          let t = ''
          while (true) { const { done, value } = await rdr.read(); if (done) break; t += dec.decode(value, { stream: true }) }
          return t
        })()
      : await res.text()
    yield* yieldFromJson(fullText)
    return
  }

  if (!res.body) return
  const sseReader = (res.body as ReadableStream<Uint8Array>).getReader()
  const sseDec = new TextDecoder()

  const firstRead = await sseReader.read()
  if (firstRead.done) return
  const firstChunk = sseDec.decode(firstRead.value, { stream: true })

  if (firstChunk.trimStart().startsWith('{') || firstChunk.trimStart().startsWith('[')) {
    let jsonBuf = firstChunk
    while (true) {
      const r = await sseReader.read()
      if (r.done) break
      jsonBuf += sseDec.decode(r.value, { stream: true })
    }
    yield* yieldFromJson(jsonBuf)
    return
  }

  const accumToolCalls: Record<number, StreamToolCall> = {}
  let lineBuffer = firstChunk

  outer:
  while (true) {
    let nl: number
    while ((nl = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, nl).replace(/\r$/, '')
      lineBuffer = lineBuffer.slice(nl + 1)

      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (raw === '[DONE]') break outer

      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null
            reasoning_content?: string | null
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
          }
          finish_reason?: string | null
        }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          input_tokens?: number
          output_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
          prompt_cache_hit_tokens?: number
        }
      }
      try { chunk = JSON.parse(raw) } catch { continue }

      if (chunk.usage) {
        const u = chunk.usage
        const input = u.input_tokens ?? u.prompt_tokens ?? 0
        const output = u.output_tokens ?? u.completion_tokens ?? 0
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0
        yield { usage: { inputTokens: input, outputTokens: output, cachedInputTokens: cached } }
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta

      if (delta?.reasoning_content && showThinking) yield { thinkText: delta.reasoning_content }
      if (delta?.content) {
        const tok = delta.content
        if (tok.includes('<think>') || tok.includes('</think>')) {
          const thinkMatch = tok.match(/<think>([\s\S]*?)<\/think>/g)
          let remainder = tok
          if (thinkMatch) {
            for (const block of thinkMatch) {
              const inner = block.slice(7, -8)
              if (inner && showThinking) yield { thinkText: inner }
              remainder = remainder.replace(block, '')
            }
          } else if (tok.includes('<think>')) {
            if (showThinking) yield { thinkText: tok.replace('<think>', '') }
            remainder = ''
          } else if (tok.includes('</think>')) {
            const idx = tok.indexOf('</think>')
            if (showThinking) yield { thinkText: tok.slice(0, idx) }
            remainder = tok.slice(idx + 8)
          }
          if (remainder.trim()) yield { text: remainder }
        } else {
          yield { text: tok }
        }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!accumToolCalls[tc.index]) {
            accumToolCalls[tc.index] = { index: tc.index, id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' }
          }
          accumToolCalls[tc.index].arguments += tc.function?.arguments ?? ''
          if (tc.id) accumToolCalls[tc.index].id = tc.id
          if (tc.function?.name) accumToolCalls[tc.index].name = tc.function.name
        }
      }

      if (choice.finish_reason) {
        if (Object.keys(accumToolCalls).length > 0) {
          yield { toolCalls: Object.values(accumToolCalls), finishReason: choice.finish_reason }
        } else {
          yield { finishReason: choice.finish_reason }
        }
      }
    }

    const r = await sseReader.read()
    if (r.done) break
    lineBuffer += sseDec.decode(r.value, { stream: true })
  }
}
