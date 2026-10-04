import { describe, it, expect, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())
const invokeMock = vi.hoisted(() => vi.fn())
const homeDirMock = vi.hoisted(() => vi.fn(async () => '/home/test'))
const fsMock = vi.hoisted(() => ({
  readProjectFile: vi.fn(),
  writeProjectFile: vi.fn(),
  getFileTree: vi.fn(),
}))
const mcpMock = vi.hoisted(() => {
  const instance = {
    shutdownAll: vi.fn(),
    initServer: vi.fn(),
    callTool: vi.fn(),
  }
  return {
    instance,
    ctor: vi.fn(function () { return instance }),
  }
})

const BASE_CONFIG = {
  model: { maxTokens: 32768, thinkingLevel: 'off' },
  behavior: {
    autoCompactThreshold: 0.70,
    yoloMode: false,
    systemPromptPrefix: '',
    cavemanEnabled: false,
    cavemanIntensity: 'full',
  },
  mcpServers: [] as any[],
  customSubagents: [],
}
const getConfigMock = vi.hoisted(() => vi.fn(() => BASE_CONFIG))
const getModelInfoMock = vi.hoisted(() => vi.fn(() => ({ name: 'gpt-4o', contextLength: 128000, smallOutput: false })))

// ── Mocks required before importing agent.ts ──────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: homeDirMock }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: fetchMock }))
vi.mock('../config', () => ({
  getConfig: getConfigMock,
  getResolvedEndpointAsync: async () => ({
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'test',
    model: 'gpt-4o',
  }),
  getModelInfo: getModelInfoMock,
}))
vi.mock('../providers', () => ({
  THINKING_MODELS: new Set<string>(),
  CACHE_MODELS: new Set<string>(),
  BETOPIA_BASE_URL: 'https://api.betopia.ai',
}))
vi.mock('../fs', () => fsMock)
vi.mock('../proxyFetch', () => ({
  proxyFetch: fetchMock,
  createProxyFetch: vi.fn(() => fetchMock),
}))
vi.mock('../mcp-manager', () => ({
  MCPManager: mcpMock.ctor,
}))
vi.mock('../lsp/typescript-client', () => ({
  getTypeScriptLspClient: () => ({
    syncFile: vi.fn().mockResolvedValue(undefined),
  }),
}))

import { historyToOAI, compactHistory, isReadOnlyBashCommand, runAgent, redactMCPArgs, isMCPToolReadOnly } from '../agent'
import type { Message, MessagePart } from '../../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMessage(role: 'user' | 'assistant', parts: MessagePart[]): Message {
  return { id: 'x', session_id: 's', role, parts, created_at: 0, updated_at: 0 }
}

function jsonResponse(data: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
  const text = init.text ?? JSON.stringify(data)
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    }),
    text: vi.fn(async () => text),
    json: vi.fn(async () => data),
  }
}

function chatContent(content: string) {
  return jsonResponse({ choices: [{ message: { content } }] })
}

function chatToolCalls(toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
  return jsonResponse({
    choices: [{
      message: {
        content: '',
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      },
    }],
  })
}

function makeCallbacks(overrides: Partial<Parameters<typeof runAgent>[3]> = {}): Parameters<typeof runAgent>[3] {
  return {
    onPartsUpdate: vi.fn(),
    onFilesChanged: vi.fn(async () => {}),
    ...overrides,
  }
}

function requestBody(callIndex: number): any {
  const body = fetchMock.mock.calls[callIndex]?.[1]?.body
  return JSON.parse(String(body))
}

function parseToolEnvelope(content: string): any {
  return JSON.parse(content)
}

beforeEach(() => {
  fetchMock.mockReset()
  invokeMock.mockReset()
  homeDirMock.mockClear()
  fsMock.readProjectFile.mockReset()
  fsMock.writeProjectFile.mockReset()
  fsMock.getFileTree.mockReset()
  mcpMock.instance.shutdownAll.mockReset()
  mcpMock.instance.initServer.mockReset()
  mcpMock.instance.callTool.mockReset()
  mcpMock.ctor.mockClear()
  getConfigMock.mockReset()
  getConfigMock.mockImplementation(() => BASE_CONFIG)
  getModelInfoMock.mockReset()
  getModelInfoMock.mockImplementation(() => ({ name: 'gpt-4o', contextLength: 128000, smallOutput: false }))
  fsMock.readProjectFile.mockRejectedValue(new Error('not found'))
  fsMock.getFileTree.mockResolvedValue([])
})

// ── historyToOAI: basic text messages ─────────────────────────────────────────

describe('historyToOAI — text messages', () => {
  it('converts a plain user text message', () => {
    const history = [makeMessage('user', [{ type: 'text', data: { text: 'hello' } }])]
    const oai = historyToOAI(history)
    expect(oai).toHaveLength(1)
    expect(oai[0]).toEqual({ role: 'user', content: 'hello' })
  })

  it('converts a plain assistant text message', () => {
    const history = [makeMessage('assistant', [{ type: 'text', data: { text: 'world' } }])]
    const oai = historyToOAI(history)
    expect(oai).toHaveLength(1)
    expect(oai[0]).toEqual({ role: 'assistant', content: 'world' })
  })

  it('returns empty string for user message with no text part', () => {
    const history = [makeMessage('user', [])]
    const oai = historyToOAI(history)
    expect(oai[0].content).toBe('')
  })
})

describe('historyToOAI — tool result model content', () => {
  it('uses modelContent for tool messages while preserving display content in UI state', () => {
    const history = [makeMessage('assistant', [
      { type: 'tool_call', data: { id: 'call_1', name: 'view_file', input: '{}' } },
      {
        type: 'tool_result',
        data: {
          tool_call_id: 'call_1',
          name: 'view_file',
          content: 'display text',
          modelContent: '{"ok":true,"output":"model text","metadata":{"tool":"view_file"}}',
        },
      },
    ])]

    const oai = historyToOAI(history)
    expect(oai.at(-1)).toEqual({
      role: 'tool',
      content: '{"ok":true,"output":"model text","metadata":{"tool":"view_file"}}',
      tool_call_id: 'call_1',
      name: 'view_file',
    })
  })
})

// ── historyToOAI: image content blocks ────────────────────────────────────────

