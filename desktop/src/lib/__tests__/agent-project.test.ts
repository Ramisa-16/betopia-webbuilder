import { describe, it, expect, vi, beforeEach } from 'vitest'

const readProjectFileMock = vi.hoisted(() => vi.fn())
const invokeMock = vi.hoisted(() => vi.fn())
const homeDirMock = vi.hoisted(() => vi.fn(async () => '/home/test'))

vi.mock('../fs', () => ({ readProjectFile: readProjectFileMock }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: homeDirMock }))

import { loadProjectMemory, invalidateMemoryCache, loadSkills, loadPersonalSkills, loadCustomSkillsForSettings, invalidateSkillsCache } from '../agent-project'
import type { Skill } from '../agent-project'

const PROJECT = '/home/test/project'

beforeEach(() => {
  vi.clearAllMocks()
  invalidateMemoryCache(PROJECT)
  invalidateSkillsCache(PROJECT)
})

// ── loadProjectMemory ──────────────────────────────────────────────────────────

describe('loadProjectMemory', () => {
  it('reads from architecture.md then design.md (primary files)', async () => {
    readProjectFileMock.mockImplementation((_proj: string, file: string) => {
      if (file === 'architecture.md') return '## Architecture\nThis is the architecture'
      if (file === 'design.md') return '## Design\nDesign doc'
      throw new Error('not found')
    })
    const result = await loadProjectMemory(PROJECT)
    expect(result).toContain('architecture.md')
    expect(result).toContain('Design')
  })

  it('only includes architecture.md if design.md missing', async () => {
    readProjectFileMock.mockImplementation((_proj: string, file: string) => {
      if (file === 'architecture.md') return '## Architecture\nArch content'
      throw new Error('not found')
    })
    const result = await loadProjectMemory(PROJECT)
    expect(result).toContain('architecture.md')
    expect(result).not.toContain('design.md')
  })

  it('falls back to legacy files when no primary files exist', async () => {
    readProjectFileMock.mockImplementation((_proj: string, file: string) => {
      if (file === 'BETOPIA.md') return 'legacy BETOPIA content'
      throw new Error('not found')
    })
    const result = await loadProjectMemory(PROJECT)
    expect(result).toBe('legacy BETOPIA content')
  })

  it('tries legacy files in order', async () => {
    readProjectFileMock.mockImplementation((_proj: string, file: string) => {
      if (file === 'BETOPIA.md') throw new Error('not found')
      if (file === 'betopia.md') throw new Error('not found')
      if (file === 'CLAUDE.md') return 'CLAUDE content'
      throw new Error('not found')
    })
    const result = await loadProjectMemory(PROJECT)
    expect(result).toBe('CLAUDE content')
  })

  it('returns null when no files exist', async () => {
    readProjectFileMock.mockRejectedValue(new Error('not found'))
    const result = await loadProjectMemory(PROJECT)
    expect(result).toBeNull()
  })

  it('caches result within TTL', async () => {
    readProjectFileMock.mockImplementation((_proj: string, file: string) => {
      if (file === 'architecture.md') return 'arch'
      throw new Error('not found')
    })
    await loadProjectMemory(PROJECT)
    const firstCallCount = readProjectFileMock.mock.calls.length
    await loadProjectMemory(PROJECT)
    // second call should be served from cache (no additional readProjectFile calls)
    expect(readProjectFileMock.mock.calls.length - firstCallCount).toBe(0)
  })

  it('deduplicates concurrent in-flight requests', async () => {
    readProjectFileMock.mockImplementation((_proj: string, file: string) => {
      if (file === 'architecture.md') return 'arch'
      throw new Error('not found')
    })
    const [r1, r2] = await Promise.all([loadProjectMemory(PROJECT), loadProjectMemory(PROJECT)])
    expect(r1).toBeTruthy()
    expect(r2).toBeTruthy()
    // _fetchMemory iterates 3 primary files, so exactly 3 read calls total
    expect(readProjectFileMock.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('re-fetches after cache is invalidated', async () => {
    readProjectFileMock.mockImplementation((_proj: string, file: string) => {
      if (file === 'architecture.md') return 'arch'
      throw new Error('not found')
    })
    await loadProjectMemory(PROJECT)
    const firstBatchCount = readProjectFileMock.mock.calls.length
    invalidateMemoryCache(PROJECT)
    await loadProjectMemory(PROJECT)
    // Second call should re-fetch — same number of read calls as first batch (3 files each)
    expect(readProjectFileMock.mock.calls.length - firstBatchCount).toBeGreaterThan(0)
  })

  it('trims content to MEMORY_MAX_CHARS for legacy files', async () => {
    const long = 'x'.repeat(40_000)
    readProjectFileMock.mockImplementation((_proj: string, file: string) => {
      if (file === 'architecture.md') throw new Error('not found')
      if (file === 'design.md') throw new Error('not found')
      if (file === 'assets.md') throw new Error('not found')
      if (file === 'BETOPIA.md') return long
      throw new Error('not found')
    })
    const result = await loadProjectMemory(PROJECT)
    expect(result!.length).toBeLessThanOrEqual(32_000)
  })

  it('includes assets.md when present with other primary memory files', async () => {
    readProjectFileMock.mockImplementation((_proj: string, file: string) => {
      if (file === 'architecture.md') return '## Architecture\nArch content'
      if (file === 'design.md') return '## Design\nDesign content'
      if (file === 'assets.md') return '## Assets\nHero image source'
      throw new Error('not found')
    })
    const result = await loadProjectMemory(PROJECT)
    expect(result).toContain('architecture.md')
    expect(result).toContain('design.md')
    expect(result).toContain('assets.md')
    expect(result).toContain('Hero image source')
  })
})

// ── loadSkills ─────────────────────────────────────────────────────────────────

describe('loadSkills', () => {
  it('loads skills from project .betopia/skills directory', async () => {
    invokeMock.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'fs_read_dir' && args?.root?.includes('.betopia/skills')) {
        return [{ name: 'react-guide.md', path: `${args.root}/react-guide.md` }]
      }
      if (cmd === 'fs_read_file' && args?.path?.includes('react-guide.md')) {
        return '# React Guide\nHow to use React hooks.'
      }
      return []
    })
    const skills = await loadSkills(PROJECT)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('react-guide')
    expect(skills[0].description).toBe('How to use React hooks.')
  })

  it('loads skills from user home directory', async () => {
    homeDirMock.mockReturnValue(Promise.resolve('/home/test'))
    invokeMock.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'fs_read_dir') {
        return [{ name: 'global-utils.md', path: `${args?.root}/global-utils.md` }]
      }
      if (cmd === 'fs_read_file') {
        return '---\ndescription: Global utilities\n---\nSome content'
      }
      return undefined
    })
    const skills = await loadSkills(PROJECT)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('global-utils')
    expect(skills[0].description).toBe('Global utilities')
  })

  it('project skills override user skills with same name', async () => {
    invokeMock.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'fs_read_dir') {
        if (args?.root?.includes('.betopia/skills')) {
          return [{ name: 'shared.md', path: `${args.root}/shared.md` }]
        }
        return [{ name: 'shared.md', path: `/home/test/.betopia/skills/shared.md` }]
      }
      if (cmd === 'fs_read_file') {
        return '---\nname: shared\n---\ncontent'
      }
      return []
    })
    const skills = await loadSkills(PROJECT)
    expect(skills).toHaveLength(1) // only project version, user version deduped
  })

  it('parses frontmatter from skill files', async () => {
    invokeMock.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'fs_read_dir' && args?.root?.includes('.betopia/skills')) {
        return [{ name: 'styled.md', path: `${args.root}/styled.md` }]
      }
      if (cmd === 'fs_read_file' && args?.path?.includes('styled.md')) {
        return `---
name: Styled Components
description: CSS-in-JS guide
disable-model-invocation: true
---
# Styled Components
Use styled-components for styling.`
      }
      return []
    })
    const skills = await loadSkills(PROJECT)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('Styled Components')
    expect(skills[0].description).toBe('CSS-in-JS guide')
    expect(skills[0].disableModelInvocation).toBe(true)
  })

  it('skips non-markdown files', async () => {
    invokeMock.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'fs_read_dir' && args?.root?.includes('.betopia/skills')) {
        return [
          { name: 'readme.md', path: `${args.root}/readme.md` },
          { name: 'notes.txt', path: `${args.root}/notes.txt` },
          { name: 'data.json', path: `${args.root}/data.json` },
        ]
      }
      if (cmd === 'fs_read_file' && args?.path?.includes('readme.md')) {
        return '# Readme'
      }
      return []
    })
    const skills = await loadSkills(PROJECT)
    expect(skills).toHaveLength(1)
  })

  it('returns empty array when skills directory does not exist', async () => {
    invokeMock.mockRejectedValue(new Error('directory not found'))
    const skills = await loadSkills(PROJECT)
    expect(skills).toEqual([])
  })

  it('caches skills within TTL', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'fs_read_dir') return []
      if (cmd === 'fs_read_file') return ''
      return '/home/test'
    })
    await loadSkills(PROJECT)
    const callCountAfterFirst = invokeMock.mock.calls.length
    await loadSkills(PROJECT)
    // Second call should be served from cache — no additional invoke calls
    expect(invokeMock.mock.calls.length - callCountAfterFirst).toBe(0)
  })

  it('re-fetches after cache is invalidated', async () => {
    let callCount = 0
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'fs_read_dir') { callCount++; return [] }
      return '/home/test'
    })
    await loadSkills(PROJECT)
    invalidateSkillsCache(PROJECT)
    await loadSkills(PROJECT)
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  it('loads settings custom skills from current, known project, and personal custom folders', async () => {
    homeDirMock.mockReturnValue(Promise.resolve('/home/test'))
    invokeMock.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'fs_read_dir') {
        if (args?.root?.endsWith('/.betopia/skills/custom')) return [{ name: 'custom-skill', path: `${args.root}/custom-skill`, isDirectory: true }]
        if (args?.root?.endsWith('/.betopia/skills/custom/custom-skill')) return [{ name: 'SKILL.md', path: `${args.root}/SKILL.md` }]
        return []
      }
      if (cmd === 'fs_read_file') {
        if (args?.path?.startsWith(`${PROJECT}/`)) return '---\nname: Current Custom\ndescription: Current\n---\nCurrent body'
        if (args?.path?.startsWith('/other/project/')) return '---\nname: Other Custom\ndescription: Other\n---\nOther body'
        if (args?.path?.startsWith('/home/test/.betopia/')) return '---\nname: Personal Custom\ndescription: Personal\n---\nPersonal body'
      }
      return []
    })

    const skills = await loadCustomSkillsForSettings(PROJECT, ['/other/project'])
    expect(skills.map(skill => skill.name)).toEqual(['Current Custom', 'Other Custom', 'Personal Custom'])
  })

  it('loads Codex system skills with companion references for runtime context', async () => {
    homeDirMock.mockReturnValue(Promise.resolve('/home/test'))
    invokeMock.mockImplementation((cmd: string, args?: any) => {
      if (cmd === 'fs_read_dir') {
        if (args?.root === '/home/test/.codex/skills/.system') {
          return [{ name: 'imagegen', path: `${args.root}/imagegen`, isDirectory: true }]
        }
        if (args?.root === '/home/test/.codex/skills/.system/imagegen') {
          return [
            { name: 'SKILL.md', path: `${args.root}/SKILL.md` },
            { name: 'references', path: `${args.root}/references`, isDirectory: true },
          ]
        }
        if (args?.root === '/home/test/.codex/skills/.system/imagegen/references') {
          return [{ name: 'prompting.md', path: `${args.root}/prompting.md` }]
        }
        return []
      }
      if (cmd === 'fs_read_file') {
        if (args?.path === '/home/test/.codex/skills/.system/imagegen/SKILL.md') {
          return '---\nname: imagegen\ndescription: Generate or edit raster images.\n---\n# Image Generation Skill\nUse image generation.'
        }
        if (args?.path === '/home/test/.codex/skills/.system/imagegen/references/prompting.md') {
          return '# Prompting\nUse precise image prompts.'
        }
      }
      return []
    })

    const skills = await loadPersonalSkills()
    const imagegen = skills.find(skill => skill.name === 'imagegen')

    expect(imagegen).toBeDefined()
    expect(imagegen!.path).toContain('/.codex/skills/.system/imagegen/SKILL.md')
    expect(imagegen!.body).toContain('Use image generation.')
    expect(imagegen!.body).toContain('Use precise image prompts.')
  })
})
