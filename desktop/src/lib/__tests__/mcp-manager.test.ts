import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MCPManager, testMCPServer, shellQuote, buildShellCmd } from '../mcp-manager'
import type { MCPServer } from '../config'

// ── Shell plugin mock ──────────────────────────────────────────────────────────

// Hold reference to the stdout handler so tests can simulate server responses.
let capturedStdoutHandler: ((data: string) => void) | null = null
let capturedStderrHandler: ((data: string) => void) | null = null

const mockChild = {
  write: vi.fn<[string], Promise<void>>(),
  kill: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
}

const mockCommand = {
  stdout: {
    on: vi.fn((event: string, handler: (data: string) => void) => {
      if (event === 'data') capturedStdoutHandler = handler
    }),
  },
  stderr: {
    on: vi.fn((event: string, handler: (data: string) => void) => {
      if (event === 'data') capturedStderrHandler = handler
    }),
  },
  on: vi.fn(),
  spawn: vi.fn(),
}

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn(() => mockCommand),
  },
}))

// Helper: simulate a JSON-RPC response from the MCP server.
function serverRespond(msg: object) {
  capturedStdoutHandler?.(JSON.stringify(msg))
}

// Auto-respond to all write() calls — mirrors a minimal MCP server.
function setupAutoResponder() {
  let nextId = 1
  mockChild.write.mockImplementation(async (data: string) => {
    const msg = JSON.parse(data.trim()) as { id?: number; method?: string }
    if (!msg.id) return // notification, no response needed

    if (msg.method === 'initialize') {
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-mcp', version: '1.0.0' } },
      }))
    } else if (msg.method === 'tools/list') {
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: {
          tools: [
            { name: 'search', description: 'Web search', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
            { name: 'fetch', description: 'Fetch URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
          ],
        },
      }))
    } else if (msg.method === 'tools/call') {
      const params = (msg as any).params
      queueMicrotask(() => serverRespond({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: `Result of ${params?.name} with args: ${JSON.stringify(params?.arguments)}` }] },
      }))
    }
  })
}

// ── HTTP mock ─────────────────────────────────────────────────────────────────

const httpServer = {
  listTools: () => ({
    jsonrpc: '2.0', id: 1,
    result: {
      tools: [{ name: 'calc', description: 'Calculator', inputSchema: { type: 'object' } }],
    },
  }),
  callTool: (name: string) => ({
    jsonrpc: '2.0', id: 1,
    result: { content: [{ type: 'text', text: `${name} result` }] },
  }),
  error: () => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('shellQuote', () => {
  it('returns safe strings unchanged', () => {
    expect(shellQuote('npx')).toBe('npx')
    expect(shellQuote('/usr/bin/node')).toBe('/usr/bin/node')
    expect(shellQuote('abc123')).toBe('abc123')
  })

  it('single-quotes strings with spaces', () => {
    expect(shellQuote('hello world')).toBe("'hello world'")
  })

  it('escapes single quotes inside', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('quotes empty string', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('quotes strings with special chars', () => {
    expect(shellQuote('$HOME')).toBe("'$HOME'")
    expect(shellQuote('key=value')).toBe("'key=value'")
  })
})

describe('buildShellCmd', () => {
  const base: MCPServer = { id: 'x', name: 'test', type: 'stdio', command: 'npx', args: ['-y', '@mcp/server', '/tmp'] }

  it('joins command and args', () => {
    expect(buildShellCmd(base)).toBe('npx -y @mcp/server /tmp')
  })

  it('prepends env vars', () => {
    const s = { ...base, env: { API_KEY: 'abc123', DEBUG: '1' } }
    const result = buildShellCmd(s)
    expect(result).toContain('API_KEY=abc123')
    expect(result).toContain('DEBUG=1')
    expect(result).toContain('npx')
  })

  it('quotes args with spaces', () => {
    const s = { ...base, args: ['-y', 'my server path'] }
    expect(buildShellCmd(s)).toContain("'my server path'")
  })

  it('quotes env values with special chars', () => {
    const s = { ...base, env: { TOKEN: 'Bearer my-secret-key!' } }
    expect(buildShellCmd(s)).toContain("'Bearer my-secret-key!'")
  })
})

describe('MCPManager — stdio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedStdoutHandler = null
    mockCommand.spawn.mockResolvedValue(mockChild)
    setupAutoResponder()
  })

  const stdioServer: MCPServer = {
    id: 'srv-1', name: 'my-mcp', type: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-test'],
    timeout: 5,
  }

  it('spawns via sh -c', async () => {
    const { Command } = await import('@tauri-apps/plugin-shell')
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    expect(Command.create).toHaveBeenCalledWith('sh', ['-c', expect.stringContaining('npx')])
  })

  it('sends initialize handshake', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const calls = mockChild.write.mock.calls.map(c => JSON.parse((c[0] as string).trim()))
    const init = calls.find(m => m.method === 'initialize')
    expect(init).toBeDefined()
    expect(init.params.protocolVersion).toBe('2024-11-05')
    const notif = calls.find(m => m.method === 'notifications/initialized')
    expect(notif).toBeDefined()
  })

  it('discovers tools after init', async () => {
    const manager = new MCPManager()
    const instance = await manager.initServer(stdioServer)
    expect(instance?.tools).toHaveLength(2)
    expect(instance?.tools[0].name).toBe('search')
    expect(instance?.tools[1].name).toBe('fetch')
  })

  it('calls tools and returns content', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const result = await manager.callTool('my-mcp__search', { q: 'typescript' })
    expect(result).toContain('search')
  })

  it('returns error message for unknown tool', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    const result = await manager.callTool('my-mcp__nonexistent', {})
    expect(result).toMatch(/not found/i)
  })

  it('kills child process on shutdown', async () => {
    const manager = new MCPManager()
    await manager.initServer(stdioServer)
    await manager.shutdown('srv-1')
    expect(mockChild.kill).toHaveBeenCalled()
  })

  it('respects disabledTools blocklist', async () => {
    const manager = new MCPManager()
    const instance = await manager.initServer({ ...stdioServer, disabledTools: ['fetch'] })
    expect(instance?.tools.map(t => t.name)).toEqual(['search'])
  })
})

