/**
 * error-detector.ts
 * Detects, classifies, and formats errors from runtime, build, and AI output.
 * Adapted from open-lovable's build-validator.ts patterns for the Tauri context.
 */

import type { DetectedError, ErrorCategory, LogEntry } from '../types'

let _errorCounter = 0
function newId() {
  return `err-${Date.now()}-${++_errorCounter}`
}

// ── Classification ────────────────────────────────────────────────────────────

export function classifyError(message: string): ErrorCategory {
  const m = message.toLowerCase()

  if (
    m.includes('failed to resolve import') ||
    m.includes('cannot find module') ||
    m.includes("module not found")
  ) return 'missing-import'

  if (
    m.includes('syntaxerror') ||
    m.includes('unexpected token') ||
    m.includes('unexpected end of input') ||
    m.includes('unexpected identifier') ||
    m.includes('parsing error')
  ) return 'syntax-error'

  if (
    m.includes('typeerror') ||
    m.includes('is not a function') ||
    m.includes('is not defined') ||
    m.includes('cannot read prop') ||
    m.includes('cannot read properties')
  ) return 'runtime-error'

  if (
    m.includes('build failed') ||
    m.includes('compilation error') ||
    m.includes('vite error') ||
    m.includes('rollup error') ||
    m.includes('[vite]')
  ) return 'build-error'

  if (
    m.includes('ts(') ||
    m.includes('ts2') ||
    m.includes('type error') ||
    m.includes('no overload') ||
    m.includes('argument of type')
  ) return 'type-error'

  if (
    m.includes("missing package") ||
    m.includes("not installed") ||
    m.includes("peer dependency")
  ) return 'missing-package'

  return 'unknown'
}

// ── Fix prompt generation ─────────────────────────────────────────────────────

export function buildFixPrompt(error: DetectedError): string {
  const location = error.file
    ? ` in \`${error.file}\`${error.line ? ` (line ${error.line})` : ''}`
    : ''

  switch (error.category) {
    case 'missing-import':
      return `Fix the missing import error${location}. Error: ${error.message}. Make sure the module exists and the import path is correct. If it's a third-party package, add it to the project dependencies.`

    case 'syntax-error':
      return `Fix the syntax error${location}. Error: ${error.message}. Check for missing brackets, commas, semicolons, or mismatched quotes.`

    case 'runtime-error':
      return `Fix the runtime error${location}. Error: ${error.message}. Add proper null/undefined checks and make sure all referenced variables and functions exist.`

    case 'build-error':
      return `Fix the build error${location}. Error: ${error.message}. Check all imports, exports, and make sure the code is valid TypeScript/JavaScript.`

    case 'type-error':
      return `Fix the TypeScript type error${location}. Error: ${error.message}. Ensure the types are compatible or add proper type assertions.`

    case 'missing-package':
      return `The project is missing a required package. Error: ${error.message}. Add the necessary dependency to package.json.`

    default:
      return `Fix the following error${location}: ${error.message}`
  }
}

// ── Parser for common error formats ──────────────────────────────────────────

interface ParsedErrorLocation {
  file?: string
  line?: number
  column?: number
}

function parseErrorLocation(message: string): ParsedErrorLocation {
  // Pattern: "at file.tsx:42:10"
  const stackMatch = message.match(/at\s+(\S+\.(?:ts|tsx|js|jsx|css|html))[\s:@](\d+)(?::(\d+))?/)
  if (stackMatch) {
    return {
      file: stackMatch[1],
      line: parseInt(stackMatch[2], 10),
      column: stackMatch[3] ? parseInt(stackMatch[3], 10) : undefined,
    }
  }

  // Pattern: "file.tsx (42:10)"
  const parenMatch = message.match(/(\S+\.(?:ts|tsx|js|jsx|css|html))\s*\((\d+):(\d+)\)/)
  if (parenMatch) {
    return {
      file: parenMatch[1],
      line: parseInt(parenMatch[2], 10),
      column: parseInt(parenMatch[3], 10),
    }
  }

  // Pattern: "file.tsx:42"
  const colonMatch = message.match(/(\S+\.(?:ts|tsx|js|jsx|css|html)):(\d+)/)
  if (colonMatch) {
    return { file: colonMatch[1], line: parseInt(colonMatch[2], 10) }
  }

  return {}
}

// ── Main parse function ───────────────────────────────────────────────────────

export function parseRuntimeError(event: ErrorEvent | string): DetectedError {
  const rawMessage = typeof event === 'string' ? event : (event.message || 'Unknown error')
  const category = classifyError(rawMessage)
  const location = parseErrorLocation(rawMessage)

  const error: DetectedError = {
    id: newId(),
    category,
    message: rawMessage,
    file: location.file ?? (event instanceof ErrorEvent && event.filename ? event.filename : undefined),
    line: location.line ?? (event instanceof ErrorEvent ? event.lineno : undefined),
    column: location.column ?? (event instanceof ErrorEvent ? event.colno : undefined),
    stack: event instanceof ErrorEvent ? undefined : undefined,
    timestamp: Date.now(),
  }
  error.fixPrompt = buildFixPrompt(error)
  return error
}

// ── Agent output scanner ──────────────────────────────────────────────────────

export function scanAgentOutputForErrors(output: string): DetectedError[] {
  const errors: DetectedError[] = []
  const lines = output.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const isError = (
      trimmed.toLowerCase().startsWith('error:') ||
      trimmed.toLowerCase().startsWith('typeerror:') ||
      trimmed.toLowerCase().startsWith('syntaxerror:') ||
      trimmed.toLowerCase().startsWith('referenceerror:') ||
      trimmed.includes('ERROR') ||
      trimmed.match(/\berror\b.*:/i) !== null
    )

    if (isError) {
      const category = classifyError(trimmed)
      const location = parseErrorLocation(trimmed)
      const error: DetectedError = {
        id: newId(),
        category,
        message: trimmed,
        file: location.file,
        line: location.line,
        timestamp: Date.now(),
      }
      error.fixPrompt = buildFixPrompt(error)
      errors.push(error)
    }
  }

  return errors
}

// ── LogEntry factory ──────────────────────────────────────────────────────────

let _logCounter = 0
export function makeLogEntry(
  level: LogEntry['level'],
  message: string,
  source?: string,
  details?: string,
  fixable?: boolean,
): LogEntry {
  return {
    id: `log-${Date.now()}-${++_logCounter}`,
    level,
    message,
    source,
    details,
    fixable,
    timestamp: Date.now(),
  }
}

export function errorToLogEntry(error: DetectedError): LogEntry {
  return {
    id: `log-${error.id}`,
    level: 'error',
    message: error.message,
    source: error.category === 'runtime-error' ? 'runtime' : 'build',
    details: error.file ? `${error.file}${error.line ? `:${error.line}` : ''}` : undefined,
    fixable: true,
    timestamp: error.timestamp,
  }
}

// ── Missing-package extractor ─────────────────────────────────────────────────

export function extractMissingPackages(message: string): string[] {
  const packages: string[] = []

  const patterns = [
    /Failed to resolve import ["']([^"']+)["']/g,
    /Cannot find module ["']([^"']+)["']/g,
    /Module not found[^:]*: ["']([^"']+)["']/g,
    /Package ["']([^"']+)["'] not found/g,
  ]

  for (const pattern of patterns) {
    for (const match of message.matchAll(pattern)) {
      const pkg = match[1]
      // Only external packages (not relative imports)
      if (!pkg.startsWith('.') && !pkg.startsWith('/')) {
        packages.push(pkg)
      }
    }
  }

  return [...new Set(packages)]
}