describe('historyToOAI — image content blocks', () => {
  const IMG_URL = 'data:image/png;base64,iVBORw0KGgo='

  it('emits content block array when user message has image', () => {
    const history = [makeMessage('user', [
      { type: 'text',      data: { text: 'look at this' } },
      { type: 'image_url', data: { url: IMG_URL } },
    ])]
    const oai = historyToOAI(history)
    expect(oai).toHaveLength(1)
    expect(Array.isArray(oai[0].content)).toBe(true)
    const blocks = oai[0].content as any[]
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: 'look at this' })
    expect(blocks[1]).toEqual({ type: 'image_url', image_url: { url: IMG_URL } })
  })

  it('omits text block when text is empty but image is present', () => {
    const history = [makeMessage('user', [
      { type: 'image_url', data: { url: IMG_URL } },
    ])]
    const oai = historyToOAI(history)
    const blocks = oai[0].content as any[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('image_url')
  })

  it('handles multiple images in one message', () => {
    const history = [makeMessage('user', [
      { type: 'text',      data: { text: 'two images' } },
      { type: 'image_url', data: { url: IMG_URL + '1' } },
      { type: 'image_url', data: { url: IMG_URL + '2' } },
    ])]
    const oai = historyToOAI(history)
    const blocks = oai[0].content as any[]
    expect(blocks).toHaveLength(3)
    expect(blocks[1].image_url.url).toBe(IMG_URL + '1')
    expect(blocks[2].image_url.url).toBe(IMG_URL + '2')
  })

  it('keeps plain string content when message has no images', () => {
    const history = [makeMessage('user', [{ type: 'text', data: { text: 'no image' } }])]
    const oai = historyToOAI(history)
    expect(typeof oai[0].content).toBe('string')
    expect(oai[0].content).toBe('no image')
  })

  it('image in history is preserved across turns', () => {
    const history = [
      makeMessage('user', [
        { type: 'text',      data: { text: 'see image' } },
        { type: 'image_url', data: { url: IMG_URL } },
      ]),
      makeMessage('assistant', [{ type: 'text', data: { text: 'I see it' } }]),
      makeMessage('user', [{ type: 'text', data: { text: 'what about it?' } }]),
    ]
    const oai = historyToOAI(history)
    expect(oai).toHaveLength(3)
    expect(Array.isArray(oai[0].content)).toBe(true)
    expect(typeof oai[2].content).toBe('string')
  })
})

// ── IMAGE_PATH_RE regex tests ─────────────────────────────────────────────────
// Recreates the regex from sendMessageCore — tests must match the actual pattern.