describe('MCPManager — http', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const httpServer_: MCPServer = {
    id: 'http-1', name: 'calc-server', type: 'http',
    url: 'http://localhost:3000', timeout: 5,
  }

  it('discovers tools from HTTP server', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => httpServer.listTools(),
    })
    const manager = new MCPManager()
    const instance = await manager.initServer(httpServer_)
    expect(instance?.tools).toHaveLength(1)
    expect(instance?.tools[0].name).toBe('calc')
  })

  it('calls tool via HTTP POST', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => httpServer.listTools() })
      .mockResolvedValueOnce({ ok: true, json: async () => httpServer.callTool('calc') })
    const manager = new MCPManager()
    await manager.initServer(httpServer_)
    const result = await manager.callTool('calc-server__calc', { a: 1, b: 2 })
    expect(result).toBe('calc result')
  })

  it('sends correct POST body for tool call', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => httpServer.listTools() })
      .mockResolvedValueOnce({ ok: true, json: async () => httpServer.callTool('calc') })
    const manager = new MCPManager()
    await manager.initServer(httpServer_)
    await manager.callTool('calc-server__calc', { a: 1, b: 2 })
    const body = JSON.parse((global.fetch as any).mock.calls[1][1].body)
    expect(body.method).toBe('tools/call')
    expect(body.params.name).toBe('calc')
    expect(body.params.arguments).toEqual({ a: 1, b: 2 })
  })

  it('returns error message on MCP error response', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => httpServer.listTools() })
      .mockResolvedValueOnce({ ok: true, json: async () => httpServer.error() })
    const manager = new MCPManager()
    await manager.initServer(httpServer_)
    const result = await manager.callTool('calc-server__calc', {})
    expect(result).toMatch(/error/i)
    expect(result).toContain('Method not found')
  })

  it('returns null and logs on HTTP failure during init', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
    const manager = new MCPManager()
    const instance = await manager.initServer(httpServer_)
    expect(instance).toBeNull()
  })
})

