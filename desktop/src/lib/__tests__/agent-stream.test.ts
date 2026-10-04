import { describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('../config', () => ({
  getConfig: () => ({
    model: {
      providerId: 'betopia',
      model: 'gpt-5.4',
      apiKeys: {},
      thinkingMode: false,
      thinkingLevel: 'high',
    },
  }),
  getResolvedEndpointAsync: async () => ({
    baseUrl: 'https://api.betopia.ai/v1',
    apiKey: 'test-key',
    model: 'gpt-5.4',
  }),
}))
vi.mock('../proxyFetch', () => ({
  proxyFetch: fetchMock,
}))
vi.mock('../providers', () => ({
  THINKING_MODELS: new Set<string>(),
  CACHE_MODELS: new Set<string>(),
  BETOPIA_BASE_URL: 'https://api.betopia.ai',
}))

import { streamChat } from '../agent-stream'
import { isInferenceError } from '../agent-stream'

describe('streamChat Betopia GPT compatibility', () => {
  it('treats empty choices and model errors as inference failures', () => {
    expect(isInferenceError(new Error('AI API error 502: {"error":"empty choices in response"}'))).toBe(true)
    expect(isInferenceError(new Error('AI API error 502: {"error":"model returned an error"}'))).toBe(true)
  })

  it('omits reasoning_effort for Betopia GPT models', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'done' } }] })))
          controller.close()
        },
      }),
      text: vi.fn(async () => JSON.stringify({ choices: [{ message: { content: 'done' } }] })),
    })

    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of streamChat([{ role: 'user', content: 'hi' } as any], [], undefined)) {
      chunks.push(chunk as Record<string, unknown>)
    }

    expect(chunks.some(c => c.text === 'done')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.max_completion_tokens).toBe(2048)
  })

  it('retries Betopia GPT models with a smaller completion budget after repeated 5xx failures', async () => {
    fetchMock.mockClear()
    const errorResponse = {
      ok: false,
      status: 502,
      text: vi.fn(async () => JSON.stringify({ error: 'model returned an error' })),
    }
    fetchMock.mockResolvedValueOnce(errorResponse)
    fetchMock.mockResolvedValueOnce(errorResponse)
    fetchMock.mockResolvedValueOnce(errorResponse)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'done' } }] })))
          controller.close()
        },
      }),
      text: vi.fn(async () => JSON.stringify({ choices: [{ message: { content: 'done' } }] })),
    })

    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of streamChat([{ role: 'user', content: 'hi' } as any], [], undefined)) {
      chunks.push(chunk as Record<string, unknown>)
    }

    expect(chunks.some(c => c.text === 'done')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const finalBody = JSON.parse(fetchMock.mock.calls[3][1].body as string)
    expect(finalBody.stream).toBe(false)
    expect(finalBody.tools).toBeUndefined()
    expect(finalBody.max_completion_tokens).toBe(1024)
  })
})