const IMAGE_PATH_RE = /(?<![:/\w])((?:\/[^\s,?#]+|[A-Za-z]:[\\\/][^\s,?#]+)\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif))/gi

function matchPaths(text: string): string[] {
  return [...text.matchAll(IMAGE_PATH_RE)].map(m => m[1])
}

describe('IMAGE_PATH_RE — local path detection', () => {
  it('matches a bare Linux absolute path', () => {
    expect(matchPaths('/home/akash/Downloads/screenshot.png')).toEqual(['/home/akash/Downloads/screenshot.png'])
  })

  it('matches path embedded in message text', () => {
    expect(matchPaths('/home/akash/Downloads/img.jpg - build this website')).toEqual(['/home/akash/Downloads/img.jpg'])
  })

  it('matches Windows path with backslash', () => {
    expect(matchPaths('C:\\Users\\akash\\Downloads\\img.jpg')).toEqual(['C:\\Users\\akash\\Downloads\\img.jpg'])
  })

  it('matches Windows path with forward slash', () => {
    expect(matchPaths('C:/Users/akash/image.png')).toEqual(['C:/Users/akash/image.png'])
  })

  it('matches multiple paths in one message', () => {
    const paths = matchPaths('/tmp/a.png and /tmp/b.jpg')
    expect(paths).toHaveLength(2)
    expect(paths[0]).toBe('/tmp/a.png')
    expect(paths[1]).toBe('/tmp/b.jpg')
  })

  it('does NOT match http URL paths (false positive prevention)', () => {
    expect(matchPaths('see http://example.com/image.png here')).toHaveLength(0)
  })

  it('does NOT match https URL paths', () => {
    expect(matchPaths('https://cdn.example.com/photo.jpg')).toHaveLength(0)
  })

  it('does NOT match relative paths (no leading slash)', () => {
    expect(matchPaths('images/photo.jpg')).toHaveLength(0)
  })

  it('does NOT match unsupported extensions', () => {
    expect(matchPaths('/home/user/file.svg')).toHaveLength(0)
    expect(matchPaths('/home/user/movie.mp4')).toHaveLength(0)
  })

  it('strips query string from match boundary', () => {
    // Path with ? should not include ? in the matched path
    const matches = matchPaths('/home/user/photo.png?v=1')
    // Either no match (? in path excluded by [^\s,?#]+) or match stops at ?
    if (matches.length > 0) {
      expect(matches[0]).not.toContain('?')
    }
  })

  it('supports all declared extensions', () => {
    const exts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif']
    for (const ext of exts) {
      const result = matchPaths(`/tmp/img.${ext}`)
      expect(result).toHaveLength(1)
      expect(result[0]).toBe(`/tmp/img.${ext}`)
    }
  })
})

// ── runAgent core loop ────────────────────────────────────────────────────────

describe('runAgent — core loop', () => {
  it('streams final text and emits a finish part when the model returns no tools', async () => {
    const updates: MessagePart[][] = []
    fetchMock.mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'hello', makeCallbacks({
      onPartsUpdate: parts => updates.push(parts),
    }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestBody(0).stream).toBe(true)
    // shutdownAll is called twice: once when the loop ends (no tools)
    // and once in the finally block.
    expect(mcpMock.instance.shutdownAll).toHaveBeenCalledTimes(2)

    const finalParts = updates.at(-1) ?? []
    expect(finalParts).toEqual(expect.arrayContaining([
      { type: 'text', data: { text: 'done' } },
      expect.objectContaining({ type: 'finish' }),
    ]))
  })

  it('auto-compacts based on token usage even when the message count is still small', async () => {
    getModelInfoMock.mockImplementation(() => ({
      name: 'gpt-4o',
      contextLength: 32768,
      smallOutput: false,
    }))

    const onCompactionDone = vi.fn()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { content: '## Goal\nSummarized session' } }],
      }))
      .mockResolvedValueOnce(chatContent('done'))

    const history = [
      makeMessage('user', [{ type: 'text', data: { text: 'first message' } }]),
      makeMessage('assistant', [{ type: 'text', data: { text: 'reply' } }]),
    ]

    await runAgent('/project', history, 'continue', makeCallbacks({ onCompactionDone }))

    expect(onCompactionDone).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(requestBody(1))).toContain('Summarized session')
  })

  it('filters exposed tools through agentAllowedTools', async () => {
    fetchMock.mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'read one file', makeCallbacks({
      agentAllowedTools: ['view_file'],
    }))

    const toolNames = requestBody(0).tools.map((tool: any) => tool.function.name)
    expect(toolNames).toEqual(['view_file'])
  })

  it('injects loaded skill bodies into the system prompt sent to the model', async () => {
    invokeMock.mockImplementation(async (command: string, args?: any) => {
      if (command === 'fs_read_dir' && args?.root === '/project-with-skill/.betopia/skills') {
        return [{ name: 'debugging-and-error-recovery', isDirectory: true }]
      }
      if (command === 'fs_read_dir' && args?.root === '/project-with-skill/.betopia/skills/debugging-and-error-recovery') {
        return [{ name: 'SKILL.md', isDirectory: false }]
      }
      if (command === 'fs_read_dir') return []
      if (command === 'fs_read_file' && args?.path === '/project-with-skill/.betopia/skills/debugging-and-error-recovery/SKILL.md') {
        return [
          '---',
          'name: Debugging and Error Recovery',
          'description: Use when debugging failing builds, runtime errors, regressions, or stuck agent work.',
          '---',
          '# Debugging and Error Recovery',
          '',
          'Always reproduce the failure, inspect recent changes, identify the root cause, then verify the fix.',
        ].join('\n')
      }
      return []
    })
    fetchMock.mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project-with-skill', [], 'Fix the failing build', makeCallbacks())

    const system = requestBody(0).messages[0].content
    expect(system).toContain('<available_skills>')
    expect(system).toContain('Debugging and Error Recovery')
    expect(system).toContain('Always reproduce the failure')
  })

  it('commits parallel tool results to model history in original tool-call order', async () => {
    const completionOrder: string[] = []
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_a', name: 'view_file', arguments: { path: 'a.txt' } },
        { id: 'call_b', name: 'view_file', arguments: { path: 'b.txt' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    fsMock.readProjectFile.mockImplementation(async (_projectPath: string, path: string) => {
      if (path === 'a.txt') {
        await new Promise(resolve => setTimeout(resolve, 20))
        completionOrder.push('a')
        return 'alpha'
      }
      if (path === 'b.txt') {
        completionOrder.push('b')
        return 'bravo'
      }
      throw new Error('not found')
    })

    await runAgent('/project', [], 'read files', makeCallbacks())

    expect(completionOrder).toEqual(['b', 'a'])

    const secondRequest = requestBody(1)
    const toolMessages = secondRequest.messages.filter((msg: any) => msg.role === 'tool')
    expect(toolMessages.map((msg: any) => msg.tool_call_id)).toEqual(['call_a', 'call_b'])
    const envelopes = toolMessages.map((msg: any) => parseToolEnvelope(msg.content))
    expect(envelopes.map((env: any) => env.output)).toEqual(['alpha', 'bravo'])
    expect(envelopes.map((env: any) => env.ok)).toEqual([true, true])
    expect(envelopes.map((env: any) => env.metadata.tool)).toEqual(['view_file', 'view_file'])
  })

  it('runs a valid bounded run_subagents batch and exposes schema caps', async () => {
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        {
          id: 'call_sub_batch',
          name: 'run_subagents',
          arguments: {
            tasks: [
              { type: 'explore', prompt: 'inspect auth', label: 'Auth' },
              { type: 'security', prompt: 'inspect billing', label: 'Billing' },
            ],
          },
        },
      ]))
      .mockResolvedValueOnce(chatContent('alpha'))
      .mockResolvedValueOnce(chatContent('bravo'))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'fan out checks', makeCallbacks())

    const runSubagentsTool = requestBody(0).tools.find((tool: any) => tool.function.name === 'run_subagents')
    expect(runSubagentsTool.function.parameters.properties.tasks.maxItems).toBe(4)
    expect(runSubagentsTool.function.parameters.properties.tasks.items.properties.prompt.maxLength).toBe(8000)

    const finalRequest = requestBody(3)
    const toolMessages = finalRequest.messages.filter((msg: any) => msg.role === 'tool')
    const envelope = parseToolEnvelope(toolMessages[0].content)
    expect(envelope.ok).toBe(true)
    expect(envelope.output).toContain('## Auth\nalpha')
    expect(envelope.output).toContain('## Billing\nbravo')
  })

  it('rejects run_subagents batches that exceed the max task count', async () => {
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        {
          id: 'call_too_many_subs',
          name: 'run_subagents',
          arguments: {
            tasks: [
              { type: 'explore', prompt: 'task 1' },
              { type: 'explore', prompt: 'task 2' },
              { type: 'explore', prompt: 'task 3' },
              { type: 'explore', prompt: 'task 4' },
              { type: 'explore', prompt: 'task 5' },
            ],
          },
        },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'too many subagents', makeCallbacks())

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const finalRequest = requestBody(1)
    const toolMessages = finalRequest.messages.filter((msg: any) => msg.role === 'tool')
    const envelope = parseToolEnvelope(toolMessages[0].content)
    expect(envelope.ok).toBe(false)
    expect(envelope.error).toContain('arguments.tasks must contain at most 4 items')
  })

  it('rejects run_subagents tasks with oversized prompts', async () => {
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        {
          id: 'call_oversized_sub_prompt',
          name: 'run_subagents',
          arguments: {
            tasks: [
              { type: 'explore', prompt: 'x'.repeat(8001), label: 'Oversized' },
            ],
          },
        },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'oversized subagent prompt', makeCallbacks())

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const finalRequest = requestBody(1)
    const toolMessages = finalRequest.messages.filter((msg: any) => msg.role === 'tool')
    const envelope = parseToolEnvelope(toolMessages[0].content)
    expect(envelope.ok).toBe(false)
    expect(envelope.error).toContain('arguments.tasks[0].prompt must be at most 8000 characters')
  })

  it('bounds run_subagents concurrency instead of spawning all tasks at once', async () => {
    let activeSubagents = 0
    let maxConcurrentSubagents = 0

    fetchMock.mockImplementation(async (_url: string, init?: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const messages = Array.isArray(body.messages) ? body.messages : []
      const lastMessage = messages.at(-1)

      if (lastMessage?.role === 'user' && lastMessage.content === 'bounded subagent batch') {
        return chatToolCalls([
          {
            id: 'call_bounded_subs',
            name: 'run_subagents',
            arguments: {
              tasks: [
                { type: 'explore', prompt: 'task-1', label: 'Task 1' },
                { type: 'explore', prompt: 'task-2', label: 'Task 2' },
                { type: 'explore', prompt: 'task-3', label: 'Task 3' },
                { type: 'explore', prompt: 'task-4', label: 'Task 4' },
              ],
            },
          },
        ])
      }

      if (lastMessage?.role === 'user' && /^task-\d+$/.test(String(lastMessage.content ?? ''))) {
        activeSubagents += 1
        maxConcurrentSubagents = Math.max(maxConcurrentSubagents, activeSubagents)
        const prompt = String(lastMessage.content)
        await new Promise(resolve => setTimeout(resolve, 20))
        activeSubagents -= 1
        return chatContent(`done ${prompt}`)
      }

      if (lastMessage?.role === 'tool') {
        return chatContent('done')
      }

      throw new Error(`Unexpected fetch body: ${JSON.stringify(body)}`)
    })

    await runAgent('/project', [], 'bounded subagent batch', makeCallbacks())

    expect(maxConcurrentSubagents).toBeLessThanOrEqual(2)
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('rejects unsafe write paths before approval preview or execution', async () => {
    const onApprovalRequired = vi.fn(async () => true)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_escape', name: 'write_file', arguments: { path: '../escape.txt', content: 'bad' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write outside project', makeCallbacks({ onApprovalRequired }))

    expect(onApprovalRequired).not.toHaveBeenCalled()
    expect(fsMock.writeProjectFile).not.toHaveBeenCalled()
    expect(fsMock.readProjectFile.mock.calls.some(([, path]) => path === '../escape.txt')).toBe(false)

    const secondRequest = requestBody(1)
    const toolMessages = secondRequest.messages.filter((msg: any) => msg.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    const envelope = parseToolEnvelope(toolMessages[0].content)
    expect(envelope).toMatchObject({
      ok: false,
      error: 'unsafe path "../escape.txt": parent directory traversal is not allowed',
      metadata: {
        tool: 'write_file',
        status: 'error',
        is_error: true,
      },
    })
  })

  it('rejects unsafe read paths before filesystem access', async () => {
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_abs', name: 'view_file', arguments: { path: '/etc/passwd' } },
        { id: 'call_traversal', name: 'list_dir', arguments: { path: '../secrets' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'read outside project', makeCallbacks())

    expect(fsMock.readProjectFile).not.toHaveBeenCalled()
    expect(invokeMock.mock.calls.some(([command]) => command === 'fs_read_file_bytes')).toBe(false)

    const secondRequest = requestBody(1)
    const toolMessages = secondRequest.messages.filter((msg: any) => msg.role === 'tool')
    const envelopes = toolMessages.map((msg: any) => parseToolEnvelope(msg.content))
    expect(envelopes).toHaveLength(2)
    expect(envelopes[0]).toMatchObject({
      ok: false,
      error: 'unsafe path "/etc/passwd": absolute paths are not allowed',
      metadata: { tool: 'view_file', status: 'error', is_error: true },
    })
    expect(envelopes[1]).toMatchObject({
      ok: false,
      error: 'unsafe path "../secrets": parent directory traversal is not allowed',
      metadata: { tool: 'list_dir', status: 'error', is_error: true },
    })
  })

  it('rejects missing required tool arguments before approval preview or execution', async () => {
    const onApprovalRequired = vi.fn(async () => true)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_missing', name: 'write_file', arguments: { path: 'ok.txt' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write incomplete file', makeCallbacks({ onApprovalRequired }))

    expect(onApprovalRequired).not.toHaveBeenCalled()
    expect(fsMock.readProjectFile).not.toHaveBeenCalledWith('/project', 'ok.txt')
    expect(fsMock.writeProjectFile).not.toHaveBeenCalled()

    const secondRequest = requestBody(1)
    const toolMessages = secondRequest.messages.filter((msg: any) => msg.role === 'tool')
    const envelope = parseToolEnvelope(toolMessages[0].content)
    expect(envelope).toMatchObject({
      ok: false,
      error: 'invalid arguments for write_file: arguments.content is required',
      metadata: {
        tool: 'write_file',
        status: 'error',
      },
    })
  })

  it('rejects wrong argument types before bash approval or execution', async () => {
    const onApprovalRequired = vi.fn(async () => true)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_bad_bash', name: 'bash', arguments: { command: 123 } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'run invalid command', makeCallbacks({ onApprovalRequired }))

    expect(onApprovalRequired).not.toHaveBeenCalled()
    expect(invokeMock.mock.calls.some(([command]) => command === 'shell_run_command')).toBe(false)

    const secondRequest = requestBody(1)
    const toolMessages = secondRequest.messages.filter((msg: any) => msg.role === 'tool')
    const envelope = parseToolEnvelope(toolMessages[0].content)
    expect(envelope).toMatchObject({
      ok: false,
      error: 'invalid arguments for bash: arguments.command must be string',
      metadata: {
        tool: 'bash',
        status: 'error',
      },
    })
  })

  it('emits redacted audit events for approved file mutations', async () => {
    const onAuditEvent = vi.fn()
    const onApprovalRequired = vi.fn(async () => true)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_write', name: 'write_file', arguments: { path: 'safe.txt', content: 'api_key=super-secret' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write safe file', makeCallbacks({ onApprovalRequired, onAuditEvent }))

    expect(onAuditEvent).toHaveBeenCalledTimes(1)
    const event = onAuditEvent.mock.calls[0][0]
    expect(event).toMatchObject({
      toolName: 'write_file',
      touchedFiles: ['safe.txt'],
      approval: 'approved',
      status: 'success',
      argsSummary: {
        path: 'safe.txt',
        contentChars: 'api_key=super-secret'.length,
      },
    })
    expect(JSON.stringify(event)).not.toContain('super-secret')
  })

  it('requires approval for file mutations in plan mode', async () => {
    const onApprovalRequired = vi.fn(async () => false)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_write_plan', name: 'write_file', arguments: { path: 'safe.txt', content: 'planned edit' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write safe file', makeCallbacks({ onApprovalRequired, permissionMode: 'plan_mode' }))

    expect(onApprovalRequired).toHaveBeenCalledTimes(1)
    expect(fsMock.writeProjectFile).not.toHaveBeenCalled()
  })

  it('auto-applies file edits in Edit automatically mode', async () => {
    const onApprovalRequired = vi.fn(async () => false)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_write_auto', name: 'write_file', arguments: { path: 'safe.txt', content: 'automatic edit' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write safe file', makeCallbacks({ onApprovalRequired, permissionMode: 'auto_review' }))

    expect(fsMock.writeProjectFile).toHaveBeenCalledWith('/project', 'safe.txt', 'automatic edit')
  })

  it('requires approval for mutating bash in Edit automatically mode', async () => {
    const onApprovalRequired = vi.fn(async () => false)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_bash_auto', name: 'bash', arguments: { command: 'npm install left-pad' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'install package', makeCallbacks({ onApprovalRequired, permissionMode: 'auto_review' }))

    expect(onApprovalRequired).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls.some(([command]) => command === 'shell_run_command')).toBe(false)
  })

  it('auto-runs mutating bash in Auto mode', async () => {
    const onApprovalRequired = vi.fn(async () => false)
    invokeMock.mockResolvedValueOnce({ stdout: 'installed', stderr: '', exit_code: 0 })
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_bash_auto_mode', name: 'bash', arguments: { command: 'npm install left-pad' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'install package', makeCallbacks({ onApprovalRequired, permissionMode: 'full_access' }))

    expect(onApprovalRequired).not.toHaveBeenCalled()
    expect(invokeMock.mock.calls.some(([command]) => command === 'shell_run_command')).toBe(true)
  })

  it('emits redacted audit events for rejected mutating bash commands', async () => {
    const onAuditEvent = vi.fn()
    const onApprovalRequired = vi.fn(async () => false)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_bash', name: 'bash', arguments: { command: 'npm publish --token super-secret-token' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'publish package', makeCallbacks({ onApprovalRequired, onAuditEvent }))

    expect(onApprovalRequired).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls.some(([command]) => command === 'shell_run_command')).toBe(false)
    expect(onAuditEvent).toHaveBeenCalledTimes(1)
    const event = onAuditEvent.mock.calls[0][0]
    expect(event).toMatchObject({
      toolName: 'bash',
      approval: 'rejected',
      status: 'denied',
      errorCategory: 'permission_denied',
    })
    expect(event.argsSummary.command).toContain('[REDACTED]')
    expect(JSON.stringify(event)).not.toContain('super-secret-token')
  })
})

