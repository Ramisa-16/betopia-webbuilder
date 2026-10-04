import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { readTextFile, exists } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'

/* ── Types ────────────────────────────────────────────────────────────────── */

interface Props { projectPath: string; serverUrl?: string | null }

interface Parameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  description?: string
  schema?: { type?: string; format?: string; default?: unknown; enum?: unknown[] }
}

interface Endpoint {
  method: string
  path: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Parameter[]
  requestBody?: {
    required?: boolean
    description?: string
    content?: Record<string, { schema?: Record<string, unknown>; example?: unknown }>
  }
  operationId?: string
  responses?: Record<string, { description?: string }>
}

interface ParsedSpec {
  title: string
  version: string
  description?: string
  baseUrl: string
  endpoints: Endpoint[]
  components?: Record<string, unknown>
}

interface TryIt {
  pathParams: Record<string, string>
  queryParams: { key: string; value: string }[]
  headers: { key: string; value: string }[]
  body: string
  contentType: string
}

interface ApiResponse {
  loading: boolean
  status?: number
  statusText?: string
  body?: string
  time?: number
  error?: string
  resHeaders?: Record<string, string>
}

/* ── Constants ────────────────────────────────────────────────────────────── */

const METHOD_COLOR: Record<string, { bg: string; fg: string }> = {
  get:     { bg: '#61affe22', fg: '#61affe' },
  post:    { bg: '#49cc9022', fg: '#49cc90' },
  put:     { bg: '#fca13022', fg: '#fca130' },
  patch:   { bg: '#50e3c222', fg: '#50e3c2' },
  delete:  { bg: '#f93e3e22', fg: '#f93e3e' },
  head:    { bg: '#9012fe22', fg: '#9012fe' },
  options: { bg: '#0d5aa722', fg: '#0d5aa7' },
}

const HTTP_METHODS = ['get','post','put','patch','delete','head','options']

const SERVER_SPEC_PATHS = [
  '/openapi.json', '/openapi.yaml',
  '/api/schema/', '/api/schema/json/',
  '/v3/api-docs/', '/v2/api-docs/',
  '/swagger.json', '/api-docs/', '/api/openapi.json',
]

const LIVE_DOC_PATHS = [
  '/docs', '/redoc', '/swagger-ui', '/swagger-ui.html',
  '/api/docs', '/swagger', '/api-docs/swagger-ui.html',
]

const LOCAL_SPEC_FILES = [
  'openapi.yaml','openapi.yml','openapi.json',
  'swagger.yaml','swagger.yml','swagger.json',
  'api.yaml','api.yml','api.json',
  'docs/openapi.yaml','docs/openapi.json',
]

const AUTO_SCAN_PORTS = [8000, 8080, 8888, 5000, 3000, 3001, 4000, 5173, 8001, 8100, 9000]
const FREE_PORT_CANDIDATES = [8000, 8001, 8002, 8003, 8080, 5000, 5001, 4000, 9000]

/* ── Backend auto-start helpers ──────────────────────────────────────────── */

interface BackendInfo {
  label: string
  command: string   // may contain {PORT} placeholder
  injectsPort: boolean
  cwd?: string      // working dir for the command; defaults to projectPath
}

async function isPortInUse(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(400) })
    return true
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return true
    return false
  }
}

async function findFreePort(): Promise<number> {
  for (const p of FREE_PORT_CANDIDATES) {
    if (!(await isPortInUse(p))) return p
  }
  return 8000
}

