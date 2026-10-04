import { describe, expect, it } from 'vitest'
import { isPlanApprovalPrompt, isPlanEditPrompt } from '../plan-intents'

describe('plan intent helpers', () => {
  it('treats build continuation prompts as approval', () => {
    expect(isPlanApprovalPrompt('continue where you left off')).toBe(true)
    expect(isPlanApprovalPrompt('start build')).toBe(true)
    expect(isPlanApprovalPrompt('implement it now')).toBe(true)
  })

  it('treats explicit plan revisions as edits', () => {
    expect(isPlanEditPrompt('edit the plan to use bun')).toBe(true)
    expect(isPlanEditPrompt('add a validation step to the plan')).toBe(true)
    expect(isPlanEditPrompt('replace step 3 in the plan')).toBe(true)
  })

  it('does not confuse ordinary follow-ups with plan edits', () => {
    expect(isPlanEditPrompt('what changed?')).toBe(false)
    expect(isPlanEditPrompt('continue where you left off')).toBe(false)
    expect(isPlanEditPrompt('implement the plan')).toBe(false)
  })
})