describe('runAgent — small-output write_file cap', () => {
  it('rejects an oversized write_file for a flagged small-output model instead of writing it', async () => {
    getModelInfoMock.mockImplementation(() => ({ name: 'qwen-small', contextLength: 262144, smallOutput: true }))
    const bigContent = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n')
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_big', name: 'write_file', arguments: { path: 'big.txt', content: bigContent } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write a big file', makeCallbacks())

    expect(fsMock.writeProjectFile).not.toHaveBeenCalled()

    const secondRequest = requestBody(1)
    const toolMessages = secondRequest.messages.filter((msg: any) => msg.role === 'tool')
    const envelope = parseToolEnvelope(toolMessages[0].content)
    expect(envelope.ok).toBe(false)
    expect(envelope.error).toContain('80-line limit')
  })

  it('counts only non-empty lines for the small-output write cap', async () => {
    getModelInfoMock.mockImplementation(() => ({ name: 'qwen-small', contextLength: 262144, smallOutput: true }))
    const formattedContent = Array.from({ length: 100 }, (_, i) => (i % 4 === 0 ? '' : `line ${i}`)).join('\n')
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_formatted', name: 'write_file', arguments: { path: 'formatted.txt', content: formattedContent } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write formatted content', makeCallbacks())

    expect(fsMock.writeProjectFile).toHaveBeenCalledWith('/project', 'formatted.txt', formattedContent)
  })

  it('counts normalized escaped newline content before enforcing the write cap', async () => {
    getModelInfoMock.mockImplementation(() => ({ name: 'qwen-small', contextLength: 262144, smallOutput: true }))
    const escapedBigContent = Array.from({ length: 120 }, (_, i) => `export const line${i} = ${i};`).join('\\n')
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_big_escaped', name: 'write_file', arguments: { path: 'big.ts', content: escapedBigContent } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write a big escaped file', makeCallbacks())

    expect(fsMock.writeProjectFile).not.toHaveBeenCalled()

    const secondRequest = requestBody(1)
    const toolMessages = secondRequest.messages.filter((msg: any) => msg.role === 'tool')
    const envelope = parseToolEnvelope(toolMessages[0].content)
    expect(envelope.ok).toBe(false)
    expect(envelope.error).toContain('120 non-empty lines')
    expect(envelope.error).toContain('80-line limit')
  })

  it('allows a small write_file for a flagged small-output model', async () => {
    getModelInfoMock.mockImplementation(() => ({ name: 'qwen-small', contextLength: 262144, smallOutput: true }))
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_small', name: 'write_file', arguments: { path: 'small.txt', content: 'hello' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write a small file', makeCallbacks())

    expect(fsMock.writeProjectFile).toHaveBeenCalledWith('/project', 'small.txt', 'hello')
  })

  it('uses the effective main model override when applying the small-output write cap', async () => {
    getModelInfoMock.mockImplementation((model?: string) => ({
      name: model ?? 'gpt-4o',
      contextLength: 128000,
      smallOutput: model === 'Qwen/Qwen3.6-35B-A3B',
    }))
    const bigContent = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n')
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_override_big', name: 'write_file', arguments: { path: 'big.txt', content: bigContent } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'write a big file', makeCallbacks({ modelOverride: 'Qwen/Qwen3.6-35B-A3B' }))

    expect(getModelInfoMock).toHaveBeenCalledWith('Qwen/Qwen3.6-35B-A3B')
    expect(fsMock.writeProjectFile).not.toHaveBeenCalled()
  })

  it('uses the effective subagent model override when applying the small-output write cap', async () => {
    getConfigMock.mockImplementation(() => ({
      ...BASE_CONFIG,
      customSubagents: [{
        id: 'small-writer',
        label: 'Small writer',
        description: 'Writes with a small-output model',
        systemPrompt: 'write carefully',
        writable: true,
        model: 'Qwen/Qwen3.6-35B-A3B',
        tools: ['write_file'],
      }],
    }))
    getModelInfoMock.mockImplementation((model?: string) => ({
      name: model ?? 'gpt-4o',
      contextLength: 128000,
      smallOutput: model === 'Qwen/Qwen3.6-35B-A3B',
    }))
    const bigContent = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n')
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_subagent', name: 'run_subagent', arguments: { type: 'small-writer', prompt: 'write big file' } },
      ]))
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_sub_write', name: 'write_file', arguments: { path: 'big.txt', content: bigContent } },
      ]))
      .mockResolvedValueOnce(chatContent('subagent done'))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'delegate big file', makeCallbacks())

    expect(getModelInfoMock).toHaveBeenCalledWith('Qwen/Qwen3.6-35B-A3B')
    expect(fsMock.writeProjectFile).not.toHaveBeenCalled()
  })
})