async function detectBackend(projectPath: string): Promise<BackendInfo | null> {
  const isWin = /^[A-Za-z]:[\\/]/.test(projectPath) || projectPath.includes('\\')
  const sep = isWin ? '\\' : '/'
  const join = (...parts: string[]) => parts.join(sep)

  const tryRead = async (path: string): Promise<string | null> => {
    try { if (await exists(path)) return await readTextFile(path) } catch {}
    return null
  }
  const fileExists = async (path: string) => exists(path).catch(() => false)

  // Resolve venv: search in given directories for .venv/venv/env (Windows and Unix paths)
  async function resolveVenvBin(...searchRoots: string[]): Promise<{ bin: string; python: string; uvicorn: string } | null> {
    for (const root of searchRoots) {
      for (const venvDir of ['.venv', 'venv', 'env']) {
        const bin = isWin ? join(root, venvDir, 'Scripts') : join(root, venvDir, 'bin')
        const py  = isWin ? join(bin, 'python.exe') : join(bin, 'python')
        if (await fileExists(py)) {
          return {
            bin,
            python:  `"${py}"`,
            uvicorn: isWin ? join(bin, 'uvicorn.exe') : join(bin, 'uvicorn'),
          }
        }
      }
    }
    return null
  }

  // ── Python ──────────────────────────────────────────────────────────────
  // Common backend subdirectories to search — orchestrated projects often put Django/FastAPI here
  const BACKEND_SUBDIRS = ['backend', 'server', 'api', 'app', 'src']

  // Find manage.py: check root first, then each backend subdir
  let djangoRoot: string | null = null
  if (await fileExists(join(projectPath, 'manage.py'))) {
    djangoRoot = projectPath
  } else {
    for (const sub of BACKEND_SUBDIRS) {
      if (await fileExists(join(projectPath, sub, 'manage.py'))) {
        djangoRoot = join(projectPath, sub)
        break
      }
    }
  }

  // Find Python deps: root first, then backend subdir (or the dir with manage.py)
  const depDirs = [projectPath, ...(djangoRoot && djangoRoot !== projectPath ? [djangoRoot] : []), ...BACKEND_SUBDIRS.map(s => join(projectPath, s))]
  let pyDeps: string | null = null
  for (const dir of depDirs) {
    pyDeps = (await tryRead(join(dir, 'requirements.txt')))
          ?? (await tryRead(join(dir, 'pyproject.toml')))
          ?? (await tryRead(join(dir, 'Pipfile')))
    if (pyDeps) break
  }

  // Search for Python entry files at root AND in common subdirectories
  // Returns: { file, content, modulePrefix } e.g. { file:'main.py', content:'...', modulePrefix:'app.' }
  interface PyEntry { file: string; content: string; modulePrefix: string }
  let pyEntry: PyEntry | null = null

  const SEARCH_LOCATIONS = [
    { subdir: '',         prefix: '' },
    { subdir: 'app',      prefix: 'app.' },
    { subdir: 'src',      prefix: 'src.' },
    { subdir: 'api',      prefix: 'api.' },
    { subdir: 'backend',  prefix: 'backend.' },
    { subdir: 'server',   prefix: 'server.' },
  ]

  for (const { subdir, prefix } of SEARCH_LOCATIONS) {
    const dir = subdir ? join(projectPath, subdir) : projectPath
    for (const f of ['main.py', 'app.py', 'server.py', 'api.py', 'run.py']) {
      const c = await tryRead(join(dir, f))
      if (c) { pyEntry = { file: f, content: c, modulePrefix: prefix }; break }
    }
    if (pyEntry) break
  }

  const hasDjangoPy = djangoRoot !== null
  const isPython = !!(pyDeps) || !!(pyEntry) || hasDjangoPy

  if (isPython) {
    // Search for venv in project root AND the directory containing manage.py
    const venv = await resolveVenvBin(projectPath, ...(djangoRoot && djangoRoot !== projectPath ? [djangoRoot] : []))
    const python = venv?.python ?? 'python'

    const allContent = (pyDeps ?? '') + (pyEntry?.content ?? '')
    const hasFastAPI = /fastapi/i.test(allContent) || /from fastapi/i.test(pyEntry?.content ?? '') || /import fastapi/i.test(pyEntry?.content ?? '')
    const hasFlask   = /flask/i.test(allContent)   || /from flask/i.test(pyEntry?.content ?? '')
    const hasDjango  = /django/i.test(allContent)  || hasDjangoPy

    if (hasFastAPI) {
      // Find the FastAPI app — prefer the directory containing main.py as the cwd
      // so that sibling modules (database.py, tools.py …) resolve correctly.
      // Run: cd <entryDir> && uvicorn main:app  (not app.main:app from project root)
      let module = 'main:app'
      let entryCwd = projectPath
      for (const { subdir } of SEARCH_LOCATIONS) {
        const dir = subdir ? join(projectPath, subdir) : projectPath
        let found = false
        for (const f of ['main.py', 'app.py', 'server.py', 'api.py']) {
          const c = await tryRead(join(dir, f))
          if (c && (/FastAPI\s*\(/.test(c) || /from fastapi/i.test(c))) {
            const varMatch = c.match(/^(\w+)\s*=\s*FastAPI\s*\(/m)
            const varName = varMatch ? varMatch[1] : 'app'
            module   = `${f.replace('.py', '')}:${varName}`
            entryCwd = dir   // run uvicorn from here so imports resolve
            found = true; break
          }
        }
        if (found) break
      }
      const uvicornExe = venv?.uvicorn && await fileExists(venv.uvicorn) ? `"${venv.uvicorn}"` : `${python} -m uvicorn`
      // On Windows, PowerShell interprets module:app as a PSDrive — single-quote it
      const moduleArg = isWin ? `'${module}'` : module
      return { label: 'FastAPI', command: `${uvicornExe} ${moduleArg} --host 0.0.0.0 --port {PORT}`, injectsPort: true, cwd: entryCwd }
    }
    if (hasFlask) {
      return { label: 'Flask', command: `${python} -m flask run --port {PORT}`, injectsPort: true }
    }
    if (hasDjango) {
      // Run manage.py from the directory that contains it (may be backend/, server/, etc.)
      const cwd = djangoRoot ?? projectPath
      return { label: 'Django', command: `${python} manage.py runserver {PORT}`, injectsPort: true, cwd }
    }
    if (pyEntry) {
      return { label: 'Python', command: `${python} ${pyEntry.modulePrefix.replace('.', sep)}${pyEntry.file}`, injectsPort: false }
    }
  }

  // ── Node.js ─────────────────────────────────────────────────────────────
  const pkgRaw = await tryRead(join(projectPath, 'package.json'))
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string,string>; devDependencies?: Record<string,string>; scripts?: Record<string,string> }
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      const serverDeps = ['express','fastify','koa','@hapi/hapi','@nestjs/core','hono']
      const isServer = serverDeps.some(d => d in deps)
      const scripts  = pkg.scripts ?? {}
      const runScript = scripts.start ? 'start' : scripts.dev ? 'dev' : null
      if (isServer && runScript) {
        return { label: 'Node.js', command: `npm run ${runScript}`, injectsPort: false }
      }
    } catch {}
  }

  // ── Go ───────────────────────────────────────────────────────────────────
  if (await fileExists(join(projectPath, 'go.mod'))) {
    return { label: 'Go', command: 'go run .', injectsPort: false }
  }

  return null
}

/* ── YAML / JSON parser ───────────────────────────────────────────────────── */

function parseYaml(text: string): Record<string, unknown> {
  try { return JSON.parse(text) as Record<string, unknown> } catch {}
  const lines = text.split('\n')
  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; obj: Record<string, unknown>; key?: string }> = [{ indent: -1, obj: root }]
  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const indent = rawLine.match(/^(\s*)/)![1].length
    const line = rawLine.trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].obj
    if (line.startsWith('- ')) {
      const val = line.slice(2).trim()
      const pk = stack[stack.length - 1].key
      if (pk && Array.isArray(parent[pk])) (parent[pk] as unknown[]).push(val)
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (value === '' || value === '{}' || value === '[]') {
      const child: Record<string, unknown> = value === '[]' ? [] as unknown as Record<string, unknown> : {}
      parent[key] = child
      stack.push({ indent, obj: child, key })
    } else if (value === 'null' || value === '~') { parent[key] = null
    } else if (value === 'true')  { parent[key] = true
    } else if (value === 'false') { parent[key] = false
    } else if (!isNaN(Number(value))) { parent[key] = Number(value)
    } else { parent[key] = value.replace(/^["']|["']$/g, '') }
    stack[stack.length - 1].key = key
  }
  return root
}

/* ── Spec helpers ─────────────────────────────────────────────────────────── */

function extractEndpoints(paths: Record<string, Record<string, unknown>>): Endpoint[] {
  const eps: Endpoint[] = []
  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== 'object' || !pathItem) continue
    const pathParams = (pathItem as Record<string, unknown>).parameters as Parameter[] | undefined
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as Record<string, unknown> | undefined
      if (!op) continue
      const opParams = op.parameters as Parameter[] | undefined
      const allParams = [...(pathParams ?? []), ...(opParams ?? [])]
      eps.push({
        method, path,
        summary:     op.summary as string | undefined,
        description: op.description as string | undefined,
        tags:        Array.isArray(op.tags) ? op.tags as string[] : undefined,
        parameters:  allParams.length ? allParams : undefined,
        requestBody: op.requestBody as Endpoint['requestBody'],
        operationId: op.operationId as string | undefined,
        responses:   op.responses as Record<string, { description?: string }> | undefined,
      })
    }
  }
  return eps
}

