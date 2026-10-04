import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, hoverTooltip, keymap } from '@codemirror/view'
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint'
import { getTypeScriptLspClient } from './typescript-client'
import type { EditorRevealTarget, LspDefinitionTarget, LspDiagnostic, LspPosition, LspRange } from './types'

interface TypeScriptLspExtensionOptions {
  projectPath: string
  path: string
  onOpenDefinition?: (target: LspDefinitionTarget) => void
  onDiagnostics?: (diagnostics: LspDiagnostic[]) => void
}

const SUPPORTED_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i

export function isTypeScriptLspPath(path: string | null | undefined): boolean {
  return Boolean(path && SUPPORTED_EXT.test(path))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function offsetFromPosition(state: EditorState, position: LspPosition): number {
  const lineNumber = clamp(position.line + 1, 1, state.doc.lines)
  const line = state.doc.line(lineNumber)
  return clamp(line.from + position.character, line.from, line.to)
}

function offsetsFromRange(state: EditorState, range: LspRange): { from: number; to: number } {
  const from = offsetFromPosition(state, range.start)
  const to = offsetFromPosition(state, range.end)
  return { from, to: Math.max(from + 1, to) }
}

function mapSeverity(severity: LspDiagnostic['severity']): Diagnostic['severity'] {
  if (severity === 'error') return 'error'
  if (severity === 'warning') return 'warning'
  if (severity === 'hint') return 'hint'
  return 'info'
}

function toCodeMirrorDiagnostic(state: EditorState, diagnostic: LspDiagnostic): Diagnostic {
  const { from, to } = offsetsFromRange(state, diagnostic.range)
  return {
    from,
    to,
    severity: mapSeverity(diagnostic.severity),
    source: diagnostic.source ?? 'typescript',
    message: diagnostic.code ? `${diagnostic.message} [${diagnostic.code}]` : diagnostic.message,
  }
}

function isSamePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').replace(/^\/+/, '') === b.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function revealLspTarget(view: EditorView, target: EditorRevealTarget | LspDefinitionTarget): void {
  const pos = offsetFromPosition(view.state, { line: target.line, character: target.character })
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: 'center', x: 'nearest' }),
  })
  view.focus()
}

function hoverDom(contents: string): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cm-ts-hover'
  const pre = document.createElement('pre')
  pre.textContent = contents
  dom.appendChild(pre)
  return dom
}

export function createTypeScriptLspExtensions(options: TypeScriptLspExtensionOptions): Extension[] {
  const { projectPath, path, onOpenDefinition, onDiagnostics } = options
  if (!projectPath || !isTypeScriptLspPath(path)) return []

  const client = getTypeScriptLspClient()

  const completionSource = async (context: CompletionContext): Promise<CompletionResult | null> => {
    if (!context.explicit) {
      const token = context.matchBefore(/[\w$]*$/)
      if (!token || token.from === token.to) return null
    }

    const content = context.state.doc.toString()
    const result = await client.completion(projectPath, path, content, context.pos)
    if (!result || context.aborted) return null

    return {
      from: result.from,
      to: result.to,
      options: result.options.map(option => ({
        label: option.label,
        detail: option.detail,
        info: option.info,
        type: option.type,
        apply: option.apply,
      })),
      validFor: /^[\w$]*$/,
    }
  }

  const runDefinition = (view: EditorView, pos: number): void => {
    const content = view.state.doc.toString()
    void client.definition(projectPath, path, content, pos).then((target) => {
      if (!target) return
      if (isSamePath(target.path, path)) {
        revealLspTarget(view, target)
      } else {
        onOpenDefinition?.(target)
      }
    }).catch(() => {})
  }

  return [
    lintGutter(),
    linter(async (view) => {
      const diagnostics = await client.diagnostics(projectPath, path, view.state.doc.toString())
      onDiagnostics?.(diagnostics)
      return diagnostics
        .filter(diagnostic => isSamePath(diagnostic.path, path))
        .map(diagnostic => toCodeMirrorDiagnostic(view.state, diagnostic))
    }, { delay: 350 }),
    EditorState.languageData.of(() => [{ autocomplete: completionSource }]),
    hoverTooltip(async (view, pos) => {
      const hover = await client.hover(projectPath, path, view.state.doc.toString(), pos).catch(() => null)
      if (!hover) return null
      const { from, to } = offsetsFromRange(view.state, hover.range)
      return {
        pos: from,
        end: to,
        above: true,
        create: () => ({ dom: hoverDom(hover.contents) }),
      }
    }, { hoverTime: 350, hideOnChange: true }),
    keymap.of([
      {
        key: 'F12',
        run(view) {
          runDefinition(view, view.state.selection.main.head)
          return true
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null) return false
        event.preventDefault()
        runDefinition(view, pos)
        return true
      },
    }),
  ]
}