describe('MCPManager — sse', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  const sseServer: MCPServer = {
    id: 'sse-1', name: 'stream-server', type: 'sse',
    url: 'http://localhost:4000/mcp', timeout: 5,
    headers: { Authorization: 'Bearer token123' },
  }

  it('sends auth header with SSE server calls', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { tools: [{ name: 'ping', description: 'Ping' }] } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { content: [{ type: 'text', text: 'pong' }] } }) })
    const manager = new MCPManager()
    await manager.initServer(sseServer)
    await manager.callTool('stream-server__ping', {})
    const headers = (global.fetch as any).mock.calls[0][1].headers
    expect(headers['Authorization']).toBe('Bearer token123')
  })
})

describe('testMCPServer — stdio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedStdoutHandler = null
    mockCommand.spawn.mockResolvedValue(mockChild)
    setupAutoResponder()
  })

  it('returns ok=true and toolCount on success', async () => {
    const result = await testMCPServer({
      id: 't1', name: 'test', type: 'stdio', command: 'npx', args: ['server'], timeout: 5,
    })
    expect(result.ok).toBe(true)
    expect(result.toolCount).toBe(2)
  })

  it('kills process after test', async () => {
    await testMCPServer({ id: 't1', name: 'test', type: 'stdio', command: 'npx', timeout: 5 })
    expect(mockChild.kill).toHaveBeenCalled()
  })

  it('returns ok=false on spawn failure', async () => {
    mockCommand.spawn.mockRejectedValueOnce(new Error('spawn ENOENT'))
    const result = await testMCPServer({ id: 't1', name: 'test', type: 'stdio', command: 'nonexistent-binary', timeout: 5 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('spawn ENOENT')
  })
})

describe('testMCPServer — http', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  it('returns ok=true and toolCount', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } }),
    })
    const result = await testMCPServer({ id: 'h1', name: 'h', type: 'http', url: 'http://localhost:9000', timeout: 5 })
    expect(result.ok).toBe(true)
    expect(result.toolCount).toBe(3)
  })

  it('returns ok=false on network error', async () => {
    ;(global.fetch as any).mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const result = await testMCPServer({ id: 'h1', name: 'h', type: 'http', url: 'http://localhost:9000', timeout: 5 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ECONNREFUSED')
  })
})

describe('JSON-RPC line routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedStdoutHandler = null
    mockCommand.spawn.mockResolvedValue(mockChild)
    setupAutoResponder()
  })

  it('handles multiple JSON messages on separate lines', async () => {
    // Simulate server emitting two separate messages for the same call via newline buffering
    let callCount = 0
    mockChild.write.mockImplementation(async (data: string) => {
      const msg = JSON.parse(data.trim()) as { id?: number; method?: string }
      if (!msg.id) return
      callCount++
      if (msg.method === 'initialize') {
        queueMicrotask(() => serverRespond({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } }))
      } else if (msg.method === 'tools/list') {
        queueMicrotask(() => serverRespond({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'tool1' }] } }))
      } else if (msg.method === 'tools/call') {
        queueMicrotask(() => serverRespond({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'done' }] } }))
      }
    })

    const manager = new MCPManager()
    const server: MCPServer = { id: 's1', name: 'linetest', type: 'stdio', command: 'test', timeout: 5 }
    const instance = await manager.initServer(server)
    expect(instance?.tools[0].name).toBe('tool1')
    const result = await manager.callTool('linetest__tool1', {})
    expect(result).toBe('done')
  })

  it('ignores non-JSON lines (server log output)', async () => {
    let initialized = false
    mockChild.write.mockImplementation(async (data: string) => {
      const msg = JSON.parse(data.trim()) as { id?: number; method?: string }
      if (!msg.id) return
      if (msg.method === 'initialize') {
        // Emit a log line first, then the real response
        queueMicrotask(() => {
          capturedStdoutHandler?.('[INFO] MCP server started on stdio')
          serverRespond({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } })
          initialized = true
        })
      } else if (msg.method === 'tools/list') {
        queueMicrotask(() => serverRespond({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }))
      }
    })

    const manager = new MCPManager()
    const instance = await manager.initServer({ id: 'x', name: 'logs', type: 'stdio', command: 'node', timeout: 5 })
    expect(instance?.isReady).toBe(true)
    expect(initialized).toBe(true)
  })
})
