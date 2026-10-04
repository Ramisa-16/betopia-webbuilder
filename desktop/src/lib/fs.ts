import { readDir, readTextFile, writeTextFile, mkdir, exists, readFile, writeFile } from '@tauri-apps/plugin-fs'
import type { FileEntry } from '../types'

const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.next', 'dist', 'build', '.cache', '.vscode', '.idea'])

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/\/+/g, '/').replace(/\/$/, '')
}

function normalizeRelPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!normalized || normalized === '.') return ''
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some(part => part === '..')) {
    throw new Error('Path cannot contain ".."')
  }
  return parts.join('/')
}

function joinPath(base: string, rel: string): string {
  const root = normalize(base)
  if (!rel) return root
  return `${root}/${rel}`
}

function normalizeCssForPostCss(relPath: string, content: string): string {
  const lower = relPath.toLowerCase()
  if (!lower.endsWith('.css')) return content

  const lines = content.split('\n')
  const normalized = lines.map((line) => {
    // Convert full-line JS comments into CSS block comments.
    const fullLine = line.match(/^(\s*)\/\/\s?(.*)$/)
    if (fullLine) {
      const indent = fullLine[1] ?? ''
      const text = (fullLine[2] ?? '').trim()
      return text ? `${indent}/* ${text} */` : `${indent}/* */`
    }

    // Convert trailing "; // note" style comments safely.
    const trailing = line.match(/^(.+[;}{]\s*)\/\/\s?(.*)$/)
    if (trailing) {
      const before = trailing[1] ?? ''
      const text = (trailing[2] ?? '').trim()
      return text ? `${before}/* ${text} */` : `${before}/* */`
    }

    return line
  })

  return normalized.join('\n')
}

async function ensureDir(absDir: string): Promise<void> {
  if (!await exists(absDir)) {
    await mkdir(absDir, { recursive: true })
  }
}

async function ensureTextFile(absFile: string, content: string): Promise<void> {
  if (!await exists(absFile)) {
    await writeTextFile(absFile, content)
  }
}

async function isDirectoryEmpty(absDir: string): Promise<boolean> {
  try {
    const entries = await readDir(absDir)
    return entries.length === 0
  } catch {
    return true
  }
}

async function createStandardProjectScaffold(projectPath: string): Promise<void> {
  const root = normalize(projectPath)

  // Only create frontend skeleton — backend, .venv, requirements.txt are
  // created by the agent when the project actually needs them.
  await ensureDir(joinPath(root, 'frontend'))
  await ensureDir(joinPath(root, 'frontend/src'))

  await ensureTextFile(joinPath(root, '.gitignore'), [
    '.venv/',
    '__pycache__/',
    'node_modules/',
    'dist/',
    'build/',
    '.DS_Store',
    '*.log',
    '.env',
    '.env.local',
    '',
  ].join('\n'))
  await ensureTextFile(joinPath(root, '.env'), '')
  await ensureTextFile(joinPath(root, 'overview.md'), [
    '# Project Overview',
    '',
    '## Notes',
    '- This project was initialized with base repository files.',
    '- Use a standard folder structure when it fits the project: frontend, backend, UI, API, Tools, Config.',
    '- Create only the folders and files that the project needs; skip unused structure.',
    '',
    '## Update this file',
    '- Add architecture, setup, conventions, and deployment notes.',
    '',
  ].join('\n'))
}

export async function getFileTree(root: string): Promise<FileEntry[]> {
  console.log('[getFileTree] Building tree for root:', root)
  const tree = await buildTree(normalize(root), normalize(root))
  console.log('[getFileTree] Tree built, count:', tree.length)
  return tree
}

async function buildTree(root: string, dir: string): Promise<FileEntry[]> {
  let entries
  try {
    entries = await readDir(dir)
  } catch {
    return []
  }

  const result: FileEntry[] = []
  for (const e of entries) {
    const name = e.name ?? ''
    if (!name || IGNORE.has(name)) continue
    const abs = dir.endsWith('/') ? dir + name : dir + '/' + name
    const absNorm = normalize(abs)
    const relPath = absNorm.startsWith(root + '/') ? absNorm.slice(root.length + 1) : absNorm
    if (e.isDirectory) {
      const children = await buildTree(root, abs)
      result.push({ name, path: relPath, is_dir: true, children })
    } else {
      result.push({ name, path: relPath, is_dir: false })
    }
  }

  return result.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export async function readProjectFile(projectPath: string, relPath: string): Promise<string> {
  const abs = normalize(projectPath) + '/' + relPath.replace(/\\/g, '/')
  console.log('[readProjectFile] Reading file:', { projectPath, relPath, abs })
  try {
    const content = await readTextFile(abs)
    console.log('[readProjectFile] Read succeeded, length:', content.length)
    return content
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[readProjectFile] Read failed:', { abs, error: msg })
    throw new Error(`readProjectFile failed for ${abs}: ${msg}`)
  }
}

export async function writeProjectFile(projectPath: string, relPath: string, content: string): Promise<void> {
  const safeRel = normalizeRelPath(relPath)
  const abs = joinPath(projectPath, safeRel)
  const parts = safeRel.split('/').filter(Boolean)
  if (parts.length > 1) {
    const parentAbs = joinPath(projectPath, parts.slice(0, -1).join('/'))
    const parentExists = await exists(parentAbs)
    if (!parentExists) {
      await mkdir(parentAbs, { recursive: true })
    }
  }
  const normalizedContent = normalizeCssForPostCss(safeRel, content)
  await writeTextFile(abs, normalizedContent)
}

export async function ensureProjectDir(projectPath: string): Promise<void> {
  const normalized = normalize(projectPath)
  const dirExists = await exists(normalized)
  if (!dirExists) {
    await mkdir(normalized, { recursive: true })
  }
  try {
    if (await isDirectoryEmpty(normalized)) {
      await createStandardProjectScaffold(normalized)
    }
  } catch (err) {
    console.warn('[ensureProjectDir] scaffold failed, continuing anyway:', err)
  }
}

export async function createProjectFolder(projectPath: string, relPath: string): Promise<string> {
  const safeRel = normalizeRelPath(relPath)
  if (!safeRel) throw new Error('Folder path is required')
  const abs = joinPath(projectPath, safeRel)
  await mkdir(abs, { recursive: true })
  return safeRel
}

export async function createProjectFile(projectPath: string, relPath: string, initialContent = ''): Promise<string> {
  const safeRel = normalizeRelPath(relPath)
  if (!safeRel) throw new Error('File path is required')
  const parts = safeRel.split('/')
  if (parts.length > 1) {
    const parentAbs = joinPath(projectPath, parts.slice(0, -1).join('/'))
    await ensureDir(parentAbs)
  }
  const abs = joinPath(projectPath, safeRel)
  const normalizedContent = normalizeCssForPostCss(safeRel, initialContent)
  await writeTextFile(abs, normalizedContent)
  return safeRel
}

export async function duplicateProjectDirectory(src: string): Promise<string | null> {
  try {
    const { copyFile } = await import('@tauri-apps/plugin-fs')
    const destName = src.replace(/[/\\]+$/, '') + '_copy'
    await copyFile(src, destName)
    return destName
  } catch {
    return null
  }
}
