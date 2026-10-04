export interface BackendEndpointLike {
  path: string
}

export interface BackendSpecLike {
  endpoints: BackendEndpointLike[]
}

export interface NodeBackendInfo {
  label: 'Node.js'
  command: string
  injectsPort: boolean
  cwd: string
  preferredPort?: number
}

export interface ProjectApiEndpoint {
  method: string
  path: string
}

export const BACKEND_PROBE_PORTS = [8000, 8001, 8002, 5000, 5001, 8888, 9000]
export const BACKEND_CLEANUP_PORTS = [
  3000, 3001, 4000, 4001,
  5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180,
  8000, 8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009,
  8803, 8804,
  8080, 8081, 5000, 5001, 8888, 9000,
]

const ROUTE_TOKEN_IGNORE = new Set([
  'api', 'apis', 'schema', 'schemas', 'docs', 'doc', 'redoc', 'swagger',
  'openapi', 'json', 'v1', 'v2', 'v3', 'admin', 'static', 'media',
])

const ROUTE_SCAN_IGNORE = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'env',
])

export function routeTokensFromPath(path: string): string[] {
  return path
    .replace(/\\/g, '/')
    .replace(/[?].*$/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{[^}]+\}/g, '')
    .replace(/\([^)]*\)/g, '')
    .split('/')
    .map(part => part.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase())
    .filter(part => part.length > 2 && !ROUTE_TOKEN_IGNORE.has(part) && !/^\d+$/.test(part))
}

