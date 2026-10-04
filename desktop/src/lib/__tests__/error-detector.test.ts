import { describe, it, expect } from 'vitest'
import {
  classifyError,
  buildFixPrompt,
  parseRuntimeError,
  scanAgentOutputForErrors,
  makeLogEntry,
  errorToLogEntry,
  extractMissingPackages,
} from '../error-detector'
import type { DetectedError } from '../../types'

describe('classifyError', () => {
  it.each([
    ['failed to resolve import \'lodash\'', 'missing-import'],
    ['Cannot find module \'react\'', 'missing-import'],
    ['Module not found: \'./helper\'', 'missing-import'],
    ['SyntaxError: Unexpected token \'<\'', 'syntax-error'],
    ['Unexpected token \'}\'', 'syntax-error'],
    ['unexpected end of input', 'syntax-error'],
    ['unexpected identifier', 'syntax-error'],
    ['Parsing error: \';\' expected', 'syntax-error'],
    ['TypeError: Cannot read property \'map\' of undefined', 'runtime-error'],
    ['xyz is not a function', 'runtime-error'],
    ['foo is not defined', 'runtime-error'],
    ['cannot read prop \'length\' of null', 'runtime-error'],
    ['Cannot read properties of undefined', 'runtime-error'],
    ['Build failed with 2 errors', 'build-error'],
    ['Compilation error in ./src', 'build-error'],
    ['Vite error: failed to load', 'build-error'],
    ['rollup error: could not resolve', 'build-error'],
    ['[vite] hot update failed', 'build-error'],
    ['TS(2322): Type \'string\' not assignable', 'type-error'],
    ['ts2769: no overload matches', 'type-error'],
    ['Type error in expression', 'type-error'],
    ['No overload matches this call', 'type-error'],
    ['argument of type \'number\' not assignable', 'type-error'],
    ['Missing package \'react\'', 'missing-package'],
    ['Package \'lodash\' is not installed', 'missing-package'],
    ['peer dependency \'react\' missing', 'missing-package'],
    ['random unrelated log message', 'unknown'],
    ['everything looks good', 'unknown'],
  ])('classifies "%s" as %s', (message, expected) => {
    expect(classifyError(message)).toBe(expected)
  })
})

describe('buildFixPrompt', () => {
  const base: DetectedError = {
    id: 'err-1',
    category: 'unknown',
    message: 'something broke',
    timestamp: 0,
  }

  it('includes file and line when available', () => {
    const prompt = buildFixPrompt({ ...base, category: 'syntax-error', file: 'src/main.ts', line: 42 })
    expect(prompt).toContain('src/main.ts')
    expect(prompt).toContain('line 42')
    expect(prompt).toContain('Fix the syntax error')
  })

  it('includes only file when no line', () => {
    const prompt = buildFixPrompt({ ...base, category: 'missing-import', file: 'src/app.ts' })
    expect(prompt).toContain('src/app.ts')
    expect(prompt).not.toContain('line')
  })

  it('generates missing-import prompt', () => {
    const prompt = buildFixPrompt({ ...base, category: 'missing-import', message: 'Cannot find module' })
    expect(prompt).toMatch(/missing import/i)
    expect(prompt).toMatch(/import path is correct/i)
  })

  it('generates syntax-error prompt', () => {
    const prompt = buildFixPrompt({ ...base, category: 'syntax-error' })
    expect(prompt).toMatch(/syntax error/i)
  })

  it('generates runtime-error prompt', () => {
    const prompt = buildFixPrompt({ ...base, category: 'runtime-error' })
    expect(prompt).toMatch(/runtime error/i)
    expect(prompt).toMatch(/null\/undefined checks/i)
  })

  it('generates build-error prompt', () => {
    const prompt = buildFixPrompt({ ...base, category: 'build-error' })
    expect(prompt).toMatch(/build error/i)
  })

  it('generates type-error prompt', () => {
    const prompt = buildFixPrompt({ ...base, category: 'type-error' })
    expect(prompt).toMatch(/typescript type error/i)
  })

  it('generates missing-package prompt', () => {
    const prompt = buildFixPrompt({ ...base, category: 'missing-package' })
    expect(prompt).toMatch(/missing a required package/i)
  })

  it('falls back to generic prompt for unknown category', () => {
    const prompt = buildFixPrompt({ ...base, category: 'unknown' })
    expect(prompt).toMatch(/Fix the following error/)
  })

  it('omits file section when no file', () => {
    const prompt = buildFixPrompt({ ...base, category: 'runtime-error' })
    expect(prompt).not.toContain('`')
  })
})

