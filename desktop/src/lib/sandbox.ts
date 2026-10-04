import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import type { SandboxConfig } from './config'

interface SandboxSession {
  sessionId: string
}

interface SandboxExecResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

const sessionCache = new Map<string, string>()

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function cacheKey(projectPath: string, endpoint: string): string {
  return `${trimSlash(endpoint)}|${projectPath}`
}

function authHeaders(cfg: SandboxConfig): Record<string, string> {
  if (!cfg.apiKey.trim()) return {}
  return { Authorization: `Bearer ${cfg.apiKey.trim()}` }
}

async function parseJsonSafe(r: Response): Promise<any> {
  try {
    return await r.json()
  } catch {
    return null
  }
}

async function ensureSession(projectPath: string, cfg: SandboxConfig): Promise<string> {
  const endpoint = trimSlash(cfg.endpoint)
  const key = cacheKey(projectPath, endpoint)
  const existing = sessionCache.get(key)
  if (existing) return existing

  const r = await tauriFetch(`${endpoint}/v1/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(cfg),
    },
    body: JSON.stringify({
      workspacePath: projectPath,
      image: cfg.image,
      cpuLimit: cfg.cpuLimit,
      memoryMb: cfg.memoryMb,
      allowNetwork: cfg.allowNetwork,
    }),
  })

  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(text || `Sandbox session start failed (${r.status})`)
  }

  const payload = (await parseJsonSafe(r)) as SandboxSession | null
  const sessionId = payload?.sessionId
  if (!sessionId) throw new Error('Sandbox session response missing sessionId')
  sessionCache.set(key, sessionId)
  return sessionId
}

async function clearCachedSession(projectPath: string, cfg: SandboxConfig): Promise<void> {
  const endpoint = trimSlash(cfg.endpoint)
  const key = cacheKey(projectPath, endpoint)
  const sessionId = sessionCache.get(key)
  if (!sessionId) return
  sessionCache.delete(key)
  try {
    await tauriFetch(`${endpoint}/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: authHeaders(cfg),
    })
  } catch {
    // ignore cleanup errors
  }
}

export async function runCommandInSandbox(
  projectPath: string,
  command: string,
  cfg: SandboxConfig,
): Promise<SandboxExecResult> {
  const endpoint = trimSlash(cfg.endpoint)
  let sessionId = await ensureSession(projectPath, cfg)

  const execute = async (id: string): Promise<SandboxExecResult> => {
    const r = await tauriFetch(`${endpoint}/v1/sessions/${encodeURIComponent(id)}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(cfg),
      },
      body: JSON.stringify({
        command,
        timeoutSec: cfg.timeoutSec,
      }),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      throw new Error(text || `Sandbox execution failed (${r.status})`)
    }
    const payload = (await parseJsonSafe(r)) as SandboxExecResult | null
    if (!payload) throw new Error('Sandbox returned empty execution payload')
    return payload
  }

  try {
    return await execute(sessionId)
  } catch (err) {
    // Session may be stale (container removed). Retry once with a fresh session.
    await clearCachedSession(projectPath, cfg)
    sessionId = await ensureSession(projectPath, cfg)
    return execute(sessionId)
  }
}
