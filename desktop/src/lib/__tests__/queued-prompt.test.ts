import { beforeEach, describe, expect, it } from 'vitest'
import { buildSkillPrompt, buildSkillVisibleText, resolveSkillDirective } from '../skill-routing'
import { getQueuedPromptExecutionArgs } from '../queued-prompt'
import { useChatStore } from '@/store/chatStore'
import type { SlashSkillOption } from '../builtin-skills'

const debugSkill: SlashSkillOption = {
  slash: '/debug',
  name: 'Debug',
  description: 'Fix runtime errors and failing tests.',
  body: '# Debug\nInvestigate the failure carefully.',
  builtin: false,
  source: 'custom',
  kind: 'skill',
  path: '/project/.betopia/skills/custom/debug/SKILL.md',
}

describe('queued prompt flow', () => {
  beforeEach(() => {
    useChatStore.getState().reset()
  })

  it('preserves agentPrompt for a selected skill chip queued through Run after', () => {
    const text = buildSkillVisibleText(debugSkill, 'fix the crash')
    const agentPrompt = buildSkillPrompt(debugSkill, 'fix the crash')

    useChatStore.getState().setQueuedPrompt({ text, agentPrompt }, [{ id: 'att-1' }])

    const state = useChatStore.getState()
    expect(state.queuedPrompt).toEqual({ text, agentPrompt })

    const execution = getQueuedPromptExecutionArgs(state.queuedPrompt, state.queuedAttachments)
    expect(execution).toEqual({
      text,
      attachments: [{ id: 'att-1' }],
      options: { agentPrompt },
    })
  })

  it('typed /debug while not busy sends expanded agentPrompt', () => {
    const route = resolveSkillDirective('/debug investigate logs', [debugSkill], { allowAuto: true })
    expect(route).toBeDefined()

    expect(route!.visibleText).toBe('[Skill: Debug] investigate logs')
    expect(route!.agentPrompt).toContain('# Debug')
    expect(route!.agentPrompt).toContain('investigate logs')
  })

  it('typed /debug while busy queues expanded agentPrompt', () => {
    const route = resolveSkillDirective('/debug investigate logs', [debugSkill], { allowAuto: true })
    expect(route).toBeDefined()

    useChatStore.getState().setQueuedPrompt({
      text: route!.visibleText,
      agentPrompt: route!.agentPrompt,
    })

    const state = useChatStore.getState()
    expect(state.queuedPrompt?.text).toBe('[Skill: Debug] investigate logs')
    expect(state.queuedPrompt?.agentPrompt).toContain('# Debug')
  })

  it('queued item does not lose skill body', () => {
    const route = resolveSkillDirective('/debug fix production outage', [debugSkill], { allowAuto: true })
    expect(route).toBeDefined()

    useChatStore.getState().setQueuedPrompt({
      text: route!.visibleText,
      agentPrompt: route!.agentPrompt,
    })

    const state = useChatStore.getState()
    const execution = getQueuedPromptExecutionArgs(state.queuedPrompt, state.queuedAttachments)

    expect(execution?.text).toBe('[Skill: Debug] fix production outage')
    expect(execution?.options?.agentPrompt).toContain('# Debug')
    expect(execution?.options?.agentPrompt).toContain('fix production outage')
  })

  it('normal non-skill message still works', () => {
    useChatStore.getState().setQueuedPrompt({ text: 'plain queued request' })

    const state = useChatStore.getState()
    expect(state.queuedPrompt).toEqual({ text: 'plain queued request' })

    const execution = getQueuedPromptExecutionArgs(state.queuedPrompt, state.queuedAttachments)
    expect(execution).toEqual({
      text: 'plain queued request',
      attachments: undefined,
      options: undefined,
    })
  })

  it('execution uses agentPrompt when it is available', () => {
    useChatStore.getState().setQueuedPrompt({
      text: '[Skill: Debug] fix production issue',
      agentPrompt: '[Skill: Debug]\n\n# Debug\nInvestigate root cause first.',
    })

    const state = useChatStore.getState()
    const execution = getQueuedPromptExecutionArgs(state.queuedPrompt, state.queuedAttachments)

    expect(execution?.text).toBe('[Skill: Debug] fix production issue')
    expect(execution?.options?.agentPrompt).toContain('Investigate root cause first')
  })
})
