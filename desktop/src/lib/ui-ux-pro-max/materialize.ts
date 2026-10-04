import { invoke } from '@tauri-apps/api/core'
import { invalidateSkillsCache } from '../agent-project'
import { findBuiltinSkill } from '../builtin-skills'
import { notifySkillsChanged } from '../skill-events'

export const UI_UX_PRO_MAX_INSTALL_DIR = '.betopia/skills/ui-ux-pro-max'

const UI_UX_PRO_MAX_BUNDLE_VERSION = '2.6.2-betopia.1'
const MANIFEST_PATH = `${UI_UX_PRO_MAX_INSTALL_DIR}/betopia-manifest.json`

const bundledFiles = import.meta.glob<string>(['./assets/**/*', './LICENSE', './skill.json'], {
  query: '?raw',
  import: 'default',
})

type MaterializeResult = {
  installed: boolean
  path: string
  fileCount: number
  version: string
}

function destinationForModulePath(modulePath: string): string | null {
  if (modulePath.startsWith('./assets/')) {
    return `${UI_UX_PRO_MAX_INSTALL_DIR}/${modulePath.slice('./assets/'.length)}`
  }
  if (modulePath === './LICENSE') return `${UI_UX_PRO_MAX_INSTALL_DIR}/LICENSE`
  if (modulePath === './skill.json') return `${UI_UX_PRO_MAX_INSTALL_DIR}/skill.json`
  return null
}

function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

function normalizeRelPath(relPath: string): string {
  const raw = String(relPath ?? '')
  if (raw.includes('\0')) {
    throw new Error('Path cannot contain null bytes')
  }

  const normalized = raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Path must be relative')
  }
  if (!normalized || normalized === '.') return ''

  const parts = normalized.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..')) {
    throw new Error('Path cannot contain ".."')
  }

  return parts.join('/')
}

function joinProjectPath(projectPath: string, relPath: string): string {
  const root = normalizeProjectPath(projectPath)
  return relPath ? `${root}/${relPath}` : root
}

function absoluteProjectFilePath(projectPath: string, relPath: string): string {
  const safeRel = normalizeRelPath(relPath)
  if (!safeRel) throw new Error('File path is required')
  return joinProjectPath(projectPath, safeRel)
}

async function readProjectFileNative(projectPath: string, relPath: string): Promise<string> {
  return invoke<string>('fs_read_file', { path: absoluteProjectFilePath(projectPath, relPath) })
}

async function writeProjectFileNative(projectPath: string, relPath: string, content: string): Promise<void> {
  await invoke('fs_write_file', { path: absoluteProjectFilePath(projectPath, relPath), content })
}

function projectSkillMarkdown(): string {
  const skillBody = findBuiltinSkill('/ui-ux')?.body ?? ''
  return [
    '---',
    'name: UI/UX Pro Max',
    'description: Full data-driven frontend design intelligence for beautiful, accessible UI.',
    'disable-model-invocation: true',
    '---',
    '',
    skillBody,
    '',
    '## Local Runtime',
    '',
    `This Betopia project has the full UI/UX Pro Max data pack installed at \`${UI_UX_PRO_MAX_INSTALL_DIR}/\`.`,
    '',
    'Important files:',
    `- \`${UI_UX_PRO_MAX_INSTALL_DIR}/scripts/search.py\` - CLI entry point`,
    `- \`${UI_UX_PRO_MAX_INSTALL_DIR}/scripts/core.py\` - BM25 search over CSV data`,
    `- \`${UI_UX_PRO_MAX_INSTALL_DIR}/scripts/design_system.py\` - design system generator`,
    `- \`${UI_UX_PRO_MAX_INSTALL_DIR}/data/\` - product, style, color, typography, UX, chart, motion, icon, and stack CSVs`,
    '',
  ].join('\n')
}

async function hasCurrentBundle(projectPath: string, expectedFileCount: number): Promise<boolean> {
  try {
    const raw = await readProjectFileNative(projectPath, MANIFEST_PATH)
    const manifest = JSON.parse(raw) as { version?: string; fileCount?: number }
    return manifest.version === UI_UX_PRO_MAX_BUNDLE_VERSION && manifest.fileCount === expectedFileCount
  } catch {
    return false
  }
}

export async function materializeUiUxProMaxSkill(projectPath: string): Promise<MaterializeResult> {
  const entries = Object.entries(bundledFiles)
    .map(([modulePath, loader]) => ({ modulePath, loader, destination: destinationForModulePath(modulePath) }))
    .filter((entry): entry is { modulePath: string; loader: () => Promise<string>; destination: string } => Boolean(entry.destination))

  const fileCount = entries.length + 2 // SKILL.md + manifest
  if (await hasCurrentBundle(projectPath, fileCount)) {
    return {
      installed: false,
      path: UI_UX_PRO_MAX_INSTALL_DIR,
      fileCount,
      version: UI_UX_PRO_MAX_BUNDLE_VERSION,
    }
  }

  for (const entry of entries) {
    const content = await entry.loader()
    await writeProjectFileNative(projectPath, entry.destination, content)
  }

  await writeProjectFileNative(projectPath, `${UI_UX_PRO_MAX_INSTALL_DIR}/SKILL.md`, projectSkillMarkdown())
  await writeProjectFileNative(projectPath, MANIFEST_PATH, JSON.stringify({
    name: 'ui-ux-pro-max',
    version: UI_UX_PRO_MAX_BUNDLE_VERSION,
    fileCount,
    installedAt: new Date().toISOString(),
    entrypoint: `${UI_UX_PRO_MAX_INSTALL_DIR}/scripts/search.py`,
  }, null, 2))

  invalidateSkillsCache(projectPath)
  notifySkillsChanged()

  return {
    installed: true,
    path: UI_UX_PRO_MAX_INSTALL_DIR,
    fileCount,
    version: UI_UX_PRO_MAX_BUNDLE_VERSION,
  }
}
