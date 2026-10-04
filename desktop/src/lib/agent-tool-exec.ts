import { invoke } from '@tauri-apps/api/core'
import { getConfig } from './config'
import { readProjectFile, writeProjectFile, getFileTree } from './fs'
import { runCommandInSandbox } from './sandbox'
import { IS_WINDOWS } from './platform'
import { raceTimeout } from './agent-types'
import {
  normalizeEscapedMultiline,
  getUnsafeProjectPathReason,
  unsafeProjectPathResult,
  resolveEditList,
  applyEditListToContent,
} from './agent-tool-valid'
import { invalidateMemoryCache } from './agent-project'
import { getTypeScriptLspClient, invalidateTypeScriptLspProject } from './lsp/typescript-client'

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractServerPort(command: string): number {
  const m = command.match(/--port[=\s]+(\d+)|:(\d+)\b/)
  if (m) return parseInt(m[1] ?? m[2])
  if (/runserver|django|uvicorn/.test(command)) return 8000
  return 5173 // vite / npm run dev default
}

function projectPathJoin(projectPath: string, relPath: string): string {
  if (relPath === '.' || relPath === '') return projectPath
  return `${projectPath}/${relPath}`.replace(/\/+/g, '/')
}

function unsafePathError(path: unknown): string | null {
  const value = String(path ?? '')
  return getUnsafeProjectPathReason(value) ? unsafeProjectPathResult(value) : null
}

// ── Built-in tool executor ────────────────────────────────────────────────────

const SMALL_OUTPUT_MAX_WRITE_LINES = 80

function countMeaningfulLines(content: string): number {
  return content.split('\n').reduce((count, line) => count + (line.trim().length > 0 ? 1 : 0), 0)
}

