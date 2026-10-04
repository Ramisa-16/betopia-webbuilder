/**
 * project-scaffold.ts
 * Automatically categorizes project files into logical folders,
 * providing a structured view for the file explorer.
 * Inspired by open-lovable's file-parser architecture.
 */

import type { FileEntry, ProjectCategory, CategorizedFile } from '../types'

// ── Category detection rules ──────────────────────────────────────────────────

const PATH_CATEGORY_RULES: Array<{ pattern: RegExp; category: ProjectCategory }> = [
  // Pages / routes
  { pattern: /\/(pages?|routes?|app|views?)\//i, category: 'pages' },
  { pattern: /\/app\/.*\.(tsx?|jsx?)$/, category: 'pages' },

  // UI components
  { pattern: /\/components?\//i, category: 'components' },
  { pattern: /\/(ui|design|layout|widgets?)\//i, category: 'ui' },

  // API routes
  { pattern: /\/api\//i, category: 'api' },
  { pattern: /\.(api|route|endpoint)\.(ts|js)$/, category: 'api' },

  // Backend / server
  { pattern: /\/(server|backend|express|fastify|hono)\//i, category: 'backend' },
  { pattern: /\/(middleware|auth|guards?)\//i, category: 'backend' },

  // Database
  { pattern: /\/(db|database|prisma|drizzle|orm|migrations?|schema)\//i, category: 'database' },
  { pattern: /\.(schema|migration|seed)\.(ts|js)$/, category: 'database' },
  { pattern: /schema\.(ts|js|prisma)$/, category: 'database' },

  // Hooks
  { pattern: /\/hooks?\//i, category: 'hooks' },
  { pattern: /\/(use[A-Z][a-zA-Z]+)\.(ts|tsx)$/, category: 'hooks' },

  // Services / data fetching
  { pattern: /\/(services?|queries?|mutations?|stores?|state)\//i, category: 'services' },

  // Utilities
  { pattern: /\/(utils?|helpers?|lib|libs?)\//i, category: 'utils' },
  { pattern: /\/(types?|interfaces?|constants?|enums?)\//i, category: 'utils' },

  // Config
  { pattern: /\/(config|configs?|settings?)\//i, category: 'configs' },
  { pattern: /\.(config|env|rc)\.(ts|js|json|yaml|yml)$/, category: 'configs' },
  { pattern: /^(vite|next|tailwind|postcss|tsconfig|jest|eslint|prettier)\./i, category: 'configs' },

  // Assets
  { pattern: /\/(assets?|static|public|images?|icons?|fonts?|media)\//i, category: 'assets' },
  { pattern: /\.(png|jpg|jpeg|gif|svg|ico|webp|mp4|mp3|woff|woff2|ttf|eot)$/, category: 'assets' },
]

function categorizeFile(file: FileEntry): ProjectCategory {
  const path = file.path.replace(/\\/g, '/')
  const name = file.name

  // Check path-based rules
  for (const rule of PATH_CATEGORY_RULES) {
    if (rule.pattern.test(path) || rule.pattern.test(name)) {
      return rule.category
    }
  }

  // Heuristic: top-level files that look like config
  const configNames = new Set([
    'package.json', 'package-lock.json', 'bun.lock', 'yarn.lock', 'pnpm-lock.yaml',
    '.env', '.env.local', '.env.example', '.env.development', '.env.production',
    '.gitignore', '.gitattributes', '.editorconfig', 'Dockerfile', 'docker-compose.yml',
    'README.md', 'LICENSE', 'CHANGELOG.md',
  ])
  if (configNames.has(name)) return 'configs'

  // Hook files by naming convention
  if (/^use[A-Z]/.test(name) && /\.(ts|tsx)$/.test(name)) return 'hooks'

  // Service files
  if (/[Ss]ervice\.(ts|tsx)$/.test(name)) return 'services'

  // Default to 'other'
  return 'other'
}

// ── Group files by category ───────────────────────────────────────────────────

export function groupFilesByCategory(files: FileEntry[]): Map<ProjectCategory, CategorizedFile[]> {
  const map = new Map<ProjectCategory, CategorizedFile[]>()

  function processEntry(entry: FileEntry) {
    if (entry.is_dir) {
      entry.children?.forEach(processEntry)
      return
    }
    const category = categorizeFile(entry)
    if (!map.has(category)) map.set(category, [])
    map.get(category)!.push({ entry, category })
  }

  files.forEach(processEntry)
  return map
}

// ── Category metadata ─────────────────────────────────────────────────────────

export interface CategoryMeta {
  label: string
  icon: string
  color: string
  description: string
}

export const CATEGORY_META: Record<ProjectCategory, CategoryMeta> = {
  pages:      { label: 'Pages',      icon: '📑', color: '#7c3aed', description: 'Routes and page components' },
  components: { label: 'Components', icon: '🧩', color: '#2563eb', description: 'Reusable UI components' },
  ui:         { label: 'UI',         icon: '🎨', color: '#db2777', description: 'Design system & UI primitives' },
  api:        { label: 'API',        icon: '🔌', color: '#059669', description: 'API routes and endpoints' },
  backend:    { label: 'Backend',    icon: '⚙️',  color: '#d97706', description: 'Server-side logic' },
  database:   { label: 'Database',   icon: '🗄️',  color: '#0891b2', description: 'Database schemas and migrations' },
  hooks:      { label: 'Hooks',      icon: '🪝', color: '#7c3aed', description: 'React hooks' },
  services:   { label: 'Services',   icon: '🔧', color: '#16a34a', description: 'Data fetching and state management' },
  utils:      { label: 'Utils',      icon: '🛠️',  color: '#9ca3af', description: 'Helper functions and utilities' },
  configs:    { label: 'Configs',    icon: '⚙️',  color: '#64748b', description: 'Configuration files' },
  assets:     { label: 'Assets',     icon: '🖼️',  color: '#f59e0b', description: 'Images, fonts, and static files' },
  other:      { label: 'Other',      icon: '📄', color: '#6b7280', description: 'Other files' },
}

export const CATEGORY_ORDER: ProjectCategory[] = [
  'pages', 'components', 'ui', 'api', 'backend', 'database',
  'hooks', 'services', 'utils', 'configs', 'assets', 'other',
]

// ── Flat file list ────────────────────────────────────────────────────────────

export function flattenFiles(files: FileEntry[]): FileEntry[] {
  const result: FileEntry[] = []
  function walk(entries: FileEntry[]) {
    for (const e of entries) {
      if (!e.is_dir) result.push(e)
      if (e.children) walk(e.children)
    }
  }
  walk(files)
  return result
}