describe('parseRuntimeError', () => {
  it('parses a string message into a DetectedError', () => {
    const result = parseRuntimeError('TypeError: x is not a function')
    expect(result.category).toBe('runtime-error')
    expect(result.message).toBe('TypeError: x is not a function')
    expect(result.file).toBeUndefined()
    expect(result.id).toMatch(/^err-/)
    expect(result.fixPrompt).toBeTruthy()
  })

  it('extracts file:line from stack traces', () => {
    const result = parseRuntimeError('TypeError: undefined at src/app.tsx:42:10')
    expect(result.file).toBe('src/app.tsx')
    expect(result.line).toBe(42)
    expect(result.column).toBe(10)
  })

  it('extracts file:line from parenthesized format', () => {
    const result = parseRuntimeError('SyntaxError in helper.ts (15:3)')
    expect(result.file).toBe('helper.ts')
    expect(result.line).toBe(15)
    expect(result.column).toBe(3)
  })

  it('extracts file:line from colon format', () => {
    const result = parseRuntimeError('Error at main.js:88')
    expect(result.file).toBe('main.js')
    expect(result.line).toBe(88)
  })

  it('handles ErrorEvent-like objects', () => {
    const event = { message: 'TypeError: foo is bad at app.ts:10:5', filename: 'app.ts', lineno: 10, colno: 5 }
    const result = parseRuntimeError(event as any)
    expect(result.category).toBe('runtime-error')
    expect(result.file).toBe('app.ts')
    expect(result.line).toBe(10)
    expect(result.column).toBe(5)
  })

  it('extracts file from ErrorEvent fallback when message lacks location', () => {
    const event = new ErrorEvent('error', { message: 'something broke', filename: 'app.ts', lineno: 10, colno: 5 })
    const result = parseRuntimeError(event)
    expect(result.category).toBe('unknown')
    expect(result.file).toBe('app.ts')
    expect(result.line).toBe(10)
    expect(result.column).toBe(5)
  })

  it('classifies and builds fix prompt', () => {
    const result = parseRuntimeError('SyntaxError: unexpected token')
    expect(result.category).toBe('syntax-error')
    expect(result.fixPrompt).toContain('Fix the syntax error')
  })
})

describe('scanAgentOutputForErrors', () => {
  it('detects errors prefixed with Error:', () => {
    const errors = scanAgentOutputForErrors('Some text\nError: file not found\nMore text')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('Error: file not found')
  })

  it('detects TypeError: prefixed lines', () => {
    const errors = scanAgentOutputForErrors('TypeError: cannot read prop')
    expect(errors).toHaveLength(1)
  })

  it('detects SyntaxError: prefixed lines', () => {
    const errors = scanAgentOutputForErrors('SyntaxError: unexpected end')
    expect(errors).toHaveLength(1)
  })

  it('detects ReferenceError: prefixed lines', () => {
    const errors = scanAgentOutputForErrors('ReferenceError: x is not defined')
    expect(errors).toHaveLength(1)
  })

  it('detects ERROR in all caps', () => {
    const errors = scanAgentOutputForErrors('some line with ERROR in it')
    expect(errors).toHaveLength(1)
  })

  it('detects error: pattern with colon', () => {
    const errors = scanAgentOutputForErrors('error: something went wrong')
    expect(errors).toHaveLength(1)
  })

  it('returns empty for clean output', () => {
    const errors = scanAgentOutputForErrors('Everything looks good.\nBuild succeeded.')
    expect(errors).toHaveLength(0)
  })

  it('skips empty lines', () => {
    const errors = scanAgentOutputForErrors('\n\n\n')
    expect(errors).toHaveLength(0)
  })

  it('classifies each detected error', () => {
    const errors = scanAgentOutputForErrors('Error: Failed to resolve import \'react\'')
    expect(errors).toHaveLength(1)
    expect(errors[0].category).toBe('missing-import')
    expect(errors[0].fixPrompt).toBeTruthy()
  })

  it('extracts file:line from error lines', () => {
    const errors = scanAgentOutputForErrors('Error: at src/app.tsx:42')
    expect(errors).toHaveLength(1)
    expect(errors[0].file).toBe('src/app.tsx')
    expect(errors[0].line).toBe(42)
  })
})

