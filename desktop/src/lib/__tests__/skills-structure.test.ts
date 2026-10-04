import { describe, expect, it, vi } from 'vitest'

const { projectPath, homePath, invokeMock } = vi.hoisted(() => {
  const projectPath = '/project'
  const homePath = '/home/mamun'
  const fileContents = new Map<string, string>([
    [`${projectPath}/.betopia/skills/base/SKILL.md`, `---\nname: base\ndescription: Base skill.\n---\n# Base\nBase body`],
    [`${projectPath}/.betopia/skills/debug/SKILL.md`, `---\nname: debug\ndescription: Debug skill.\ndepends-on: base\n---\n# Debug\nMain body`],
    [`${projectPath}/.betopia/skills/debug/references/notes.md`, `# Notes\nReference detail`],
    [`${projectPath}/.betopia/skills/legacy.md`, `---\nname: legacy\ndescription: Legacy flat skill.\n---\n# Legacy\nLegacy body`],
  ])
  const dirEntries = new Map<string, Array<{ name: string; isDirectory: boolean }>>([
    [`${projectPath}/.betopia/skills`, [
      { name: 'base', isDirectory: true },
      { name: 'debug', isDirectory: true },
      { name: 'legacy.md', isDirectory: false },
    ]],
    [`${projectPath}/.betopia/skills/base`, [
      { name: 'SKILL.md', isDirectory: false },
    ]],
    [`${projectPath}/.betopia/skills/debug`, [
      { name: 'SKILL.md', isDirectory: false },
      { name: 'references', isDirectory: true },
    ]],
    [`${projectPath}/.betopia/skills/debug/references`, [
      { name: 'notes.md', isDirectory: false },
    ]],
    [`${homePath}/.betopia/skills`, []],
  ])
  const invokeMock = vi.fn(async (method: string, args: Record<string, any>) => {
    if (method === 'fs_read_dir') return dirEntries.get(args.root) ?? []
    if (method === 'fs_read_file') return fileContents.get(args.path) ?? ''
    throw new Error(`unexpected invoke: ${method}`)
  })
  return { projectPath, homePath, invokeMock }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => homePath }))

import { loadSkills } from '../agent-project'
import { renderAvailableSkills } from '../agent-prompts'

describe('skills structure', () => {
  it('loads folder-based skills, preserves companion files, and orders dependencies first', async () => {
    const skills = await loadSkills(projectPath)

    expect(skills.map(s => s.name)).toEqual(['base', 'debug', 'legacy'])

    const debug = skills.find(s => s.name === 'debug')
    expect(debug).toBeDefined()
    expect(debug!.path).toContain('/project/.betopia/skills/debug/SKILL.md')
    expect(debug!.dependsOn).toEqual(['base'])
    expect(debug!.body).toContain('Main body')
    expect(debug!.companionFiles).toBeDefined()
    expect(debug!.companionFiles![0].relPath).toBe('references/notes.md')
    expect(debug!.companionFiles![0].body).toContain('Reference detail')
  })

  it('inlines small skill bodies in the available-skills prompt', () => {
    const prompt = renderAvailableSkills([
      {
        name: 'debug',
        description: 'Debug skill.',
        body: '# Debug\nShort body',
        path: '/project/.betopia/skills/debug/SKILL.md',
        dependsOn: ['base'],
        companionFiles: [{ relPath: 'references/notes.md', body: 'Reference detail' }],
      },
    ])

    expect(prompt).toContain('<depends_on>base</depends_on>')
    expect(prompt).toContain('Short body')
    expect(prompt).toContain('references/notes.md')
  })
})