describe('runAgent — subagent cache scoping', () => {
  it('does not share read-only subagent cache across project paths', async () => {
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_project_a', name: 'run_subagent', arguments: { type: 'explore', prompt: 'cache scope project prompt' } },
      ]))
      .mockResolvedValueOnce(chatContent('project-a-subagent-result'))
      .mockResolvedValueOnce(chatContent('done a'))
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_project_b', name: 'run_subagent', arguments: { type: 'explore', prompt: 'cache scope project prompt' } },
      ]))
      .mockResolvedValueOnce(chatContent('project-b-subagent-result'))
      .mockResolvedValueOnce(chatContent('done b'))

    await runAgent('/project-a', [], 'run subagent in project a', makeCallbacks())
    await runAgent('/project-b', [], 'run subagent in project b', makeCallbacks())

    expect(fetchMock).toHaveBeenCalledTimes(6)

    const firstToolMessages = requestBody(2).messages.filter((msg: any) => msg.role === 'tool')
    const secondToolMessages = requestBody(5).messages.filter((msg: any) => msg.role === 'tool')
    expect(parseToolEnvelope(firstToolMessages[0].content).output).toBe('project-a-subagent-result')
    expect(parseToolEnvelope(secondToolMessages[0].content).output).toBe('project-b-subagent-result')
  })

  it('does not share subagent cache when the resolved subagent config changes', async () => {
    let currentConfig: any = {
      ...BASE_CONFIG,
      customSubagents: [{
        id: 'review-helper',
        label: 'Review helper',
        description: 'Version one',
        systemPrompt: 'inspect with config v1',
        writable: false,
        model: 'gpt-4o',
        tools: ['view_file'],
      }],
    }
    getConfigMock.mockImplementation(() => currentConfig)

    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_cfg_1', name: 'run_subagent', arguments: { type: 'review-helper', prompt: 'cache scope config prompt' } },
      ]))
      .mockResolvedValueOnce(chatContent('config-v1-result'))
      .mockResolvedValueOnce(chatContent('done cfg1'))
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_cfg_2', name: 'run_subagent', arguments: { type: 'review-helper', prompt: 'cache scope config prompt' } },
      ]))
      .mockResolvedValueOnce(chatContent('config-v2-result'))
      .mockResolvedValueOnce(chatContent('done cfg2'))

    await runAgent('/project-config', [], 'run config v1', makeCallbacks())

    currentConfig = {
      ...BASE_CONFIG,
      customSubagents: [{
        id: 'review-helper',
        label: 'Review helper',
        description: 'Version two',
        systemPrompt: 'inspect with config v2',
        writable: false,
        model: 'Qwen/Qwen3.6-35B-A3B',
        tools: ['view_file', 'list_dir'],
      }],
    }

    await runAgent('/project-config', [], 'run config v2', makeCallbacks())

    expect(fetchMock).toHaveBeenCalledTimes(6)

    const firstToolMessages = requestBody(2).messages.filter((msg: any) => msg.role === 'tool')
    const secondToolMessages = requestBody(5).messages.filter((msg: any) => msg.role === 'tool')
    expect(parseToolEnvelope(firstToolMessages[0].content).output).toBe('config-v1-result')
    expect(parseToolEnvelope(secondToolMessages[0].content).output).toBe('config-v2-result')
  })

  it('does not share subagent cache when the tool policy changes', async () => {
    let currentConfig: any = {
      ...BASE_CONFIG,
      customSubagents: [{
        id: 'policy-helper',
        label: 'Policy helper',
        description: 'Read-only helper',
        systemPrompt: 'inspect with stable instructions',
        writable: false,
        tools: ['view_file'],
      }],
    }
    getConfigMock.mockImplementation(() => currentConfig)

    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_policy_1', name: 'run_subagent', arguments: { type: 'policy-helper', prompt: 'cache scope policy prompt' } },
      ]))
      .mockResolvedValueOnce(chatContent('policy-v1-result'))
      .mockResolvedValueOnce(chatContent('done policy1'))
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_policy_2', name: 'run_subagent', arguments: { type: 'policy-helper', prompt: 'cache scope policy prompt' } },
      ]))
      .mockResolvedValueOnce(chatContent('policy-v2-result'))
      .mockResolvedValueOnce(chatContent('done policy2'))

    await runAgent('/project-policy', [], 'run policy v1', makeCallbacks())

    currentConfig = {
      ...BASE_CONFIG,
      customSubagents: [{
        id: 'policy-helper',
        label: 'Policy helper',
        description: 'Read-only helper',
        systemPrompt: 'inspect with stable instructions',
        writable: false,
        tools: ['view_file', 'list_dir'],
      }],
    }

    await runAgent('/project-policy', [], 'run policy v2', makeCallbacks())

    expect(fetchMock).toHaveBeenCalledTimes(6)

    const firstToolMessages = requestBody(2).messages.filter((msg: any) => msg.role === 'tool')
    const secondToolMessages = requestBody(5).messages.filter((msg: any) => msg.role === 'tool')
    expect(parseToolEnvelope(firstToolMessages[0].content).output).toBe('policy-v1-result')
    expect(parseToolEnvelope(secondToolMessages[0].content).output).toBe('policy-v2-result')
  })
})

