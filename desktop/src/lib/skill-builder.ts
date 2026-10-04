import type { Skill } from './agent'

export type SkillBuilderMode = 'manual' | 'repo' | 'local'
export type SkillScope = 'project' | 'global'
export type SkillRiskLevel = 'low' | 'medium' | 'high'
export type SkillValidationStatus = 'valid' | 'warning' | 'blocked'

export interface SkillBuilderDraft {
  name: string
  slash: string
  description: string
  body: string
  dependsOn: string[]
  disableModelInvocation: boolean
  folderName: string
  originalPath?: string
  sourceType: SkillBuilderMode
  sourceUrl?: string
  sourcePath?: string
}

export interface SkillValidationReport {
  status: SkillValidationStatus
  riskLevel: SkillRiskLevel
  errors: string[]
  warnings: string[]
  overlaps: Array<{ name: string; path: string; reason: string }>
}

export interface LocalSkillSourceSummary {
  rootPath: string
  topLevelEntries: string[]
  keyFiles: Array<{ path: string; excerpt: string }>
}

export interface RepoSourceFile {
  path: string
  url: string
  body: string
}

export interface GitHubRepoCandidate {
  path: string
  url: string
}

export interface RepoSkillImportCandidate {
  id: string
  name: string
  description: string
  source_path: string
  source_files: RepoSourceFile[]
  fallback: boolean
}

export function nameToFolderName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'
}

export function slashForSkillName(name: string): string {
  return `/${nameToFolderName(name) || 'skill-name'}`
}

function titleCaseFromSlug(value: string): string {
  return value
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
    || 'Imported Skill'
}

export function inferNameFromRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    const treeIdx = parts.indexOf('tree')
    const last = treeIdx >= 0 && parts.length > treeIdx + 2
      ? parts[parts.length - 1]
      : parts[1] ?? parts[parts.length - 1] ?? url.hostname
    return titleCaseFromSlug(last)
  } catch {
    const last = repoUrl.split('/').filter(Boolean).pop() ?? repoUrl
    return titleCaseFromSlug(last)
  }
}

export function createEmptySkillDraft(sourceType: SkillBuilderMode = 'manual'): SkillBuilderDraft {
  return {
    name: '',
    slash: '/new-skill',
    description: '',
    body: '',
    dependsOn: [],
    disableModelInvocation: false,
    folderName: 'new-skill',
    sourceType,
  }
}

export function createManualSkillDraft(input: Partial<SkillBuilderDraft>): SkillBuilderDraft {
  const name = input.name?.trim() ?? ''
  const description = input.description?.trim() ?? ''
  const body = input.body?.trim() ?? ''
  return {
    ...createEmptySkillDraft('manual'),
    ...input,
    name,
    slash: input.slash?.trim() || slashForSkillName(input.folderName || name),
    description,
    body: normalizeManualBody(name, description, body),
    folderName: nameToFolderName(input.folderName || name),
    sourceType: 'manual',
  }
}

export function createRepoSkillDraft(repoUrl: string, intent = '', explicitName = ''): SkillBuilderDraft {
  const name = explicitName.trim() || inferNameFromRepoUrl(repoUrl)
  const description = intent.trim()
    || `Use when the user asks to apply workflows, conventions, or tooling from ${repoUrl}.`
  const body = [
    `# ${name}`,
    '',
    'Use this skill when a task depends on behavior, conventions, commands, or examples from the source repository.',
    '',
    '## Source',
    '',
    `- Repository: ${repoUrl}`,
    '- Import mode: read-only source import',
    '',
    '## Workflow',
    '',
    '1. Inspect the repository documentation, scripts, examples, and existing skill-like files before making changes.',
    '2. Extract only reusable task guidance that helps the current user request.',
    '3. Prefer concise instructions from the repository docs and avoid copying unrelated source content.',
    '4. Validate commands before recommending or running them, especially install, deploy, delete, or credential-related steps.',
    '5. If the repository is private, unavailable, or too large to inspect, ask the user for a local clone or the relevant skill folder.',
    '',
    '## Review Checklist',
    '',
    '- Confirm the skill is not duplicating an existing built-in, project, or personal skill.',
    '- Confirm private repository details stay in the selected scope.',
    '- Confirm unsafe instructions were removed or rewritten before publish.',
  ].join('\n')

  return {
    ...createEmptySkillDraft('repo'),
    name,
    slash: slashForSkillName(name),
    description,
    body,
    folderName: nameToFolderName(name),
    sourceType: 'repo',
    sourceUrl: repoUrl,
  }
}

