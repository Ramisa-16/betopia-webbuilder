import { describe, it, expect } from 'vitest'
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  OAIMessage,
  ContextTransformFn,
} from '../agent'

// ── Type-level tests: hook signatures compile correctly ───────────────────────

describe('BeforeToolCallContext / BeforeToolCallResult types', () => {
  it('block with reason', () => {
    const result: BeforeToolCallResult = { block: true, reason: 'Blocked: unsafe path' }
    expect(result.block).toBe(true)
    expect(result.reason).toBe('Blocked: unsafe path')
  })

  it('arg override', () => {
    const result: BeforeToolCallResult = { args: JSON.stringify({ path: 'safe/path.ts', content: 'x' }) }
    expect(result.args).toContain('safe/path.ts')
    expect(result.block).toBeUndefined()
  })

  it('empty result = proceed unchanged', () => {
    const result: BeforeToolCallResult = {}
    expect(result.block).toBeUndefined()
    expect(result.args).toBeUndefined()
  })

  it('context shape', () => {
    const ctx: BeforeToolCallContext = {
      toolName: 'write_file',
      toolArgs: JSON.stringify({ path: 'index.ts', content: '' }),
      parsedArgs: { path: 'index.ts', content: '' },
    }
    expect(ctx.toolName).toBe('write_file')
    expect(ctx.parsedArgs.path).toBe('index.ts')
  })
})

describe('AfterToolCallContext / AfterToolCallResult types', () => {
  it('result override', () => {
    const r: AfterToolCallResult = { result: 'truncated output…' }
    expect(r.result).toBe('truncated output…')
  })

  it('terminate flag', () => {
    const r: AfterToolCallResult = { terminate: true }
    expect(r.terminate).toBe(true)
    expect(r.result).toBeUndefined()
  })

  it('isError override', () => {
    const r: AfterToolCallResult = { isError: false, result: 'recovered' }
    expect(r.isError).toBe(false)
  })

  it('context shape', () => {
    const ctx: AfterToolCallContext = {
      toolName: 'bash',
      toolArgs: JSON.stringify({ command: 'ls' }),
      result: 'file.ts\nother.ts',
      isError: false,
    }
    expect(ctx.toolName).toBe('bash')
    expect(ctx.isError).toBe(false)
  })
})

// ── transformContext: functional behaviour ────────────────────────────────────

describe('transformContext hook semantics', () => {
  // A typical use case: prune tool result messages older than N turns
  function makeToolPruner(keepLast: number): ContextTransformFn {
    return (messages: OAIMessage[]) => {
      const toolPairs: number[] = []
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'tool') toolPairs.push(i)
      }
      if (toolPairs.length <= keepLast) return messages
      const pruneUntil = toolPairs[toolPairs.length - keepLast]
      return messages.filter((_, i) => i < pruneUntil ? messages[i].role !== 'tool' : true)
    }
  }

  it('passes messages through when below threshold', () => {
    const fn = makeToolPruner(5)
    const msgs: OAIMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'result', tool_call_id: '1', name: 'bash' },
    ]
    expect(fn(msgs)).toHaveLength(3)
  })

  it('prunes old tool messages when above threshold', () => {
    const fn = makeToolPruner(1)
    const msgs: OAIMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'tool', content: 'old', tool_call_id: '1', name: 'bash' },
      { role: 'tool', content: 'old2', tool_call_id: '2', name: 'bash' },
      { role: 'tool', content: 'keep', tool_call_id: '3', name: 'bash' },
    ]
    const out = fn(msgs) as OAIMessage[]
    // only the last tool message kept
    const toolMsgs = out.filter(m => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].content).toBe('keep')
  })

  it('system message always preserved', () => {
    const fn = makeToolPruner(0)
    const msgs: OAIMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'tool', content: 'drop', tool_call_id: '1', name: 'bash' },
    ]
    const out = fn(msgs) as OAIMessage[]
    expect(out.some(m => m.role === 'system')).toBe(true)
  })

  it('async transform resolves correctly', async () => {
    const asyncFn: ContextTransformFn = async (msgs) => {
      await Promise.resolve()
      return msgs.filter(m => m.role !== 'tool')
    }
    const msgs: OAIMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'r', tool_call_id: '1', name: 'x' },
    ]
    const out = await asyncFn(msgs)
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
  })
})

