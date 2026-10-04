import { describe, it, expect } from 'vitest'
import { resolveSubagent, SUBAGENTS, WRITE_TOOLS } from '../subagents'
import type { CustomSubagentDef } from '../subagents'

// ── resolveSubagent ───────────────────────────────────────────────────────────

describe('resolveSubagent — built-in types', () => {
  it('resolves all built-in read-only types', () => {
    for (const id of ['explore', 'code-review', 'security', 'general']) {
      const def = resolveSubagent(id)
      expect(def).toBeDefined()
      expect(def!.writable).toBe(false)
    }
  })

  it('resolves coder as write-capable', () => {
    const def = resolveSubagent('coder')
    expect(def).toBeDefined()
    expect(def!.writable).toBe(true)
    expect(def!.tools).toEqual(expect.arrayContaining(['write_file', 'edit', 'bash']))
  })

  it('resolves fixer as write-capable', () => {
    const def = resolveSubagent('fixer')
    expect(def).toBeDefined()
    expect(def!.writable).toBe(true)
  })

  it('returns undefined for unknown id without custom list', () => {
    expect(resolveSubagent('nonexistent')).toBeUndefined()
  })

  it('returns undefined for unknown id with empty custom list', () => {
    expect(resolveSubagent('nonexistent', [])).toBeUndefined()
  })
})

describe('resolveSubagent — custom subagents', () => {
  const customs: CustomSubagentDef[] = [
    { id: 'my-researcher', label: 'My Researcher', description: 'custom', systemPrompt: 'you research', writable: false },
    { id: 'my-coder', label: 'My Coder', description: 'custom writer', systemPrompt: 'you code', writable: true },
  ]

  it('resolves a read-only custom subagent', () => {
    const def = resolveSubagent('my-researcher', customs)
    expect(def).toBeDefined()
    expect(def!.label).toBe('My Researcher')
    expect(def!.writable).toBe(false)
    expect(def!.tools).not.toContain('write_file')
  })

  it('resolves a write-capable custom subagent', () => {
    const def = resolveSubagent('my-coder', customs)
    expect(def).toBeDefined()
    expect(def!.writable).toBe(true)
    expect(def!.tools).toContain('write_file')
  })

  it('built-in takes precedence over custom with same id', () => {
    const shadowing: CustomSubagentDef[] = [
      { id: 'explore', label: 'Shadowing explore', description: '', systemPrompt: 'shadow', writable: true },
    ]
    const def = resolveSubagent('explore', shadowing)
    // Should be the built-in explore (read-only), not the custom one
    expect(def!.writable).toBe(false)
    expect(def!.label).toBe('Explore')
  })

  it('returns undefined when id not in built-ins or custom list', () => {
    expect(resolveSubagent('ghost', customs)).toBeUndefined()
  })
})

// ── WRITE_TOOLS coverage ──────────────────────────────────────────────────────

describe('WRITE_TOOLS', () => {
  it('includes all essential write tools', () => {
    expect(WRITE_TOOLS).toContain('write_file')
    expect(WRITE_TOOLS).toContain('edit')
    expect(WRITE_TOOLS).toContain('bash')
    expect(WRITE_TOOLS).toContain('delete_file')
    expect(WRITE_TOOLS).toContain('rename_file')
  })

  it('also includes read tools', () => {
    expect(WRITE_TOOLS).toContain('view_file')
    expect(WRITE_TOOLS).toContain('grep_search')
    expect(WRITE_TOOLS).toContain('list_files')
  })
})

// ── SubagentDef invariants ────────────────────────────────────────────────────

describe('SUBAGENTS invariants', () => {
  it('every def has a non-empty systemPrompt', () => {
    for (const [id, def] of Object.entries(SUBAGENTS)) {
      expect(def.systemPrompt.length, `${id} systemPrompt empty`).toBeGreaterThan(20)
    }
  })

  it('read-only defs do not include write_file', () => {
    for (const [id, def] of Object.entries(SUBAGENTS)) {
      if (!def.writable) {
        expect(def.tools, `${id} should not have write_file`).not.toContain('write_file')
      }
    }
  })

  it('writable defs include write_file', () => {
    for (const [id, def] of Object.entries(SUBAGENTS)) {
      if (def.writable) {
        expect(def.tools, `${id} should have write_file`).toContain('write_file')
      }
    }
  })
})