export function createRepoSkillDraftFromSource(
  repoUrl: string,
  sourceFiles: RepoSourceFile[],
  intent = '',
  explicitName = '',
): SkillBuilderDraft {
  if (sourceFiles.length === 0) return createRepoSkillDraft(repoUrl, intent, explicitName)

  const baseDraft = createRepoSkillDraft(repoUrl, intent, explicitName)
  const imported = sourceFiles.slice(0, 8).map(file => {
    const excerpt = trimSourceExcerpt(file.body)
    return `### ${file.path}\n\n${excerpt}`
  }).join('\n\n')

  const body = [
    `# ${baseDraft.name}`,
    '',
    'Use this skill when a task depends on behavior, workflows, commands, examples, or conventions imported from the source repository.',
    '',
    '## Source',
    '',
    `- Repository: ${repoUrl}`,
    `- Imported files: ${sourceFiles.map(file => file.path).join(', ')}`,
    '- Import mode: read-only public GitHub source inspection',
    '',
    '## Workflow',
    '',
    '1. Apply the imported guidance only when it directly matches the user request.',
    '2. Prefer the source repository workflow, naming, validation steps, and safety constraints over generic assumptions.',
    '3. Before running commands from the imported guidance, verify they fit the current project and do not expose secrets, delete data, or deploy without permission.',
    '4. If the task requires source files not included below, ask the user for the local clone or the specific folder/file.',
    '5. Keep generated changes scoped to the selected project or personal skill scope.',
    '',
    '## Imported Guidance',
    '',
    imported,
    '',
    '## Review Checklist',
    '',
    '- Confirm this skill is not duplicating an existing built-in, project, or personal skill.',
    '- Confirm private repository details stay in the selected scope.',
    '- Confirm unsafe instructions were removed or rewritten before publish.',
  ].join('\n')

  return {
    ...baseDraft,
    body,
  }
}

export function createRepoSkillDraftFromCandidate(
  repoUrl: string,
  candidate: RepoSkillImportCandidate,
  explicitName = '',
): SkillBuilderDraft {
  const draft = createRepoSkillDraftFromSource(
    repoUrl,
    candidate.source_files,
    candidate.description,
    explicitName || candidate.name,
  )
  return {
    ...draft,
    description: candidate.description || draft.description,
    body: draft.body.replace('read-only public GitHub source inspection', 'read-only cloned repository inspection'),
    folderName: nameToFolderName(explicitName || candidate.name),
  }
}

export function createLocalFolderSkillDraft(summary: LocalSkillSourceSummary, intent = ''): SkillBuilderDraft {
  const folder = summary.rootPath.split(/[\\/]/).filter(Boolean).pop() ?? 'local-skill'
  const name = titleCaseFromSlug(folder)
  const keyFiles = summary.keyFiles.length > 0
    ? summary.keyFiles.map(file => `### ${file.path}\n\n${file.excerpt}`).join('\n\n')
    : 'No README or common agent instruction files were found during the first scan.'
  const entries = summary.topLevelEntries.slice(0, 24).map(entry => `- ${entry}`).join('\n') || '- No top-level entries found.'
  const description = intent.trim()
    || `Use when the user asks to apply workflows, conventions, or tooling from ${summary.rootPath}.`
  const body = [
    `# ${name}`,
    '',
    'Use this skill when a task depends on behavior, conventions, commands, or examples from the selected local source folder.',
    '',
    '## Source',
    '',
    `- Local folder: ${summary.rootPath}`,
    '',
    '## Initial Scan',
    '',
    entries,
    '',
    '## Key Source Notes',
    '',
    keyFiles,
    '',
    '## Workflow',
    '',
    '1. Inspect the relevant source files before applying this skill to a task.',
    '2. Use the key source notes as orientation, not as a complete replacement for reading current files.',
    '3. Keep generated instructions scoped to reusable workflows and avoid copying unrelated repository content.',
    '4. Validate commands before recommending or running install, deploy, delete, or credential-related steps.',
  ].join('\n')

  return {
    ...createEmptySkillDraft('local'),
    name,
    slash: slashForSkillName(name),
    description,
    body,
    folderName: nameToFolderName(name),
    sourceType: 'local',
    sourcePath: summary.rootPath,
  }
}

