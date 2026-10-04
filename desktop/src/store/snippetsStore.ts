import { create } from 'zustand'
import { newSnippetId, type Snippet } from '@/lib/snippets'

const LS_KEY = 'betopia:snippets'

function load(): Snippet[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') } catch { return [] }
}
function save(list: Snippet[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)) } catch {}
}

type SnippetsState = {
  snippets: Snippet[]
  upsert: (snippet: Snippet) => void
  remove: (id: string) => void
}

export const useSnippetsStore = create<SnippetsState>((set, get) => ({
  snippets: load(),

  upsert: (snippet) => {
    const list = get().snippets
    const idx = list.findIndex(s => s.id === snippet.id)
    const next = idx === -1 ? [...list, snippet] : list.map(s => s.id === snippet.id ? snippet : s)
    set({ snippets: next })
    save(next)
  },

  remove: (id) => {
    const next = get().snippets.filter(s => s.id !== id)
    set({ snippets: next })
    save(next)
  },
}))

export { newSnippetId }
export type { Snippet }
