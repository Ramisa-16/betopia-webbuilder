import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const existsMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  exists: existsMock,
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

import { writeProjectFile } from '../fs'

describe('writeProjectFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the native project write command instead of scoped plugin-fs exists checks', async () => {
    await writeProjectFile('/home/mamun/projects/example', '.betopia/skills/custom/debug/SKILL.md', '# Debug')

    expect(existsMock).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith('fs_write_file', {
      path: '/home/mamun/projects/example/.betopia/skills/custom/debug/SKILL.md',
      content: '# Debug',
    })
  })
})
