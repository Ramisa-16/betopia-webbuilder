import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const invokeMock = vi.hoisted(() => vi.fn())
const readProjectFileMock = vi.hoisted(() => vi.fn())
const writeProjectFileMock = vi.hoisted(() => vi.fn())
const getFileTreeMock = vi.hoisted(() => vi.fn())
const runCommandInSandboxMock = vi.hoisted(() => vi.fn())
const raceTimeoutMock = vi.hoisted(() => vi.fn(<T>(p: Promise<T>, _label: string) => p))
const getTypeScriptLspClientMock = vi.hoisted(() => vi.fn(() => ({ syncFile: vi.fn() })))
const invalidateTypeScriptLspProjectMock = vi.hoisted(() => vi.fn())
const invalidateMemoryCacheMock = vi.hoisted(() => vi.fn())
const getConfigMock = vi.hoisted(() => vi.fn(() => ({ sandbox: { enabled: false } })))

// Non-hoisted mock factories for tool-valid helpers — these are pure functions, just re-route
vi.mock('../agent-tool-valid', async () => {
  const actual = await vi.importActual('../agent-tool-valid')
  return {
    ...(actual as any),
    getUnsafeProjectPathReason: vi.fn((p: string) => (actual as any).getUnsafeProjectPathReason(p)),
    unsafeProjectPathResult: vi.fn((p: string) => `Error: unsafe path ${p}`),
    normalizeEscapedMultiline: vi.fn((s: string) => s),
    resolveEditList: vi.fn((args: any) => {
      if (args.edits) return args.edits
      if (args.old_string && args.new_string) return [{ old_string: args.old_string, new_string: args.new_string }]
      return null
    }),
    applyEditListToContent: vi.fn((content: string, edits: any[]) => {
      if (edits.length === 0) return { error: 'No edits provided' }
      const e = edits[0]
      if (!content.includes(e.old_string)) return { error: `Edit failed: old_string not found` }
      return { content: content.replace(e.old_string, e.new_string) }
    }),
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('../fs', () => ({
  readProjectFile: readProjectFileMock,
  writeProjectFile: writeProjectFileMock,
  getFileTree: getFileTreeMock,
}))
vi.mock('../sandbox', () => ({ runCommandInSandbox: runCommandInSandboxMock }))
vi.mock('../platform', () => ({ IS_WINDOWS: false }))
vi.mock('../agent-types', () => ({ raceTimeout: raceTimeoutMock, makeId: () => 'mock-id' }))
vi.mock('../config', () => ({ getConfig: getConfigMock }))
vi.mock('../agent-project', () => ({ invalidateMemoryCache: invalidateMemoryCacheMock }))
vi.mock('../lsp/typescript-client', () => ({
  getTypeScriptLspClient: getTypeScriptLspClientMock,
  invalidateTypeScriptLspProject: invalidateTypeScriptLspProjectMock,
}))

import { executeBuiltinTool } from '../agent-tool-exec'

const PROJECT = '/home/test/project'

function exec(name: string, args: Record<string, unknown>, overrides?: {
  onFilesChanged?: () => Promise<void>
  onPermissionRequest?: (tool: string, args: string) => Promise<boolean>
  onServerStarted?: (url: string) => void
  onProgress?: (progress: string) => void
  smallOutput?: boolean
}): Promise<string> {
  return executeBuiltinTool(
    PROJECT,
    name,
    JSON.stringify(args),
    overrides?.onFilesChanged ?? vi.fn(),
    overrides?.onPermissionRequest,
    overrides?.onServerStarted,
    overrides?.onProgress,
    overrides?.smallOutput,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── write_file ─────────────────────────────────────────────────────────────────

describe('write_file', () => {
  it('writes a file and returns success message', async () => {
    const result = await exec('write_file', { path: 'src/main.ts', content: 'hello' })
    expect(result).toBe('File written: src/main.ts')
    expect(writeProjectFileMock).toHaveBeenCalledWith(PROJECT, 'src/main.ts', 'hello')
  })

  it('returns error when path is missing', async () => {
    const result = await exec('write_file', { content: 'hello' })
    expect(result).toMatch(/path and content required/)
    expect(writeProjectFileMock).not.toHaveBeenCalled()
  })

  it('returns error when content is missing', async () => {
    const result = await exec('write_file', { path: 'x.ts' })
    expect(result).toMatch(/path and content required/)
  })

  it('rejects unsafe paths', async () => {
    const { getUnsafeProjectPathReason } = await import('../agent-tool-valid')
    vi.mocked(getUnsafeProjectPathReason).mockReturnValueOnce('outside project')
    const result = await exec('write_file', { path: '../../etc/passwd', content: 'hack' })
    expect(result).toContain('Error: unsafe path')
    expect(writeProjectFileMock).not.toHaveBeenCalled()
  })

  it('rejects oversized content in smallOutput mode', async () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const result = await exec('write_file', { path: 'big.ts', content: big }, { smallOutput: true })
    expect(result).toContain('80-line limit')
    expect(writeProjectFileMock).not.toHaveBeenCalled()
  })

  it('allows small content in smallOutput mode', async () => {
    const small = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const result = await exec('write_file', { path: 'small.ts', content: small }, { smallOutput: true })
    expect(result).toBe('File written: small.ts')
  })

  it('calls permission request when provided', async () => {
    const onPermissionRequest = vi.fn(async () => true)
    await exec('write_file', { path: 'f.ts', content: 'x' }, { onPermissionRequest })
    expect(onPermissionRequest).toHaveBeenCalledWith('write_file', expect.any(String))
  })

  it('returns denied message when permission rejected', async () => {
    const onPermissionRequest = vi.fn(async () => false)
    const result = await exec('write_file', { path: 'f.ts', content: 'x' }, { onPermissionRequest })
    expect(result).toContain('Permission denied')
    expect(writeProjectFileMock).not.toHaveBeenCalled()
  })

  it('syncs file via LSP client', async () => {
    const syncFile = vi.fn()
    vi.mocked(getTypeScriptLspClientMock).mockReturnValueOnce({ syncFile })
    await exec('write_file', { path: 'src/x.ts', content: 'code' })
    expect(syncFile).toHaveBeenCalledWith('/home/test/project', 'src/x.ts', 'code')
  })

  it('calls onFilesChanged after write', async () => {
    const onFilesChanged = vi.fn()
    await exec('write_file', { path: 'f.ts', content: 'x' }, { onFilesChanged })
    expect(onFilesChanged).toHaveBeenCalled()
  })
})

// ── edit ───────────────────────────────────────────────────────────────────────

describe('edit', () => {
  it('applies old_string → new_string edit', async () => {
    readProjectFileMock.mockResolvedValue('const x = 1\nconst y = 2')
    const result = await exec('edit', { path: 'src/main.ts', old_string: 'const x = 1', new_string: 'const x = 10' })
    expect(result).toBe('File edited: src/main.ts')
    expect(writeProjectFileMock).toHaveBeenCalledWith(PROJECT, 'src/main.ts', 'const x = 10\nconst y = 2')
  })

  it('applies multiple edits from edits array', async () => {
    readProjectFileMock.mockResolvedValue('a\nb\nc')
    const result = await exec('edit', {
      path: 'file.ts',
      edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'C' }],
    })
    expect(result).toContain('2 changes applied')
  })

  it('returns error when path missing', async () => {
    const result = await exec('edit', { old_string: 'a', new_string: 'b' })
    expect(result).toMatch(/path required/)
  })

  it('returns error when neither edits nor old_string provided', async () => {
    const result = await exec('edit', { path: 'f.ts' })
    expect(result).toMatch(/provide either edits/)
  })

  it('returns error when old_string not found', async () => {
    readProjectFileMock.mockResolvedValue('some content')
    const result = await exec('edit', { path: 'f.ts', old_string: 'nonexistent', new_string: 'replacement' })
    expect(result).toContain('Edit failed')
  })

  it('rejects unsafe paths', async () => {
    const { getUnsafeProjectPathReason } = await import('../agent-tool-valid')
    vi.mocked(getUnsafeProjectPathReason).mockReturnValueOnce('outside project')
    const result = await exec('edit', { path: '/etc/hosts', old_string: 'a', new_string: 'b' })
    expect(result).toContain('Error: unsafe path')
  })

  it('calls permission request', async () => {
    readProjectFileMock.mockResolvedValue('a')
    const onPermissionRequest = vi.fn(async () => true)
    await exec('edit', { path: 'f.ts', old_string: 'a', new_string: 'b' }, { onPermissionRequest })
    expect(onPermissionRequest).toHaveBeenCalled()
  })

  it('reports line delta via onProgress', async () => {
    readProjectFileMock.mockResolvedValue('line1\nline2')
    const onProgress = vi.fn()
    await exec('edit', { path: 'f.ts', old_string: 'line1', new_string: 'line1\nline1.5' }, { onProgress })
    expect(onProgress).toHaveBeenCalledWith('+1 lines')
  })
})

// ── delete_file ────────────────────────────────────────────────────────────────

describe('delete_file', () => {
  it('deletes a file', async () => {
    invokeMock.mockResolvedValue(undefined)
    const result = await exec('delete_file', { path: 'old.ts' })
    expect(result).toBe('Deleted: old.ts')
    expect(invokeMock).toHaveBeenCalledWith('fs_delete', { path: `${PROJECT}/old.ts` })
  })

  it('returns error when path missing', async () => {
    const result = await exec('delete_file', {})
    expect(result).toMatch(/path required/)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('returns error on delete failure', async () => {
    invokeMock.mockRejectedValue(new Error('file not found'))
    const result = await exec('delete_file', { path: 'missing.ts' })
    expect(result).toContain('Error deleting')
  })

  it('invalidates LSP project on delete', async () => {
    invokeMock.mockResolvedValue(undefined)
    await exec('delete_file', { path: 'gone.ts' })
    expect(invalidateTypeScriptLspProjectMock).toHaveBeenCalledWith(PROJECT)
  })
})

// ── rename_file ────────────────────────────────────────────────────────────────

describe('rename_file', () => {
  it('renames a file', async () => {
    invokeMock.mockResolvedValue(undefined)
    const result = await exec('rename_file', { from: 'old.ts', to: 'new.ts' })
    expect(result).toBe('Renamed: old.ts → new.ts')
    expect(invokeMock).toHaveBeenCalledWith('fs_rename', {
      from: `${PROJECT}/old.ts`,
      to: `${PROJECT}/new.ts`,
    })
  })

  it('returns error when from or to missing', async () => {
    expect(await exec('rename_file', { from: 'a.ts' })).toMatch(/from and to paths required/)
    expect(await exec('rename_file', { to: 'b.ts' })).toMatch(/from and to paths required/)
  })

  it('returns error on rename failure', async () => {
    invokeMock.mockRejectedValue(new Error('source not found'))
    const result = await exec('rename_file', { from: 'old.ts', to: 'new.ts' })
    expect(result).toContain('Error renaming')
  })

  it('invalidates LSP project', async () => {
    invokeMock.mockResolvedValue(undefined)
    await exec('rename_file', { from: 'a.ts', to: 'b.ts' })
    expect(invalidateTypeScriptLspProjectMock).toHaveBeenCalledWith(PROJECT)
  })
})

// ── view_file ──────────────────────────────────────────────────────────────────

describe('view_file', () => {
  it('reads and returns file content', async () => {
    readProjectFileMock.mockResolvedValue('line1\nline2\nline3')
    const result = await exec('view_file', { path: 'src/main.ts' })
    expect(result).toBe('line1\nline2\nline3')
  })

  it('returns error when path missing', async () => {
    const result = await exec('view_file', {})
    expect(result).toMatch(/path required/)
  })

  it('respects start_line and end_line', async () => {
    readProjectFileMock.mockResolvedValue('a\nb\nc\nd\ne')
    const result = await exec('view_file', { path: 'f.ts', start_line: 2, end_line: 4 })
    expect(result).toBe('b\nc\nd')
  })

  it('truncates at VIEW_MAX_LINES', async () => {
    const long = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n')
    readProjectFileMock.mockResolvedValue(long)
    const result = await exec('view_file', { path: 'big.ts' })
    expect(result).toContain('[File truncated')
    expect(result.split('\n').length).toBeLessThanOrEqual(2002)
  })

  it('reads image files and returns base64', async () => {
    invokeMock.mockResolvedValue([0x89, 0x50, 0x4e, 0x47])
    const result = await exec('view_file', { path: 'logo.png' })
    expect(result).toContain('__IMAGE_DATA__:data:image/png;base64,')
  })

  it('returns error for unreadable image', async () => {
    invokeMock.mockRejectedValue(new Error('permission denied'))
    const result = await exec('view_file', { path: 'secret.png' })
    expect(result).toContain('Error reading image')
  })
})

// ── list_files ─────────────────────────────────────────────────────────────────

describe('list_files', () => {
  it('returns flattened file tree', async () => {
    getFileTreeMock.mockResolvedValue([
      { name: 'src', is_dir: true, children: [{ name: 'main.ts', is_dir: false, path: 'src/main.ts' }] },
      { name: 'package.json', is_dir: false, path: 'package.json' },
    ])
    const result = await exec('list_files', {})
    expect(result).toContain('📁 src')
    expect(result).toContain('📄 main.ts')
    expect(result).toContain('📄 package.json')
  })

  it('returns (empty project) for empty tree', async () => {
    getFileTreeMock.mockResolvedValue([])
    const result = await exec('list_files', {})
    expect(result).toBe('(empty project)')
  })
})

// ── list_dir ───────────────────────────────────────────────────────────────────

describe('list_dir', () => {
  it('lists directory entries', async () => {
    const readDirMock = vi.fn().mockResolvedValue([
      { name: 'main.ts', isDirectory: false },
      { name: 'utils', isDirectory: true },
    ])
    vi.doMock('@tauri-apps/plugin-fs', () => ({ readDir: readDirMock }))
    // Re-import with the mock applied
    const { executeBuiltinTool: exec2 } = await import('../agent-tool-exec')
    const result = await exec2(PROJECT, 'list_dir', JSON.stringify({ path: '.' }), vi.fn())
    expect(result).toContain('📄 main.ts')
    expect(result).toContain('📁 utils')
  })
})

// ── grep_search ────────────────────────────────────────────────────────────────

describe('grep_search', () => {
  it('returns matching lines', async () => {
    invokeMock.mockResolvedValue([
      { path: 'src/main.ts', line: 10, text: '  const x = 1' },
      { path: 'src/utils.ts', line: 5, text: '  const x = 2' },
    ])
    const result = await exec('grep_search', { query: 'const x' })
    expect(result).toContain('src/main.ts:10: const x = 1')
    expect(result).toContain('src/utils.ts:5: const x = 2')
  })

  it('returns error when query missing', async () => {
    const result = await exec('grep_search', {})
    expect(result).toMatch(/query required/)
  })

  it('returns "No matches found" for empty results', async () => {
    invokeMock.mockResolvedValue([])
    const result = await exec('grep_search', { query: 'nonexistent' })
    expect(result).toBe('No matches found')
  })

  it('shows truncation warning at max results', async () => {
    const matches = Array.from({ length: 100 }, (_, i) => ({ path: 'f.ts', line: i, text: `match ${i}` }))
    invokeMock.mockResolvedValue(matches)
    const result = await exec('grep_search', { query: 'match' })
    expect(result).toContain('Showing first 100 matches')
  })
})

// ── bash ───────────────────────────────────────────────────────────────────────

describe('bash', () => {
  it('runs a command and returns stdout', async () => {
    invokeMock.mockResolvedValue({ stdout: 'hello world', stderr: '', exit_code: 0 })
    const result = await exec('bash', { command: 'echo hello' })
    expect(result).toBe('hello world')
  })

  it('returns error when command missing', async () => {
    const result = await exec('bash', {})
    expect(result).toMatch(/command required/)
  })

  it('returns stderr on non-zero exit', async () => {
    invokeMock.mockResolvedValue({ stdout: '', stderr: 'command not found', exit_code: 127 })
    const result = await exec('bash', { command: 'nonexistent' })
    expect(result).toContain('Error (code 127)')
    expect(result).toContain('command not found')
  })

  it('calls permission request', async () => {
    invokeMock.mockResolvedValue({ stdout: 'ok', stderr: '', exit_code: 0 })
    const onPermissionRequest = vi.fn(async () => true)
    await exec('bash', { command: 'ls' }, { onPermissionRequest })
    expect(onPermissionRequest).toHaveBeenCalledWith('bash', expect.any(String))
  })

  it('returns denied when permission rejected', async () => {
    const onPermissionRequest = vi.fn(async () => false)
    const result = await exec('bash', { command: 'rm -rf /' }, { onPermissionRequest })
    expect(result).toContain('Permission denied')
  })

  it('truncates output over 50k chars', async () => {
    const big = 'x'.repeat(60_000)
    invokeMock.mockResolvedValue({ stdout: big, stderr: '', exit_code: 0 })
    const result = await exec('bash', { command: 'cat bigfile' })
    expect(result).toContain('[Output truncated')
    expect(result.length).toBeLessThanOrEqual(50_200)
  })

  it('reports elapsed time via onProgress', async () => {
    invokeMock.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 1100))
      return { stdout: 'done', stderr: '', exit_code: 0 }
    })
    const onProgress = vi.fn()
    await exec('bash', { command: 'sleep 0.01' }, { onProgress })
    expect(onProgress).toHaveBeenCalled()
  })

  it('respects custom timeout', async () => {
    invokeMock.mockResolvedValue({ stdout: 'ok', stderr: '', exit_code: 0 })
    await exec('bash', { command: 'ls', timeout: 30 })
    expect(invokeMock).toHaveBeenCalledWith('shell_run_command', expect.objectContaining({ timeoutSecs: 30 }))
  })

  it('runs commands in an explicit project-relative cwd', async () => {
    invokeMock.mockResolvedValue({ stdout: 'ok', stderr: '', exit_code: 0 })
    await exec('bash', { command: 'npm install', cwd: 'frontend' })
    expect(invokeMock).toHaveBeenCalledWith('shell_run_command', expect.objectContaining({
      command: 'npm install',
      cwd: `${PROJECT}/frontend`,
    }))
  })

  it('rejects unsafe bash cwd values', async () => {
    const result = await exec('bash', { command: 'npm install', cwd: '../other-project' })
    expect(result).toContain('unsafe path')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('auto-selects frontend cwd for rootless frontend dev servers', async () => {
    vi.doMock('@tauri-apps/plugin-fs', () => ({
      exists: vi.fn(async (path: string) => path.endsWith('/frontend/package.json')),
    }))
    invokeMock.mockResolvedValue(undefined)

    const result = await exec('bash', { command: 'npm run dev', run_in_background: true })

    expect(invokeMock).toHaveBeenCalledWith('shell_bg_start', expect.objectContaining({
      cwd: `${PROJECT}/frontend`,
    }))
    expect(result).toContain('Auto-selected cwd: frontend')
  })

  it('auto-selects frontend cwd for rootless frontend install commands', async () => {
    vi.doMock('@tauri-apps/plugin-fs', () => ({
      exists: vi.fn(async (path: string) => path.endsWith('/frontend/package.json')),
    }))
    invokeMock.mockResolvedValue({ stdout: 'installed', stderr: '', exit_code: 0 })

    const result = await exec('bash', { command: 'npm install' })

    expect(invokeMock).toHaveBeenCalledWith('shell_run_command', expect.objectContaining({
      command: 'npm install',
      cwd: `${PROJECT}/frontend`,
    }))
    expect(result).toContain('Auto-selected cwd: frontend')
    expect(result).toContain('installed')
  })

  it('uses relative cwd inside sandbox sessions', async () => {
    getConfigMock.mockReturnValueOnce({ sandbox: { enabled: true, timeoutSec: 30 } })
    runCommandInSandboxMock.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false })

    const result = await exec('bash', { command: 'npm install', cwd: 'frontend' })

    expect(runCommandInSandboxMock).toHaveBeenCalledWith(PROJECT, 'cd "frontend" && npm install', expect.any(Object))
    expect(result).toBe('ok')
  })

  it('clamps timeout between 1 and 600', async () => {
    invokeMock.mockResolvedValue({ stdout: 'ok', stderr: '', exit_code: 0 })
    await exec('bash', { command: 'ls', timeout: 0 })
    expect(invokeMock).toHaveBeenCalledWith('shell_run_command', expect.objectContaining({ timeoutSecs: 1 }))
    await exec('bash', { command: 'ls', timeout: 1000 })
    expect(invokeMock).toHaveBeenCalledWith('shell_run_command', expect.objectContaining({ timeoutSecs: 600 }))
  })
})

