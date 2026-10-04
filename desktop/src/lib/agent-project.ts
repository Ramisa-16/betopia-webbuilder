import { readProjectFile } from './fs'
import { invoke } from '@tauri-apps/api/core'
import { homeDir } from '@tauri-apps/api/path'

// ── Project memory ────────────────────────────────────────────────────────────

const PRIMARY_MEMORY_FILES = ['architecture.md', 'design.md', 'assets.md']
const LEGACY_MEMORY_FILES = ['BETOPIA.md', 'betopia.md', 'CLAUDE.md', 'AGENTS.md', '.betopia/memory.md']
const MEMORY_MAX_CHARS = 32_000
const CACHE_TTL = 30_000

const memoryCache = new Map<string, { content: string; ts: number }>()
// In-flight guard: concurrent callers share one promise instead of racing to disk
const memoryInFlight = new Map<string, Promise<string | null>>()

export function invalidateMemoryCache(projectPath: string): void {
  memoryCache.delete(projectPath)
  memoryInFlight.delete(projectPath)
}

export function loadProjectMemory(projectPath: string): Promise<string | null> {
  const cached = memoryCache.get(projectPath)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return Promise.resolve(cached.content || null)

  const inflight = memoryInFlight.get(projectPath)
  if (inflight) return inflight

  const promise = _fetchMemory(projectPath).finally(() => memoryInFlight.delete(projectPath))
  memoryInFlight.set(projectPath, promise)
  return promise
}

async function _fetchMemory(projectPath: string): Promise<string | null> {
  const perFileBudget = Math.floor(MEMORY_MAX_CHARS / PRIMARY_MEMORY_FILES.length)
  const primaryParts: string[] = []
  for (const file of PRIMARY_MEMORY_FILES) {
    try {
      const content = await readProjectFile(projectPath, file)
      if (content?.trim()) primaryParts.push(`## ${file}\n${content.trim().slice(0, perFileBudget)}`)
    } catch { /* file doesn't exist */ }
  }
  if (primaryParts.length > 0) {
    const combined = primaryParts.join('\n\n')
    memoryCache.set(projectPath, { content: combined, ts: Date.now() })
    return combined
  }

  for (const file of LEGACY_MEMORY_FILES) {
    try {
      const content = await readProjectFile(projectPath, file)
      if (content?.trim()) {
        const trimmed = content.slice(0, MEMORY_MAX_CHARS)
        memoryCache.set(projectPath, { content: trimmed, ts: Date.now() })
        return trimmed
      }
    } catch { /* file doesn't exist, try next */ }
  }
  memoryCache.set(projectPath, { content: '', ts: Date.now() })
  return null
}

// ── Skills system ─────────────────────────────────────────────────────────────

export interface Skill {
  name: string
  description: string
  body: string
  path: string
  slash?: string
  disableModelInvocation?: boolean
  dependsOn?: string[]
  companionFiles?: SkillCompanionFile[]
}

const skillsCache = new Map<string, { skills: Skill[]; ts: number }>()
const SKILLS_CACHE_TTL = 30_000

type SkillCompanionFile = { relPath: string; body: string }

type ParsedSkillDoc = {
  name: string
  description: string
  body: string
  slash?: string
  disableModelInvocation: boolean
  dependsOn: string[]
  warnings: string[]
}

type DirEntry = { name?: string; path?: string; isDirectory?: boolean; is_dir?: boolean }

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

function joinAbsPath(base: string, rel: string): string {
  return normalizePath(`${base}/${rel}`)
}

function entryIsDirectory(entry: DirEntry): boolean {
  return Boolean(entry.isDirectory ?? entry.is_dir)
}

function inferSkillNameFromPath(filePath: string): string {
  const normalized = normalizePath(filePath)
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return 'unnamed'
  const last = parts[parts.length - 1]
  if (last.toUpperCase() === 'SKILL.MD') return parts[parts.length - 2] ?? 'unnamed'
  return last.replace(/\.md$/i, '') || 'unnamed'
}

