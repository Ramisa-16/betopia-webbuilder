import { describe, it, expect, vi } from 'vitest'
import { buildSystemPrompt, buildMcpGuidance } from '../agent-prompts'
import type { MCPTool } from '../agent-tools'
import type { Skill } from '../agent-project'

const mockGetConfig = vi.hoisted(() => vi.fn(() => ({
  behavior: {
    systemPromptPrefix: '',
    yoloMode: false,
    cavemanEnabled: false,
    cavemanIntensity: 'full',
  },
  customSubagents: [],
})))

vi.mock('../config', () => ({
  getConfig: mockGetConfig,
}))

vi.mock('../platform', () => ({
  IS_WINDOWS: false,
}))

const mcpTool: MCPTool = {
  name: 'search',
  description: 'Web search tool',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  serverName: 'web-search',
}

const skill: Skill = {
  name: 'react-guide',
  description: 'React components guide',
  body: 'How to write React components',
  path: '/home/.betopia/skills/react-guide.md',
  disableModelInvocation: false,
}

// ── buildSystemPrompt ──────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('includes base system prompt text', () => {
    const result = buildSystemPrompt()
    expect(result).toContain('Betopia Coder')
    expect(result).toContain('Critical Rules')
    expect(result).toContain('assets.md')
  })

  it('includes agent persona instructions', () => {
    const result = buildSystemPrompt({ name: 'Reviewer', instructions: 'Only review code, never write it.' })
    expect(result).toContain('ACTIVE AGENT — Reviewer')
    expect(result).toContain('Only review code, never write it.')
  })

  it('includes system prompt prefix from config', () => {
    mockGetConfig.mockReturnValueOnce({
      behavior: { systemPromptPrefix: 'PREFIX CONTENT', yoloMode: false, cavemanEnabled: false, cavemanIntensity: 'full' },
      customSubagents: [],
    })
    const result = buildSystemPrompt()
    expect(result).toContain('PREFIX CONTENT')
  })

  it('includes MCP tool guidance when tools provided', () => {
    const result = buildSystemPrompt(null, undefined, null, [mcpTool])
    expect(result).toContain('Active MCP Servers')
    expect(result).toContain('web-search')
    expect(result).toContain('search')
  })

  it('includes project memory', () => {
    const result = buildSystemPrompt(null, undefined, '## Architecture\nReact frontend')
    expect(result).toContain('PROJECT MEMORY')
    expect(result).toContain('React frontend')
  })

  it('includes skills when provided', () => {
    const result = buildSystemPrompt(null, undefined, null, undefined, undefined, [skill])
    expect(result).toContain('available_skills')
    expect(result).toContain('react-guide')
    expect(result).toContain('React components guide')
  })

  it('includes custom instructions', () => {
    const result = buildSystemPrompt(null, 'Always use TypeScript.')
    expect(result).toContain('USER CUSTOM INSTRUCTIONS')
    expect(result).toContain('Always use TypeScript.')
  })

  it('includes small-output constraint when enabled', () => {
    const result = buildSystemPrompt(null, undefined, null, undefined, undefined, undefined, undefined, true)
    expect(result).toContain('CRITICAL OUTPUT CONSTRAINT')
    expect(result).toContain('Skeleton-first workflow')
  })

  it('includes permission mode description for full_access', () => {
    const result = buildSystemPrompt(null, undefined, null, undefined, 'full_access')
    expect(result).toContain('PERMISSION MODE: AUTO MODE')
    expect(result).toContain('Proceed autonomously')
  })

  it('includes permission mode for plan_mode', () => {
    const result = buildSystemPrompt(null, undefined, null, undefined, 'plan_mode')
    expect(result).toContain('PERMISSION MODE: PLAN MODE')
  })

  it('includes project path', () => {
    const result = buildSystemPrompt(null, undefined, null, undefined, undefined, undefined, '/home/project')
    expect(result).toContain('/home/project')
  })

  it('excludes skills with disableModelInvocation', () => {
    const hiddenSkill: Skill = { ...skill, disableModelInvocation: true }
    const result = buildSystemPrompt(null, undefined, null, undefined, undefined, [skill, hiddenSkill])
    const skillsSection = result.slice(result.indexOf('<available_skills>'), result.indexOf('</available_skills>'))
    expect(skillsSection).toContain('react-guide')
    expect(skillsSection).not.toContain('disableModelInvocation')
  })

  it('includes date in output', () => {
    const result = buildSystemPrompt()
    expect(result).toMatch(/Current date: \d{4}-\d{2}-\d{2}/)
  })

  it('includes imported subagent metadata in the prompt inventory', () => {
    mockGetConfig.mockReturnValueOnce({
      behavior: { systemPromptPrefix: '', yoloMode: false, cavemanEnabled: false, cavemanIntensity: 'full' },
      customSubagents: [
        {
          id: 'deploy-specialist',
          label: 'Deploy Specialist',
          description: 'Repository-aware deployment helper.',
          systemPrompt: 'Use repository guidance.',
          writable: false,
          sourceType: 'repo',
          sourceUrl: 'https://github.com/example/deploy-kit',
          linkedSkills: ['Deploy'],
        },
      ],
    })
    const result = buildSystemPrompt()

    expect(result).toContain('deploy-specialist')
    expect(result).toContain('source=repo')
    expect(result).toContain('linked-skills=Deploy')
    expect(result).toContain('https://github.com/example/deploy-kit')
  })

  it('includes caveman suffix when enabled', () => {
    mockGetConfig.mockReturnValueOnce({
      behavior: { systemPromptPrefix: '', yoloMode: false, cavemanEnabled: true, cavemanIntensity: 'lite' },
      customSubagents: [],
    })
    const result = buildSystemPrompt()
    expect(result).toContain('RESPONSE STYLE')
    expect(result).toContain('Keep articles')
  })
})

// ── buildMcpGuidance ───────────────────────────────────────────────────────

describe('buildMcpGuidance', () => {
  it('returns empty string for no tools', () => {
    expect(buildMcpGuidance([])).toBe('')
  })

  it('groups tools by server', () => {
    const tools: MCPTool[] = [
      { name: 'search', description: '', inputSchema: {}, serverName: 'web' },
      { name: 'fetch', description: '', inputSchema: {}, serverName: 'web' },
      { name: 'deploy', description: '', inputSchema: {}, serverName: 'infra' },
    ]
    const result = buildMcpGuidance(tools)
    expect(result).toContain('web') // server name
    expect(result).toContain('infra')
    expect(result).toContain('search')
    expect(result).toContain('fetch')
    expect(result).toContain('deploy')
  })

  it('includes Figma workflow when figma tools present', () => {
    const figmaTool: MCPTool = {
      name: 'figma_get_file_data', description: '', inputSchema: {},
      serverName: 'figma-design-server',
    }
    const result = buildMcpGuidance([figmaTool])
    expect(result).toContain('Figma Design-to-Code Workflow')
    expect(result).toContain(figmaTool.name)
  })

  it('prefers getData tool over image tool in Figma section', () => {
    const dataTool: MCPTool = {
      name: 'get_file_data', description: '', inputSchema: {},
      serverName: 'figma',
    }
    const imgTool: MCPTool = {
      name: 'download_asset', description: '', inputSchema: {},
      serverName: 'figma',
    }
    const result = buildMcpGuidance([imgTool, dataTool])
    expect(result).toContain('get_file_data')
  })
})