function buildSpec(raw: Record<string, unknown>, src: string, fallbackBase: string): ParsedSpec | null {
  try {
    const info    = (raw.info as Record<string, string>) ?? {}
    const paths   = (raw.paths as Record<string, Record<string, unknown>>) ?? {}
    const servers = raw.servers as Array<Record<string, string>> | undefined
    const baseUrl = servers?.[0]?.url || fallbackBase
    // Merge OAS 3.x components + OAS 2.x definitions into one lookup map
    const components = { ...((raw.components as Record<string, unknown>) ?? {}) }
    const definitions = raw.definitions as Record<string, unknown> | undefined
    if (definitions) {
      const schemas = (components.schemas as Record<string, unknown>) ?? {}
      components.schemas = { ...definitions, ...schemas }
    }
    return { title: info.title || src, version: info.version || '1.0', description: info.description, baseUrl, endpoints: extractEndpoints(paths), components }
  } catch { return null }
}

function resolveRef(ref: string, components: Record<string, unknown>): Record<string, unknown> | null {
  // OAS 3.x: "#/components/schemas/Foo" → path starts after "#/components/"
  // OAS 2.x: "#/definitions/Foo"        → mapped into schemas/ during buildSpec
  const OAS3 = '#/components/'
  const OAS2 = '#/definitions/'
  let path: string[]
  if (ref.startsWith(OAS3)) {
    path = ref.slice(OAS3.length).split('/')           // ['schemas','Foo']
  } else if (ref.startsWith(OAS2)) {
    path = ['schemas', ...ref.slice(OAS2.length).split('/')]  // ['schemas','Foo']
  } else {
    return null
  }
  let cur: unknown = components
  for (const part of path) {
    if (typeof cur !== 'object' || cur === null) return null
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'object' && cur !== null ? cur as Record<string, unknown> : null
}

function getPathVars(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
}

function buildRequestUrl(base: string, path: string, pathP: Record<string, string>, queryP: { key: string; value: string }[]): string {
  let url = base.replace(/\/$/, '') + path
  for (const [k, v] of Object.entries(pathP)) if (v) url = url.replace(`{${k}}`, encodeURIComponent(v))
  const qs = queryP.filter(p => p.key && p.value).map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&')
  return qs ? url + '?' + qs : url
}

function buildSampleFromSchema(schema: Record<string, unknown>, components?: Record<string, unknown>, depth = 0): unknown {
  if (!schema || depth > 8) return null

  // Resolve $ref first
  if (schema.$ref && typeof schema.$ref === 'string' && components) {
    const resolved = resolveRef(schema.$ref, components)
    if (resolved) return buildSampleFromSchema(resolved, components, depth + 1)
    return null
  }

  if (schema.example !== undefined) return schema.example

  // anyOf / oneOf — use first non-null branch
  const anyOf = schema.anyOf as Array<Record<string, unknown>> | undefined
  if (anyOf?.length) {
    const branch = anyOf.find(b => b.type !== 'null') ?? anyOf[0]
    return buildSampleFromSchema(branch, components, depth + 1)
  }
  const oneOf = schema.oneOf as Array<Record<string, unknown>> | undefined
  if (oneOf?.length) return buildSampleFromSchema(oneOf[0], components, depth + 1)

  const type = schema.type as string | undefined

  if (type === 'object' || schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined
    if (!props) return {}
    const obj: Record<string, unknown> = {}
    for (const [key, propSchema] of Object.entries(props)) {
      obj[key] = buildSampleFromSchema(propSchema, components, depth + 1)
    }
    return obj
  }

  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined
    return items ? [buildSampleFromSchema(items, components, depth + 1)] : []
  }

  if (type === 'string') {
    if (schema.enum) return (schema.enum as unknown[])[0]
    if (schema.format === 'date-time') return '2024-01-01T00:00:00Z'
    if (schema.format === 'date')      return '2024-01-01'
    if (schema.format === 'email')     return 'user@example.com'
    if (schema.format === 'uuid')      return '00000000-0000-0000-0000-000000000000'
    if (schema.nullable === true)      return null
    return 'string'
  }

  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  if (type === 'null' || schema.nullable === true) return null

  return null
}

function defaultTryIt(ep: Endpoint, components?: Record<string, unknown>): TryIt {
  const pathVars = getPathVars(ep.path)
  const pathParams: Record<string, string> = {}
  for (const v of pathVars) pathParams[v] = ''
  const queryParams = (ep.parameters ?? []).filter(p => p.in === 'query').map(p => ({ key: p.name, value: '' }))
  const hasBody = ['post','put','patch'].includes(ep.method)

  let body = ''
  if (hasBody) {
    const schema = ep.requestBody?.content?.['application/json']?.schema
    if (schema) {
      try {
        const sample = buildSampleFromSchema(schema as Record<string, unknown>, components)
        body = JSON.stringify(sample ?? {}, null, 2)
      } catch { body = '{}' }
    } else {
      body = '{}'
    }
  }

  return { pathParams, queryParams, headers: [{ key: 'Content-Type', value: 'application/json' }], body, contentType: 'application/json' }
}

function groupByTag(eps: Endpoint[]): [string, Endpoint[]][] {
  const map = new Map<string, Endpoint[]>()
  for (const ep of eps) {
    const tag = ep.tags?.[0] ?? 'default'
    if (!map.has(tag)) map.set(tag, [])
    map.get(tag)!.push(ep)
  }
  return [...map.entries()]
}

/* ── Sub-components ───────────────────────────────────────────────────────── */

const S = {
  input: { background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 4, padding: '4px 8px', fontSize: 12, color: 'var(--text)', outline: 'none', width: '100%', fontFamily: 'var(--mono)' } as React.CSSProperties,
  label: { fontSize: 11, color: 'var(--text-3)', marginBottom: 3, display: 'block' } as React.CSSProperties,
  sectionTitle: { fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 8 },
}

function ParamRow({ label, value, onChange, placeholder, required }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <div style={{ minWidth: 120, fontSize: 12, color: required ? 'var(--text)' : 'var(--text-2)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}{required && <span style={{ color: '#f87171', marginLeft: 2 }}>*</span>}
      </div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? label}
        style={{ ...S.input, flex: 1 }}
      />
    </div>
  )
}

function KVRow({ pair, onChange, onRemove }: { pair: { key: string; value: string }; onChange: (p: { key: string; value: string }) => void; onRemove: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 5 }}>
      <input value={pair.key} onChange={e => onChange({ ...pair, key: e.target.value })} placeholder="key" style={{ ...S.input, width: 140, flex: 'none' }} />
      <input value={pair.value} onChange={e => onChange({ ...pair, value: e.target.value })} placeholder="value" style={{ ...S.input, flex: 1 }} />
      <button onClick={onRemove} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}>×</button>
    </div>
  )
}

