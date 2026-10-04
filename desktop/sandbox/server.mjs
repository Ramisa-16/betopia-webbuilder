import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const HOST = process.env.SANDBOX_HOST || '127.0.0.1'
const PORT = Number(process.env.SANDBOX_PORT || 7879)
const API_KEY = process.env.SANDBOX_API_KEY || ''
const DEFAULT_IMAGE = process.env.SANDBOX_IMAGE || 'node:20-alpine'
const DEFAULT_CPU = Math.max(Number(process.env.SANDBOX_DEFAULT_CPU || 1), 0.25)
const DEFAULT_MEMORY_MB = Math.max(Number(process.env.SANDBOX_DEFAULT_MEMORY_MB || 1024), 256)
const DEFAULT_TIMEOUT_SEC = Math.max(Number(process.env.SANDBOX_DEFAULT_TIMEOUT_SEC || 120), 5)
const SESSION_TTL_SEC = Math.max(Number(process.env.SANDBOX_SESSION_TTL_SEC || 3600), 300)
const MAX_REQUEST_BYTES = 2 * 1024 * 1024

const RUNTIME_ROOT = path.resolve(process.env.SANDBOX_RUNTIME_ROOT || path.join(process.cwd(), '.sandbox-runtime'))
const allowedRootsRaw = process.env.SANDBOX_ALLOWED_ROOTS || path.resolve(process.cwd(), '..')
const ALLOWED_ROOTS = allowedRootsRaw
  .split(';')
  .map(v => v.trim())
  .filter(Boolean)
  .map(v => path.resolve(v))

const sessions = new Map()
let dockerCheckedAt = 0
let dockerAvailable = false

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new Error('Payload too large')
    }
  }
  if (!body.trim()) return {}
  return JSON.parse(body)
}

function normalizePath(inputPath) {
  return path.resolve(String(inputPath || ''))
}

function pathInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function isAllowedWorkspace(workspacePath) {
  return ALLOWED_ROOTS.some(root => pathInside(root, workspacePath))
}

function toDockerVolumePath(p) {
  let out = path.resolve(p)
  if (process.platform === 'win32') out = out.replace(/\\/g, '/')
  return out
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000
  const cwd = options.cwd || process.cwd()

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

async function ensureDocker() {
  const now = Date.now()
  if (now - dockerCheckedAt < 10000) {
    if (!dockerAvailable) throw new Error('Docker is not available')
    return
  }

  dockerCheckedAt = now
  try {
    const r = await runProcess('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 12000 })
    dockerAvailable = r.code === 0
  } catch {
    dockerAvailable = false
  }

  if (!dockerAvailable) throw new Error('Docker is not available')
}

function getAuthToken(req) {
  const raw = req.headers.authorization || ''
  if (!raw.startsWith('Bearer ')) return ''
  return raw.slice('Bearer '.length).trim()
}

function requireAuth(req, res) {
  if (!API_KEY) return true
  if (getAuthToken(req) === API_KEY) return true
  json(res, 401, { error: 'Unauthorized' })
  return false
}

function makeSessionId() {
  return crypto.randomBytes(8).toString('hex')
}

function sanitizeCommand(command) {
  const value = String(command || '').trim()
  if (!value) throw new Error('command is required')
  if (value.length > 8000) throw new Error('command is too long')
  return value
}

async function copyWorkspace(sourcePath, targetPath) {
  await fs.mkdir(targetPath, { recursive: true })
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
    preserveTimestamps: false,
  })
}

function containerNameFor(id) {
  return `betopia-sbx-${id}`
}

async function createSession(payload) {
  const workspacePath = normalizePath(payload.workspacePath)
  if (!workspacePath) throw new Error('workspacePath is required')
  if (!existsSync(workspacePath)) throw new Error(`workspacePath does not exist: ${workspacePath}`)
  if (!isAllowedWorkspace(workspacePath)) {
    throw new Error(`workspacePath is outside allowed roots: ${ALLOWED_ROOTS.join(', ')}`)
  }

  await ensureDocker()

  const image = String(payload.image || DEFAULT_IMAGE).trim() || DEFAULT_IMAGE
  const cpuLimit = Math.max(Number(payload.cpuLimit || DEFAULT_CPU), 0.25)
  const memoryMb = Math.max(Number(payload.memoryMb || DEFAULT_MEMORY_MB), 256)
  const allowNetwork = Boolean(payload.allowNetwork)

  const id = makeSessionId()
  const runtimePath = path.join(RUNTIME_ROOT, id)
  const sessionWorkspace = path.join(runtimePath, 'workspace')
  await fs.mkdir(runtimePath, { recursive: true })
  await copyWorkspace(workspacePath, sessionWorkspace)

  const containerName = containerNameFor(id)
  const dockerArgs = [
    'run', '-d',
    '--name', containerName,
    '--workdir', '/workspace',
    '--cpus', String(cpuLimit),
    '--memory', `${Math.round(memoryMb)}m`,
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
  ]

  if (!allowNetwork) dockerArgs.push('--network', 'none')
  dockerArgs.push('-v', `${toDockerVolumePath(sessionWorkspace)}:/workspace`)
  dockerArgs.push(image, 'sh', '-lc', 'sleep infinity')

  const started = await runProcess('docker', dockerArgs, { timeoutMs: 90000 })
  if (started.code !== 0) {
    throw new Error(`Failed to create container: ${started.stderr || started.stdout}`)
  }

  const now = Date.now()
  sessions.set(id, {
    id,
    containerName,
    sourceWorkspace: workspacePath,
    sessionWorkspace,
    runtimePath,
    createdAt: now,
    updatedAt: now,
    allowNetwork,
    image,
  })

  return { sessionId: id }
}