function parseSkillList(raw: string | undefined): string[] {
  if (!raw) return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  const text = trimmed.replace(/^\[(.*)\]$/, '$1')
  return text
    .split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

function parseSkillDoc(content: string, filePath: string): ParsedSkillDoc {
  const fallbackName = inferSkillNameFromPath(filePath)
  let name = fallbackName
  let description = ''
  let body = content.trim()
  let slash: string | undefined
  let disableModelInvocation = false
  const dependsOn: string[] = []
  const warnings: string[] = []

  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (fmMatch) {
    body = content.slice(fmMatch[0].length).trim()
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^([\w-]+):\s*(.+)/)
      if (!m) {
        const trimmed = line.trim()
        if (trimmed && !trimmed.startsWith('#')) warnings.push(`ignored malformed frontmatter line: ${trimmed}`)
        continue
      }
      const key = m[1]
      const value = m[2].trim()
      if (key === 'name') name = value || fallbackName
      if (key === 'description') description = value
      if (key === 'slash') slash = value.startsWith('/') ? value : `/${value}`
      if (key === 'disable-model-invocation') disableModelInvocation = value.toLowerCase() === 'true'
      if (key === 'depends-on' || key === 'depends_on') dependsOn.push(...parseSkillList(value))
    }
  } else {
    warnings.push('missing frontmatter block')
  }

  if (!description) {
    const firstLine = body.split('\n').find(l => l.trim() && !l.trim().startsWith('#'))
    description = firstLine?.trim().slice(0, 120) ?? ''
    warnings.push('missing description frontmatter; derived from body')
  }
  if (!name) {
    name = fallbackName
    warnings.push('missing name frontmatter; derived from file path')
  }

  const dedupedDependsOn = [...new Set(dependsOn.map(dep => dep.trim()).filter(Boolean))]
  return { name, description, body, slash, disableModelInvocation, dependsOn: dedupedDependsOn, warnings }
}

async function readDirEntries(absDir: string): Promise<DirEntry[]> {
  const entries = await invoke<DirEntry[]>('fs_read_dir', { root: absDir, respectGitignore: false })
  return entries ?? []
}

async function readAbsFile(absPath: string): Promise<string> {
  return invoke<string>('fs_read_file', { path: absPath })
}

async function collectSkillCompanions(absDir: string, skillRoot: string, skipPaths: Set<string>): Promise<SkillCompanionFile[]> {
  const entries = (await readDirEntries(absDir)).slice().sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  const companions: SkillCompanionFile[] = []

  for (const entry of entries) {
    if (!entry.name) continue
    const childPath = joinAbsPath(absDir, entry.name)
    const childRelPath = normalizePath(childPath).slice(normalizePath(skillRoot).length + 1)
    if (skipPaths.has(normalizePath(childPath))) continue

    if (entryIsDirectory(entry)) {
      try {
        const childEntries = await readDirEntries(childPath)
        if (childEntries.some(child => child.name?.toUpperCase() === 'SKILL.MD' && !entryIsDirectory(child))) {
          continue
        }
      } catch {
        // Fall through and let recursion handle any readable companion subtrees.
      }
      companions.push(...await collectSkillCompanions(childPath, skillRoot, skipPaths))
      continue
    }

    if (!entry.name.toLowerCase().endsWith('.md')) continue
    try {
      const content = await readAbsFile(childPath)
      if (content?.trim()) {
        companions.push({
          relPath: childRelPath,
          body: parseSkillDoc(content, childPath).body,
        })
      }
    } catch (err) {
      console.warn(`[skills] failed to read companion file ${childPath}:`, err)
    }
  }

  return companions.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

async function loadSkillFolder(absDir: string): Promise<Skill | null> {
  const entries = await readDirEntries(absDir)
  const mainEntry = entries.find(entry => entry.name?.toUpperCase() === 'SKILL.MD' && !entryIsDirectory(entry))
  if (!mainEntry) return null

  const mainPath = joinAbsPath(absDir, mainEntry.name!)
  const content = await readAbsFile(mainPath)
  const parsed = parseSkillDoc(content, mainPath)
  if (parsed.warnings.length > 0) {
    console.warn(`[skills] ${mainPath}: ${parsed.warnings.join('; ')}`)
  }

  const companions = await collectSkillCompanions(absDir, absDir, new Set([normalizePath(mainPath)]))
  return {
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    path: mainPath,
    slash: parsed.slash,
    disableModelInvocation: parsed.disableModelInvocation,
    dependsOn: parsed.dependsOn,
    companionFiles: companions,
  }
}

async function collectSkillsUnderDir(absDir: string): Promise<Skill[]> {
  let entries: DirEntry[] = []
  try {
    entries = await readDirEntries(absDir)
  } catch {
    return []
  }
  entries = entries.slice().sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))

  const skills: Skill[] = []
  for (const entry of entries) {
    if (!entry.name) continue
    const childPath = joinAbsPath(absDir, entry.name)
    if (entryIsDirectory(entry)) {
      const maybeSkill = await loadSkillFolder(childPath)
      if (maybeSkill) {
        skills.push(maybeSkill)
      } else {
        skills.push(...await collectSkillsUnderDir(childPath))
      }
      continue
    }

    if (entry.name.toLowerCase().endsWith('.md')) {
      try {
        const content = await readAbsFile(childPath)
        if (content?.trim()) {
          const parsed = parseSkillDoc(content, childPath)
          if (parsed.warnings.length > 0) {
            console.warn(`[skills] ${childPath}: ${parsed.warnings.join('; ')}`)
          }
          skills.push({
            name: parsed.name,
            description: parsed.description,
            body: parsed.body,
            path: childPath,
            slash: parsed.slash,
            disableModelInvocation: parsed.disableModelInvocation,
            dependsOn: parsed.dependsOn,
          })
        }
      } catch (err) {
        console.warn(`[skills] failed to read legacy skill file ${childPath}:`, err)
      }
    }
  }

  return skills
}