describe('runAgent — update_plan', () => {
  it('upserts a single live plan part across repeated calls', async () => {
    const updates: MessagePart[][] = []
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_plan_1', name: 'update_plan', arguments: { plan: [
          { step: 'Write skeleton', status: 'in_progress' },
          { step: 'Fill sections', status: 'pending' },
        ] } },
      ]))
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_plan_2', name: 'update_plan', arguments: { plan: [
          { step: 'Write skeleton', status: 'completed' },
          { step: 'Fill sections', status: 'in_progress' },
        ] } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'build a page', makeCallbacks({
      onPartsUpdate: parts => updates.push(parts),
    }))

    const finalParts = updates.at(-1) ?? []
    const planParts = finalParts.filter(p => p.type === 'plan')
    expect(planParts).toHaveLength(1)
    expect(planParts[0].data).toMatchObject({
      steps: [
        { step: 'Write skeleton', status: 'completed' },
        { step: 'Fill sections', status: 'in_progress' },
      ],
    })
  })

  it('rejects a plan with more than one in_progress step', async () => {
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_bad_plan', name: 'update_plan', arguments: { plan: [
          { step: 'A', status: 'in_progress' },
          { step: 'B', status: 'in_progress' },
        ] } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    const updates: MessagePart[][] = []
    await runAgent('/project', [], 'build a page', makeCallbacks({
      onPartsUpdate: parts => updates.push(parts),
    }))

    const finalParts = updates.at(-1) ?? []
    expect(finalParts.some(p => p.type === 'plan')).toBe(false)

    const secondRequest = requestBody(1)
    const toolMessages = secondRequest.messages.filter((msg: any) => msg.role === 'tool')
    const envelope = parseToolEnvelope(toolMessages[0].content)
    expect(envelope.ok).toBe(false)
    expect(envelope.error).toContain('only one step may be in_progress')
  })
})

// ── isReadOnlyBashCommand ─────────────────────────────────────────────────────

describe('isReadOnlyBashCommand', () => {
  // Read-only commands — should NOT trigger approval
  it.each([
    'ls',
    'ls -la',
    'ls /home/akash',
    'cat package.json',
    'grep -r "hello" src/',
    'git status',
    'git log --oneline',
    'git diff HEAD',
    'git branch',
    'pwd',
    'whoami',
    'node --version',
    'npm --version',
    'python3 --version',
    'which node',
    'find . -name "*.ts"',
    'wc -l src/App.tsx',
    'head -20 README.md',
    'tail -f logs/app.log',
    'echo hello',
    'ps aux',
    'env',
  ])('treats "%s" as read-only', (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(true)
  })

  // Mutating commands — MUST require approval in Default mode
  it.each([
    'rm -rf dist/',
    'npm install',
    'npm run build',
    'git commit -m "test"',
    'git push origin main',
    'git reset --hard HEAD',
    'mkdir newdir',
    'mv file.ts file.tsx',
    'cp -r src backup',
    'chmod +x script.sh',
    'pip install requests',
    'cargo build',
    'docker run alpine',
  ])('treats "%s" as mutating', (cmd) => {
    expect(isReadOnlyBashCommand(cmd)).toBe(false)
  })
})

