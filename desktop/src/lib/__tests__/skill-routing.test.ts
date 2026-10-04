import { describe, expect, it } from 'vitest'
import { buildSkillPrompt, buildSkillVisibleText, resolveSkillDirective } from '../skill-routing'
import type { SlashSkillOption } from '../builtin-skills'

const debugSkill: SlashSkillOption = {
  slash: '/debug',
  name: 'Debug',
  description: 'Fix runtime errors and failing tests.',
  body: '# Debug\nInvestigate the failure.',
  builtin: false,
  source: 'custom',
  kind: 'skill',
  path: '/project/.betopia/skills/custom/debug/SKILL.md',
}

const reviewSubagent: SlashSkillOption = {
  slash: '/review-helper',
  name: 'Review Helper',
  description: 'Analyze code changes.',
  body: 'Use run_subagent to inspect diffs.',
  builtin: false,
  source: 'subagent',
  kind: 'subagent',
  subagentId: 'review-helper',
  writable: false,
}

describe('skill routing', () => {
  it('resolves explicit /skills namespace commands to skill routes', () => {
    const route = resolveSkillDirective('/skills debug investigate logs', [debugSkill])

    expect(route).toBeDefined()
    expect(route?.source).toBe('explicit')
    expect(route?.option.slash).toBe('/debug')
    expect(route?.task).toBe('investigate logs')
    expect(route?.visibleText).toBe('[Skill: Debug] investigate logs')
    expect(route?.agentPrompt).toContain('[Skill: Debug]')
  })

  it('resolves /sub agents commands to subagent routes', () => {
    const route = resolveSkillDirective('/sub agents review-helper inspect the diff', [reviewSubagent])

    expect(route).toBeDefined()
    expect(route?.option.kind).toBe('subagent')
    expect(route?.task).toBe('inspect the diff')
    expect(route?.visibleText).toBe('[Sub-agent: Review Helper] inspect the diff')
    expect(route?.agentPrompt).toContain('run_subagent')
  })

  it('auto-matches strong natural-language skill requests', () => {
    const route = resolveSkillDirective('Please debug the failing build and explain the root cause', [debugSkill], { allowAuto: true })

    expect(route).toBeDefined()
    expect(route?.source).toBe('auto')
    expect(route?.option.slash).toBe('/debug')
    expect(route?.visibleText).toBe('[Skill: Debug] Please debug the failing build and explain the root cause')
  })

  it('builds hidden prompts without exposing full skill bodies in the visible text', () => {
    expect(buildSkillVisibleText(debugSkill, 'fix the crash')).toBe('[Skill: Debug] fix the crash')
    expect(buildSkillPrompt(debugSkill, 'fix the crash')).toContain('# Debug')
    expect(buildSkillPrompt(reviewSubagent, 'inspect the patch')).toContain('This imported subagent is configured read-only')
  })
})
