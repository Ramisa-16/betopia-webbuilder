import { readTextFile, writeTextFile, mkdir, exists, remove } from '@tauri-apps/plugin-fs'
import { appDataDir } from '@tauri-apps/api/path'

let _dir: string | null = null

async function dataDir(): Promise<string> {
  if (_dir) return _dir
  const base = await appDataDir()
  _dir = base.replace(/\\/g, '/').replace(/\/$/, '')
  return _dir
}

export async function persistWrite(name: string, data: unknown): Promise<void> {
  try {
    const dir = await dataDir()
    await mkdir(dir, { recursive: true }).catch(() => {})
    await writeTextFile(`${dir}/${name}`, JSON.stringify(data))
  } catch { /* non-fatal */ }
}

export async function persistRead<T>(name: string): Promise<T | null> {
  try {
    const dir = await dataDir()
    const path = `${dir}/${name}`
    if (!(await exists(path))) return null
    const text = await readTextFile(path)
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

// ── JSONL session files ───────────────────────────────────────────────────────
// One file per session: appDataDir/sessions/<session-id>.jsonl
// Each line = one JSON-encoded Message. Rewriting on sync is <10ms for typical sessions.

async function sessionsDir(): Promise<string> {
  const dir = `${await dataDir()}/sessions`
  await mkdir(dir, { recursive: true }).catch(() => {})
  return dir
}

export async function writeSessionJsonl(sessionId: string, messages: unknown[]): Promise<void> {
  try {
    const dir = await sessionsDir()
    const content = messages.map(m => JSON.stringify(m)).join('\n')
    await writeTextFile(`${dir}/${sessionId}.jsonl`, content)
  } catch { /* non-fatal */ }
}

export async function readSessionJsonl<T>(sessionId: string): Promise<T[] | null> {
  try {
    const dir = await sessionsDir()
    const path = `${dir}/${sessionId}.jsonl`
    if (!(await exists(path))) return null
    const text = await readTextFile(path)
    const results: T[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { results.push(JSON.parse(trimmed) as T) } catch { /* skip malformed line */ }
    }
    return results
  } catch { return null }
}

export async function deleteSessionJsonl(sessionId: string): Promise<void> {
  try {
    const dir = await sessionsDir()
    await remove(`${dir}/${sessionId}.jsonl`).catch(() => {})
  } catch { /* non-fatal */ }
}
