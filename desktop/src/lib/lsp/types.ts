export type LspSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspDiagnostic {
  path: string
  range: LspRange
  severity: LspSeverity
  message: string
  source?: string
  code?: string | number
}

export interface LspCompletion {
  label: string
  detail?: string
  info?: string
  type?: string
  apply?: string
}

export interface LspCompletionResult {
  from: number
  to?: number
  options: LspCompletion[]
  isIncomplete?: boolean
}

export interface LspHover {
  range: LspRange
  contents: string
}

export interface LspDefinitionTarget {
  path: string
  line: number
  character: number
  range?: LspRange
}

export interface EditorRevealTarget extends LspDefinitionTarget {
  token: number
}

export interface LspProjectFile {
  path: string
  content: string
}
