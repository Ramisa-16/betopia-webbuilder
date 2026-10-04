import type { FileEntry } from '@/types'
import { getFileTree, readProjectFile } from '@/lib/fs'
import type {
  LspCompletionResult,
  LspDefinitionTarget,
  LspDiagnostic,
  LspHover,
  LspProjectFile,
} from './types'

type RequestType = 'resetProject' | 'upsertFiles' | 'diagnostics' | 'completion' | 'hover' | 'definition'

interface WorkerResponse<T = unknown> {
  id: number
  ok: boolean
  result?: T
  error?: string
}

const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i
const CONFIG_FILE = /(^|\/)(tsconfig|jsconfig)(\.[^/]*)?\.json$/i
const PACKAGE_FILE = /(^|\/)package\.json$/i
const MAX_PROJECT_FILES = 260
const MAX_FILE_CHARS = 500_000
const MAX_TOTAL_CHARS = 5_000_000

class TypeScriptLspClient {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
  private hydratedProjects = new Set<string>()
  private knownProjects = new Set<string>()
  private hydration = new Map<string, Promise<void>>()

  invalidateProject(projectPath?: string): void {
    if (!projectPath) return
    const key = this.projectKey(projectPath)
    this.hydratedProjects.delete(key)
    this.hydration.delete(key)
    void this.post('resetProject', { projectPath }).catch(() => {})
  }

  async diagnostics(projectPath: string, path: string, content: string): Promise<LspDiagnostic[]> {
    await this.ensureProject(projectPath)
    return this.post<LspDiagnostic[]>('diagnostics', { path, content })
  }

  async completion(projectPath: string, path: string, content: string, offset: number): Promise<LspCompletionResult | null> {
    await this.ensureProject(projectPath)
    return this.post<LspCompletionResult | null>('completion', { path, content, offset })
  }

  async hover(projectPath: string, path: string, content: string, offset: number): Promise<LspHover | null> {
    await this.ensureProject(projectPath)
    return this.post<LspHover | null>('hover', { path, content, offset })
  }

  async definition(projectPath: string, path: string, content: string, offset: number): Promise<LspDefinitionTarget | null> {
    await this.ensureProject(projectPath)
    return this.post<LspDefinitionTarget | null>('definition', { path, content, offset })
  }

  async syncFile(path: string, content: string): Promise<void>
  async syncFile(projectPath: string, path: string, content: string): Promise<void>
  async syncFile(arg1: string, arg2: string, arg3?: string): Promise<void> {
    if (arg3 === undefined) {
      const path = arg1
      const content = arg2
      await this.post('upsertFiles', { files: [{ path, content }] }).catch(() => {})
      return
    }

    const projectPath = arg1
    const path = arg2
    const content = arg3
    await this.ensureProject(projectPath)
    await this.post('upsertFiles', { files: [{ path, content }] }).catch(() => {})
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker
    this.worker = new Worker(new URL('./typescript-service.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      if (response.ok) pending.resolve(response.result)
      else pending.reject(new Error(response.error || 'TypeScript language worker failed'))
    }
    this.worker.onerror = (event) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(event.message || 'TypeScript language worker crashed'))
      }
      this.pending.clear()
      this.worker?.terminate()
      this.worker = null
      this.hydratedProjects.clear()
      this.hydration.clear()
    }
    void this.recoverKnownProjects()
    return this.worker
  }

  private post<T>(type: RequestType, payload: unknown): Promise<T> {
    const worker = this.getWorker()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      worker.postMessage({ id, type, payload })
    })
  }

  private projectKey(projectPath: string): string {
    return projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  private async ensureProject(projectPath: string): Promise<void> {
    const key = this.projectKey(projectPath)
    if (!key || this.hydratedProjects.has(key)) return
    this.knownProjects.add(key)

    const existing = this.hydration.get(key)
    if (existing) return existing

    const task = this.hydrateProject(key)
      .then(() => {
        this.hydratedProjects.add(key)
      })
      .finally(() => {
        this.hydration.delete(key)
      })
    this.hydration.set(key, task)
    return task
  }

  private async recoverKnownProjects(): Promise<void> {
    if (this.knownProjects.size === 0) return
    await Promise.all([...this.knownProjects].map(projectPath => this.ensureProject(projectPath).catch(() => {})))
  }

  private async hydrateProject(projectPath: string): Promise<void> {
    let tree: FileEntry[] = []
    try {
      tree = await getFileTree(projectPath)
    } catch {
      await this.post('resetProject', { projectPath })
      return
    }

    const paths = collectLanguageServiceFiles(tree)
    const loaded: LspProjectFile[] = []
    let totalChars = 0

    for (const path of paths) {
      if (loaded.length >= MAX_PROJECT_FILES || totalChars >= MAX_TOTAL_CHARS) break
      try {
        const content = await readProjectFile(projectPath, path)
        if (content.length > MAX_FILE_CHARS) continue
        totalChars += content.length
        loaded.push({ path, content })
      } catch {
        // Deleted or binary-ish files can disappear while the tree is being hydrated.
      }
    }

    await this.post('resetProject', { projectPath })
    if (loaded.length > 0) await this.post('upsertFiles', { files: loaded })
  }
}

function flattenFiles(entries: FileEntry[], result: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.is_dir) {
      if (entry.children) flattenFiles(entry.children, result)
    } else {
      result.push(entry.path.replace(/\\/g, '/'))
    }
  }
  return result
}

function collectLanguageServiceFiles(entries: FileEntry[]): string[] {
  const all = flattenFiles(entries).filter(path => {
    const lower = path.toLowerCase()
    if (lower.includes('/node_modules/') || lower.includes('/dist/') || lower.includes('/build/') || lower.includes('/.next/')) return false
    if (lower.endsWith('package-lock.json') || lower.endsWith('pnpm-lock.yaml') || lower.endsWith('yarn.lock')) return false
    return SOURCE_EXT.test(path) || CONFIG_FILE.test(path) || PACKAGE_FILE.test(path)
  })

  const configs = all.filter(path => CONFIG_FILE.test(path) || PACKAGE_FILE.test(path))
  const declarations = all.filter(path => /\.d\.[cm]?ts$/i.test(path))
  const sources = all.filter(path => SOURCE_EXT.test(path) && !declarations.includes(path))
  return [...new Set([...configs, ...declarations, ...sources])]
}

const client = new TypeScriptLspClient()

export function getTypeScriptLspClient(): TypeScriptLspClient {
  return client
}

export function invalidateTypeScriptLspProject(projectPath?: string): void {
  client.invalidateProject(projectPath)
}
