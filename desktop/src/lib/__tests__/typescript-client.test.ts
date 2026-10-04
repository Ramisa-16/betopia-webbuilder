import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({
  getFileTree: vi.fn(),
  readProjectFile: vi.fn(),
}))

vi.mock('@/lib/fs', () => fsMock)

class FakeWorker {
  static instances: FakeWorker[] = []

  onmessage: ((event: { data: any }) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null
  terminated = false
  messages: any[] = []

  constructor(public url: URL, public options: { type: string }) {
    FakeWorker.instances.push(this)
  }

  postMessage(message: any): void {
    this.messages.push(message)
    queueMicrotask(() => {
      if (this.terminated) return
      const { id, type, payload } = message
      const result = type === 'diagnostics'
        ? [{ path: payload.path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 'error', message: 'boom', source: 'typescript', code: 123 }]
        : null
      this.onmessage?.({ data: { id, ok: true, result } })
    })
  }

  terminate(): void {
    this.terminated = true
  }

  triggerError(message = 'worker crashed'): void {
    this.onerror?.({ message })
  }
}

describe('TypeScriptLspClient worker recovery', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker)
    fsMock.getFileTree.mockReset()
    fsMock.readProjectFile.mockReset()
    fsMock.getFileTree.mockResolvedValue([
      { name: 'index.ts', path: 'index.ts', is_dir: false },
    ])
    fsMock.readProjectFile.mockImplementation(async (_projectPath: string, relPath: string) => {
      if (relPath === 'index.ts') return 'export const value: number = 1'
      throw new Error(`Unexpected file: ${relPath}`)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recreates the worker and rehydrates known projects after a crash', async () => {
    vi.resetModules()
    const { getTypeScriptLspClient } = await import('../lsp/typescript-client')
    const client = getTypeScriptLspClient()

    await client.diagnostics('/project', 'index.ts', 'export const value: number = 1')
    expect(FakeWorker.instances).toHaveLength(1)

    FakeWorker.instances[0].triggerError('boom')

    await client.diagnostics('/project', 'index.ts', 'export const value: number = 1')
    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances[1].messages.map(message => message.type)).toEqual([
      'resetProject',
      'upsertFiles',
      'diagnostics',
    ])
  })
})