function trimSourceExcerpt(body: string): string {
  const clean = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !line.trim().match(/^<!--.*-->$/))
    .join('\n')
    .trim()
  if (clean.length <= 5_000) return clean
  return `${clean.slice(0, 5_000).trim()}\n\n[Source excerpt trimmed during import.]`
}

export function githubRepoCandidateFiles(repoUrl: string): GitHubRepoCandidate[] {
  const parsed = parseGitHubRepoUrl(repoUrl)
  if (!parsed) return []
  const refs = parsed.ref ? [parsed.ref] : ['main', 'master']
  const candidatePaths = [
    'SKILL.md',
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/README.md',
    'references/README.md',
  ]
  const files: GitHubRepoCandidate[] = []
  for (const ref of refs) {
    for (const filePath of candidatePaths) {
      const fullPath = parsed.basePath ? `${parsed.basePath}/${filePath}` : filePath
      files.push({
        path: fullPath,
        url: `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${ref}/${fullPath}`,
      })
    }
  }
  return files
}

function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string; ref?: string; basePath?: string } | null {
  try {
    const url = new URL(repoUrl)
    if (!url.hostname.toLowerCase().endsWith('github.com')) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/i, '')
    const treeIdx = parts.indexOf('tree')
    if (treeIdx >= 0 && parts.length > treeIdx + 1) {
      return {
        owner,
        repo,
        ref: parts[treeIdx + 1],
        basePath: parts.slice(treeIdx + 2).join('/') || undefined,
      }
    }
    return { owner, repo }
  } catch {
    return null
  }
}

