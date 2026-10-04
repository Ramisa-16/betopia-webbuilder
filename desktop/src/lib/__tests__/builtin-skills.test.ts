import { describe, it, expect } from 'vitest'
import { allSlashOptions, findBuiltinSkill } from '../builtin-skills'

describe('builtin skills', () => {
  it('loads folder-based debug, deploy, and review skills from SKILL.md files', () => {
    const debug = findBuiltinSkill('/debug')
    const deploy = findBuiltinSkill('/deploy')
    const review = findBuiltinSkill('/review')
    const research = findBuiltinSkill('/deep-research')
    const uiUx = findBuiltinSkill('/ui-ux')
    const testSkill = findBuiltinSkill('/test')

    expect(debug).toBeDefined()
    expect(debug!.path).toContain('/Skills/debug/SKILL.md')
    expect(debug!.body).toContain('git diff HEAD~1')

    expect(deploy).toBeDefined()
    expect(deploy!.path).toContain('/Skills/deploy/SKILL.md')
    expect(deploy!.body).toContain('Smoke test')

    expect(review).toBeDefined()
    expect(review!.path).toContain('/Skills/review/SKILL.md')
    expect(review!.body).toContain('must fix')

    expect(research).toBeDefined()
    expect(research!.path).toContain('/Skills/deep-research/SKILL.md')
    expect(research!.body).toContain('firecrawl')

    expect(uiUx).toBeDefined()
    expect(uiUx!.path).toContain('/Skills/ui-ux/SKILL.md')
    expect(uiUx!.body).toContain('UI/UX Pro Max')

    expect(testSkill).toBeDefined()
    expect(testSkill!.path).toContain('/Skills/test/SKILL.md')
    expect(testSkill!.body).toContain('Cover the happy path')
  })

  it('keeps custom skill bodies on slash options for agent prompt injection', () => {
    const options = allSlashOptions([
      {
        name: 'Custom Repo Skill',
        description: 'Use repo workflow.',
        body: '# Custom Repo Skill\nGenerated repo workflow.',
        path: '/home/test/.betopia/skills/custom/custom-repo-skill/SKILL.md',
      },
    ])
    const custom = options.find(option => option.slash === '/custom-repo-skill')

    expect(custom).toBeDefined()
    expect(custom!.builtin).toBe(false)
    expect(custom!.source).toBe('custom')
    expect(custom!.body).toContain('Generated repo workflow')
  })

  it('lets custom skills override system skills with the same slash trigger', () => {
    const options = allSlashOptions([
      {
        name: 'Debug',
        description: 'Custom debug workflow.',
        body: '# Custom Debug\nUse custom project debugging workflow.',
        path: '/project/.betopia/skills/custom/debug/SKILL.md',
      },
    ])
    const debugOptions = options.filter(option => option.slash === '/debug')

    expect(debugOptions).toHaveLength(1)
    expect(debugOptions[0].source).toBe('custom')
    expect(debugOptions[0].body).toContain('Custom Debug')
  })

  it('does not recommend non-custom registry skills or client-only commands in slash options', () => {
    const options = allSlashOptions([
      {
        name: 'External System Skill',
        description: 'Should not appear.',
        body: '# External',
        path: '/home/test/.codex/skills/.system/imagegen/SKILL.md',
      },
      {
        name: 'Project Non Custom Skill',
        description: 'Should not appear.',
        body: '# Project',
        path: '/project/.betopia/skills/debug/SKILL.md',
      },
      {
        name: 'Custom Skill',
        description: 'Should appear.',
        body: '# Custom',
        path: '/project/.betopia/skills/custom/custom-skill/SKILL.md',
      },
    ])

    expect(options.some(option => option.slash === '/caveman')).toBe(false)
    expect(options.some(option => option.name === 'External System Skill')).toBe(false)
    expect(options.some(option => option.name === 'Project Non Custom Skill')).toBe(false)
    expect(options.some(option => option.name === 'Custom Skill')).toBe(true)
  })

  it('treats relative custom skill paths as custom registry entries', () => {
    const options = allSlashOptions([
      {
        name: 'Debugging and Error Recovery',
        description: 'Custom debug workflow.',
        body: '# Custom Debug\nProject-specific debugging instructions.',
        path: '.betopia/skills/custom/debugging-and-error-recovery/SKILL.md',
      },
    ])

    const matching = options.filter(option => option.slash === '/debugging-and-error-recovery')
    expect(matching).toHaveLength(1)
    expect(matching[0].source).toBe('custom')
    expect(matching[0].body).toContain('Project-specific debugging instructions')
  })

  it('includes imported custom subagents as a separate slash source', () => {
    const options = allSlashOptions([], [
      {
        id: 'deploy-specialist',
        label: 'Deploy Specialist',
        description: 'Repository-aware deployment helper.',
        systemPrompt: 'Use runbooks from the imported repo.',
        writable: false,
        sourceType: 'repo',
        sourceUrl: 'https://github.com/example/deploy-kit',
      },
    ])
    const subagent = options.find(option => option.slash === '/deploy-specialist')

    expect(subagent).toBeDefined()
    expect(subagent!.source).toBe('subagent')
    expect(subagent!.kind).toBe('subagent')
    expect(subagent!.subagentId).toBe('deploy-specialist')
  })
})
