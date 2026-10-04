import { beforeEach, describe, expect, it } from 'vitest'
import { resolveTypedCavemanSubmitAction } from '../caveman-command'
import { getQueuedPromptExecutionArgs } from '../queued-prompt'
import { useChatStore } from '@/store/chatStore'

describe('typed /caveman submit flow', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
  })

  it('/caveman full while busy queues', () => {
    const action = resolveTypedCavemanSubmitAction('/caveman full', true, false, 'full')

    expect(action).toBeDefined()
    expect(action?.kind).toBe('queue')
    if (action?.kind === 'queue') {
      expect(action.visibleText).toBe('[Skill: Caveman Mode] /caveman full')
      expect(action.agentPrompt).toContain('Respond in ultra-terse style')
    }
  })

  it('/caveman full while not busy sends immediately', () => {
    const action = resolveTypedCavemanSubmitAction('/caveman full', false, false, 'full')

    expect(action).toBeDefined()
    expect(action?.kind).toBe('send')
    if (action?.kind === 'send') {
      expect(action.visibleText).toBe('[Skill: Caveman Mode] /caveman full')
      expect(action.agentPrompt).toContain('Respond in ultra-terse style')
    }
  })

  it('queued /caveman full preserves agentPrompt/body', () => {
    const action = resolveTypedCavemanSubmitAction('/caveman full', true, false, 'full')
    expect(action?.kind).toBe('queue')
    if (action?.kind !== 'queue') return

    useChatStore.getState().setQueuedPrompt({
      text: action.visibleText,
      agentPrompt: action.agentPrompt,
    })

    const state = useChatStore.getState()
    const execution = getQueuedPromptExecutionArgs(state.queuedPrompt, state.queuedAttachments)

    expect(execution?.text).toBe('[Skill: Caveman Mode] /caveman full')
    expect(execution?.options?.agentPrompt).toContain('Respond in ultra-terse style')
    expect(execution?.options?.agentPrompt).toContain('/caveman full')
  })
})
