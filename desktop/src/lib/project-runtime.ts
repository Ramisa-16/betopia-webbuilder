import { exists as pathExists } from '@tauri-apps/plugin-fs'
import { ensureProjectDir, readProjectFile, writeProjectFile } from './fs'

export type ProjectRuntimeStatus = 'running' | 'stopped'
export type ProjectLiveMode = 'static' | 'runtime' | null

export interface ProjectIdentity {
  version: 1
  projectId: string
  projectPath: string
  projectName: string
  createdAt: string
  updatedAt: string
}

export interface ProjectRuntimeState {
  version: 1
  projectId: string
  projectPath: string
  projectName: string
  status: ProjectRuntimeStatus
  updatedAt: string
  preview?: {
    url?: string | null
    mode?: ProjectLiveMode
    port?: number | null
  }
  backend?: {
    running?: boolean
    entryCwd?: string | null
    command?: string | null
    procId?: string | null
    url?: string | null
    port?: number | null
  }
  watcher?: {
    running?: boolean
  }
}

const PROJECT_META_FILE = '.betopia/project.json'
const PROJECT_RUNTIME_FILE = '.betopia/runtime.json'

function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
}

function projectNameFromPath(path: string): string {
  const normalized = normalizeProjectPath(path)
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? 'project'
}

function hashProjectPath(path: string): string {
  const text = normalizeProjectPath(path).toLowerCase()
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (`00000000${(hash >>> 0).toString(16)}`).slice(-8)
}

function nowIso(): string {
  return new Date().toISOString()
}

function buildIdentity(projectPath: string, existing?: Partial<ProjectIdentity>): ProjectIdentity {
  const normalized = normalizeProjectPath(projectPath)
  const projectName = existing?.projectName || projectNameFromPath(normalized)
  const projectId = existing?.projectId || `betopia-${hashProjectPath(normalized)}`
  return {
    version: 1,
    projectId,
    projectPath: normalized,
    projectName,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  }
}

async function readJsonFile<T>(projectPath: string, relPath: string): Promise<T | null> {
  try {
    const abs = `${normalizeProjectPath(projectPath)}/${relPath}`
    if (!(await pathExists(abs))) return null
    const raw = await readProjectFile(projectPath, relPath)
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function writeJsonFile(projectPath: string, relPath: string, data: unknown): Promise<void> {
  await ensureProjectDir(projectPath)
  await writeProjectFile(projectPath, relPath, `${JSON.stringify(data, null, 2)}\n`)
}

function mergeRuntime(
  base: ProjectRuntimeState | null,
  patch: Partial<ProjectRuntimeState>,
  identity: ProjectIdentity,
): ProjectRuntimeState {
  return {
    version: 1,
    projectId: identity.projectId,
    projectPath: identity.projectPath,
    projectName: identity.projectName,
    status: patch.status ?? base?.status ?? 'stopped',
    updatedAt: nowIso(),
    preview: {
      ...(base?.preview ?? {}),
      ...(patch.preview ?? {}),
    },
    backend: {
      ...(base?.backend ?? {}),
      ...(patch.backend ?? {}),
    },
    watcher: {
      ...(base?.watcher ?? {}),
      ...(patch.watcher ?? {}),
    },
  }
}

export async function ensureProjectIdentity(projectPath: string): Promise<ProjectIdentity> {
  const existing = await readJsonFile<ProjectIdentity>(projectPath, PROJECT_META_FILE)
  const identity = buildIdentity(projectPath, existing ?? undefined)
  await writeJsonFile(projectPath, PROJECT_META_FILE, identity)
  return identity
}

export async function readProjectRuntime(projectPath: string): Promise<ProjectRuntimeState | null> {
  return readJsonFile<ProjectRuntimeState>(projectPath, PROJECT_RUNTIME_FILE)
}

export async function updateProjectRuntime(
  projectPath: string,
  patch: Partial<ProjectRuntimeState>,
): Promise<ProjectRuntimeState> {
  const identity = await ensureProjectIdentity(projectPath)
  const existing = await readProjectRuntime(projectPath)
  const next = mergeRuntime(existing, patch, identity)
  await writeJsonFile(projectPath, PROJECT_RUNTIME_FILE, next)
  return next
}

export async function markProjectRunning(
  projectPath: string,
  patch: Partial<ProjectRuntimeState> = {},
): Promise<ProjectRuntimeState> {
  return updateProjectRuntime(projectPath, { ...patch, status: 'running' })
}

export async function markProjectStopped(
  projectPath: string,
  patch: Partial<ProjectRuntimeState> = {},
): Promise<ProjectRuntimeState> {
  return updateProjectRuntime(projectPath, { ...patch, status: 'stopped' })
}
