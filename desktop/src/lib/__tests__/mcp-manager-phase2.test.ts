import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MCPManager } from '../mcp-manager'
import type { MCPServer } from '../config'

// ── Stdio mock helpers (reuse same pattern as mcp-manager.test.ts) ────────

let capturedStdoutHandler: ((data: string) => void) | null = null

const mockChild = {
  write: vi.fn<(s: string) => Promise<void>>(),
  kill: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}

const mockCommand = {
  stdout: {
    on: vi.fn((event: string, handler: (data: string) => void) => {
      if (event === 'data') capturedStdoutHandler = handler
    }),
  },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  spawn: vi.fn(),
}

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: vi.fn(() => mockCommand) },
}))

function serverRespond(msg: object) {
  capturedStdoutHandler?.(JSON.stringify(msg) + '\n')
}

function setupAutoResponder() {
  let nextId = 1
  mockChild.write.mockImplementation(async (data: string) => {
    const msg = JSON.parse(data.trim()) as { id?: number; method?: string }
    if (!msg.id) return
    if (msg.method === 'initialize') {
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-mcp', version: '1.0.0' } },
      }))
    } else if (msg.method === 'tools/list') {
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: { tools: [{ name: 'search', description: 'Search', inputSchema: {} }] },
      }))
    } else if (msg.method === 'resources/list') {
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: { resources: [{ uri: 'file:///docs/api', name: 'API Docs', mimeType: 'text/markdown' }] },
      }))
    } else if (msg.method === 'resources/read') {
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: { contents: [{ uri: (msg as any).params?.uri, text: 'API documentation content' }] },
      }))
    } else if (msg.method === 'prompts/list') {
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: { prompts: [{ name: 'review', description: 'Review code' }] },
      }))
    } else if (msg.method === 'prompts/get') {
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: { messages: [{ role: 'user', content: 'Review this code' }] },
      }))
    } else if (msg.method === 'tools/call') {
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: 'tool result' }] },
      }))
    }
  })
}

const stdioServer: MCPServer = {
  id: 'srv-1', name: 'my-mcp', type: 'stdio',
  command: 'npx', args: ['-y', '@mcp/test'], timeout: 5,
}

// ── HTTP mock helpers ─────────────────────────────────────────────────────

const httpServerConfig: MCPServer = {
  id: 'http-1', name: 'calc-server', type: 'http',
  url: 'http://localhost:3000', timeout: 5,
}

const httpResponses = {
  listResources: () => ({
    jsonrpc: '2.0', id: 1,
    result: { resources: [{ uri: 'calc://ops/add', name: 'Add', mimeType: 'text/plain' }] },
  }),
  readResource: () => ({
    jsonrpc: '2.0', id: 1,
    result: { contents: [{ uri: 'calc://ops/add', text: 'Addition operation' }] },
  }),
  listPrompts: () => ({
    jsonrpc: '2.0', id: 1,
    result: { prompts: [{ name: 'math-help', description: 'Math assistance' }] },
  }),
  getPrompt: () => ({
    jsonrpc: '2.0', id: 1,
    result: { messages: [{ role: 'user', content: 'Help with math' }] },
  }),
  listTools: () => ({
    jsonrpc: '2.0', id: 1,
    result: { tools: [{ name: 'calc', description: 'Calculator', inputSchema: {} }] },
  }),
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('MCPManager — reconnectServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedStdoutHandler = null
    mockCommand.spawn.mockResolvedValue(mockChild)
    setupAutoResponder()
  })

  it('returns false for unknown server', async () => {
    const manager = new MCPManager()
    const result = await manager.reconnectServer('nonexistent')
    expect(result).toBe(false)
  })

  it('reconnects a stdio server successfully', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const result = await manager.reconnectServer('srv-1')
    expect(result).toBe(true)
  })

  it('kills and re-spawns child process', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const beforeKill = mockChild.kill.mock.calls.length
    await manager.reconnectServer('srv-1')
    expect(mockChild.kill).toHaveBeenCalledTimes(beforeKill + 1)
    // After kill, a new mockChild is spawned
    expect(mockCommand.spawn).toHaveBeenCalled()
  })
})

describe('MCPManager — listResources (stdio)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedStdoutHandler = null
    mockCommand.spawn.mockResolvedValue(mockChild)
    setupAutoResponder()
  })

  it('lists resources from stdio server', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const resources = await manager.listResources('srv-1')
    expect(resources).toHaveLength(1)
    expect(resources[0].name).toBe('API Docs')
    expect(resources[0].uri).toBe('file:///docs/api')
  })

  it('throws for uninitialized server', async () => {
    const manager = new MCPManager()
    await expect(manager.listResources('nonexistent')).rejects.toThrow('not initialized')
  })
})

