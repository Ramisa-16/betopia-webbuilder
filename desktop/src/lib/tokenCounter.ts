import { getEncoding, type Tiktoken } from 'js-tiktoken'
import type { Message } from '@/types'

let _enc: Tiktoken | null = null
let _failed = false

function getEncoder(): Tiktoken | null {
  if (_failed) return null
  if (_enc) return _enc
  try {
    _enc = getEncoding('cl100k_base') // gpt-4 / gpt-4o / claude-compatible BPE
    return _enc
  } catch {
    _failed = true
    return null
  }
}

export function countTokens(text: string): number {
  const enc = getEncoder()
  if (!enc) return Math.round(text.length / 4)
  try {
    return enc.encode(text).length
  } catch {
    return Math.round(text.length / 4)
  }
}

export function estimateMessagesTokens(messages: Message[]): number {
  const sample = messages.length > 100 ? messages.slice(-100) : messages
  let total = 0
  for (const m of sample) {
    for (const p of m.parts) {
      if (p.type === 'text') {
        const text = (p.data as { text?: string }).text ?? ''
        if (text) total += countTokens(text)
      } else if (p.type === 'tool_call') {
        const d = p.data as { input?: string }
        if (d.input) total += Math.round(d.input.length / 4)
      } else if (p.type === 'tool_result') {
        const d = p.data as { content?: string }
        if (d.content) total += Math.round(Math.min(d.content.length, 4000) / 4)
      }
    }
  }
  return total
}
