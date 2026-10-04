export interface Workspace {
  id: string
  path: string
  yolo?: boolean
  version?: string
}

export interface Session {
  id: string
  title?: string
  message_count?: number
  created_at?: number
  updated_at?: number
}

export interface TextData { text: string }
export interface ToolCallData { id: string; name: string; input: string; finished?: boolean }
export interface ToolResultData { tool_call_id: string; name: string; content: string; is_error?: boolean }
export interface FinishData { reason: string; time: number; message?: string }
export interface ReasoningData { thinking: string; started_at?: number; finished_at?: number }
export interface ImageUrlData { url: string }
export interface BinaryData { name: string; mimeType: string; data: string }

export type PartType = 'text' | 'tool_call' | 'tool_result' | 'finish' | 'reasoning' | 'image_url' | 'binary' | 'approval_request'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface ApprovalData {
  id: string
  toolName: string
  path: string
  originalContent: string
  proposedContent: string
  isNewFile: boolean
  status: ApprovalStatus
  command?: string  // bash-specific
}

export interface MessagePart {
  type: PartType
  data: TextData | ToolCallData | ToolResultData | FinishData | ReasoningData | ImageUrlData | BinaryData | ApprovalData | Record<string, unknown>
}

export interface Message {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  parts: MessagePart[]
  model?: string
  provider?: string
  created_at: number
  updated_at: number
}

export interface FileEntry {
  name: string
  path: string
  is_dir: boolean
  size?: number
  children?: FileEntry[]
}

export interface SsePayload {
  type: string
  payload: unknown
}

export type ViewMode = 'code' | 'live' | 'terminal' | 'dashboard' | 'database' | 'storage' | 'settings'

// ── Tab system ────────────────────────────────────────────────────────────────
export interface TabEntry {
  path: string
  label: string
  isDirty?: boolean
  language?: string
}

// ── Log / error system ────────────────────────────────────────────────────────
export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug'

export interface LogEntry {
  id: string
  level: LogLevel
  message: string
  source?: string
  timestamp: number
  details?: string
  fixable?: boolean
}

// ── Auto-fix ──────────────────────────────────────────────────────────────────
export type ErrorCategory =
  | 'missing-import'
  | 'syntax-error'
  | 'runtime-error'
  | 'build-error'
  | 'type-error'
  | 'missing-package'
  | 'unknown'

export interface DetectedError {
  id: string
  category: ErrorCategory
  message: string
  file?: string
  line?: number
  column?: number
  stack?: string
  fixPrompt?: string
  timestamp: number
}

// ── Project scaffold ──────────────────────────────────────────────────────────
export type ProjectCategory =
  | 'ui'
  | 'api'
  | 'backend'
  | 'database'
  | 'components'
  | 'pages'
  | 'hooks'
  | 'services'
  | 'utils'
  | 'configs'
  | 'assets'
  | 'other'

export interface CategorizedFile {
  entry: FileEntry
  category: ProjectCategory
}
