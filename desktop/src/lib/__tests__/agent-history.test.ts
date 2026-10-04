import { describe, it, expect, vi } from 'vitest'

vi.mock('../tokenCounter', () => ({
  countTokens: (text: string) => Math.round(text.length / 4),
}))

import {
  estimateHistoryTokens,
  estimateOAIHistoryTokens,
  sanitizeHistorySize,
  trimInferenceContext,
  historyToOAI,
  COMPACT_KEEP_TAIL,
  COMPACT_THRESHOLD,
  COMPACTION_VERSION,
  HISTORY_MAX_MESSAGES,
} from '../agent-history'
import type { OAIMessage } from '../agent-types'
import type { Message, CompactionData } from '../../types'

function textMsg(role: 'user' | 'assistant', text: string, session_id = 's1'): Message {
  return {
    id: 'id1',
    session_id,
    role,
    parts: [{ type: 'text', data: { text } }],
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function toolResultMsg(content: string, session_id = 's1'): Message {
  return {
    id: 'id2',
    session_id,
    role: 'assistant',
    parts: [{ type: 'tool_result', data: { tool_call_id: 'tc1', name: 'read_file', content } }],
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function toolCallMsg(name: string, input: string, session_id = 's1'): Message {
  return {
    id: 'id3',
    session_id,
    role: 'assistant',
    parts: [{ type: 'tool_call', data: { id: 'tc1', name, input } }],
    created_at: Date.now(),
    updated_at: Date.now(),
  }
}

function oaiMsg(role: string, content: string | null, tool_calls?: any[]): OAIMessage {
  const m: OAIMessage = { role: role as any, content }
  if (tool_calls) m.tool_calls = tool_calls
  return m
}

// ── estimateHistoryTokens ──────────────────────────────────────────────────

describe('estimateHistoryTokens', () => {
  it('estimates tokens for text messages', () => {
    const msgs = [textMsg('user', 'hello world')]
    const tokens = estimateHistoryTokens(msgs)
    expect(tokens).toBeGreaterThan(0)
    expect(Number.isInteger(tokens)).toBe(true)
  })

  it('adds overhead constant (32k)', () => {
    const msgs = [textMsg('user', 'hi')]
    const tokens = estimateHistoryTokens(msgs)
    expect(tokens).toBeGreaterThanOrEqual(32_000)
  })

  it('estimates tokens for tool_call parts', () => {
    const msgs = [toolCallMsg('write_file', JSON.stringify({ path: '/x', content: 'abc' }))]
    const tokens = estimateHistoryTokens(msgs)
    expect(tokens).toBeGreaterThan(0)
  })

  it('caps tool result length at 4000 chars for estimation', () => {
    const long = 'x'.repeat(8000)
    const msgs = [toolResultMsg(long)]
    const tokens1 = estimateHistoryTokens(msgs)

    const short = 'x'.repeat(4000)
    const msgs2 = [toolResultMsg(short)]
    const tokens2 = estimateHistoryTokens(msgs2)

    expect(tokens1).toBe(tokens2)
  })

  it('handles empty history', () => {
    expect(estimateHistoryTokens([])).toBe(32_000)
  })

  it('sums tokens across multiple messages', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => textMsg('user', `msg ${i}`))
    const single = estimateHistoryTokens([textMsg('user', 'msg 0')])
    const multi = estimateHistoryTokens(msgs)
    expect(multi).toBeGreaterThan(single)
  })
})

// ── estimateOAIHistoryTokens ───────────────────────────────────────────────

describe('estimateOAIHistoryTokens', () => {
  it('estimates tokens for string content', () => {
    const msgs = [oaiMsg('user', 'hello world')]
    expect(estimateOAIHistoryTokens(msgs)).toBeGreaterThan(0)
  })

  it('handles null content', () => {
    const msgs = [oaiMsg('assistant', null)]
    expect(estimateOAIHistoryTokens(msgs)).toBe(0)
  })

  it('estimates tokens for tool_calls', () => {
    const msgs = [oaiMsg('assistant', null, [{ function: { arguments: '{"a":1}' } }])]
    const tokens = estimateOAIHistoryTokens(msgs)
    expect(tokens).toBeGreaterThan(0)
  })

  it('handles empty history', () => {
    expect(estimateOAIHistoryTokens([])).toBe(0)
  })

  it('handles array content (not counted by string branch)', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as any
    expect(estimateOAIHistoryTokens(msgs)).toBe(0)
  })
})

// ── trimInferenceContext ───────────────────────────────────────────────────

describe('trimInferenceContext', () => {
  it('returns history unchanged when under threshold', () => {
    const history = Array.from({ length: 8 }, (_, i) => oaiMsg('user', `msg ${i}`))
    const result = trimInferenceContext(history)
    expect(result).toBe(history)
  })

  it('preserves system messages', () => {
    const system = oaiMsg('system', 'you are a bot')
    const rest = Array.from({ length: 40 }, (_, i) => oaiMsg('user', `msg ${i}`))
    const history = [system, ...rest]
    const result = trimInferenceContext(history)
    expect(result[0].role).toBe('system')
    expect(result.filter(m => m.role === 'system')).toHaveLength(1)
  })

  function toolCallOaiMsg(name: string, args: string): OAIMessage {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function' as const, function: { name, arguments: args } }],
    }
  }

  function toolResultOaiMsg(content: string): OAIMessage {
    return { role: 'tool' as any, content, tool_call_id: 'tc1', name: 'test' }
  }

  it('removes some messages when over threshold', () => {
    const history: OAIMessage[] = []
    for (let i = 0; i < 15; i++) {
      history.push(oaiMsg('user', `user ${i}`))
      history.push(toolCallOaiMsg('read_file', '{"path":"x"}'))
      history.push(toolResultOaiMsg(`result ${i}`))
    }
    const result = trimInferenceContext(history)
    expect(result.length).toBeLessThan(history.length)
  })

  it('keeps last 6 messages', () => {
    const history: OAIMessage[] = []
    for (let i = 0; i < 10; i++) {
      history.push(oaiMsg('user', `user ${i}`))
      history.push(toolCallOaiMsg('read', '{}'))
      history.push(toolResultOaiMsg(`res ${i}`))
    }
    const result = trimInferenceContext(history)
    const tail = result.slice(-6)
    expect(tail.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant', 'tool'])
  })

  it('does not keep orphaned tool results', () => {
    const history: OAIMessage[] = []
    for (let i = 0; i < 6; i++) history.push(oaiMsg('user', `user ${i}`))
    history.push(toolResultOaiMsg('orphaned tool result'))
    for (let i = 6; i < 14; i++) history.push(oaiMsg('user', `user ${i}`))

    const result = trimInferenceContext(history)

    expect(result.some(msg => msg.role === 'tool' && msg.content === 'orphaned tool result')).toBe(false)
  })

  it('does not split assistant tool call and tool result', () => {
    const history: OAIMessage[] = []
    for (let i = 0; i < 8; i++) history.push(oaiMsg('user', `user ${i}`))
    history.push(toolCallOaiMsg('read_file', '{"path":"/tmp/a"}'))
    history.push(toolResultOaiMsg('grouped result'))
    for (let i = 8; i < 14; i++) history.push(oaiMsg('user', `user ${i}`))

    const result = trimInferenceContext(history)
    const assistantIdx = result.findIndex(msg => msg.role === 'assistant' && msg.tool_calls?.[0]?.id === 'tc1')
    const toolIdx = result.findIndex(msg => msg.role === 'tool' && msg.tool_call_id === 'tc1')

    expect(assistantIdx === -1).toBe(toolIdx === -1)
    if (assistantIdx !== -1 && toolIdx !== -1) {
      expect(toolIdx).toBe(assistantIdx + 1)
    }
  })

  it('keeps multiple tool calls grouped with their results', () => {
    const multiToolAssistant: OAIMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'tc1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { id: 'tc2', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"b"}' } },
      ],
    }
    const history: OAIMessage[] = []
    for (let i = 0; i < 8; i++) history.push(oaiMsg('user', `user ${i}`))
    history.push(multiToolAssistant)
    history.push({ role: 'tool' as any, content: 'result a', tool_call_id: 'tc1', name: 'read_file' })
    history.push({ role: 'tool' as any, content: 'result b', tool_call_id: 'tc2', name: 'read_file' })
    for (let i = 8; i < 14; i++) history.push(oaiMsg('user', `user ${i}`))

    const result = trimInferenceContext(history)
    const assistantIdx = result.findIndex(msg => msg.role === 'assistant' && msg.tool_calls?.length === 2)

    if (assistantIdx !== -1) {
      expect(result[assistantIdx + 1].role).toBe('tool')
      expect((result[assistantIdx + 1] as any).tool_call_id).toBe('tc1')
      expect(result[assistantIdx + 2].role).toBe('tool')
      expect((result[assistantIdx + 2] as any).tool_call_id).toBe('tc2')
    }
  })

  it('still trims normal non-tool history correctly', () => {
    const history = Array.from({ length: 24 }, (_, i) =>
      oaiMsg(i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`),
    )

    const result = trimInferenceContext(history)

    expect(result.length).toBeLessThan(history.length)
    expect(result.some(msg => msg.role === 'tool')).toBe(false)
    expect(result[0].role).toBe('user')
  })

  it('preserves first user message', () => {
    const history: OAIMessage[] = [oaiMsg('assistant', 'start'), oaiMsg('user', 'first user')]
    for (let i = 2; i < 30; i++) {
      history.push(oaiMsg(i % 2 === 0 ? 'user' : 'assistant', `msg ${i}`))
    }
    const result = trimInferenceContext(history)
    expect(result.map(m => m.content)).toContain('first user')
  })

  it('returns empty history unchanged', () => {
    expect(trimInferenceContext([])).toEqual([])
  })
})

// ── sanitizeHistorySize ────────────────────────────────────────────────────

describe('sanitizeHistorySize', () => {
  it('returns history unchanged when under budget', () => {
    const history = [oaiMsg('user', 'hi')]
    const result = sanitizeHistorySize(history, 100_000)
    expect(result).toBe(history)
  })

  it('caps tool results when over budget', () => {
    const big = 'x'.repeat(60_000)
    const h2 = [oaiMsg('tool', big)]
    const limited = sanitizeHistorySize(h2, 500)
    const toolMsg = limited.find(m => m.role === 'tool')
    expect(toolMsg?.content?.toString().length).toBeLessThan(2500)
  })
})

// ── historyToOAI ───────────────────────────────────────────────────────────

describe('historyToOAI', () => {
  it('converts user text messages', () => {
    const msgs = [textMsg('user', 'hello')]
    const result = historyToOAI(msgs)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toBe('hello')
  })

  it('converts assistant messages with text', () => {
    const msgs = [textMsg('assistant', 'hi there')]
    const result = historyToOAI(msgs)
    expect(result[0].role).toBe('assistant')
    expect(result[0].content).toBe('hi there')
  })

  it('converts assistant messages with tool calls', () => {
    const msgs: Message[] = [
      {
        id: 'a1',
        session_id: 's1',
        role: 'assistant',
        parts: [
          { type: 'text', data: { text: 'checking...' } },
          { type: 'tool_call', data: { id: 'tc1', name: 'read_file', input: '{"path":"/x"}' } },
          { type: 'tool_result', data: { tool_call_id: 'tc1', name: 'read_file', content: 'file contents' } },
        ],
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]
    const result = historyToOAI(msgs)
    expect(result.length).toBe(2)
    expect(result[0].role).toBe('assistant')
    expect(result[0].tool_calls).toHaveLength(1)
    expect(result[0].tool_calls![0].function.name).toBe('read_file')
    expect(result[1].role).toBe('tool')
  })

  it('limits history to HISTORY_MAX_MESSAGES', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => textMsg('user', `msg ${i}`))
    const result = historyToOAI(msgs)
    expect(result.length).toBeLessThanOrEqual(HISTORY_MAX_MESSAGES)
  })

  it('includes compaction summary when history exceeds max', () => {
    const compactionData: CompactionData = {
      version: COMPACTION_VERSION,
      summary: 'Built a login component',
      messageCount: 45,
      fromTs: 0,
      toTs: Date.now(),
    }
    const compactionMsg: Message = {
      id: 'c1',
      session_id: 's1',
      role: 'user',
      parts: [{ type: 'compaction', data: compactionData as any }],
      created_at: 0,
      updated_at: 0,
    }
    const msgs = Array.from({ length: 100 }, (_, i) => textMsg('user', `msg ${i}`))
    msgs[0] = compactionMsg
    const result = historyToOAI(msgs)
    const summaryMsg = result.find(m => m.content?.toString().includes('[COMPACTED'))
    expect(summaryMsg).toBeDefined()
  })

  it('handles user messages with images', () => {
    const msg: Message = {
      id: 'i1',
      session_id: 's1',
      role: 'user',
      parts: [
        { type: 'text', data: { text: 'what is this' } },
        { type: 'image_url', data: { url: 'data:image/png;base64,abc' } },
      ],
      created_at: Date.now(),
      updated_at: Date.now(),
    }
    const result = historyToOAI([msg])
    expect(result).toHaveLength(1)
    const content = result[0].content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      expect(content).toHaveLength(2)
      expect(content[0].type).toBe('text')
      expect(content[1].type).toBe('image_url')
    }
  })
})