function ResponseDisplay({ res }: { res: ApiResponse }) {
  if (res.loading) return <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 12 }}>Executing…</div>
  if (res.error) return <div style={{ padding: 12, color: '#f87171', fontSize: 12 }}>{res.error}</div>

  const statusOk = (res.status ?? 0) < 400
  let bodyDisplay = res.body ?? ''
  try { bodyDisplay = JSON.stringify(JSON.parse(bodyDisplay), null, 2) } catch {}

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: statusOk ? '#49cc90' : '#f87171' }}>
          {res.status} {res.statusText}
        </span>
        {res.time != null && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{res.time}ms</span>}
      </div>
      {res.resHeaders && Object.keys(res.resHeaders).length > 0 && (
        <details style={{ marginBottom: 8 }}>
          <summary style={{ fontSize: 11, color: 'var(--text-3)', cursor: 'pointer', userSelect: 'none' }}>Response headers ({Object.keys(res.resHeaders).length})</summary>
          <div style={{ marginTop: 6, padding: '6px 10px', background: 'var(--surface-1)', borderRadius: 4, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>
            {Object.entries(res.resHeaders).map(([k, v]) => (
              <div key={k}><span style={{ color: 'var(--text-3)' }}>{k}: </span>{v}</div>
            ))}
          </div>
        </details>
      )}
      <pre style={{ margin: 0, padding: '10px 12px', background: 'var(--surface-1)', borderRadius: 6, fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)' }}>
        {bodyDisplay || '(empty response)'}
      </pre>
    </div>
  )
}

function EndpointCard({ ep, baseUrl, components }: { ep: Endpoint; baseUrl: string; components?: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const [tryIt, setTryIt] = useState<TryIt>(() => defaultTryIt(ep, components))
  const [response, setResponse] = useState<ApiResponse | null>(null)
  const col = METHOD_COLOR[ep.method] ?? { bg: '#88888822', fg: '#888' }
  const pathVars = getPathVars(ep.path)
  const queryDefs = (ep.parameters ?? []).filter(p => p.in === 'query')
  const hasBody = ['post','put','patch'].includes(ep.method)

  const execute = async () => {
    setResponse({ loading: true })
    const url = buildRequestUrl(baseUrl, ep.path, tryIt.pathParams, tryIt.queryParams)
    const headers: Record<string, string> = {}
    for (const h of tryIt.headers) if (h.key) headers[h.key] = h.value
    const init: RequestInit = { method: ep.method.toUpperCase(), headers }
    if (hasBody && tryIt.body.trim()) init.body = tryIt.body
    const t0 = Date.now()
    try {
      const res = await fetch(url, init)
      const time = Date.now() - t0
      const resHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => { resHeaders[k] = v })
      const body = await res.text()
      setResponse({ loading: false, status: res.status, statusText: res.statusText, body, time, resHeaders })
    } catch (err) {
      setResponse({ loading: false, error: String(err) })
    }
  }

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      {/* Row header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', textAlign: 'left', padding: '9px 14px', background: open ? 'var(--surface-2)' : 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
      >
        <span style={{ fontSize: 11, fontWeight: 800, color: col.fg, background: col.bg, borderRadius: 4, padding: '2px 7px', minWidth: 58, textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.03em', flexShrink: 0 }}>
          {ep.method}
        </span>
        <code style={{ fontSize: 12, color: 'var(--text)', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ep.path}</code>
        {ep.summary && <span style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220, flexShrink: 0 }}>{ep.summary}</span>}
        <span style={{ fontSize: 10, color: 'var(--text-3)', flexShrink: 0, marginLeft: 4 }}>{open ? '▼' : '▶'}</span>
      </button>

      {/* Expanded detail */}
      {open && (
        <div style={{ padding: '14px 16px 16px', background: 'var(--surface-2)', borderTop: '1px solid var(--border)' }}>
          {ep.description && <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.6 }}>{ep.description}</p>}

          {/* Path params */}
          {pathVars.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={S.sectionTitle}>Path Parameters</div>
              {pathVars.map(v => (
                <ParamRow key={v} label={v} required value={tryIt.pathParams[v] ?? ''} onChange={val => setTryIt(t => ({ ...t, pathParams: { ...t.pathParams, [v]: val } }))} />
              ))}
            </div>
          )}

          {/* Query params from spec */}
          {queryDefs.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={S.sectionTitle}>Query Parameters</div>
              {queryDefs.map(p => {
                const idx = tryIt.queryParams.findIndex(q => q.key === p.name)
                const value = idx >= 0 ? tryIt.queryParams[idx].value : ''
                return (
                  <ParamRow
                    key={p.name} label={p.name} required={p.required}
                    placeholder={p.description ?? p.name}
                    value={value}
                    onChange={val => setTryIt(t => {
                      const qp = [...t.queryParams]
                      const i = qp.findIndex(q => q.key === p.name)
                      if (i >= 0) qp[i] = { key: p.name, value: val }
                      else qp.push({ key: p.name, value: val })
                      return { ...t, queryParams: qp }
                    })}
                  />
                )
              })}
            </div>
          )}

          {/* Extra query params */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={S.sectionTitle}>Extra Query Params</div>
              <button onClick={() => setTryIt(t => ({ ...t, queryParams: [...t.queryParams, { key: '', value: '' }] }))}
                style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-3)', fontSize: 11, padding: '1px 7px', cursor: 'pointer' }}>+ Add</button>
            </div>
            {tryIt.queryParams.filter(q => !queryDefs.find(d => d.name === q.key)).map((p, i) => (
              <KVRow key={i} pair={p}
                onChange={np => setTryIt(t => { const a = [...t.queryParams]; a[i] = np; return { ...t, queryParams: a } })}
                onRemove={() => setTryIt(t => { const a = [...t.queryParams]; a.splice(i, 1); return { ...t, queryParams: a } })} />
            ))}
          </div>

          {/* Headers */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={S.sectionTitle}>Headers</div>
              <button onClick={() => setTryIt(t => ({ ...t, headers: [...t.headers, { key: '', value: '' }] }))}
                style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-3)', fontSize: 11, padding: '1px 7px', cursor: 'pointer' }}>+ Add</button>
            </div>
            {tryIt.headers.map((h, i) => (
              <KVRow key={i} pair={h}
                onChange={np => setTryIt(t => { const a = [...t.headers]; a[i] = np; return { ...t, headers: a } })}
                onRemove={() => setTryIt(t => { const a = [...t.headers]; a.splice(i, 1); return { ...t, headers: a } })} />
            ))}
          </div>

          {/* Request body */}
          {hasBody && (
            <div style={{ marginBottom: 14 }}>
              <div style={S.sectionTitle}>Request Body</div>
              {ep.requestBody?.description && <p style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>{ep.requestBody.description}</p>}
              <textarea
                value={tryIt.body}
                onChange={e => setTryIt(t => ({ ...t, body: e.target.value }))}
                rows={6}
                placeholder='{ "key": "value" }'
                spellCheck={false}
                style={{ ...S.input, resize: 'vertical', fontFamily: 'var(--mono)', lineHeight: 1.5 }}
              />
            </div>
          )}

          {/* Execute */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: response ? 0 : 0 }}>
            <div style={{ flex: 1, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {buildRequestUrl(baseUrl, ep.path, tryIt.pathParams, tryIt.queryParams)}
            </div>
            <button
              onClick={execute}
              disabled={response?.loading}
              style={{ background: col.fg, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 18px', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0, opacity: response?.loading ? 0.6 : 1 }}
            >
              Execute
            </button>
          </div>

          {/* Response */}
          {response && <ResponseDisplay res={response} />}
        </div>
      )}
    </div>
  )
}