async function destroySession(id, writeBack = false) {
  const session = sessions.get(id)
  if (!session) return false

  sessions.delete(id)

  try {
    await runProcess('docker', ['rm', '-f', session.containerName], { timeoutMs: 30000 })
  } catch {
    // ignore
  }

  if (writeBack) {
    await fs.cp(session.sessionWorkspace, session.sourceWorkspace, {
      recursive: true,
      force: true,
      errorOnExist: false,
      preserveTimestamps: false,
    })
  }

  try {
    await fs.rm(session.runtimePath, { recursive: true, force: true })
  } catch {
    // ignore
  }

  return true
}

async function executeInSession(id, payload) {
  const session = sessions.get(id)
  if (!session) throw new Error('Session not found')

  const command = sanitizeCommand(payload.command)
  const timeoutSec = Math.max(Number(payload.timeoutSec || DEFAULT_TIMEOUT_SEC), 5)
  const started = Date.now()

  const result = await runProcess(
    'docker',
    ['exec', session.containerName, 'sh', '-lc', command],
    { timeoutMs: timeoutSec * 1000 },
  )

  session.updatedAt = Date.now()

  return {
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
  }
}

function cleanupExpiredSessions() {
  const ttlMs = SESSION_TTL_SEC * 1000
  const now = Date.now()
  const expired = []
  for (const [id, session] of sessions.entries()) {
    if (now - session.updatedAt > ttlMs) expired.push(id)
  }
  expired.forEach(id => {
    destroySession(id).catch(() => {})
  })
}

function parseSessionIdFromPath(urlPath) {
  const match = /^\/v1\/sessions\/([^/]+)(?:\/(exec|writeback))?$/.exec(urlPath)
  if (!match) return null
  return {
    id: decodeURIComponent(match[1]),
    action: match[2] || '',
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
  const pathname = url.pathname

  if (req.method === 'GET' && pathname === '/health') {
    return json(res, 200, {
      ok: true,
      host: HOST,
      port: PORT,
      platform: os.platform(),
      sessions: sessions.size,
      allowedRoots: ALLOWED_ROOTS,
    })
  }

  if (!requireAuth(req, res)) return

  try {
    if (req.method === 'POST' && pathname === '/v1/sessions') {
      const payload = await readJson(req)
      const session = await createSession(payload)
      return json(res, 201, session)
    }

    if (req.method === 'GET' && pathname === '/v1/sessions') {
      const items = [...sessions.values()].map(s => ({
        sessionId: s.id,
        image: s.image,
        allowNetwork: s.allowNetwork,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }))
      return json(res, 200, { sessions: items })
    }

    const parsed = parseSessionIdFromPath(pathname)
    if (parsed) {
      const { id, action } = parsed
      if (req.method === 'POST' && action === 'exec') {
        const payload = await readJson(req)
        const result = await executeInSession(id, payload)
        return json(res, 200, result)
      }

      if (req.method === 'POST' && action === 'writeback') {
        const ok = await destroySession(id, true)
        if (!ok) return json(res, 404, { error: 'Session not found' })
        return json(res, 200, { ok: true, writeBack: true })
      }

      if (req.method === 'DELETE' && !action) {
        const writeBack = url.searchParams.get('writeBack') === '1'
        const ok = await destroySession(id, writeBack)
        if (!ok) return json(res, 404, { error: 'Session not found' })
        return json(res, 200, { ok: true, writeBack })
      }
    }

    json(res, 404, { error: 'Not found' })
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) })
  }
})

async function shutdown() {
  for (const id of [...sessions.keys()]) {
    await destroySession(id).catch(() => {})
  }
  server.close(() => process.exit(0))
}

setInterval(cleanupExpiredSessions, 30 * 1000)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await fs.mkdir(RUNTIME_ROOT, { recursive: true })
server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[sandbox] listening on http://${HOST}:${PORT}`)
  // eslint-disable-next-line no-console
  console.log(`[sandbox] allowed roots: ${ALLOWED_ROOTS.join(', ')}`)
})