// ── project_structure ──────────────────────────────────────────────────────────

describe('project_structure', () => {
  it('returns project stats and tree', async () => {
    getFileTreeMock.mockResolvedValue([
      { name: 'src', is_dir: true, children: [{ name: 'main.ts', is_dir: false, path: 'src/main.ts' }] },
      { name: 'index.html', is_dir: false, path: 'index.html' },
    ])
    const result = await exec('project_structure', {})
    expect(result).toContain('Files: 2, Directories: 1')
    expect(result).toContain('Entry Points:')
    expect(result).toContain('index.html')
    expect(result).toContain('main.ts')
  })

  it('handles empty project', async () => {
    getFileTreeMock.mockResolvedValue([])
    const result = await exec('project_structure', {})
    expect(result).toContain('Files: 0, Directories: 0')
  })
})

// ── read_files ─────────────────────────────────────────────────────────────────

describe('read_files', () => {
  it('reads files from project tree', async () => {
    getFileTreeMock.mockResolvedValue([
      { name: 'f1.ts', is_dir: false, path: 'f1.ts' },
    ])
    readProjectFileMock.mockResolvedValue('content of f1')
    const result = await exec('read_files', {})
    expect(result).toContain('📄 f1.ts')
    expect(result).toContain('content of f1')
  })

  it('returns (no files found) when empty', async () => {
    getFileTreeMock.mockResolvedValue([])
    const result = await exec('read_files', {})
    expect(result).toBe('(no files found)')
  })

  it('respects max_files limit', async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({ name: `f${i}.ts`, is_dir: false, path: `f${i}.ts` }))
    getFileTreeMock.mockResolvedValue(files)
    readProjectFileMock.mockResolvedValue('x')
    const result = await exec('read_files', { max_files: 5 })
    const matches = result.match(/📄 /g)
    expect(matches).toHaveLength(5)
  })
})