/* ── Main component ───────────────────────────────────────────────────────── */

export default function ApiDocsPanel({ projectPath, serverUrl }: Props) {
  const [spec, setSpec]             = useState<ParsedSpec | null>(null)
  const [specSrc, setSpecSrc]       = useState<string | null>(null)
  const [loading, setLoading]       = useState(true)
  const [tab, setTab]               = useState<'docs' | 'live'>('docs')
  const [iframeUrl, setIframeUrl]   = useState<string | null>(null)
  const [customUrl, setCustomUrl]   = useState('')
  const [openTags, setOpenTags]     = useState<Set<string>>(new Set())
  const [backendUrl, setBackendUrl] = useState(serverUrl?.replace(/\/$/, '') ?? '')
  const [urlInput, setUrlInput]     = useState(serverUrl?.replace(/\/$/, '') ?? '')
  const [ctxMenu, setCtxMenu]       = useState<{ x: number; y: number } | null>(null)
  const [autoStatus, setAutoStatus] = useState<string>('Scanning for running servers…')
  const ctxTargetRef                = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const procIdRef                   = useRef<string | null>(null)

  // When serverUrl prop changes (server starts), update the input
  useEffect(() => {
    if (serverUrl && !backendUrl) {
      setBackendUrl(serverUrl.replace(/\/$/, ''))
      setUrlInput(serverUrl.replace(/\/$/, ''))
    }
  }, [serverUrl, backendUrl])

  const detect = useCallback(async (overrideBase?: string) => {
    setLoading(true)
    setSpec(null); setSpecSrc(null); setIframeUrl(null)

    const base = (overrideBase ?? backendUrl).replace(/\/$/, '')
    let found = false
    let resolvedBase = base

    // helper: try to fetch spec from a given base URL
    const tryFetchSpec = async (tryBase: string): Promise<ParsedSpec | null> => {
      for (const p of SERVER_SPEC_PATHS) {
        try {
          const res = await fetch(tryBase + p, { signal: AbortSignal.timeout(1500) })
          if (!res.ok) continue
          const ct = res.headers.get('content-type') ?? ''
          const text = await res.text()
          const looksLikeSpec = ct.includes('json') || ct.includes('yaml')
            || text.trim().startsWith('{') || text.trim().startsWith('openapi') || text.trim().startsWith('swagger')
          if (!looksLikeSpec) continue
          const raw = parseYaml(text)
          if (raw?.paths) {
            const parsed = buildSpec(raw, tryBase + p, tryBase)
            if (parsed) return parsed
          }
        } catch {}
      }
      return null
    }

    // 1. Try the user-specified / prop backend URL
    if (base) {
      const parsed = await tryFetchSpec(base)
      if (parsed) { setSpec(parsed); setSpecSrc(base); setTab('docs'); found = true; resolvedBase = base }
    }

    // 2. Auto-scan common localhost ports
    if (!found) {
      for (const port of AUTO_SCAN_PORTS) {
        const tryBase = `http://localhost:${port}`
        if (tryBase === base) continue
        const parsed = await tryFetchSpec(tryBase)
        if (parsed) {
          setSpec(parsed); setSpecSrc(tryBase); setTab('docs')
          found = true; resolvedBase = tryBase
          setBackendUrl(tryBase); setUrlInput(tryBase)
          break
        }
      }
    }

    // 3. Fall back to local spec files in the project directory
    if (!found) {
      for (const rel of LOCAL_SPEC_FILES) {
        const full = projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + rel
        try {
          if (await exists(full)) {
            const text = await readTextFile(full)
            const raw = parseYaml(text)
            if (raw?.paths) {
              const parsed = buildSpec(raw, rel, resolvedBase)
              if (parsed) { setSpec(parsed); setSpecSrc(rel); setTab('docs'); found = true; break }
            }
          }
        } catch {}
      }
    }

    // 4. Try to find a live docs page for the iframe tab
    if (resolvedBase) {
      for (const p of LIVE_DOC_PATHS) {
        try {
          const res = await fetch(resolvedBase + p, { method: 'HEAD', signal: AbortSignal.timeout(1500) })
          if (res.ok) { setIframeUrl(resolvedBase + p); break }
        } catch {}
      }
    }

    setLoading(false)
  }, [projectPath, backendUrl])

  // ── Auto-start backend on project open ──────────────────────────────────
  const autoStart = useCallback(async () => {
    setLoading(true); setSpec(null); setSpecSrc(null); setIframeUrl(null)

    // Inline spec fetcher (same logic as detect's tryFetchSpec)
    const tryBase = async (base: string): Promise<ParsedSpec | null> => {
      for (const p of SERVER_SPEC_PATHS) {
        try {
          const res = await fetch(base + p, { signal: AbortSignal.timeout(1500) })
          if (!res.ok) continue
          const ct = res.headers.get('content-type') ?? ''
          const text = await res.text()
          const ok = ct.includes('json') || ct.includes('yaml')
            || text.trim().startsWith('{') || text.trim().startsWith('openapi') || text.trim().startsWith('swagger')
          if (!ok) continue
          const raw = parseYaml(text)
          if (raw?.paths) return buildSpec(raw, base + p, base)
        } catch {}
      }
      return null
    }

    // ── Phase 1: Scan already-running servers ─────────────────────────────
    setAutoStatus('Scanning for running servers…')
    const portsToScan = backendUrl
      ? [backendUrl, ...AUTO_SCAN_PORTS.map(p => `http://localhost:${p}`).filter(u => u !== backendUrl)]
      : AUTO_SCAN_PORTS.map(p => `http://localhost:${p}`)

    for (const url of portsToScan) {
      const parsed = await tryBase(url)
      if (parsed) {
        setSpec(parsed); setSpecSrc(url); setTab('docs')
        setBackendUrl(url); setUrlInput(url)
        // Also check for live docs
        for (const p of LIVE_DOC_PATHS) {
          try { const r = await fetch(url + p, { method: 'HEAD', signal: AbortSignal.timeout(1000) }); if (r.ok) { setIframeUrl(url + p); break } } catch {}
        }
        setLoading(false); setAutoStatus(''); return
      }
    }

    // ── Phase 2: Check local spec files ──────────────────────────────────
    for (const rel of LOCAL_SPEC_FILES) {
      const full = projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + rel
      try {
        if (await exists(full)) {
          const text = await readTextFile(full)
          const raw = parseYaml(text)
          if (raw?.paths) {
            const parsed = buildSpec(raw, rel, backendUrl)
            if (parsed) { setSpec(parsed); setSpecSrc(rel); setTab('docs'); setLoading(false); setAutoStatus(''); return }
          }
        }
      } catch {}
    }

    // ── Phase 3: Detect & auto-start backend ─────────────────────────────
    setAutoStatus('Detecting backend framework…')
    const info = await detectBackend(projectPath)

    if (!info) { setLoading(false); setAutoStatus('No backend framework detected'); return }

    // Find free port
    const port    = info.injectsPort ? await findFreePort() : 8000
    const cmd     = info.injectsPort ? info.command.replace('{PORT}', String(port)) : info.command
    const entryCwd = info.cwd ?? projectPath   // may be a subdir (e.g. app/)
    const procId  = `api-server-${projectPath.slice(-8).replace(/[^a-z0-9]/gi, '')}`
    procIdRef.current = procId

    // ── Pre-install: install requirements before starting ─────────────────
    const isWin = /^[A-Za-z]:[\\/]/.test(projectPath) || projectPath.includes('\\')
    const pSep  = isWin ? '\\' : '/'
    // Use info.cwd (which may be backend/, server/, etc.) so we find the right requirements.txt
    const backendDir = entryCwd   // already set to info.cwd ?? projectPath
    const reqPath = backendDir.replace(/[/\\]$/, '') + pSep + 'requirements.txt'
    const reqExists = await exists(reqPath).catch(() => false)
    if (reqExists) {
      setAutoStatus(`Installing dependencies for ${info.label}…`)
      // Find pip: search venv in project root AND backend subdir
      let pip = 'pip'
      for (const searchDir of [projectPath, backendDir]) {
        let found = false
        for (const vd of ['.venv', 'venv', 'env']) {
          const pipExe = `${searchDir}${pSep}${vd}${pSep}${isWin ? 'Scripts\\pip.exe' : 'bin/pip'}`
          if (await exists(pipExe).catch(() => false)) { pip = `"${pipExe}"`; found = true; break }
        }
        if (found) break
      }
      try {
        await invoke('shell_run_command', { command: `${pip} install -r requirements.txt`, cwd: backendDir })
      } catch {}
    }

    setAutoStatus(`Starting ${info.label} server on port ${port}…`)
    try {
      await invoke('shell_bg_start', { id: procId, command: cmd, cwd: entryCwd })
    } catch (err) {
      setAutoStatus(`Could not start ${info.label}: ${err}`)
      setLoading(false); return
    }

    // ── Phase 4: Wait for server to respond ───────────────────────────────
    const deadline = Date.now() + 45_000
    let serverPort: number | null = info.injectsPort ? port : null
    let failReason = ''
    let psRetried  = false
    let modRetried = false
    let logOffset  = 0   // skip logs we already acted on after each restart

    while (Date.now() < deadline) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000)
      setAutoStatus(`Waiting for ${info.label} to start… (${remaining}s)`)

      // Check process logs for errors
      try {
        const allLogs = await invoke<string[]>('shell_bg_logs', { id: procId })
        const logs = allLogs.slice(logOffset)   // only look at new lines since last restart

        // Auto-fix: ModuleNotFoundError → install missing package and retry
        const missingMod = logs.find(l => /modulenotfounderror|no module named/i.test(l))
        if (missingMod && !modRetried) {
          modRetried = true
          const match = missingMod.match(/No module named ['"]([^'".\s]+)/i)
          const pkg = match?.[1] ?? null
          if (pkg) {
            setAutoStatus(`Auto-installing missing package: ${pkg}…`)
            let pip = 'pip'
            for (const searchDir of [projectPath, backendDir]) {
              let found = false
              for (const vd of ['.venv', 'venv', 'env']) {
                const pipExe = `${searchDir}${pSep}${vd}${pSep}${isWin ? 'Scripts\\pip.exe' : 'bin/pip'}`
                if (await exists(pipExe).catch(() => false)) { pip = `"${pipExe}"`; found = true; break }
              }
              if (found) break
            }
            try {
              await invoke('shell_run_command', { command: `${pip} install ${pkg}`, cwd: backendDir })
              await invoke('shell_bg_stop', { id: procId }).catch(() => {})
              await new Promise(r => setTimeout(r, 800))
              logOffset = allLogs.length   // skip old logs on next iteration
              await invoke('shell_bg_start', { id: procId, command: cmd, cwd: entryCwd })
              setAutoStatus(`Restarting ${info.label} after installing ${pkg}…`)
              continue
            } catch {}
          }
        }

        // PowerShell parser error → try cmd /c fallback on Windows
        const psError = logs.find(l => /ParserError|ParentContainsError/i.test(l))
        if (psError && isWin && !psRetried) {
          psRetried = true
          const cleanCmd = cmd.replace(/'/g, '')   // strip single-quotes added for PS
          const cmdFallback = `cmd /c ${cleanCmd}`
          setAutoStatus(`Fixing PowerShell quoting issue, retrying…`)
          await invoke('shell_bg_stop', { id: procId }).catch(() => {})
          await new Promise(r => setTimeout(r, 800))
          logOffset = allLogs.length   // skip old error logs on next iteration
          try {
            await invoke('shell_bg_start', { id: procId, command: cmdFallback, cwd: entryCwd })
            continue
          } catch {}
        }

        // Fatal error — exclude lines we already know are auto-fixable
        const isFatal = logs.find(l =>
          /traceback|importerror|error:|failed|address already in use/i.test(l)
          && !/ParserError|ParentContainsError|modulenotfounderror|no module named/i.test(l)
        )
        if (isFatal && !missingMod && !psError) { failReason = isFatal.trim().slice(0, 140); break }
      } catch {}

      if (serverPort !== null) {
        if (await isPortInUse(serverPort)) break
      } else {
        for (const p of AUTO_SCAN_PORTS) {
          if (await isPortInUse(p)) { serverPort = p; break }
        }
        if (serverPort !== null) break
      }
      await new Promise(r => setTimeout(r, 1000))
    }

    if (failReason) {
      setAutoStatus(`${info.label} error: ${failReason}`)
      setLoading(false); return
    }

    if (serverPort === null) {
      setAutoStatus(`${info.label} server started but not responding on port ${port}. Try Scan manually.`)
      setLoading(false); return
    }

    // ── Phase 5: Load API docs ────────────────────────────────────────────
    const url = `http://localhost:${serverPort}`
    setBackendUrl(url); setUrlInput(url)
    setAutoStatus('Loading API docs…')

    // Give the ASGI app a moment to register all routes after the port opens
    await new Promise(r => setTimeout(r, 1500))

    // Retry spec fetch — server may need a few seconds to fully initialize
    let parsed: ParsedSpec | null = null
    for (let attempt = 0; attempt < 5 && !parsed; attempt++) {
      if (attempt > 0) {
        setAutoStatus(`Loading API docs… (attempt ${attempt + 1}/5)`)
        await new Promise(r => setTimeout(r, 2000))
      }
      parsed = await tryBase(url)
    }

    if (parsed) {
      setSpec(parsed); setSpecSrc(url); setTab('docs')
      for (const p of LIVE_DOC_PATHS) {
        try { const r = await fetch(url + p, { method: 'HEAD', signal: AbortSignal.timeout(1000) }); if (r.ok) { setIframeUrl(url + p); break } } catch {}
      }
      setLoading(false); setAutoStatus(''); return
    }

    // Spec JSON not found — try opening the Live Docs iframe (FastAPI /docs, Redoc, etc.)
    for (const p of LIVE_DOC_PATHS) {
      try {
        const r = await fetch(url + p, { method: 'HEAD', signal: AbortSignal.timeout(1500) })
        if (r.ok) {
          setIframeUrl(url + p)
          setTab('live')
          setLoading(false); setAutoStatus(''); return
        }
      } catch {}
    }

    // Server running but no recognisable API docs endpoint found
    setAutoStatus(`${info.label} running on port ${serverPort} — no OpenAPI endpoint found. Enter URL and click Scan.`)
    setLoading(false)
  }, [projectPath, backendUrl])

  // Stop any auto-started backend when project changes
  useEffect(() => {
    return () => {
      if (procIdRef.current) {
        invoke('shell_bg_stop', { id: procIdRef.current }).catch(() => {})
        procIdRef.current = null
      }
    }
  }, [projectPath])

  useEffect(() => { autoStart() }, [projectPath])

  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [ctxMenu])

  const toggleTag = (tag: string) => setOpenTags(prev => {
    const next = new Set(prev)
    if (next.has(tag)) next.delete(tag); else next.add(tag)
    return next
  })

  const handleGo = () => {
    const u = customUrl.trim()
    if (!u) return
    setIframeUrl(u.startsWith('http') ? u : (backendUrl ?? '') + u)
    setTab('live')
  }

  const handleUrlSubmit = () => {
    const u = urlInput.trim()
    if (!u) return
    const normalized = u.startsWith('http') ? u : 'http://' + u
    setBackendUrl(normalized.replace(/\/$/, ''))
    detect(normalized.replace(/\/$/, ''))
  }

  const handleContainerContextMenu = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      e.preventDefault()
      ctxTargetRef.current = el as HTMLInputElement | HTMLTextAreaElement
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
  }

  const ctxCopy = () => {
    ctxTargetRef.current?.focus()
    document.execCommand('copy')
    setCtxMenu(null)
  }

  const ctxCut = () => {
    ctxTargetRef.current?.focus()
    document.execCommand('cut')
    setCtxMenu(null)
  }

  const ctxPaste = async () => {
    const el = ctxTargetRef.current
    if (!el) { setCtxMenu(null); return }
    el.focus()
    try {
      const text = await navigator.clipboard.readText()
      const start = el.selectionStart ?? el.value.length
      const end   = el.selectionEnd   ?? el.value.length
      const newVal = el.value.slice(0, start) + text + el.value.slice(end)
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set
      nativeInputValueSetter?.call(el, newVal)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.setSelectionRange(start + text.length, start + text.length)
    } catch {
      document.execCommand('paste')
    }
    setCtxMenu(null)
  }

  const ctxSelectAll = () => {
    ctxTargetRef.current?.select()
    setCtxMenu(null)
  }

  if (loading) return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', color:'var(--text-3)', fontSize:13, gap:12 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation:'spin 1s linear infinite', color:'var(--accent)' }}>
        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
      </svg>
      <span style={{ fontWeight: 500, color: 'var(--text-2)' }}>{autoStatus || 'Scanning for API docs…'}</span>
      <span style={{ fontSize:11, opacity:0.5, textAlign:'center', maxWidth:280, lineHeight:1.6 }}>
        Scanning ports · Detecting framework · Auto-starting server
      </span>
    </div>
  )

  const CTX_ITEM: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '6px 12px',
    background: 'none', border: 'none', color: 'var(--text)', fontSize: 12,
    cursor: 'pointer', borderRadius: 4, textAlign: 'left',
  }

  return (
    <div
      style={{ display:'flex', flexDirection:'column', height:'100%', background:'var(--bg)', fontSize:13, overflow:'hidden' }}
      onContextMenu={handleContainerContextMenu}
      onClick={() => ctxMenu && setCtxMenu(null)}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>

      {/* ── Context menu portal ── */}
      {ctxMenu && createPortal(
        <div
          onMouseDown={e => e.preventDefault()}
          style={{
            position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 99999,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 4, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            minWidth: 170,
          }}
        >
          {[
            { label: 'Cut',        shortcut: 'Ctrl+X', action: ctxCut },
            { label: 'Copy',       shortcut: 'Ctrl+C', action: ctxCopy },
            { label: 'Paste',      shortcut: 'Ctrl+V', action: ctxPaste },
            null,
            { label: 'Select All', shortcut: 'Ctrl+A', action: ctxSelectAll },
          ].map((item, i) =>
            item === null
              ? <div key={i} style={{ height: 1, background: 'var(--border)', margin: '3px 6px' }} />
              : (
                <button
                  key={item.label}
                  style={CTX_ITEM}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  onClick={item.action}
                >
                  <span style={{ flex: 1 }}>{item.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>{item.shortcut}</span>
                </button>
              )
          )}
        </div>,
        document.body
      )}

      {/* ── Header ── */}
      <div style={{ display:'flex', flexDirection:'column', borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
        {/* Title row */}
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 12px 5px' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          <span style={{ fontWeight:700, fontSize:12, color:'var(--text)' }}>API Documentation</span>
          {spec && <span style={{ fontSize:11, padding:'1px 7px', background:'var(--surface-3)', borderRadius:20, color:'var(--text-3)' }}>v{spec.version}</span>}
          {specSrc && <span style={{ fontSize:11, color:'var(--text-3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:180 }}>· {specSrc}</span>}
          <div style={{ flex:1 }} />
          <button onClick={() => detect()} title="Re-scan" style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', display:'flex', padding:2 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.6"/>
            </svg>
          </button>
        </div>
        {/* Backend URL bar */}
        <div style={{ display:'flex', gap:5, padding:'0 10px 7px' }}>
          <div style={{ flex:1, display:'flex', alignItems:'center', gap:5, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:6, padding:'3px 8px' }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color:'var(--text-3)', flexShrink:0 }}>
              <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
            <input
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleUrlSubmit()}
              placeholder="http://localhost:8000  (your backend server)"
              style={{ flex:1, background:'none', border:'none', outline:'none', fontSize:11, color:'var(--text)', fontFamily:'var(--mono)' }}
            />
          </div>
          <button
            onClick={handleUrlSubmit}
            style={{ background:'var(--accent)', color:'#fff', border:'none', borderRadius:6, padding:'3px 12px', fontSize:11, fontWeight:700, cursor:'pointer', flexShrink:0 }}
          >
            Scan
          </button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display:'flex', borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
        {(['docs','live'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding:'6px 16px', fontSize:12, border:'none', borderBottom: tab===t ? '2px solid var(--accent)' : '2px solid transparent', background:'none', color: tab===t ? 'var(--text)' : 'var(--text-3)', cursor:'pointer', fontWeight: tab===t ? 700 : 400 }}>
            {t === 'docs' ? 'API Explorer' : 'Live Docs'}
          </button>
        ))}
      </div>

      {/* ── API Explorer tab ── */}
      {tab === 'docs' && (
        <div style={{ flex:1, overflow:'auto' }}>
          {spec ? (
            <>
              {/* Spec info bar */}
              <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
                <div style={{ fontSize:15, fontWeight:800, color:'var(--text)', marginBottom:2 }}>{spec.title}</div>
                {spec.description && <p style={{ fontSize:12, color:'var(--text-2)', margin:'4px 0 0', lineHeight:1.5 }}>{spec.description}</p>}
                <div style={{ fontSize:11, color:'var(--text-3)', marginTop:4 }}>
                  Base URL: <code style={{ background:'var(--surface-2)', padding:'1px 5px', borderRadius:3, fontFamily:'var(--mono)' }}>{spec.baseUrl}</code>
                  <span style={{ marginLeft:10 }}>{spec.endpoints.length} endpoints</span>
                </div>
              </div>

              {/* Endpoint groups */}
              {spec.endpoints.length === 0 ? (
                <div style={{ padding:24, color:'var(--text-3)', fontSize:12, textAlign:'center' }}>No endpoints found in spec.</div>
              ) : (
                groupByTag(spec.endpoints).map(([tag, eps]) => (
                  <div key={tag} style={{ borderBottom:'1px solid var(--border)' }}>
                    <button
                      onClick={() => toggleTag(tag)}
                      style={{ width:'100%', textAlign:'left', padding:'10px 14px', background:'var(--surface-2)', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:8, color:'var(--text)', fontWeight:700, fontSize:13 }}
                    >
                      <span style={{ fontSize:9, color:'var(--text-3)' }}>{openTags.has(tag) ? '▼' : '▶'}</span>
                      <span style={{ textTransform:'capitalize' }}>{tag}</span>
                      <span style={{ marginLeft:'auto', fontSize:11, fontWeight:400, color:'var(--text-3)' }}>{eps.length} endpoint{eps.length !== 1 ? 's' : ''}</span>
                    </button>
                    {openTags.has(tag) && eps.map(ep => (
                      <EndpointCard key={`${ep.method}${ep.path}`} ep={ep} baseUrl={spec.baseUrl} components={spec.components} />
                    ))}
                  </div>
                ))
              )}
            </>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, color:'var(--text-3)', padding:32, height:'60%' }}>
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ opacity:0.35 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              <p style={{ textAlign:'center', fontSize:13, margin:0 }}>
                No OpenAPI spec found.
              </p>
              {autoStatus && (
                <p style={{ fontSize:11, color:'var(--accent)', textAlign:'center', margin:0, background:'var(--accent-bg)', padding:'4px 12px', borderRadius:6 }}>
                  {autoStatus}
                </p>
              )}
              <p style={{ fontSize:11, opacity:0.55, textAlign:'center', margin:0, lineHeight:1.7 }}>
                Auto-detection tried: scan running servers → detect framework → auto-start.<br/>
                You can also enter the URL manually above and click <strong>Scan</strong>.
              </p>
              <p style={{ fontSize:11, opacity:0.4, textAlign:'center', margin:0 }}>
                Supports: FastAPI · Flask · Django · Express · Go · local openapi.yaml
              </p>
              <button onClick={() => detect()} style={{ marginTop:4, background:'var(--accent)', color:'#fff', border:'none', borderRadius:6, padding:'6px 18px', fontSize:12, cursor:'pointer', fontWeight:600 }}>
                Scan Again
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Live Docs tab ── */}
      {tab === 'live' && (
        <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
          <div style={{ display:'flex', gap:6, padding:'7px 10px', borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
            <input
              value={customUrl}
              onChange={e => setCustomUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleGo()}
              placeholder={backendUrl ? `${backendUrl}/docs` : 'http://localhost:8000/docs'}
              style={{ flex:1, background:'var(--surface-2)', border:'1px solid var(--border)', borderRadius:5, padding:'4px 9px', fontSize:12, color:'var(--text)', outline:'none' }}
            />
            <button onClick={handleGo} style={{ background:'var(--accent)', color:'#fff', border:'none', borderRadius:5, padding:'4px 12px', fontSize:12, cursor:'pointer', fontWeight:600 }}>Go</button>
          </div>
          {backendUrl && (
            <div style={{ display:'flex', gap:4, flexWrap:'wrap', padding:'5px 10px', borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
              {LIVE_DOC_PATHS.map(p => {
                const url = backendUrl + p
                return (
                  <button key={p} onClick={() => { setIframeUrl(url); setCustomUrl(url) }}
                    style={{ fontSize:11, padding:'2px 9px', borderRadius:4, border:'1px solid var(--border)', background: iframeUrl===url ? 'var(--accent)' : 'var(--surface-3)', color: iframeUrl===url ? '#fff' : 'var(--text-2)', cursor:'pointer' }}>
                    {p}
                  </button>
                )
              })}
            </div>
          )}
          {iframeUrl ? (
            <iframe src={iframeUrl} style={{ flex:1, border:'none', width:'100%' }} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" title="API Docs" />
          ) : (
            <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12, color:'var(--text-3)', padding:24 }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity:0.35 }}>
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p style={{ textAlign:'center', fontSize:13, margin:0 }}>
                {backendUrl ? 'No Swagger/Redoc UI auto-detected. Enter the URL above.' : 'Enter your backend URL above, then click Go.'}
              </p>
              <p style={{ fontSize:11, opacity:0.55, textAlign:'center', margin:0 }}>Common: /docs (FastAPI) · /redoc · /swagger-ui.html (Spring)</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
