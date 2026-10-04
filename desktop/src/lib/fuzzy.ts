/**
 * Fuzzy string matching — tolerates misspellings and partial input.
 * Returns 0 if no match, higher scores for better matches.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query || !target) return 0
  const q = query.toLowerCase().trim()
  const t = target.toLowerCase()
  if (!q) return 0

  // Exact
  if (t === q) return 100
  // Prefix
  if (t.startsWith(q)) return 90
  // Word-prefix: every query token starts a word in target
  const qWords = q.split(/\s+/)
  const tWords = t.split(/[\s\-_./]+/)
  if (qWords.length > 0 && qWords.every(qw => tWords.some(tw => tw.startsWith(qw)))) return 82
  // Substring
  if (t.includes(q)) return 70

  // Fuzzy: all chars appear in order with consecutive-run bonus
  let qi = 0
  let score = 0
  let streak = 0
  let lastMatch = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (ti === lastMatch + 1) { streak++; score += 5 + streak }
      else { streak = 0; score += 2 }
      lastMatch = ti
      qi++
    }
  }
  return qi < q.length ? 0 : Math.min(65, score)
}

/**
 * Filter and sort items by fuzzy match score.
 * getFields returns an array of searchable strings; first field gets highest weight.
 */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  getFields: (item: T) => string[],
): T[] {
  if (!query.trim()) return items
  const WEIGHTS = [3, 1.5, 1, 1, 1, 1]
  const scored = items.map(item => {
    const fields = getFields(item)
    const score = Math.max(...fields.map((f, i) => fuzzyScore(query, f) * (WEIGHTS[i] ?? 1)))
    return { item, score }
  })
  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.item)
}
