import { persistWrite, persistRead } from './persist'
import { readProjectFile, writeProjectFile } from './fs'
import type { FileEntry } from '../types'

export interface CodeHistoryEntry {
  id: string
  timestamp: number
  prompt: string
  snapshotId?: string
}

export interface CodeSnapshotFile {
  path: string
  content: string
}

export interface CodeSnapshot {
  id: string
  files: CodeSnapshotFile[]
}

const LS_KEY    = (p: string) => `betopia:code-history:${p.replace(/[/\\:]/g, '_')}`
const FILE_KEY  = (p: string) => `code_history_${p.replace(/[/\\: ]/g, '_').slice(-80)}.json`
const SNAP_KEY  = (id: string) => `betopia_snapshot_${id}.json`
const MAX = 10

const BINARY_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|pdf|docx?|xlsx?|pptx?|zip|tar|gz|7z|exe|dll|so|dylib|pyc|wasm|ttf|woff2?|eot|mp4|mp3|webm|ogg|wav|bin|dat)$/i
const MAX_FILE_BYTES = 500_000

export function loadCodeHistory(projectPath: string): CodeHistoryEntry[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY(projectPath)) ?? '[]') } catch { return [] }
}

function saveCodeHistory(projectPath: string, entries: CodeHistoryEntry[]) {
  try { localStorage.setItem(LS_KEY(projectPath), JSON.stringify(entries)) } catch {}
  persistWrite(FILE_KEY(projectPath), entries).catch(() => {})
}

export function addCodeHistoryEntry(projectPath: string, prompt: string): string {
  const id = `h-${Date.now().toString(36)}`
  const entry: CodeHistoryEntry = {
    id,
    timestamp: Date.now(),
    prompt: prompt.trim(),
    snapshotId: id,
  }
  const existing = loadCodeHistory(projectPath)
  saveCodeHistory(projectPath, [entry, ...existing].slice(0, MAX))
  return id
}

export async function restoreCodeHistoryFromFile(projectPath: string): Promise<void> {
  if (localStorage.getItem(LS_KEY(projectPath))) return
  const saved = await persistRead<CodeHistoryEntry[]>(FILE_KEY(projectPath))
  if (saved?.length) {
    try { localStorage.setItem(LS_KEY(projectPath), JSON.stringify(saved)) } catch {}
  }
}

function flattenFiles(entries: FileEntry[]): FileEntry[] {
  const result: FileEntry[] = []
  for (const e of entries) {
    if (e.is_dir) {
      if (e.children) result.push(...flattenFiles(e.children))
    } else {
      result.push(e)
    }
  }
  return result
}

export async function saveSnapshot(projectPath: string, fileEntries: FileEntry[], snapshotId: string): Promise<void> {
  const flat = flattenFiles(fileEntries)
  const files: CodeSnapshotFile[] = []
  for (const entry of flat) {
    if (BINARY_EXT.test(entry.name)) continue
    try {
      const content = await readProjectFile(projectPath, entry.path)
      if (content.length > MAX_FILE_BYTES) continue
      files.push({ path: entry.path, content })
    } catch { /* skip unreadable */ }
  }
  await persistWrite(SNAP_KEY(snapshotId), { id: snapshotId, files })
}

export async function loadSnapshot(snapshotId: string): Promise<CodeSnapshot | null> {
  const snap = await persistRead<CodeSnapshot>(SNAP_KEY(snapshotId))
  return snap ?? null
}

export async function loadSnapshotFileContent(snapshotId: string, filePath: string): Promise<string | null> {
  const snap = await loadSnapshot(snapshotId)
  const file = snap?.files?.find(f => f.path === filePath)
  return file?.content ?? null
}

export async function restoreSnapshot(projectPath: string, snapshotId: string): Promise<boolean> {
  const snap = await persistRead<CodeSnapshot>(SNAP_KEY(snapshotId))
  if (!snap?.files?.length) return false
  for (const f of snap.files) {
    try { await writeProjectFile(projectPath, f.path, f.content) } catch { /* skip */ }
  }
  return true
}

export function formatHistoryDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `Today, ${time}`
  if (isYesterday) return `Yesterday, ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${time}`
}
