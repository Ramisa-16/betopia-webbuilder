import { describe, expect, it, vi } from 'vitest'
import { createFigmaTaskCache } from '../figma-task-cache'

function makeDesignPayload(pageCount = 2) {
  return JSON.stringify({
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: Array.from({ length: pageCount }, (_, index) => ({
        id: `${index + 1}:0`,
        name: `Page ${index + 1}`,
        type: 'CANVAS',
        children: [
          {
            id: `${index + 1}:1`,
            name: `Frame ${index + 1}`,
            type: 'FRAME',
            children: [],
          },
        ],
      })),
    },
  })
}

describe('FigmaTaskCache', () => {
  it('caches duplicate design lookups inside one task', async () => {
    const cache = createFigmaTaskCache({ sessionId: 'session-1', taskId: 'task-1' })
    const execute = vi.fn().mockResolvedValue(makeDesignPayload(2))

    const first = await cache.run(
      {
        kind: 'tool',
        serverName: 'figma',
        toolName: 'figma_get_file_data',
        args: { fileKey: 'FILE-1' },
        rawArgsJson: '{"fileKey":"FILE-1"}',
      },
      execute,
    )

    const second = await cache.run(
      {
        kind: 'tool',
        serverName: 'figma',
        toolName: 'figma_get_file_data',
        args: { fileKey: 'FILE-1' },
        rawArgsJson: '{"fileKey":"FILE-1"}',
      },
      execute,
    )

    expect(execute).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(first).toContain('Page 1')
  })

  it('bypasses the cache when refresh is requested', async () => {
    const cache = createFigmaTaskCache({ sessionId: 'session-1', taskId: 'task-2' })
    const execute = vi.fn()
      .mockResolvedValueOnce(makeDesignPayload(1))
      .mockResolvedValueOnce(makeDesignPayload(1))

    await cache.run(
      {
        kind: 'tool',
        serverName: 'figma',
        toolName: 'figma_get_file_data',
        args: { fileKey: 'FILE-2' },
        rawArgsJson: '{"fileKey":"FILE-2"}',
      },
      execute,
    )

    await cache.run(
      {
        kind: 'tool',
        serverName: 'figma',
        toolName: 'figma_get_file_data',
        args: { fileKey: 'FILE-2', refresh: true },
        rawArgsJson: '{"fileKey":"FILE-2","refresh":true}',
      },
      execute,
    )

    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('asks for a target when the file is broad', async () => {
    const cache = createFigmaTaskCache({ sessionId: 'session-1', taskId: 'task-3' })
    const execute = vi.fn().mockResolvedValue(makeDesignPayload(14))

    const result = await cache.run(
      {
        kind: 'tool',
        serverName: 'figma',
        toolName: 'figma_get_file_data',
        args: { fileKey: 'FILE-3' },
        rawArgsJson: '{"fileKey":"FILE-3"}',
      },
      execute,
    )

    expect(result).toContain('Pick a target frame/page')
    expect(result).toContain('Available targets')
  })

  it('focuses a node when the URL contains node-id', async () => {
    const cache = createFigmaTaskCache({ sessionId: 'session-1', taskId: 'task-4' })
    const execute = vi.fn().mockResolvedValue(JSON.stringify({
      document: {
        id: '0:0',
        name: 'Document',
        type: 'DOCUMENT',
        children: [
          {
            id: '1:0',
            name: 'Landing',
            type: 'CANVAS',
            children: [
              {
                id: '123:456',
                name: 'Hero',
                type: 'FRAME',
                children: [
                  { id: '123:789', name: 'Button', type: 'FRAME', children: [] },
                ],
              },
            ],
          },
        ],
      },
    }))

    const result = await cache.run(
      {
        kind: 'resource',
        serverName: 'figma',
        toolName: 'resources/read',
        args: { server_name: 'figma', uri: 'https://figma.com/file/FILE-4/Design?node-id=123%3A456' },
        rawArgsJson: '{"server_name":"figma","uri":"https://figma.com/file/FILE-4/Design?node-id=123%3A456"}',
        resourceUri: 'https://figma.com/file/FILE-4/Design?node-id=123%3A456',
      },
      execute,
    )

    expect(result).toContain('"id": "123:456"')
    expect(result).toContain('"name": "Hero"')
    expect(result).not.toContain('Pick a target frame/page')
  })

  it('stops after a rate-limit error', async () => {
    const cache = createFigmaTaskCache({ sessionId: 'session-1', taskId: 'task-5' })
    const execute = vi.fn().mockResolvedValue('Error: 429 Too Many Requests')

    const first = await cache.run(
      {
        kind: 'tool',
        serverName: 'figma',
        toolName: 'figma_get_file_data',
        args: { fileKey: 'FILE-5' },
        rawArgsJson: '{"fileKey":"FILE-5"}',
      },
      execute,
    )

    const second = await cache.run(
      {
        kind: 'tool',
        serverName: 'figma',
        toolName: 'figma_get_file_data',
        args: { fileKey: 'FILE-5' },
        rawArgsJson: '{"fileKey":"FILE-5"}',
      },
      execute,
    )

    expect(first).toContain('Retry later')
    expect(second).toContain('Retry later')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('stops after a thrown rate-limit error', async () => {
    const cache = createFigmaTaskCache({ sessionId: 'session-1', taskId: 'task-6' })
    const execute = vi.fn().mockRejectedValue(new Error('429 Too Many Requests'))

    const result = await cache.run(
      {
        kind: 'tool',
        serverName: 'figma',
        toolName: 'figma_get_file_data',
        args: { fileKey: 'FILE-6' },
        rawArgsJson: '{"fileKey":"FILE-6"}',
      },
      execute,
    )

    expect(result).toContain('hit a rate limit')
    expect(result).toContain('Stop retrying')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
