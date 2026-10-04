import { readTextFile, writeTextFile, mkdir, exists } from '@tauri-apps/plugin-fs'
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
