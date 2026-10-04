import type { CustomSubagentDef } from './subagents'

export interface BuiltinSkill {
  slash: string
  name: string
  description: string
  body: string
  path: string
  order?: number
  disableModelInvocation?: boolean
}

export type SlashSkillOption = {
  slash: string
  name: string
  description: string
  builtin: boolean
  source: 'system' | 'custom' | 'subagent'
  kind: 'skill' | 'subagent'
  body?: string
  path?: string
  clientOnly?: boolean
  subagentId?: string
  writable?: boolean
  disableModelInvocation?: boolean
  activationBody?: string
}

type ClientCommand = SlashSkillOption & {
  activationBody: string
  clientOnly: true
}

type ParsedMarkdownSkill = {
  meta: Record<string, string>
  body: string
}

function parseMarkdownSkill(content: string): ParsedMarkdownSkill {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!fmMatch) return { meta: {}, body: content.trim() }

  const meta: Record<string, string> = {}
  for (const line of fmMatch[1].split('\n')) {
    const match = line.match(/^([\w-]+):\s*(.+)/)
    if (match) meta[match[1]] = match[2].trim()
  }
  return { meta, body: content.slice(fmMatch[0].length).trim() }
}

function getSkillRoot(filePath: string): { root: string; rootIndex: number } | null {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const parts = normalized.split('/').filter(Boolean)
  const idx = parts.findIndex(part => ['builtin-skills', 'Skills', 'skills'].includes(part))
  if (idx < 0 || !parts[idx + 1]) return null
  return { root: parts[idx + 1], rootIndex: idx }
}

function skillRelativePath(filePath: string): string {
  const root = getSkillRoot(filePath)
  if (!root) return filePath
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized.split('/').filter(Boolean).slice(root.rootIndex + 2).join('/')
}

function inferSlash(filePath: string, meta: Record<string, string>): string {
  const explicit = meta.slash?.trim()
  if (explicit) return explicit.startsWith('/') ? explicit : `/${explicit}`
  const root = getSkillRoot(filePath)
  return root ? `/${root.root}` : '/unnamed'
}

function combineSkillBodies(mainBody: string, extraFiles: Array<{ relPath: string; body: string }>): string {
  if (extraFiles.length === 0) return mainBody.trim()
  const extras = extraFiles
    .map(extra => `### ${extra.relPath}\n\n${extra.body.trim()}`)
    .join('\n\n')
  return `${mainBody.trim()}\n\n---\n\n## Companion Files\n\n${extras}`.trim()
}

const builtinSkillModuleMap = import.meta.glob<string>('./builtin-skills/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const projectSkillModuleMap = import.meta.glob<string>('../Skills/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function loadFolderBuiltinSkills(): BuiltinSkill[] {
  const grouped = new Map<string, Array<{ path: string; content: string }>>()

  for (const [path, content] of Object.entries({ ...builtinSkillModuleMap, ...projectSkillModuleMap })) {
    const root = getSkillRoot(path)
    if (!root) continue
    const entries = grouped.get(root.root) ?? []
    entries.push({ path, content })
    grouped.set(root.root, entries)
  }

  const skills: BuiltinSkill[] = []
  for (const [folder, entries] of grouped.entries()) {
    const main = entries.find(entry => /\/SKILL\.md$/i.test(entry.path))
    if (!main) continue

    const parsed = parseMarkdownSkill(main.content)
    const extras = entries
      .filter(entry => entry.path !== main.path)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(entry => ({
        relPath: skillRelativePath(entry.path),
        body: parseMarkdownSkill(entry.content).body,
      }))

    skills.push({
      slash: inferSlash(main.path, parsed.meta),
      name: parsed.meta.name?.trim() || folder,
      description: parsed.meta.description?.trim()
        || parsed.body.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim().slice(0, 120)
        || '',
      body: combineSkillBodies(parsed.body, extras),
      path: main.path,
      order: Number(parsed.meta.order ?? 0) || 0,
      disableModelInvocation: (parsed.meta['disable-model-invocation'] ?? '').toLowerCase() === 'true',
    })
  }

  return skills.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.slash.localeCompare(b.slash))
}