export function extractRouteTokensFromSource(fileName: string, text: string): Set<string> {
  const tokens = new Set<string>()
  if (!/\.(py|ts|tsx|js|jsx)$/.test(fileName) && !/urls|routes|views|api|controller/i.test(fileName)) {
    return tokens
  }

  const matches = [
    ...text.matchAll(/(?:path|re_path|route|include)\(\s*['"`]([^'"`]+)['"`]/g),
    ...text.matchAll(/(?:router|app)\.(?:get|post|put|patch|delete|head|options)\(\s*['"`]([^'"`]+)['"`]/g),
    ...text.matchAll(/@\w+\.(?:get|post|put|patch|delete|head|options|route)\(\s*['"`]([^'"`]+)['"`]/g),
    ...text.matchAll(/@(?:Get|Post|Put|Patch|Delete|Head|Options|All|Route)\(\s*['"`]([^'"`]+)['"`]/g),
    ...text.matchAll(/@Controller\(\s*['"`]([^'"`]+)['"`]/g),
  ]

  for (const match of matches) {
    for (const token of routeTokensFromPath(match[1] ?? '')) tokens.add(token)
  }

  return tokens
}

function normalizeRoutePath(...parts: string[]): string {
  const cleaned = parts
    .map(part => part.trim().replace(/^['"`]+|['"`]+$/g, ''))
    .filter(Boolean)
    .map(part => part.replace(/^\/+|\/+$/g, ''))
  return `/${cleaned.join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

export function extractProjectApiEndpointsFromSource(fileName: string, text: string): ProjectApiEndpoint[] {
  if (!/\.(py|ts|tsx|js|jsx)$/.test(fileName) && !/urls|routes|views|api|controller/i.test(fileName)) {
    return []
  }

  const endpoints: ProjectApiEndpoint[] = []

  const nestControllers = [...text.matchAll(/@Controller\(\s*['"`]([^'"`]+)['"`]\s*\)/g)].map(m => m[1] ?? '')
  const nestMethods = [...text.matchAll(/@(Get|Post|Put|Patch|Delete|Head|Options|All|Route)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)]
  for (const match of nestMethods) {
    const method = (match[1] ?? 'Get').toLowerCase()
    const route = match[2] ?? ''
    if (nestControllers.length) {
      for (const controller of nestControllers) {
        endpoints.push({ method, path: normalizeRoutePath(controller, route) })
      }
    } else {
      endpoints.push({ method, path: normalizeRoutePath(route) })
    }
  }

  for (const match of text.matchAll(/(?:router|app)\.(get|post|put|patch|delete|head|options)\(\s*['"`]([^'"`]+)['"`]/g)) {
    endpoints.push({ method: (match[1] ?? 'get').toLowerCase(), path: normalizeRoutePath(match[2] ?? '') })
  }

  for (const match of text.matchAll(/(?:path|re_path)\(\s*['"`]([^'"`]+)['"`]/g)) {
    endpoints.push({ method: 'get', path: normalizeRoutePath(match[1] ?? '') })
  }

  return endpoints
}

export async function collectProjectRouteTokens(projectPath: string): Promise<Set<string>> {
  const { readDir, readTextFile } = await import('@tauri-apps/plugin-fs')
  const tokens = new Set<string>()
  const root = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  const stack = [root]
  let visited = 0

  while (stack.length && visited < 400) {
    const dir = stack.pop()!
    let entries: Array<{ name?: string; isDirectory: boolean }> = []
    try { entries = await readDir(dir) } catch { continue }

    for (const entry of entries) {
      if (visited++ >= 400) break
      const name = entry.name ?? ''
      if (!name || ROUTE_SCAN_IGNORE.has(name)) continue
      const full = `${dir}/${name}`
      if (entry.isDirectory) {
        stack.push(full)
        continue
      }
      if (!/\.(py|ts|tsx|js|jsx)$/.test(name) && !/urls|routes|views|api|controller/i.test(name)) continue

      let text = ''
      try { text = await readTextFile(full) } catch { continue }
      for (const token of extractRouteTokensFromSource(name, text)) tokens.add(token)
    }
  }

  return tokens
}

export async function collectProjectApiEndpoints(projectPath: string): Promise<ProjectApiEndpoint[]> {
  const { readDir, readTextFile } = await import('@tauri-apps/plugin-fs')
  const endpoints: ProjectApiEndpoint[] = []
  const seen = new Set<string>()
  const root = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  const stack = [root]
  let visited = 0

  while (stack.length && visited < 400) {
    const dir = stack.pop()!
    let entries: Array<{ name?: string; isDirectory: boolean }> = []
    try { entries = await readDir(dir) } catch { continue }

    for (const entry of entries) {
      if (visited++ >= 400) break
      const name = entry.name ?? ''
      if (!name || ROUTE_SCAN_IGNORE.has(name)) continue
      const full = `${dir}/${name}`
      if (entry.isDirectory) {
        stack.push(full)
        continue
      }
      if (!/\.(py|ts|tsx|js|jsx)$/.test(name) && !/urls|routes|views|api|controller/i.test(name)) continue

      let text = ''
      try { text = await readTextFile(full) } catch { continue }
      for (const endpoint of extractProjectApiEndpointsFromSource(name, text)) {
        const key = `${endpoint.method}:${endpoint.path}`
        if (seen.has(key)) continue
        seen.add(key)
        endpoints.push(endpoint)
      }
    }
  }

  return endpoints
}

function specRouteTokens(spec: BackendSpecLike): Set<string> {
  return new Set(spec.endpoints.flatMap(ep => routeTokensFromPath(ep.path)))
}

export function isSpecForCurrentProject(spec: BackendSpecLike, projectTokens: Set<string>): boolean {
  if (projectTokens.size === 0) return false
  const tokens = specRouteTokens(spec)
  if (tokens.size === 0) return false

  let overlap = 0
  for (const token of tokens) {
    if (projectTokens.has(token)) overlap++
  }

  if (overlap >= 2) return true
  if (overlap === 1 && projectTokens.size <= 2 && tokens.size <= 2) return true
  return false
}

export async function resolveNodeBackendInfo(projectPath: string): Promise<NodeBackendInfo | null> {
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  const isWin = /^[A-Za-z]:[\\/]/.test(projectPath) || projectPath.includes('\\')
  const sep = isWin ? '\\' : '/'
  const join = (...parts: string[]) => parts.join(sep)

  const candidateDirs = [
    projectPath,
    join(projectPath, 'backend'),
    join(projectPath, 'server'),
    join(projectPath, 'api'),
    join(projectPath, 'app'),
    join(projectPath, 'src'),
  ]

  for (const dir of candidateDirs) {
    const pkgPath = join(dir, 'package.json')
    if (!(await exists(pkgPath).catch(() => false))) continue

    let pkgRaw = ''
    try { pkgRaw = await readTextFile(pkgPath) } catch { continue }

    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        scripts?: Record<string, string>
      }
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      const serverDeps = ['express', 'fastify', 'koa', '@hapi/hapi', '@nestjs/core', 'hono']
      const isServer = serverDeps.some(d => d in deps)
      if (!isServer) continue

      const scripts = pkg.scripts ?? {}
      const runScript =
        scripts['start:dev'] ? 'start:dev'
          : scripts.dev ? 'dev'
          : scripts.start ? 'start'
          : scripts['serve:dev'] ? 'serve:dev'
          : scripts.serve ? 'serve'
          : null
      if (!runScript) continue

      const entryDirs = [dir, join(dir, 'src'), join(dir, 'app'), join(dir, 'server')]
      const entryFiles = ['main.ts', 'main.js', 'server.ts', 'server.js', 'index.ts', 'index.js', 'app.ts', 'app.js']
      let preferredPort: number | undefined

      for (const entryDir of entryDirs) {
        for (const file of entryFiles) {
          const entryPath = join(entryDir, file)
          if (!(await exists(entryPath).catch(() => false))) continue
          let text = ''
          try { text = await readTextFile(entryPath) } catch { continue }
          const listenMatch = text.match(/listen\(\s*([\s\S]*?)\)/m)
          const args = listenMatch?.[1] ?? text
          const ports = [...args.matchAll(/\b(\d{2,5})\b/g)].map(m => Number(m[1])).filter(n => Number.isInteger(n) && n > 0 && n < 65536)
          const port = ports.length > 0 ? ports[ports.length - 1] : NaN
          if (Number.isInteger(port) && port > 0 && port < 65536) {
            preferredPort = port
            break
          }
        }
        if (preferredPort) break
      }

      return { label: 'Node.js', command: `npm run ${runScript}`, injectsPort: false, cwd: dir, preferredPort }
    } catch {}
  }

  return null
}
