import { describe, expect, it } from 'vitest'
import { READ_ONLY_TOOLS, resolveSubagent, validateCustomSubagents } from '../subagents'

describe('subagents runtime compatibility', () => {
  it('resolves legacy custom subagents without repo metadata', () => {
    const resolved = resolveSubagent('legacy-helper', [
      {
        id: 'legacy-helper',
        label: 'Legacy Helper',
        description: 'Original manually configured helper.',
        systemPrompt: 'Read files and summarize findings.',
        writable: false,
      },
    ])

    expect(resolved).toBeDefined()
    expect(resolved!.tools).toEqual(READ_ONLY_TOOLS)
    expect(resolved!.model).toBeUndefined()
  })

  it('accepts unique custom subagent ids', () => {
    const errors = validateCustomSubagents([
      {
        id: 'helper-one',
        label: 'Helper One',
        description: 'First helper.',
        systemPrompt: 'Inspect one.',
        writable: false,
      },
      {
        id: 'helper-two',
        label: 'Helper Two',
        description: 'Second helper.',
        systemPrompt: 'Inspect two.',
        writable: false,
      },
    ])

    expect(errors).toEqual([])
  })

  it('rejects exact duplicate custom subagent ids', () => {
    const errors = validateCustomSubagents([
      {
        id: 'duplicate-helper',
        label: 'Duplicate Helper',
        description: 'First copy.',
        systemPrompt: 'Inspect one.',
        writable: false,
      },
      {
        id: 'duplicate-helper',
        label: 'Duplicate Helper Two',
        description: 'Second copy.',
        systemPrompt: 'Inspect two.',
        writable: false,
      },
    ])

    expect(errors).toContain('Subagent "duplicate-helper": duplicate id conflicts with "duplicate-helper"')
  })

  it('rejects whitespace-normalized duplicate custom subagent ids', () => {
    const errors = validateCustomSubagents([
      {
        id: 'whitespace-helper',
        label: 'Whitespace Helper',
        description: 'First copy.',
        systemPrompt: 'Inspect one.',
        writable: false,
      },
      {
        id: '  whitespace-helper  ',
        label: 'Whitespace Helper Two',
        description: 'Second copy.',
        systemPrompt: 'Inspect two.',
        writable: false,
      },
    ])

    expect(errors).toContain('Subagent "whitespace-helper": duplicate id conflicts with "whitespace-helper"')
  })

  it('rejects case-insensitive duplicate custom subagent ids', () => {
    const errors = validateCustomSubagents([
      {
        id: 'Case-Helper',
        label: 'Case Helper',
        description: 'First copy.',
        systemPrompt: 'Inspect one.',
        writable: false,
      },
      {
        id: 'case-helper',
        label: 'Case Helper Two',
        description: 'Second copy.',
        systemPrompt: 'Inspect two.',
        writable: false,
      },
    ])

    expect(errors).toContain('Subagent "case-helper": duplicate id conflicts with "Case-Helper"')
  })

  it('rejects read-only subagents that attempt to enable write tools', () => {
    const errors = validateCustomSubagents([
      {
        id: 'unsafe-helper',
        label: 'Unsafe Helper',
        description: 'Should stay read-only.',
        systemPrompt: 'Do dangerous things.',
        writable: false,
        tools: ['view_file', 'bash'],
        sourceType: 'repo',
        sourceUrl: 'https://github.com/example/unsafe-helper',
      },
    ])

    expect(errors).toContain('Subagent "unsafe-helper": read-only subagents cannot enable write tools [bash]')
  })

  it('resolves custom subagent ids with normalized whitespace and case', () => {
    const resolved = resolveSubagent('  LEGACY-HELPER  ', [
      {
        id: 'legacy-helper',
        label: 'Legacy Helper',
        description: 'Original manually configured helper.',
        systemPrompt: 'Read files and summarize findings.',
        writable: false,
      },
    ])

    expect(resolved).toBeDefined()
    expect(resolved!.id).toBe('legacy-helper')
  })

  it('strips mutating tools from read-only custom subagents at runtime', () => {
    const resolved = resolveSubagent('locked-helper', [
      {
        id: 'locked-helper',
        label: 'Locked Helper',
        description: 'Should remain read-only even if persisted config is stale.',
        systemPrompt: 'Inspect only.',
        writable: false,
        tools: ['view_file', 'bash', 'write_file', 'edit', 'delete_file', 'rename_file'],
      },
    ])

    expect(resolved).toBeDefined()
    expect(resolved!.tools).toEqual(['view_file'])
    expect(resolved!.tools).not.toContain('bash')
    expect(resolved!.tools).not.toContain('write_file')
    expect(resolved!.tools).not.toContain('edit')
    expect(resolved!.tools).not.toContain('delete_file')
    expect(resolved!.tools).not.toContain('rename_file')
  })
})