describe('makeLogEntry', () => {
  it('creates a log entry with required fields', () => {
    const entry = makeLogEntry('error', 'Something broke')
    expect(entry.level).toBe('error')
    expect(entry.message).toBe('Something broke')
    expect(entry.id).toMatch(/^log-/)
    expect(entry.timestamp).toBeGreaterThan(0)
  })

  it('includes optional source, details, fixable', () => {
    const entry = makeLogEntry('warn', 'msg', 'my-source', 'some details', true)
    expect(entry.source).toBe('my-source')
    expect(entry.details).toBe('some details')
    expect(entry.fixable).toBe(true)
  })

  it('defaults source and details when omitted', () => {
    const entry = makeLogEntry('info', 'msg')
    expect(entry.source).toBeUndefined()
    expect(entry.details).toBeUndefined()
  })
})

describe('errorToLogEntry', () => {
  it('converts a DetectedError to a LogEntry', () => {
    const error: DetectedError = { id: 'err-abc', category: 'build-error', message: 'Build failed', timestamp: 1000 }
    const entry = errorToLogEntry(error)
    expect(entry.level).toBe('error')
    expect(entry.message).toBe('Build failed')
    expect(entry.source).toBe('build')
    expect(entry.fixable).toBe(true)
    expect(entry.id).toContain('err-abc')
  })

  it('sets source to runtime for runtime errors', () => {
    const error: DetectedError = { id: 'err-1', category: 'runtime-error', message: 'crash', timestamp: 0 }
    expect(errorToLogEntry(error).source).toBe('runtime')
  })

  it('includes file:line in details when available', () => {
    const error: DetectedError = { id: 'err-1', category: 'syntax-error', message: 'bad', file: 'src/main.ts', line: 42, timestamp: 0 }
    expect(errorToLogEntry(error).details).toBe('src/main.ts:42')
  })

  it('omits details when no file', () => {
    const error: DetectedError = { id: 'err-1', category: 'type-error', message: 'type mismatch', timestamp: 0 }
    expect(errorToLogEntry(error).details).toBeUndefined()
  })
})

describe('extractMissingPackages', () => {
  it('extracts from "Failed to resolve import"', () => {
    const packages = extractMissingPackages('Failed to resolve import "lodash"')
    expect(packages).toEqual(['lodash'])
  })

  it('extracts from "Cannot find module"', () => {
    const packages = extractMissingPackages(`Cannot find module 'react'`)
    expect(packages).toEqual(['react'])
  })

  it('extracts from "Module not found"', () => {
    const packages = extractMissingPackages('Module not found: "express"')
    expect(packages).toEqual(['express'])
  })

  it('extracts from "Package not found"', () => {
    const packages = extractMissingPackages('Package "axios" not found')
    expect(packages).toEqual(['axios'])
  })

  it('skips relative imports (./ or /)', () => {
    const packages = extractMissingPackages(`Cannot find module './helper'`)
    expect(packages).toEqual([])
  })

  it('skips absolute imports (starting with /)', () => {
    const packages = extractMissingPackages('Failed to resolve import "/src/utils"')
    expect(packages).toEqual([])
  })

  it('deduplicates identical packages', () => {
    const packages = extractMissingPackages(`Cannot find module 'lodash' Failed to resolve import "lodash"`)
    expect(packages).toEqual(['lodash'])
  })

  it('extracts multiple distinct packages', () => {
    const packages = extractMissingPackages(`Cannot find module 'react' Cannot find module 'lodash'`)
    expect(packages).toContain('react')
    expect(packages).toContain('lodash')
  })

  it('returns empty array for unrelated messages', () => {
    const packages = extractMissingPackages('SyntaxError: unexpected token')
    expect(packages).toEqual([])
  })
})