// ── redactMCPArgs ─────────────────────────────────────────────────────────────

describe('redactMCPArgs', () => {
  it('redacts string values of sensitive top-level keys', () => {
    const result = redactMCPArgs({ token: 'abc123', query: 'search term' })
    expect(result.token).toBe('[REDACTED]')
    expect(result.query).toBe('search term')
  })

  it.each(['token', 'api_key', 'apiKey', 'apikey', 'secret', 'password', 'passwd', 'pwd',
    'authorization', 'auth', 'credential', 'bearer', 'private_key', 'access_key',
  ])('redacts key "%s"', (key) => {
    expect((redactMCPArgs({ [key]: 'super-secret' }) as any)[key]).toBe('[REDACTED]')
  })

  it('does not redact non-string values (numbers, booleans)', () => {
    const result = redactMCPArgs({ token: 42 as any, secret: true as any })
    expect(result.token).toBe(42)
    expect(result.secret).toBe(true)
  })

  it('does not redact empty string values', () => {
    const result = redactMCPArgs({ token: '' })
    expect(result.token).toBe('')
  })

  it('redacts nested sensitive keys recursively', () => {
    const result = redactMCPArgs({ auth: { token: 'nested-secret', scope: 'read' } })
    const auth = result.auth as any
    expect(auth.token).toBe('[REDACTED]')
    expect(auth.scope).toBe('read')
  })

  it('leaves arrays unchanged', () => {
    const result = redactMCPArgs({ items: ['a', 'b'] as any })
    expect(result.items).toEqual(['a', 'b'])
  })

  it('redacts nested sensitive keys inside arrays', () => {
    const result = redactMCPArgs({ headers: [{ token: 'nested-secret', name: 'x' }] as any })
    expect(result.headers).toEqual([{ token: '[REDACTED]', name: 'x' }])
  })

  it('leaves non-sensitive keys unchanged', () => {
    const result = redactMCPArgs({ repo: 'myrepo', owner: 'myorg', limit: 10 as any })
    expect(result).toEqual({ repo: 'myrepo', owner: 'myorg', limit: 10 })
  })
})

// ── isMCPToolReadOnly ─────────────────────────────────────────────────────────

describe('isMCPToolReadOnly', () => {
  it('returns true when readOnlyHint annotation is true', () => {
    expect(isMCPToolReadOnly('svc__anything', { readOnlyHint: true })).toBe(true)
  })

  it('returns false when readOnlyHint is false', () => {
    expect(isMCPToolReadOnly('svc__list_items', { readOnlyHint: false })).toBe(false)
  })

  it('returns false when destructiveHint is true (overrides name heuristic)', () => {
    expect(isMCPToolReadOnly('svc__get_data', { destructiveHint: true })).toBe(false)
  })

  it('annotation takes precedence over name heuristic', () => {
    expect(isMCPToolReadOnly('svc__delete_all', { readOnlyHint: true })).toBe(true)
  })

  it.each([
    'svc__list_issues',
    'svc__get_user',
    'svc__search_repos',
    'svc__find_file',
    'svc__fetch_data',
    'svc__read_config',
    'svc__show_pr',
    'svc__view_branch',
    'svc__describe_table',
    'svc__query_logs',
  ])('name heuristic: treats "%s" as read-only', (toolId) => {
    expect(isMCPToolReadOnly(toolId, undefined)).toBe(true)
  })

  it.each([
    'svc__create_issue',
    'svc__update_pr',
    'svc__delete_branch',
    'svc__send_message',
    'svc__push_commit',
    'svc__merge_pr',
    'svc__upload_file',
    'svc__deploy_app',
  ])('name heuristic: treats "%s" as write (requires approval)', (toolId) => {
    expect(isMCPToolReadOnly(toolId, undefined)).toBe(false)
  })

  it('defaults to false (require approval) for ambiguous names', () => {
    expect(isMCPToolReadOnly('svc__run_pipeline', undefined)).toBe(false)
    expect(isMCPToolReadOnly('svc__execute', undefined)).toBe(false)
  })

  it('treats Figma tool reads as read-only by default', () => {
    expect(isMCPToolReadOnly('figma__get_file_data', undefined)).toBe(true)
    expect(isMCPToolReadOnly('figma__download_asset', undefined)).toBe(true)
  })
})

// ── compaction version ────────────────────────────────────────────────────────

describe('historyToOAI — compaction version warning', () => {
  it('warns when stored compaction version exceeds current', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const history: Message[] = [{
      id: 'c1', session_id: 's', role: 'user', created_at: 0, updated_at: 0,
      parts: [{
        type: 'compaction',
        data: { version: 9999, summary: 'old summary', messageCount: 5, fromTs: 0, toTs: 1 },
      }],
    }]

    historyToOAI(history)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('9999'),
    )
    warnSpy.mockRestore()
  })

  it('does NOT warn for current version', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const history: Message[] = [{
      id: 'c1', session_id: 's', role: 'user', created_at: 0, updated_at: 0,
      parts: [{
        type: 'compaction',
        data: { version: 1, summary: 'summary', messageCount: 3, fromTs: 0, toTs: 1 },
      }],
    }]

    historyToOAI(history)

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('version'), expect.anything())
    warnSpy.mockRestore()
  })

  it('injects compaction summary into OAI messages', () => {
    const history: Message[] = [{
      id: 'c1', session_id: 's', role: 'user', created_at: 0, updated_at: 0,
      parts: [{
        type: 'compaction',
        data: { version: 1, summary: 'Goal: build a todo app', messageCount: 10, fromTs: 0, toTs: 1 },
      }],
    }]

    const oai = historyToOAI(history)
    expect(oai).toHaveLength(1)
    expect(oai[0].role).toBe('user')
    expect(oai[0].content).toContain('Goal: build a todo app')
    expect(oai[0].content).toContain('10 earlier messages')
  })

  it('keeps compacted memory when trimming long histories', () => {
    const history: Message[] = [{
      id: 'c1', session_id: 's', role: 'user', created_at: 0, updated_at: 0,
      parts: [{
        type: 'compaction',
        data: { version: 1, summary: 'Critical memory survives', messageCount: 12, fromTs: 0, toTs: 1 },
      }],
    }]

    for (let i = 0; i < 70; i++) {
      history.push(makeMessage('user', [{ type: 'text', data: { text: `message ${i}` } }]))
    }

    const oai = historyToOAI(history)
    expect(oai[0].content).toContain('Critical memory survives')
    expect(oai.some(msg => String(msg.content).includes('message 0'))).toBe(false)
    expect(oai.some(msg => String(msg.content).includes('message 69'))).toBe(true)
  })
})