describe('MCPManager — readResource (stdio)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedStdoutHandler = null
    mockCommand.spawn.mockResolvedValue(mockChild)
    setupAutoResponder()
  })

  it('reads a resource from stdio server', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const content = await manager.readResource('srv-1', 'file:///docs/api')
    expect(content).toContain('API documentation content')
  })

  it('throws for uninitialized server', async () => {
    const manager = new MCPManager()
    await expect(manager.readResource('nonexistent', 'x')).rejects.toThrow('not initialized')
  })
})

describe('MCPManager — listPrompts (stdio)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedStdoutHandler = null
    mockCommand.spawn.mockResolvedValue(mockChild)
    setupAutoResponder()
  })

  it('lists prompts from stdio server', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const prompts = await manager.listPrompts('srv-1')
    expect(prompts).toHaveLength(1)
    expect(prompts[0].name).toBe('review')
    expect(prompts[0].description).toBe('Review code')
  })

  it('throws for uninitialized server', async () => {
    const manager = new MCPManager()
    await expect(manager.listPrompts('nonexistent')).rejects.toThrow('not initialized')
  })
})

describe('MCPManager — getPrompt (stdio)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedStdoutHandler = null
    mockCommand.spawn.mockResolvedValue(mockChild)
    setupAutoResponder()
  })

  it('gets a prompt from stdio server', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const result = await manager.getPrompt('srv-1', 'review')
    expect(result.messages).toBeDefined()
    expect(result.messages[0].content).toBe('Review this code')
  })

  it('throws for uninitialized server', async () => {
    const manager = new MCPManager()
    await expect(manager.getPrompt('nonexistent', 'x')).rejects.toThrow('not initialized')
  })
})

describe('MCPManager — resources/prompts (http)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  const mockFetch = (responses: (() => any)[]) => {
    (global.fetch as any).mockImplementation(async () => ({
      ok: true,
      json: async () => responses.shift()?.(),
    }))
  }

  it('listResources via HTTP', async () => {
    mockFetch([httpResponses.listTools, httpResponses.listResources])
    const manager = new MCPManager()
    await manager.initServer(httpServerConfig)
    const resources = await manager.listResources('http-1')
    expect(resources).toHaveLength(1)
    expect(resources[0].name).toBe('Add')
  })

  it('readResource via HTTP', async () => {
    mockFetch([httpResponses.listTools, httpResponses.readResource])
    const manager = new MCPManager()
    await manager.initServer(httpServerConfig)
    const content = await manager.readResource('http-1', 'calc://ops/add')
    expect(content).toContain('Addition operation')
  })

  it('listPrompts via HTTP', async () => {
    mockFetch([httpResponses.listTools, httpResponses.listPrompts])
    const manager = new MCPManager()
    await manager.initServer(httpServerConfig)
    const prompts = await manager.listPrompts('http-1')
    expect(prompts).toHaveLength(1)
    expect(prompts[0].name).toBe('math-help')
  })

  it('getPrompt via HTTP', async () => {
    mockFetch([httpResponses.listTools, httpResponses.getPrompt])
    const manager = new MCPManager()
    await manager.initServer(httpServerConfig)
    const result = await manager.getPrompt('http-1', 'math-help')
    expect(result.messages[0].content).toBe('Help with math')
  })
})

describe('MCPManager — auto-reconnect in callTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedStdoutHandler = null
    mockCommand.spawn.mockResolvedValue(mockChild)
    setupAutoResponder()
  })

  it('reconnects disconnected stdio server on callTool', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    // Mark server as not ready
    const instance = (manager as any).instances.get('srv-1')
    instance.isReady = false
    const result = await manager.callTool('my-mcp__search', { q: 'test' })
    expect(result).toBe('tool result')
    expect(mockChild.kill).toHaveBeenCalled()
  })

  it('returns error when reconnection fails', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const instance = (manager as any).instances.get('srv-1')
    instance.isReady = false
    // Make re-spawn fail
    mockCommand.spawn.mockRejectedValue(new Error('spawn failed'))
    const result = await manager.callTool('my-mcp__search', { q: 'test' })
    expect(result).toContain('reconnection failed')
  })
})
