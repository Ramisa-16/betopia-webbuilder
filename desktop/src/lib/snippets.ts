export type Snippet = {
  id: string
  handle: string  // lowercase, [a-z0-9-]+, used as #handle in composer
  name: string
  description: string
  content: string
}

export function newSnippetId(): string {
  return `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h)
}

/**
 * Replace `#handle` tokens in `text` with <snippet> blocks prepended to message.
 * Unmatched tokens are left as-is.
 */
export function expandSnippetTokens(
  text: string,
  snippets: readonly Snippet[],
): { body: string; blocks: string[] } {
  const byHandle = new Map(snippets.map(s => [s.handle, s]))
  const matched = new Map<string, Snippet>()
  const re = /(^|\s)#([a-z0-9][a-z0-9-]*)\b/gi
  const body = text.replace(re, (full, lead: string, raw: string) => {
    const h = raw.toLowerCase()
    const snip = byHandle.get(h)
    if (!snip) return full
    matched.set(snip.id, snip)
    return lead
  })
  const blocks = Array.from(matched.values()).map(
    s => `<snippet name="${s.handle}">\n${s.content}\n</snippet>`,
  )
  return { body: body.replace(/[ \t]+\n/g, '\n').trim(), blocks }
}