// ── read_with_deps ─────────────────────────────────────────────────────────────

describe('read_with_deps', () => {
  it('reads file and resolves local deps', async () => {
    readProjectFileMock.mockResolvedValueOnce('import { helper } from "./helper"\nconst x = 1')
    readProjectFileMock.mockResolvedValueOnce('export const helper = () => {}')
    const result = await exec('read_with_deps', { path: 'src/main.ts' })
    expect(result).toContain('📄 src/main.ts')
    expect(result).toContain('📄 src/helper')
  })

  it('returns error when path missing', async () => {
    const result = await exec('read_with_deps', {})
    expect(result).toMatch(/path required/)
  })

  it('resolves CSS href deps', async () => {
    readProjectFileMock.mockResolvedValueOnce('<link href="./style.css" rel="stylesheet">')
    readProjectFileMock.mockResolvedValueOnce('body { color: red }')
    const result = await exec('read_with_deps', { path: 'index.html' })
    expect(result).toContain('index.html')
    expect(result).toContain('style.css')
  })

  it('resolves @import deps', async () => {
    readProjectFileMock.mockResolvedValueOnce('@import "./vars"')
    readProjectFileMock.mockResolvedValueOnce('$color: red')
    const result = await exec('read_with_deps', { path: 'style.scss' })
    expect(result).toContain('style.scss')
    expect(result).toContain('vars')
  })

  it('skips http deps', async () => {
    readProjectFileMock.mockResolvedValueOnce(`import React from 'https://cdn/react'`)
    const result = await exec('read_with_deps', { path: 'x.ts' })
    // Only the original file is returned — the http dependency is not resolved
    const fileCount = (result.match(/📄/g) ?? []).length
    expect(fileCount).toBe(1)
  })
})

