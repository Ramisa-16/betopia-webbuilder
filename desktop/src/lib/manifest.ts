import type { FileEntry } from '../types'

export interface WorkspaceSummary {
  fileCount: number
  dirCount: number
  htmlCount: number
  jsCount: number
  cssCount: number
  jsonCount: number
  entryFile: string | null
  styleFiles: string[]
}

function getExt(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function walk(entries: FileEntry[], visitor: (entry: FileEntry) => void): void {
  for (const entry of entries) {
    visitor(entry)
    if (entry.is_dir && entry.children?.length) {
      walk(entry.children, visitor)
    }
  }
}

function findEntryFile(entries: FileEntry[]): string | null {
  const entryNames = ['index.html', 'main.html', 'app.html', 'home.html', 'index.jsx', 'main.jsx', 'index.tsx', 'main.tsx']

  for (const name of entryNames) {
    const found = entries.find(e => !e.is_dir && e.name === name)
    if (found) return found.path
  }

  for (const entry of entries) {
    if (entry.is_dir && entry.children?.length) {
      const nested = findEntryFile(entry.children)
      if (nested) return nested
    }
  }

  const first = entries.find(e => !e.is_dir)
  return first?.path ?? null
}

export function getWorkspaceSummary(entries: FileEntry[]): WorkspaceSummary {
  const summary: WorkspaceSummary = {
    fileCount: 0,
    dirCount: 0,
    htmlCount: 0,
    jsCount: 0,
    cssCount: 0,
    jsonCount: 0,
    entryFile: findEntryFile(entries),
    styleFiles: [],
  }

  walk(entries, (entry) => {
    if (entry.is_dir) {
      summary.dirCount += 1
      return
    }

    summary.fileCount += 1
    const ext = getExt(entry.name)
    if (ext === 'html' || ext === 'htm') summary.htmlCount += 1
    if (ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') summary.jsCount += 1
    if (ext === 'css' || ext === 'scss' || ext === 'sass') {
      summary.cssCount += 1
      summary.styleFiles.push(entry.path)
    }
    if (ext === 'json') summary.jsonCount += 1
  })

  return summary
}

export function fileExists(entries: FileEntry[], target: string): boolean {
  let found = false
  walk(entries, (entry) => {
    if (!entry.is_dir && entry.path === target) {
      found = true
    }
  })
  return found
}