export async function executeBuiltinTool(
  projectPath: string,
  name: string,
  argsJson: string,
  onFilesChanged: () => Promise<void>,
  onPermissionRequest?: (tool: string, args: string) => Promise<boolean>,
  onServerStarted?: (url: string) => void,
  onProgress?: (progress: string) => void,
  smallOutput?: boolean,
): Promise<string> {
  let args: Record<string, any>
  try {
    let parsed = JSON.parse(argsJson)
    // Handle double-encoded args: some models send arguments as a JSON-encoded string
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed) } catch { /* use as-is */ }
    }
    args = parsed as Record<string, any>
  } catch { return 'Error: invalid tool arguments JSON' }

  // Normalize edits field: some models send edits as a JSON-encoded string instead of array
  if (args.edits && typeof args.edits === 'string') {
    try { args.edits = JSON.parse(args.edits) } catch { /* leave as-is, executor will report error */ }
  }

  try {
    if (name === 'write_file') {
      const { path, content } = args
      if (!path || content === undefined) return 'Error: path and content required'
      const unsafeReason = getUnsafeProjectPathReason(String(path))
      if (unsafeReason) return unsafeProjectPathResult(String(path))
      const normalizedContent = normalizeEscapedMultiline(content)
      if (smallOutput) {
        const lineCount = countMeaningfulLines(normalizedContent)
        if (lineCount > SMALL_OUTPUT_MAX_WRITE_LINES) {
          return `Error: content is ${lineCount} non-empty lines, over the ${SMALL_OUTPUT_MAX_WRITE_LINES}-line limit for this model. Write a skeleton first (structure + stubs, ≤ 50 lines), then use the edit tool to fill each section in separate calls.`
        }
      }
      if (onPermissionRequest) {
        const allowed = await onPermissionRequest('write_file', argsJson)
        if (!allowed) return `Permission denied: user declined to write ${path}`
      }
      await writeProjectFile(projectPath, path, normalizedContent)
      await getTypeScriptLspClient().syncFile(projectPath, path, normalizedContent)
      await onFilesChanged()
      return `File written: ${path}`
    }

    if (name === 'edit') {
      const { path, old_string, new_string, edits } = args
      if (!path) return 'Error: path required'
      const unsafeReason = getUnsafeProjectPathReason(String(path))
      if (unsafeReason) return unsafeProjectPathResult(String(path))
      if (onPermissionRequest) {
        const allowed = await onPermissionRequest('edit', argsJson)
        if (!allowed) return `Permission denied: user declined to edit ${path}`
      }

      const editList = resolveEditList({ ...args, old_string, new_string, edits })
      if (!editList) return 'Error: provide either edits:[{old_string, new_string}] array or old_string + new_string'

      const rawContent = await readProjectFile(projectPath, path)
      const applied = applyEditListToContent(rawContent, editList)
      if ('error' in applied) return applied.error

      if (onProgress) {
        const origLines = rawContent.split('\n').length
        const newLines = applied.content.split('\n').length
        const delta = newLines - origLines
        const sign = delta >= 0 ? `+${delta}` : `${delta}`
        onProgress(`${sign} lines`)
      }
      await writeProjectFile(projectPath, path, applied.content)
      await getTypeScriptLspClient().syncFile(projectPath, path, applied.content)
      await onFilesChanged()
      return editList.length > 1 ? `File edited: ${path} (${editList.length} changes applied)` : `File edited: ${path}`
    }

    if (name === 'delete_file') {
      const { path } = args
      if (!path) return 'Error: path required'
      const unsafeReason = getUnsafeProjectPathReason(String(path))
      if (unsafeReason) return unsafeProjectPathResult(String(path))
      if (onPermissionRequest) {
        const allowed = await onPermissionRequest('delete_file', argsJson)
        if (!allowed) return `Permission denied: user declined to delete ${path}`
      }
      try {
        const fullPath = path === '.' ? projectPath : `${projectPath}/${path}`.replace(/\/+/g, '/')
        await invoke('fs_delete', { path: fullPath })
        invalidateTypeScriptLspProject(projectPath)
        await onFilesChanged()
        return `Deleted: ${path}`
      } catch (err) {
        return `Error deleting: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'rename_file') {
      const { from, to } = args
      if (!from || !to) return 'Error: from and to paths required'
      const unsafeFromReason = getUnsafeProjectPathReason(String(from))
      if (unsafeFromReason) return unsafeProjectPathResult(String(from))
      const unsafeToReason = getUnsafeProjectPathReason(String(to))
      if (unsafeToReason) return unsafeProjectPathResult(String(to))
      if (onPermissionRequest) {
        const allowed = await onPermissionRequest('rename_file', argsJson)
        if (!allowed) return `Permission denied: user declined to rename ${from}`
      }
      try {
        const abs = (p: string) => `${projectPath}/${p}`.replace(/\/+/g, '/')
        await invoke('fs_rename', { from: abs(from), to: abs(to) })
        invalidateTypeScriptLspProject(projectPath)
        await onFilesChanged()
        return `Renamed: ${from} → ${to}`
      } catch (err) {
        return `Error renaming: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'view_file') {
      const VIEW_MAX_LINES = 2000
      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.avif'])
      const { path, start_line, end_line } = args
      if (!path) return 'Error: path required'
      const unsafeReason = unsafePathError(path)
      if (unsafeReason) return unsafeReason

      const ext = path.includes('.') ? `.${path.split('.').pop()!.toLowerCase()}` : ''
      if (IMAGE_EXTS.has(ext)) {
        try {
          const bytes = await invoke<number[]>('fs_read_file_bytes', {
            path: projectPathJoin(projectPath, path),
          })
          const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.avif': 'image/avif' }
          const mime = mimeMap[ext] ?? 'image/png'
          const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes as unknown as ArrayBuffer)))
          return `__IMAGE_DATA__:data:${mime};base64,${b64}`
        } catch (err) {
          return `Error reading image: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      const content = await readProjectFile(projectPath, path)
      const lines = content.split('\n')
      const start = Math.max(0, (start_line || 1) - 1)
      const end = end_line !== undefined ? Math.min(end_line, lines.length) : lines.length
      const slice = lines.slice(start, end)
      if (slice.length > VIEW_MAX_LINES) {
        const shown = slice.slice(0, VIEW_MAX_LINES)
        const nextLine = start + VIEW_MAX_LINES + 1
        return shown.join('\n') + `\n\n[File truncated at line ${start + VIEW_MAX_LINES}. Use start_line=${nextLine} to continue reading.]`
      }
      return slice.join('\n')
    }

    if (name === 'list_files') {
      const tree = await getFileTree(projectPath)
      const flatten = (entries: any[], indent = 0): string =>
        entries.map(e =>
          '  '.repeat(indent) + (e.is_dir ? '📁 ' : '📄 ') + e.name +
          (e.is_dir && e.children ? '\n' + flatten(e.children, indent + 1) : ''),
        ).join('\n')
      return flatten(tree) || '(empty project)'
    }

    if (name === 'list_dir') {
      const { path = '.' } = args
      const unsafeReason = unsafePathError(path)
      if (unsafeReason) return unsafeReason
      const abs = projectPathJoin(projectPath, path)
      try {
        const { readDir } = await import('@tauri-apps/plugin-fs')
        const entries = await readDir(abs)
        return entries.map((e: any) => (e.isDirectory ? '📁 ' : '📄 ') + e.name).join('\n') || '(empty)'
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'read_files') {
      const { path = '.', max_files = 100 } = args
      const unsafeReason = unsafePathError(path)
      if (unsafeReason) return unsafeReason
      const tree = await getFileTree(projectPath)
      const results: Array<{ path: string; content: string }> = []

      const filterByPath = (entries: any[], targetPath: string): any[] => {
        if (targetPath === '.' || targetPath === '') return entries
        const parts = targetPath.split('/').filter(Boolean)
        let current = entries
        for (const part of parts) {
          const found = current.find(e => e.name === part && e.is_dir)
          if (!found) return []
          current = found.children || []
        }
        return current
      }

      const collectFiles = async (entries: any[]) => {
        if (results.length >= max_files) return
        for (const e of entries) {
          if (results.length >= max_files) break
          if (e.is_dir && e.children) {
            await collectFiles(e.children)
          } else {
            try {
              const content = await readProjectFile(projectPath, e.path)
              results.push({ path: e.path, content })
            } catch (err) {
              console.warn(`[read_files] skipped unreadable file "${e.path}":`, err instanceof Error ? err.message : err)
            }
          }
        }
      }

      const filteredEntries = filterByPath(tree, path)
      await collectFiles(filteredEntries)

      if (results.length === 0) return '(no files found)'
      return results.map(f => `📄 ${f.path}\n${'─'.repeat(40)}\n${f.content}`).join('\n\n')
    }

    if (name === 'project_structure') {
      const tree = await raceTimeout(getFileTree(projectPath), 'project_structure')

      const countFiles = (entries: any[]): { files: number; dirs: number } => {
        let files = 0, dirs = 0
        for (const e of entries) {
          if (e.is_dir) {
            dirs++
            if (e.children) {
              const c = countFiles(e.children)
              files += c.files
              dirs += c.dirs
            }
          } else {
            files++
          }
        }
        return { files, dirs }
      }

      const findEntryPoints = (entries: any[]): string[] => {
        const entryPoints: string[] = []
        const search = (entries: any[], prefix = '') => {
          for (const e of entries) {
            const fullPath = prefix ? `${prefix}/${e.name}` : e.name
            if (!e.is_dir && (e.name === 'index.html' || e.name === 'main.tsx' || e.name === 'main.ts' || e.name === 'app.tsx' || e.name === 'index.jsx' || e.name === 'index.tsx')) {
              entryPoints.push(fullPath)
            }
            if (e.is_dir && e.children) {
              search(e.children, fullPath)
            }
          }
        }
        search(entries)
        return entryPoints
      }

      const { files, dirs } = countFiles(tree)
      const entryPoints = findEntryPoints(tree)

      const flatten = (entries: any[], indent = 0, maxDepth = 2): string => {
        if (indent > maxDepth) return '...'
        return entries.map(e =>
          '  '.repeat(indent) + (e.is_dir ? '📁 ' : '📄 ') + e.name +
          (e.is_dir && e.children ? '\n' + flatten(e.children, indent + 1, maxDepth) : ''),
        ).join('\n')
      }

      return `Project Structure:
Files: ${files}, Directories: ${dirs}
Entry Points: ${entryPoints.length > 0 ? entryPoints.join(', ') : 'none found'}

Tree (2 levels deep):
${flatten(tree)}`
    }

    if (name === 'read_with_deps') {
      const { path } = args
      if (!path) return 'Error: path required'
      const unsafeReason = unsafePathError(path)
      if (unsafeReason) return unsafeReason

      try {
        const content = await raceTimeout(readProjectFile(projectPath, path), 'read_with_deps')
        const results = [{ path, content }]

        const deps = new Set<string>()
        const fileDir = path.split('/').slice(0, -1).join('/')

        const resolveDep = (raw: string): string | null => {
          if (raw.startsWith('http') || raw.startsWith('//') || raw.startsWith('/')) return null
          if (!raw.startsWith('.')) return null
          let dep = raw.startsWith('./') ? raw.slice(2) : raw
          if (fileDir) dep = fileDir + '/' + dep
          dep = dep.replace(/[^/]+\/\.\.\//g, '').replace(/^\.\.\//g, '')
          return dep
        }

        for (const m of content.matchAll(/href=["']([^"']*\.css)['"]/g)) {
          const d = resolveDep(m[1]); if (d) deps.add(d)
        }
        for (const m of content.matchAll(/src=["']([^"']*\.(js|jsx|ts|tsx))['"]/g)) {
          const d = resolveDep(m[1]); if (d) deps.add(d)
        }
        for (const m of content.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)) {
          const d = resolveDep(m[1]); if (d) deps.add(d)
        }
        for (const m of content.matchAll(/@import\s+["']([^"']+)['"]/g)) {
          const d = resolveDep(m[1]); if (d) deps.add(d)
        }

        let depCount = 0
        for (const dep of deps) {
          if (depCount >= 10) break
          if (unsafePathError(dep)) continue
          try {
            const depContent = await readProjectFile(projectPath, dep)
            results.push({ path: dep, content: depContent })
            depCount++
          } catch { /* skip unresolvable */ }
        }

        return results.map(f => `📄 ${f.path}\n${'─'.repeat(50)}\n${f.content}`).join('\n\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'grep_search') {
      const { query } = args
      if (!query) return 'Error: query required'
      try {
        const GREP_MAX = 100
        const matches = await raceTimeout(
          invoke<Array<{ path: string; line: number; text: string }>>('fs_grep', {
            root: projectPath,
            pattern: query,
            case_sensitive: false,
            max_results: GREP_MAX,
          }),
          'grep_search',
        )
        if (matches.length === 0) return 'No matches found'
        const lines = matches.map(m => `${m.path}:${m.line}: ${m.text.trim()}`).join('\n')
        if (matches.length === GREP_MAX) {
          return lines + `\n\n[Showing first ${GREP_MAX} matches — results may be incomplete. Use a more specific pattern to narrow results.]`
        }
        return lines
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'bash') {
      const { command, run_in_background } = args
      if (!command) return 'Error: command required'
      if (onPermissionRequest) {
        const allowed = await onPermissionRequest('bash', argsJson)
        if (!allowed) return `Permission denied: user declined to run: ${command}`
      }

      const isServer = run_in_background === true || /npm run dev|npm start|npm run start|npx vite|vite\b|runserver|--watch|uvicorn|nodemon|next dev|gatsby develop/.test(command)

      const cfg = getConfig()
      if (cfg.sandbox?.enabled && !isServer) {
        try {
          const result = await runCommandInSandbox(projectPath, command, cfg.sandbox)
          const out = result.stdout ?? ''
          const err = result.stderr ?? ''
          if (result.timedOut) return `Error: sandbox timed out after ${cfg.sandbox.timeoutSec}s\n${err || out}`
          if (result.exitCode !== 0) return `Error (code ${result.exitCode}):\n${err || out}`
          return out || 'OK'
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      if (isServer) {
        let effectiveCommand = command
        if (!IS_WINDOWS && !command.includes('--host')) {
          if (/npx\s+vite\b/.test(command) || /bunx\s+vite\b/.test(command)) {
            effectiveCommand = command + ' --host 127.0.0.1'
          } else if (/npm run (dev|start)\b|npm start\b/.test(command) || /bun run (dev|start)\b|bun start\b/.test(command)) {
            effectiveCommand = command + ' -- --host 127.0.0.1'
          }
        }
        const bgId = `server-${effectiveCommand.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}`
        try {
          await invoke('shell_bg_start', { id: bgId, command: effectiveCommand, cwd: projectPath })
          const port = extractServerPort(effectiveCommand)
          const serverUrl = `http://127.0.0.1:${port}`
          if (onServerStarted) {
            ;(async () => {
              const deadline = Date.now() + 30_000
              while (Date.now() < deadline) {
                try {
                  const up = await invoke<boolean>('probe_port', { port })
                  if (up) { onServerStarted(serverUrl); return }
                } catch {}
                await new Promise(r => setTimeout(r, 500))
              }
            })()
          }
          return `Server started in background (id: ${bgId}). Running at ${serverUrl} — click the Preview ▶ button to open it.`
        } catch (err) {
          return `Error starting server: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      const BASH_MAX_CHARS = 50_000
      try {
        const timeoutSecs = typeof args.timeout === 'number'
          ? Math.min(Math.max(1, Math.floor(args.timeout)), 600)
          : undefined
        const bashStart = Date.now()
        const elapsedTimer = onProgress
          ? setInterval(() => onProgress(`${Math.floor((Date.now() - bashStart) / 1000)}s`), 1000)
          : null
        let result: { stdout: string; stderr: string; exit_code: number }
        try {
          result = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
            command,
            cwd: projectPath,
            timeoutSecs,
          })
        } finally {
          if (elapsedTimer) clearInterval(elapsedTimer)
        }
        const code = result.exit_code ?? (result as any).exitCode ?? 0
        const raw = code !== 0 ? (result.stderr || result.stdout) : (result.stdout || 'OK')
        const prefix = code !== 0 ? `Error (code ${code}):\n` : ''
        if (raw.length > BASH_MAX_CHARS) {
          const kept = raw.slice(-BASH_MAX_CHARS)
          return `${prefix}[Output truncated — showing last ${BASH_MAX_CHARS} chars. Narrow your command or pipe through grep/tail to reduce output.]\n${kept}`
        }
        return prefix + raw
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'update_memory') {
      const { content, mode } = args
      if (!content) return 'Error: content required'
      const MEMORY_FILE = '.betopia/memory.md'
      try {
        if (mode === 'replace') {
          await writeProjectFile(projectPath, MEMORY_FILE, content)
          await onFilesChanged()
          invalidateMemoryCache(projectPath)
          return `Memory file replaced: ${MEMORY_FILE}`
        } else {
          let existing = ''
          try { existing = await readProjectFile(projectPath, MEMORY_FILE) } catch { /* doesn't exist yet */ }
          const separator = existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : ''
          await writeProjectFile(projectPath, MEMORY_FILE, existing + separator + content)
          await onFilesChanged()
          invalidateMemoryCache(projectPath)
          return `Memory updated: ${MEMORY_FILE}`
        }
      } catch (err) {
        return `Error writing memory: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'update_plan') {
      const { plan, explanation } = args
      if (!Array.isArray(plan) || plan.length === 0) return 'Error: update_plan requires a non-empty plan array of {step, status}'
      const validStatuses = new Set(['pending', 'in_progress', 'completed'])
      let inProgress = 0
      let completed = 0
      for (const s of plan) {
        if (!s || typeof s.step !== 'string' || !s.step.trim()) return 'Error: each plan step needs non-empty "step" text'
        if (!validStatuses.has(s.status)) return `Error: invalid status "${s.status}" — must be pending, in_progress, or completed`
        if (s.status === 'in_progress') inProgress++
        if (s.status === 'completed') completed++
      }
      if (inProgress > 1) return 'Error: only one step may be in_progress at a time'
      return `Plan updated: ${completed}/${plan.length} steps complete.${explanation ? ' ' + explanation : ''}`
    }

    return `Error: unknown tool "${name}"`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}