function mergeBuiltinSkills(skills: BuiltinSkill[]): BuiltinSkill[] {
  const bySlash = new Map<string, BuiltinSkill>()
  for (const skill of skills) bySlash.set(skill.slash.toLowerCase(), skill)
  return [...bySlash.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.slash.localeCompare(b.slash))
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [...mergeBuiltinSkills(loadFolderBuiltinSkills())]

export function findBuiltinSkill(slash: string): BuiltinSkill | undefined {
  return BUILTIN_SKILLS.find(s => s.slash.toLowerCase() === slash.toLowerCase())
}

// Client-side commands — toggle config, then optionally send activation context to agent.
export const CLIENT_COMMANDS: ClientCommand[] = [
  {
    slash: '/caveman',
    name: 'Caveman Mode',
    description: 'Toggle terse response style — drops filler, articles, fluff',
    builtin: true,
    source: 'system',
    kind: 'skill',
    clientOnly: true,
    activationBody: `# Caveman Mode — Activated

Respond in ultra-terse style for the rest of this session:
- Drop filler words: just, really, basically, actually, simply, certainly
- Drop articles (a, an, the) where possible
- Fragments OK — complete sentences not required
- Short synonyms: fix not "implement a solution for", big not "extensive"
- Technical terms stay exact. Code blocks unchanged.
- No pleasantries, hedging, or summaries unless asked.

Acknowledge activation now with a single terse line, then await the next task.`,
  },
]

export const CAVEMAN_CLIENT_COMMAND = CLIENT_COMMANDS[0]

export function isCustomSkillPath(path: string | undefined): boolean {
  if (!path) return false
  const normalized = path.replace(/\\/g, '/').toLowerCase().replace(/^\.\//, '')
  return normalized.includes('/.betopia/skills/custom/') || normalized.startsWith('.betopia/skills/custom/')
}

function slashFromSkillName(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `/${slug || 'custom-skill'}`
}

function slashFromSubagentId(id: string): string {
  const slug = id.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `/${slug || 'subagent'}`
}

export function allSlashOptions(
  customSkills: { name: string; description: string; body?: string; path?: string; slash?: string; disableModelInvocation?: boolean }[],
  customSubagents: CustomSubagentDef[] = [],
): SlashSkillOption[] {
  const custom = customSkills.filter(s => !s.disableModelInvocation && isCustomSkillPath(s.path)).map(s => ({
    slash: s.slash?.trim() || slashFromSkillName(s.name),
    name: s.name,
    description: s.description,
    body: s.body,
    path: s.path,
    builtin: false,
    source: 'custom' as const,
    kind: 'skill' as const,
    clientOnly: false,
  }))
  const subagents = customSubagents.map(subagent => ({
    slash: slashFromSubagentId(subagent.id),
    name: subagent.label,
    description: subagent.description,
    body: subagent.systemPrompt,
    path: subagent.sourcePath,
    builtin: false,
    source: 'subagent' as const,
    kind: 'subagent' as const,
    clientOnly: false,
    subagentId: subagent.id,
    writable: subagent.writable,
  }))
  const reservedSlashes = new Set([...custom, ...subagents].map(s => s.slash.toLowerCase()))
  const builtin: SlashSkillOption[] = BUILTIN_SKILLS
    .filter(s => !s.disableModelInvocation && !reservedSlashes.has(s.slash.toLowerCase()))
    .map(s => ({
      slash: s.slash,
      name: s.name,
      description: s.description,
      body: s.body,
      path: s.path,
      builtin: true,
      source: 'system' as const,
      kind: 'skill' as const,
      clientOnly: false,
    }))
  return builtin.concat(custom, subagents)
}