async function resolveSkillGraph(skills: Skill[]): Promise<Skill[]> {
  const byName = new Map(skills.map(skill => [skill.name.toLowerCase(), skill]))
  const ordered: Skill[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (skill: Skill): void => {
    const key = skill.name.toLowerCase()
    if (visited.has(key)) return
    if (visiting.has(key)) {
      console.warn(`[skills] dependency cycle detected at "${skill.name}"`)
      return
    }
    visiting.add(key)
    for (const depName of skill.dependsOn ?? []) {
      const dep = byName.get(depName.toLowerCase())
      if (!dep) {
        console.warn(`[skills] missing dependency "${depName}" required by "${skill.name}"`)
        continue
      }
      visit(dep)
    }
    visiting.delete(key)
    visited.add(key)
    ordered.push(skill)
  }

  for (const skill of skills) visit(skill)
  return ordered
}

async function loadSkillsFromDir(absDir: string): Promise<Skill[]> {
  return collectSkillsUnderDir(absDir)
}

function mergeSkillBodyWithCompanions(skill: Skill): Skill {
  if (!skill.companionFiles?.length) return skill
  const companionBody = skill.companionFiles
    .map(file => `### ${file.relPath}\n\n${file.body.trim()}`)
    .join('\n\n')
  return {
    ...skill,
    body: `${skill.body.trim()}\n\n---\n\n## Companion Files\n\n${companionBody}`.trim(),
  }
}

async function loadCodexSystemSkills(): Promise<Skill[]> {
  try {
    const home = await homeDir()
    const skills = await loadSkillsFromDir(`${home}/.codex/skills/.system`)
    return skills.map(mergeSkillBodyWithCompanions)
  } catch {
    return []
  }
}

function dedupeSkillsByPath(skills: Skill[]): Skill[] {
  const seen = new Set<string>()
  const result: Skill[] = []
  for (const skill of skills) {
    const key = normalizePath(skill.path).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(skill)
  }
  return result
}

export async function loadSkills(projectPath: string): Promise<Skill[]> {
  const cached = skillsCache.get(projectPath)
  if (cached && Date.now() - cached.ts < SKILLS_CACHE_TTL) return cached.skills

  const home = await homeDir()

  const [systemSkills, projectSkills, userSkills] = await Promise.all([
    loadCodexSystemSkills(),
    loadSkillsFromDir(`${projectPath}/.betopia/skills`),
    loadSkillsFromDir(`${home}/.betopia/skills`),
  ])

  const seen = new Set([...systemSkills, ...projectSkills].map(s => s.name.toLowerCase()))
  const merged = [...systemSkills, ...projectSkills, ...userSkills.filter(s => !seen.has(s.name.toLowerCase()))]
  const skills = await resolveSkillGraph(merged)
  skillsCache.set(projectPath, { skills, ts: Date.now() })
  return skills
}

export async function loadPersonalSkills(): Promise<Skill[]> {
  const cacheKey = '__personal_skills__'
  const cached = skillsCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < SKILLS_CACHE_TTL) return cached.skills

  const home = await homeDir()
  const [systemSkills, userSkills] = await Promise.all([
    loadCodexSystemSkills(),
    loadSkillsFromDir(`${home}/.betopia/skills`),
  ])
  const seen = new Set(systemSkills.map(s => s.name.toLowerCase()))
  const skills = await resolveSkillGraph([...systemSkills, ...userSkills.filter(s => !seen.has(s.name.toLowerCase()))])
  skillsCache.set(cacheKey, { skills, ts: Date.now() })
  return skills
}

export async function loadCustomSkillsForSettings(projectPath: string, knownProjectPaths: string[] = []): Promise<Skill[]> {
  const home = await homeDir()
  const uniqueProjectRoots = new Set<string>()
  if (projectPath) uniqueProjectRoots.add(normalizePath(projectPath))
  for (const path of knownProjectPaths) {
    if (path) uniqueProjectRoots.add(normalizePath(path))
  }

  const loaded: Skill[][] = []
  for (const path of uniqueProjectRoots) {
    loaded.push(await loadSkillsFromDir(`${path}/.betopia/skills/custom`))
  }
  loaded.push(await loadSkillsFromDir(`${home}/.betopia/skills/custom`))

  return dedupeSkillsByPath(loaded.flat()).sort((a, b) => a.name.localeCompare(b.name))
}

export function invalidateSkillsCache(projectPath: string): void {
  skillsCache.delete(projectPath)
  skillsCache.delete('__personal_skills__')
}