// ── update_memory ──────────────────────────────────────────────────────────────

describe('update_memory', () => {
  it('replaces memory file in replace mode', async () => {
    const result = await exec('update_memory', { content: 'new memory', mode: 'replace' })
    expect(result).toBe('Memory file replaced: .betopia/memory.md')
    expect(writeProjectFileMock).toHaveBeenCalledWith(PROJECT, '.betopia/memory.md', 'new memory')
    expect(invalidateMemoryCacheMock).toHaveBeenCalledWith(PROJECT)
  })

  it('appends to memory file by default', async () => {
    readProjectFileMock.mockResolvedValue('existing memory')
    const result = await exec('update_memory', { content: 'new content' })
    expect(result).toBe('Memory updated: .betopia/memory.md')
    expect(writeProjectFileMock).toHaveBeenCalledWith(PROJECT, '.betopia/memory.md', 'existing memory\n\nnew content')
  })

  it('creates memory file if none exists', async () => {
    readProjectFileMock.mockRejectedValue(new Error('not found'))
    const result = await exec('update_memory', { content: 'first memory' })
    expect(result).toBe('Memory updated: .betopia/memory.md')
    expect(writeProjectFileMock).toHaveBeenCalledWith(PROJECT, '.betopia/memory.md', 'first memory')
  })

  it('returns error when content missing', async () => {
    const result = await exec('update_memory', {})
    expect(result).toMatch(/content required/)
  })
})

