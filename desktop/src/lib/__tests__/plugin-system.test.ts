import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PluginScope } from '../plugin/plugin-scope'
import { PluginHookRegistry } from '../plugin/hooks'
import { PluginRegistry } from '../plugin/plugin-registry'
import { PluginLoader } from '../plugin/plugin-loader'
import { createPluginContext } from '../plugin/plugin-context'
import { checkNetworkPermission, checkFilesystemPermission, checkShellPermission } from '../plugin/plugin-permissions'
import { PluginError, PluginLoadError, PluginPermissionDenied } from '../plugin/errors'
import type { BetopiaPlugin, PluginActivationContext, BeforeToolCallContext, AfterToolCallContext, ToolDefinition } from '../plugin/plugin-api'

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makeMockPlugin(overrides: Partial<BetopiaPlugin> = {}): BetopiaPlugin {
  return {
    manifest: { id: 'test:mock', name: 'Mock Plugin', version: '1.0.0' },
    activate: vi.fn(),
    deactivate: vi.fn(),
    ...overrides,
  }
}

// ── PluginScope ─────────────────────────────────────────────────────────────────

describe('PluginScope', () => {
  it('collects and runs disposers in reverse order', () => {
    const scope = new PluginScope()
    const order: number[] = []

    scope.add(() => { order.push(1) })
    scope.add(() => { order.push(2) })
    scope.add(() => { order.push(3) })

    scope.dispose()
    expect(order).toEqual([3, 2, 1])
  })

  it('isolates errors between disposers', () => {
    const scope = new PluginScope()
    const spy = vi.fn()

    scope.add(() => { throw new Error('oops') })
    scope.add(spy)

    scope.dispose()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('is safe to call dispose multiple times', () => {
    const scope = new PluginScope()
    const spy = vi.fn()
    scope.add(spy)
    scope.dispose()
    scope.dispose()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('add returns the disposer for convenience', () => {
    const scope = new PluginScope()
    const fn = () => {}
    const result = scope.add(fn)
    expect(result).toBe(fn)
  })
})

// ── PluginHookRegistry ──────────────────────────────────────────────────────────

describe('PluginHookRegistry', () => {
  let registry: PluginHookRegistry

  beforeEach(() => {
    registry = new PluginHookRegistry()
  })

  describe('beforeToolCall', () => {
    it('passes through when no handlers registered', async () => {
      const result = await registry.dispatchBeforeToolCall(
        { toolName: 'read_file', toolArgs: '{}', parsedArgs: {} },
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      expect(result).toEqual({ type: 'pass', toolCall: expect.any(Object) })
    })

    it('blocks when a handler returns block', async () => {
      registry.registerBeforeToolCall('test:blocker', async () => ({
        type: 'block',
        reason: 'Not allowed',
      }))

      const result = await registry.dispatchBeforeToolCall(
        { toolName: 'bash', toolArgs: '{}', parsedArgs: {} },
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      expect(result).toEqual({ type: 'block', reason: 'Not allowed' })
    })

    it('modifies args when a handler returns modify', async () => {
      registry.registerBeforeToolCall('test:modifier', async (tc) => ({
        type: 'modify',
        toolCall: { ...tc, parsedArgs: { command: 'echo hello' } },
      }))

      const result = await registry.dispatchBeforeToolCall(
        { toolName: 'bash', toolArgs: '{}', parsedArgs: { command: 'echo bye' } },
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      expect(result).not.toBeNull()
      if (result && 'toolCall' in result) {
        expect(result.toolCall.parsedArgs).toEqual({ command: 'echo hello' })
      } else {
        throw new Error('Expected pass result with modified args')
      }
    })

    it('chains handlers in order; first block wins', async () => {
      registry.registerBeforeToolCall('test:a', async () => ({ type: 'block', reason: 'A blocks' }))
      registry.registerBeforeToolCall('test:b', async () => ({ type: 'block', reason: 'B blocks' }))

      const result = await registry.dispatchBeforeToolCall(
        { toolName: 'read_file', toolArgs: '{}', parsedArgs: {} },
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      expect(result).toEqual({ type: 'block', reason: 'A blocks' })
    })

    it('continues chain on null return', async () => {
      registry.registerBeforeToolCall('test:pass', async () => null)
      registry.registerBeforeToolCall('test:blocker', async () => ({ type: 'block', reason: 'Second blocks' }))

      const result = await registry.dispatchBeforeToolCall(
        { toolName: 'bash', toolArgs: '{}', parsedArgs: {} },
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      expect(result).toEqual({ type: 'block', reason: 'Second blocks' })
    })

    it('handles handler errors gracefully', async () => {
      registry.registerBeforeToolCall('test:crash', async () => { throw new Error('boom') })

      const result = await registry.dispatchBeforeToolCall(
        { toolName: 'read_file', toolArgs: '{}', parsedArgs: {} },
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      // Should pass through on error
      expect(result).toEqual({ type: 'pass', toolCall: expect.any(Object) })
    })
  })

  describe('afterToolCall', () => {
    it('returns empty result when no handlers', async () => {
      const result = await registry.dispatchAfterToolCall(
        { toolName: 'read_file', toolArgs: '{}', result: 'content', isError: false },
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      expect(result).toEqual({})
    })

    it('accumulates modifications from handlers', async () => {
      registry.registerAfterToolCall('test:mod', async () => ({ result: 'modified', isError: false }))

      const result = await registry.dispatchAfterToolCall(
        { toolName: 'read_file', toolArgs: '{}', result: 'original', isError: false },
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      expect(result.result).toBe('modified')
    })

    it('last handler wins on conflicting fields', async () => {
      registry.registerAfterToolCall('test:a', async () => ({ result: 'from a' }))
      registry.registerAfterToolCall('test:b', async () => ({ result: 'from b', terminate: true }))

      const result = await registry.dispatchAfterToolCall(
        { toolName: 'read_file', toolArgs: '{}', result: 'original', isError: false },
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      expect(result.result).toBe('from b')
      expect(result.terminate).toBe(true)
    })
  })

  describe('transformContext', () => {
    it('passes through when no handlers', async () => {
      const msgs = [{ role: 'user', content: 'hello' }]
      const result = await registry.dispatchTransformContext(msgs, { sessionId: null, projectPath: '/test', pluginId: 'agent' })
      expect(result).toEqual(msgs)
    })

    it('chains message transformations', async () => {
      registry.registerTransformContext('test:add', async (msgs) => {
        return [...msgs, { role: 'assistant', content: 'injected' }]
      })

      const result = await registry.dispatchTransformContext(
        [{ role: 'user', content: 'hello' }],
        { sessionId: null, projectPath: '/test', pluginId: 'agent' },
      )
      expect(result).toHaveLength(2)
      expect(result[1]).toEqual({ role: 'assistant', content: 'injected' })
    })
  })

  describe('cleanup', () => {
    it('removeAllForPlugin removes only that plugins handlers', () => {
      const a = vi.fn()
      const b = vi.fn()
      registry.registerBeforeToolCall('test:a', async () => null)
      registry.registerBeforeToolCall('test:b', async () => null)
      registry.registerAfterToolCall('test:a', async () => ({}))
      registry.registerTransformContext('test:a', async (msgs) => msgs)

      registry.removeAllForPlugin('test:a')

      // After removal, only test:b handlers remain
      expect(registry['beforeToolCallHandlers'].filter(e => e.pluginId === 'test:a')).toHaveLength(0)
      expect(registry['beforeToolCallHandlers'].filter(e => e.pluginId === 'test:b')).toHaveLength(1)
      expect(registry['afterToolCallHandlers']).toHaveLength(0)
      expect(registry['transformContextHandlers']).toHaveLength(0)
    })
  })
})

// ── PluginRegistry ──────────────────────────────────────────────────────────────

describe('PluginRegistry', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry()
  })

    it('registers and retrieves tools with prefixed names', () => {
      const tool: ToolDefinition = {
        name: 'my_tool',
        description: 'Test tool',
        parameters: { type: 'object', properties: {} },
        execute: async () => 'result',
      }
      registry.registerTool('test:plugin', tool)

      // getTool uses the prefixed name
      const registered = registry.getTool('test:plugin__my_tool')
      expect(registered).toBeDefined()
      expect(registered!.definition.name).toBe('my_tool')

      // getAllTools returns RegisteredTool objects
      const allTools = registry.getAllTools()
      expect(allTools).toHaveLength(1)
      expect(allTools[0].pluginId).toBe('test:plugin')
    })

  it('unregisters a tool', () => {
    const tool: ToolDefinition = {
      name: 'my_tool',
      description: 'Test tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'result',
    }
    registry.registerTool('test:plugin', tool)
    registry.unregisterTool('test:plugin__my_tool')

    expect(registry.getAllTools()).toHaveLength(0)
  })

  it('removeAllForPlugin cleans up all contributions', () => {
    const tool: ToolDefinition = {
      name: 't1',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async () => '',
    }
    registry.registerTool('test:a', tool)
    registry.registerTool('test:b', tool)
    registry.registerPanel('test:a', { id: 'p1', title: 'P1', component: 'div' as any })

    registry.removeAllForPlugin('test:a')

    const tools = registry.getAllTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].pluginId).toBe('test:b')
    expect(tools[0].definition.name).toBe('t1')
  })
})

// ── Permissions ─────────────────────────────────────────────────────────────────

describe('checkFilesystemPermission', () => {
  const readManifest = { filesystem: { read: ['/projects/**/*'], write: [] } }
  const writeManifest = { filesystem: { read: [], write: ['/projects/**/*'] } }

  it('allows reading within allowed globs', () => {
    const result = checkFilesystemPermission(readManifest, '/projects/foo/bar.txt', 'read')
    expect(result.allowed).toBe(true)
  })

  it('denies reading outside allowed globs', () => {
    const result = checkFilesystemPermission(readManifest, '/etc/passwd', 'read')
    expect(result.allowed).toBe(false)
  })

  it('denies when no permissions are defined', () => {
    const result = checkFilesystemPermission(undefined, '/any/path', 'read')
    expect(result.allowed).toBe(false)
  })

  it('allows writing within allowed write globs', () => {
    const result = checkFilesystemPermission(writeManifest, '/projects/new/file.txt', 'write')
    expect(result.allowed).toBe(true)
  })
})

describe('checkNetworkPermission', () => {
  const apiManifest = { network: { origins: ['https://api.example.com/**'] } }

  it('allows known origins', () => {
    const result = checkNetworkPermission(apiManifest, 'https://api.example.com/data')
    expect(result.allowed).toBe(true)
  })

  it('denies unknown origins', () => {
    const result = checkNetworkPermission(apiManifest, 'https://evil.com/hack')
    expect(result.allowed).toBe(false)
  })

  it('denies when no permissions defined', () => {
    const result = checkNetworkPermission(undefined, 'https://anywhere.com')
    expect(result.allowed).toBe(false)
  })
})

describe('checkShellPermission', () => {
  const shellManifest = { shell: true }

  it('allows when shell permission declared', () => {
    const result = checkShellPermission(shellManifest)
    expect(result.allowed).toBe(true)
  })

  it('denies when no shell permission declared', () => {
    const result = checkShellPermission(undefined)
    expect(result.allowed).toBe(false)
  })
})

// ── Errors ──────────────────────────────────────────────────────────────────────

describe('PluginError', () => {
  it('PluginLoadError includes pluginId and message', () => {
    const err = new PluginLoadError('test:missing', 'Not found')
    expect(err.pluginId).toBe('test:missing')
    expect(err.message).toContain('test:missing')
    expect(err.message).toContain('Not found')
    expect(err).toBeInstanceOf(PluginError)
  })

  it('PluginPermissionDenied includes details', () => {
    const err = new PluginPermissionDenied('test:plugin', 'network', 'https://evil.com')
    expect(err.pluginId).toBe('test:plugin')
    expect(err.message).toContain('network')
    expect(err.message).toContain('https://evil.com')
    expect(err).toBeInstanceOf(PluginError)
  })
})

// ── PluginLoader ─────────────────────────────────────────────────────────────────

describe('PluginLoader', () => {
  let loader: PluginLoader

  beforeEach(() => {
    loader = new PluginLoader()
  })

  it('invalidateCache clears the module cache entry', () => {
    // Pre-populate cache
    ;(loader as any).moduleCache.set('test:plugin', {} as any)
    loader.invalidateCache('test:plugin')
    expect((loader as any).moduleCache.has('test:plugin')).toBe(false)
  })
})

// ── PluginContext (createPluginContext) ──────────────────────────────────────────

describe('createPluginContext', () => {
  let hooks: PluginHookRegistry
  let pluginRegistry: PluginRegistry
  let scope: PluginScope
  let ctx: PluginActivationContext

  beforeEach(() => {
    hooks = new PluginHookRegistry()
    pluginRegistry = new PluginRegistry()
    scope = new PluginScope()
    ctx = createPluginContext(
      'test:ctx',
      { key: 'val' },
      '/data/test',
      hooks,
      pluginRegistry,
      scope,
      {
        chat: { getMessages: () => [], sendMessage: () => {} },
        session: { getActiveSession: () => null },
        app: { getPermissionMode: () => 'default' },
      },
      { publish: () => {}, subscribe: () => () => {} },
    )
  })

  it('returns identity fields', () => {
    expect(ctx.id).toBe('test:ctx')
    expect(ctx.config).toEqual({ key: 'val' })
    expect(ctx.dataDir).toBe('/data/test')
  })

  it('registerTool registers with prefixed name and returns disposer', () => {
    const tool: ToolDefinition = {
      name: 'cool_tool',
      description: 'A cool tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    }
    const disposer = ctx.registerTool(tool)
    expect(typeof disposer).toBe('function')

    const allTools = pluginRegistry.getAllTools()
    expect(allTools).toHaveLength(1)
    expect(allTools[0].pluginId).toBe('test:ctx')
    expect(allTools[0].definition.name).toBe('cool_tool')
  })

  it('onBeforeToolCall registers and returns disposer', () => {
    const dispo = ctx.onBeforeToolCall(async () => null)
    expect(typeof dispo).toBe('function')

    // Should be in hook registry
    expect(hooks['beforeToolCallHandlers']).toHaveLength(1)
    dispo()
    expect(hooks['beforeToolCallHandlers']).toHaveLength(0)
  })

  it('onAfterToolCall registers and returns disposer', () => {
    const dispo = ctx.onAfterToolCall(async () => ({}))
    expect(typeof dispo).toBe('function')

    expect(hooks['afterToolCallHandlers']).toHaveLength(1)
    dispo()
    expect(hooks['afterToolCallHandlers']).toHaveLength(0)
  })

  it('onTransformContext registers and returns disposer', () => {
    const dispo = ctx.onTransformContext(async (msgs) => msgs)
    expect(typeof dispo).toBe('function')

    expect(hooks['transformContextHandlers']).toHaveLength(1)
    dispo()
    expect(hooks['transformContextHandlers']).toHaveLength(0)
  })

  it('registerPanel registers and returns disposer', () => {
    const panel = { id: 'my-panel', title: 'My Panel', component: 'div' as any }
    const dispo = ctx.registerPanel(panel)
    expect(typeof dispo).toBe('function')
  })

  it('scope.dispose() cleans up all registered disposables', () => {
    const tool: ToolDefinition = {
      name: 't',
      description: '',
      parameters: { type: 'object', properties: {} },
      execute: async () => '',
    }
    ctx.registerTool(tool)
    ctx.onBeforeToolCall(async () => null)
    ctx.onAfterToolCall(async () => ({}))

    expect(pluginRegistry.getAllTools()).toHaveLength(1)
    expect(hooks['beforeToolCallHandlers']).toHaveLength(1)

    scope.dispose()

    // After scope disposal, only scope disposables should be freed.
    // The scope tracks disposers returned from registration methods.
    // Since those disposers were added to the scope AND the registry/hooks
    // still hold references, scope disposal will call them which removes
    // the entries from their respective registries.
    expect(pluginRegistry.getAllTools()).toHaveLength(0)
    expect(hooks['beforeToolCallHandlers']).toHaveLength(0)
  })

  it('provides tauri.invoke which wraps the real invoke', async () => {
    const result = await ctx.tauri.invoke('plugin_read_file', { pluginDataDir: '/tmp', relativePath: 'test.txt' })
    // In test environment (no Tauri), this will throw — but the shape is correct
    expect(ctx.tauri.invoke).toBeDefined()
    expect(ctx.tauri.listen).toBeDefined()
  })

  it('fs layer prevents path traversal', async () => {
    await expect(ctx.fs.readFile('../../etc/passwd')).rejects.toThrow('path traversal')
    await expect(ctx.fs.writeFile('../../etc/passwd', 'x')).rejects.toThrow('path traversal')
    await expect(ctx.fs.listDir('~/config')).rejects.toThrow('path traversal')
    await expect(ctx.fs.deleteFile('~/config')).rejects.toThrow('path traversal')
  })
})

// ── Integration: full activation lifecycle ──────────────────────────────────────

describe('Plugin lifecycle integration', () => {
  it('activate can register tools and hooks; deactivate cleans them up', () => {
    const hooks = new PluginHookRegistry()
    const pluginRegistry = new PluginRegistry()
    let cleanupScope: PluginScope | null = null

    const plugin: BetopiaPlugin = {
      manifest: { id: 'test:lifecycle', name: 'Lifecycle', version: '0.1.0' },
      activate: (ctx) => {
        const dispo = ctx.registerTool({
          name: 'greet',
          description: 'Says hello',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'hello',
        })
        // Store scope for later assertion
        cleanupScope = (ctx as any).scope
        return dispo
      },
      deactivate: vi.fn(),
    }

    // Simulate activation
    const scope = new PluginScope()
    const ctx = createPluginContext(
      'test:lifecycle',
      {},
      '/tmp/data',
      hooks,
      pluginRegistry,
      scope,
      { chat: { getMessages: () => [], sendMessage: () => {} }, session: { getActiveSession: () => null }, app: { getPermissionMode: () => 'default' } },
      { publish: () => {}, subscribe: () => () => {} },
    )

    plugin.activate(ctx)
    expect(pluginRegistry.getAllTools()).toHaveLength(1)
    expect(pluginRegistry.getAllTools()[0].pluginId).toBe('test:lifecycle')
    expect(pluginRegistry.getAllTools()[0].definition.name).toBe('greet')

    // Deactivate (dispose scope)
    scope.dispose()
    expect(pluginRegistry.getAllTools()).toHaveLength(0)
  })
})
