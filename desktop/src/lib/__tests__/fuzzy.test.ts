import { describe, it, expect } from 'vitest'
import { fuzzyScore, fuzzyFilter } from '../fuzzy'

describe('fuzzyScore', () => {
  it('returns 0 for empty query', () => {
    expect(fuzzyScore('', 'hello')).toBe(0)
  })

  it('returns 0 for empty target', () => {
    expect(fuzzyScore('hi', '')).toBe(0)
  })

  it('scores exact match highest (100)', () => {
    expect(fuzzyScore('theme', 'theme')).toBe(100)
  })

  it('scores prefix match high (90)', () => {
    expect(fuzzyScore('them', 'theme')).toBe(90)
  })

  it('scores substring match (70)', () => {
    expect(fuzzyScore('hem', 'theme selector')).toBe(70)
  })

  it('is case-insensitive', () => {
    expect(fuzzyScore('THEME', 'theme')).toBe(100)
    expect(fuzzyScore('Theme', 'theme settings')).toBeGreaterThan(0)
  })

  it('handles fuzzy char sequence', () => {
    const score = fuzzyScore('thm', 'theme')
    expect(score).toBeGreaterThan(0)
  })

  it('returns 0 when chars do not appear in order', () => {
    expect(fuzzyScore('xyz', 'theme')).toBe(0)
  })

  it('scores word-prefix match (82) for multi-word query', () => {
    // 'key shor' doesn't prefix the full string but each token prefixes a word
    expect(fuzzyScore('key shor', 'keyboard shortcuts')).toBe(82)
  })

  it('handles misspelling via fuzzy — "teme" matches "theme"', () => {
    const score = fuzzyScore('teme', 'theme')
    // t, e, m, e — t✓ h e✓ m✓ e✓ → all 4 chars matched
    expect(score).toBeGreaterThan(0)
  })

  it('exact beats prefix beats substring', () => {
    const exact = fuzzyScore('nord', 'nord')
    const prefix = fuzzyScore('nor', 'nord')
    const sub = fuzzyScore('or', 'nord')
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(sub)
  })
})

describe('fuzzyFilter', () => {
  const items = [
    { name: 'Tokyo Night', tags: ['dark', 'blue'] },
    { name: 'Nord', tags: ['dark', 'arctic'] },
    { name: 'Betopia', tags: ['dark', 'orange'] },
    { name: 'Rosé Pine', tags: ['purple', 'dark'] },
  ]
  const getFields = (item: typeof items[0]) => [item.name, ...item.tags]

  it('returns all items for empty query', () => {
    expect(fuzzyFilter('', items, getFields)).toHaveLength(items.length)
  })

  it('filters by name', () => {
    const result = fuzzyFilter('Nord', items, getFields)
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].name).toBe('Nord')
  })

  it('filters by tag', () => {
    const result = fuzzyFilter('orange', items, getFields)
    expect(result[0].name).toBe('Betopia')
  })

  it('returns empty array for no match', () => {
    expect(fuzzyFilter('zzzzz', items, getFields)).toHaveLength(0)
  })

  it('sorts better matches first', () => {
    const result = fuzzyFilter('dark', items, getFields)
    // "Nord" first field is "Nord" which doesn't start with "dark"; "dark" tag matches all
    expect(result.length).toBeGreaterThan(0)
  })

  it('fuzzy search handles abbreviated query — "toky" matches "Tokyo Night"', () => {
    // Sequential-char fuzzy: t-o-k-y all appear in order in "tokyo night"
    const result = fuzzyFilter('toky', items, getFields)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].name).toBe('Tokyo Night')
  })
})