function normalizeManualBody(name: string, description: string, body: string): string {
  if (!body) return ''
  if (/^#\s+/m.test(body)) return body
  const title = name || 'Custom Skill'
  const parts = [`# ${title}`, '']
  if (description) parts.push(description, '')
  parts.push('## Workflow', '', body)
  return parts.join('\n').trim()
}

function yamlValue(value: string): string {
  const clean = value.replace(/\r?\n/g, ' ').trim()
  return /[:#{}\[\],&*?|\-<>=!%@`"']/.test(clean) ? JSON.stringify(clean) : clean
}

export function serializeSkillDraft(draft: SkillBuilderDraft): string {
  const lines = ['---', `name: ${yamlValue(draft.name)}`]
  if (draft.slash.trim()) lines.push(`slash: ${yamlValue(draft.slash.trim())}`)
  if (draft.description.trim()) lines.push(`description: ${yamlValue(draft.description)}`)
  if (draft.dependsOn.length > 0) lines.push(`depends-on: ${draft.dependsOn.join(', ')}`)
  if (draft.disableModelInvocation) lines.push('disable-model-invocation: true')
  lines.push('---', '', draft.body.trim())
  return lines.join('\n')
}

export function validateSkillDraft(draft: SkillBuilderDraft, existingSkills: Skill[]): SkillValidationReport {
  const errors: string[] = []
  const warnings: string[] = []
  const overlaps: SkillValidationReport['overlaps'] = []
  const name = draft.name.trim()
  const slash = draft.slash.trim()
  const folder = nameToFolderName(draft.folderName || name)
  const description = draft.description.trim()
  const body = draft.body.trim()

  if (!name) errors.push('Skill name is required.')
  if (!description) errors.push('When to use / description is required.')
  if (!body) errors.push('Instructions are required.')
  if (!/^\/[a-z0-9-]+$/.test(slash)) errors.push('Slash trigger must start with / and use lowercase letters, numbers, and hyphens only.')
  if (!/^[a-z0-9-]+$/.test(folder)) errors.push('Folder name must use lowercase letters, numbers, and hyphens only.')
  if (body.length > 18_000) warnings.push('Skill body is large. Move long details into references/ before publishing.')
  if (body.length < 80) warnings.push('Instructions are very short. Add concrete workflow steps before publishing.')
  if (draft.sourceType === 'repo' && !isProbablyRepoUrl(draft.sourceUrl ?? '')) errors.push('Enter a valid Git repository URL.')
  if (draft.sourceType === 'local' && !draft.sourcePath) errors.push('Choose a local source folder.')

  const normalizedName = name.toLowerCase()
  const normalizedFolder = folder.toLowerCase()
  for (const skill of existingSkills) {
    const skillName = skill.name.toLowerCase()
    const skillFolder = nameToFolderName(skill.name)
    const skillSlash = (skill.slash?.trim() || slashForSkillName(skill.name)).toLowerCase()
    if (skillName === normalizedName || skillFolder === normalizedFolder || skillSlash === slash.toLowerCase()) {
      overlaps.push({ name: skill.name, path: skill.path, reason: 'Same name or slash trigger.' })
      continue
    }
    if (hasMeaningfulOverlap(description, skill.description)) {
      overlaps.push({ name: skill.name, path: skill.path, reason: 'Similar usage description.' })
    }
  }

  const security = scanSkillBodySecurity(body)
  errors.push(...security.errors)
  warnings.push(...security.warnings)

  if (overlaps.length > 0) warnings.push('A similar skill already exists. Review before publishing a duplicate.')
  const riskLevel: SkillRiskLevel = errors.length > 0 || security.highRisk ? 'high' : warnings.length > 0 || overlaps.length > 0 ? 'medium' : 'low'
  const status: SkillValidationStatus = errors.length > 0 ? 'blocked' : warnings.length > 0 || overlaps.length > 0 ? 'warning' : 'valid'
  return { status, riskLevel, errors, warnings: [...new Set(warnings)], overlaps }
}

function isProbablyRepoUrl(value: string): boolean {
  return /^(https?:\/\/|git@)[^\s]+/i.test(value.trim()) && /(\.git$|github\.com|gitlab\.com|bitbucket\.org|\/[^/\s]+\/[^/\s]+$)/i.test(value.trim())
}

function hasMeaningfulOverlap(a: string, b: string): boolean {
  const wordsA = keywordSet(a)
  const wordsB = keywordSet(b)
  if (wordsA.size < 3 || wordsB.size < 3) return false
  let shared = 0
  for (const word of wordsA) if (wordsB.has(word)) shared++
  return shared >= 3
}

function keywordSet(text: string): Set<string> {
  const stop = new Set(['the', 'and', 'for', 'with', 'when', 'user', 'asks', 'use', 'this', 'that', 'from', 'into'])
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3 && !stop.has(word)))
}

function scanSkillBodySecurity(body: string): { errors: string[]; warnings: string[]; highRisk: boolean } {
  const text = body.toLowerCase()
  const errors: string[] = []
  const warnings: string[] = []
  let highRisk = false

  if (/ignore (all )?(previous|system|developer) instructions/.test(text)) {
    errors.push('Skill contains prompt-injection language that tells the agent to ignore higher-priority instructions.')
    highRisk = true
  }
  if (/\brm\s+-rf\s+(\/|\*)/.test(text) || /\bdel\s+\/[sfq]\s+[a-z]:\\/i.test(body)) {
    errors.push('Skill contains destructive delete commands that must be rewritten before publishing.')
    highRisk = true
  }
  if (/(curl|wget)[^\n|]*\|\s*(sh|bash|python|node)/.test(text)) {
    warnings.push('Skill contains pipe-to-shell install commands. Require explicit user confirmation before use.')
  }
  if (/\bsudo\b/.test(text)) warnings.push('Skill contains privileged commands. Require explicit user confirmation before use.')
  if (/(api[_-]?key|secret|token|password).*(print|echo|log|send|exfiltrate)/.test(text)) {
    errors.push('Skill appears to expose secrets or credentials.')
    highRisk = true
  }

  return { errors, warnings, highRisk }
}
