import { invoke } from '@tauri-apps/api/core'
import type { AgentAuditEvent } from './agent-types'

const AUDIT_FILE = '.betopia/audit.jsonl'
const AUDIT_MAX_LINES = 2000

export async function appendAuditEvent(projectPath: string, event: AgentAuditEvent): Promise<void> {
  try {
    const line = JSON.stringify(event) + '\n'
    await invoke('fs_append_file', { path: `${projectPath}/${AUDIT_FILE}`, content: line })
  } catch {
    // Non-fatal — audit persistence is best-effort
  }
}

export async function loadAuditEvents(projectPath: string): Promise<AgentAuditEvent[]> {
  try {
    const raw = await invoke<string>('fs_read_file', { path: `${projectPath}/${AUDIT_FILE}` })
    const lines = raw.split('\n').filter(Boolean)
    const events = lines.flatMap(line => {
      try { return [JSON.parse(line) as AgentAuditEvent] } catch { return [] }
    })
    // Prune opportunistically when file has grown past the limit
    if (lines.length > AUDIT_MAX_LINES) {
      void _writeAuditLines(projectPath, events.slice(-AUDIT_MAX_LINES))
      return events.slice(-AUDIT_MAX_LINES)
    }
    return events
  } catch {
    return []
  }
}

async function _writeAuditLines(projectPath: string, events: AgentAuditEvent[]): Promise<void> {
  try {
    const content = events.map(e => JSON.stringify(e)).join('\n') + '\n'
    await invoke('fs_write_file', { path: `${projectPath}/${AUDIT_FILE}`, content })
  } catch { /* best-effort */ }
}