// ── Hook guard semantics (unit-level logic matching what runAgent does) ────────

describe('beforeToolCall guard logic', () => {
  function applyGuard(
    ctx: BeforeToolCallContext,
    hook: (c: BeforeToolCallContext) => BeforeToolCallResult,
  ): { blocked: boolean; effectiveArgs: string } {
    const res = hook(ctx)
    if (res.block) return { blocked: true, effectiveArgs: ctx.toolArgs }
    return { blocked: false, effectiveArgs: res.args ?? ctx.toolArgs }
  }

  it('blocks path traversal attempt', () => {
    const hook = (ctx: BeforeToolCallContext): BeforeToolCallResult => {
      const p = ctx.parsedArgs.path as string
      if (p?.includes('../')) return { block: true, reason: 'path traversal blocked' }
      return {}
    }
    const ctx: BeforeToolCallContext = {
      toolName: 'write_file',
      toolArgs: JSON.stringify({ path: '../../etc/passwd' }),
      parsedArgs: { path: '../../etc/passwd' },
    }
    expect(applyGuard(ctx, hook).blocked).toBe(true)
  })

  it('rewrites args for safe path', () => {
    const hook = (ctx: BeforeToolCallContext): BeforeToolCallResult => {
      const args = { ...ctx.parsedArgs, path: 'safe.ts' }
      return { args: JSON.stringify(args) }
    }
    const ctx: BeforeToolCallContext = {
      toolName: 'write_file',
      toolArgs: JSON.stringify({ path: 'unsafe.ts' }),
      parsedArgs: { path: 'unsafe.ts' },
    }
    const { blocked, effectiveArgs } = applyGuard(ctx, hook)
    expect(blocked).toBe(false)
    expect(JSON.parse(effectiveArgs).path).toBe('safe.ts')
  })

  it('passes through when hook returns empty object', () => {
    const hook = (_ctx: BeforeToolCallContext): BeforeToolCallResult => ({})
    const ctx: BeforeToolCallContext = {
      toolName: 'list_files',
      toolArgs: '{}',
      parsedArgs: {},
    }
    const { blocked, effectiveArgs } = applyGuard(ctx, hook)
    expect(blocked).toBe(false)
    expect(effectiveArgs).toBe('{}')
  })
})

describe('afterToolCall override logic', () => {
  function applyAfter(
    result: string,
    hook: (c: AfterToolCallContext) => AfterToolCallResult,
  ): { result: string; isError: boolean; terminate: boolean } {
    const ctx: AfterToolCallContext = { toolName: 'bash', toolArgs: '{}', result, isError: result.startsWith('Error:') }
    const override = hook(ctx)
    return {
      result: override.result ?? result,
      isError: override.isError ?? ctx.isError,
      terminate: override.terminate ?? false,
    }
  }

  it('truncates large output', () => {
    const hook = (ctx: AfterToolCallContext): AfterToolCallResult => {
      if (ctx.result.length > 100) return { result: ctx.result.slice(0, 100) + '…[truncated]' }
      return {}
    }
    const longOutput = 'x'.repeat(200)
    const { result } = applyAfter(longOutput, hook)
    expect(result.endsWith('[truncated]')).toBe(true)
    expect(result.length).toBeLessThan(200)
  })

  it('recovers error result', () => {
    const hook = (_ctx: AfterToolCallContext): AfterToolCallResult => ({
      result: 'recovered',
      isError: false,
    })
    const { result, isError } = applyAfter('Error: something went wrong', hook)
    expect(result).toBe('recovered')
    expect(isError).toBe(false)
  })

  it('terminate flag propagates', () => {
    const hook = (_ctx: AfterToolCallContext): AfterToolCallResult => ({ terminate: true })
    const { terminate } = applyAfter('ok', hook)
    expect(terminate).toBe(true)
  })
})