describe('compactHistory', () => {
  it('can compact the whole session when keepTail is zero', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({ choices: [{ message: { content: '## Goal\nSummarized session' } }] })),
    })

    const history: Message[] = [
      makeMessage('user', [{ type: 'text', data: { text: 'first message' } }]),
      makeMessage('assistant', [{ type: 'text', data: { text: 'reply' } }]),
    ]

    const { compactionMsg, keptMessages } = await compactHistory(history, 0)

    expect(keptMessages).toHaveLength(0)
    expect((compactionMsg.parts[0].data as { messageCount: number }).messageCount).toBe(2)
  })

  it('keeps existing compacted memory when there is nothing new to summarize', async () => {
    const compacted: Message = {
      id: 'c1', session_id: 's', role: 'user', created_at: 0, updated_at: 0,
      parts: [{
        type: 'compaction',
        data: { version: 1, summary: 'Already summarized', messageCount: 9, fromTs: 0, toTs: 1 },
      }],
    }

    const { compactionMsg, keptMessages } = await compactHistory([compacted], 0)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(compactionMsg).toBe(compacted)
    expect(keptMessages).toHaveLength(0)
  })
})

// ── MCP approval flow ─────────────────────────────────────────────────────────

const MCP_SERVER_CONFIG = {
  id: 'gh-server',
  name: 'github',
  type: 'http' as const,
  url: 'http://mcp.local',
  disabled: false,
}

function withMCPServer(tools: Array<{ name: string; annotations?: any }>) {
  getConfigMock.mockImplementation(() => ({
    ...BASE_CONFIG,
    mcpServers: [MCP_SERVER_CONFIG],
  }))
  mcpMock.instance.initServer.mockResolvedValue({
    serverId: MCP_SERVER_CONFIG.id,
    serverName: MCP_SERVER_CONFIG.name,
    type: 'http',
    tools,
    isReady: true,
  })
  mcpMock.instance.callTool.mockResolvedValue('tool result')
}

describe('runAgent — MCP approval', () => {
  it('requires approval for write MCP tools and calls tool after approval', async () => {
    withMCPServer([{ name: 'create_issue' }])
    const onApprovalRequired = vi.fn(async () => true)
    const onAuditEvent = vi.fn()
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_mcp', name: 'github__create_issue', arguments: { title: 'Bug', body: 'desc', token: 'ghp_secret' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'create issue', makeCallbacks({ onApprovalRequired, onAuditEvent }))

    expect(onApprovalRequired).toHaveBeenCalledTimes(1)
    expect(onApprovalRequired.mock.calls[0][1]).toBe('github__create_issue')
    expect(mcpMock.instance.callTool).toHaveBeenCalledWith('github__create_issue', { title: 'Bug', body: 'desc', token: 'ghp_secret' })
    expect(onAuditEvent).toHaveBeenCalledTimes(1)
    const event = onAuditEvent.mock.calls[0][0]
    expect(event).toMatchObject({
      toolName: 'github__create_issue',
      approval: 'approved',
      status: 'success',
    })
    expect(event.argsSummary.args).toContain('[REDACTED]')
    expect(JSON.stringify(event)).not.toContain('ghp_secret')
  })

  it('skips approval for read-only MCP tools', async () => {
    withMCPServer([{ name: 'list_issues' }])
    const onApprovalRequired = vi.fn(async () => true)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_mcp_r', name: 'github__list_issues', arguments: { repo: 'myrepo' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'list issues', makeCallbacks({ onApprovalRequired }))

    expect(onApprovalRequired).not.toHaveBeenCalled()
    expect(mcpMock.instance.callTool).toHaveBeenCalledWith('github__list_issues', { repo: 'myrepo' })
  })

  it('skips approval when server declares readOnlyHint: true', async () => {
    withMCPServer([{ name: 'run_query', annotations: { readOnlyHint: true } }])
    const onApprovalRequired = vi.fn(async () => true)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_ro', name: 'github__run_query', arguments: { sql: 'SELECT 1' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'run query', makeCallbacks({ onApprovalRequired }))

    expect(onApprovalRequired).not.toHaveBeenCalled()
  })

  it('redacts sensitive args in approval card — token not visible to UI', async () => {
    withMCPServer([{ name: 'create_issue' }])
    const parts: MessagePart[][] = []
    const onApprovalRequired = vi.fn(async () => true)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_s', name: 'github__create_issue', arguments: { title: 'T', token: 'ghp_supersecret' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'create', makeCallbacks({
      onApprovalRequired,
      onPartsUpdate: p => parts.push(p),
    }))

    const approvalPart = parts.flat().find(p => p.type === 'approval_request')
    expect(approvalPart).toBeDefined()
    const command = (approvalPart!.data as any).command as string
    expect(command).toContain('[REDACTED]')
    expect(command).not.toContain('ghp_supersecret')
  })

  it('does not call tool when MCP approval is rejected', async () => {
    withMCPServer([{ name: 'delete_branch' }])
    const onApprovalRequired = vi.fn(async () => false)
    const onAuditEvent = vi.fn()
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_del', name: 'github__delete_branch', arguments: { branch: 'feat/old' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'delete branch', makeCallbacks({ onApprovalRequired, onAuditEvent }))

    expect(mcpMock.instance.callTool).not.toHaveBeenCalled()
    expect(onAuditEvent).toHaveBeenCalledTimes(1)
    expect(onAuditEvent.mock.calls[0][0]).toMatchObject({
      toolName: 'github__delete_branch',
      approval: 'rejected',
      status: 'denied',
      errorCategory: 'permission_denied',
    })
    const secondRequest = requestBody(1)
    const toolMessages = secondRequest.messages.filter((m: any) => m.role === 'tool')
    expect(toolMessages[0].content).toContain('Permission denied')
  })

  it('requires approval for write MCP tools in Edit automatically mode', async () => {
    withMCPServer([{ name: 'create_issue' }])
    const onApprovalRequired = vi.fn(async () => false)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_mcp_auto', name: 'github__create_issue', arguments: { title: 'Bug' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'create issue', makeCallbacks({ onApprovalRequired, permissionMode: 'auto_review' }))

    expect(onApprovalRequired).toHaveBeenCalledTimes(1)
    expect(mcpMock.instance.callTool).not.toHaveBeenCalled()
  })

  it('auto-runs write MCP tools in Auto mode', async () => {
    withMCPServer([{ name: 'create_issue' }])
    const onApprovalRequired = vi.fn(async () => false)
    fetchMock
      .mockResolvedValueOnce(chatToolCalls([
        { id: 'call_mcp_full_auto', name: 'github__create_issue', arguments: { title: 'Bug' } },
      ]))
      .mockResolvedValueOnce(chatContent('done'))

    await runAgent('/project', [], 'create issue', makeCallbacks({ onApprovalRequired, permissionMode: 'full_access' }))

    expect(onApprovalRequired).not.toHaveBeenCalled()
    expect(mcpMock.instance.callTool).toHaveBeenCalledWith('github__create_issue', { title: 'Bug' })
  })
})