// ── update_plan ────────────────────────────────────────────────────────────────

describe('update_plan', () => {
  it('validates and returns plan summary', async () => {
    const result = await exec('update_plan', {
      plan: [{ step: 'Setup', status: 'completed' }, { step: 'Build', status: 'in_progress' }],
      explanation: 'Working on it',
    })
    expect(result).toContain('1/2 steps complete')
    expect(result).toContain('Working on it')
  })

  it('rejects empty plan', async () => {
    const result = await exec('update_plan', { plan: [] })
    expect(result).toMatch(/non-empty plan array/)
  })

  it('rejects non-array plan', async () => {
    const result = await exec('update_plan', { plan: 'not array' })
    expect(result).toMatch(/non-empty plan array/)
  })

  it('rejects steps without step text', async () => {
    const result = await exec('update_plan', { plan: [{ status: 'pending' }] })
    expect(result).toMatch(/needs non-empty "step" text/)
  })

  it('rejects invalid status', async () => {
    const result = await exec('update_plan', { plan: [{ step: 'x', status: 'invalid' }] })
    expect(result).toMatch(/invalid status/)
  })

  it('rejects multiple in_progress steps', async () => {
    const result = await exec('update_plan', {
      plan: [
        { step: 'A', status: 'in_progress' },
        { step: 'B', status: 'in_progress' },
      ],
    })
    expect(result).toMatch(/only one step may be in_progress/)
  })
})

// ── unknown tool ───────────────────────────────────────────────────────────────

describe('unknown tool', () => {
  it('returns error for unrecognized tool name', async () => {
    const result = await exec('nonexistent_tool', {})
    expect(result).toMatch(/unknown tool/)
  })
})

// ── Invalid arguments ──────────────────────────────────────────────────────────

describe('invalid arguments', () => {
  it('returns error for non-JSON args', async () => {
    const result = await executeBuiltinTool(PROJECT, 'write_file', 'not json', vi.fn())
    expect(result).toMatch(/invalid tool arguments/)
  })

  it('handles double-encoded strings', async () => {
    const inner = JSON.stringify({ path: 'f.ts', content: 'hi' })
    const result = await executeBuiltinTool(PROJECT, 'write_file', JSON.stringify(inner), vi.fn())
    expect(result).toBe('File written: f.ts')
  })
})
