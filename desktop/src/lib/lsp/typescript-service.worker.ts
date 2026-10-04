/// <reference lib="webworker" />

import * as ts from 'typescript'
import type {
  LspCompletion,
  LspCompletionResult,
  LspDefinitionTarget,
  LspDiagnostic,
  LspHover,
  LspProjectFile,
  LspRange,
  LspSeverity,
} from './types'

type WorkerRequest =
  | { id: number; type: 'resetProject'; payload: { projectPath?: string } }
  | { id: number; type: 'upsertFiles'; payload: { files: LspProjectFile[] } }
  | { id: number; type: 'diagnostics'; payload: { path: string; content: string } }
  | { id: number; type: 'completion'; payload: { path: string; content: string; offset: number } }
  | { id: number; type: 'hover'; payload: { path: string; content: string; offset: number } }
  | { id: number; type: 'definition'; payload: { path: string; content: string; offset: number } }

type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

interface VfsFile {
  content: string
  version: number
  bundled?: boolean
}

const libModules = import.meta.glob<string>('../../../node_modules/typescript/lib/lib.*.d.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const bundledTypeModules = import.meta.glob<string>([
  '../../../node_modules/@types/react/**/*.d.ts',
  '../../../node_modules/@types/react-dom/**/*.d.ts',
  '../../../node_modules/@types/node/**/*.d.ts',
  '../../../node_modules/@types/prop-types/**/*.d.ts',
  '../../../node_modules/csstype/**/*.d.ts',
  '../../../node_modules/undici-types/**/*.d.ts',
  '../../../node_modules/vite/**/*.d.ts',
], {
  query: '?raw',
  import: 'default',
  eager: true,
})

const PROJECT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'])
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])
const BUNDLED_PREFIX = '/node_modules/'
const AMBIENT_FILE = '/node_modules/@types/betopia-lsp-shims/index.d.ts'

const files = new Map<string, VfsFile>()
let projectVersion = 0
let activeFileName = '/index.tsx'

function normalizePath(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+/g, '/')
  const withoutTrailing = normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized
  return withoutTrailing.startsWith('/') ? withoutTrailing : `/${withoutTrailing}`
}

function normalizeProjectPath(path: string): string {
  return normalizePath(path).replace(/^\/+/, '/')
}

function dirname(path: string): string {
  const normalized = normalizePath(path)
  const idx = normalized.lastIndexOf('/')
  return idx <= 0 ? '/' : normalized.slice(0, idx)
}

function basename(path: string): string {
  const normalized = normalizePath(path)
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

function extname(path: string): string {
  const name = basename(path).toLowerCase()
  if (name.endsWith('.d.ts')) return '.ts'
  if (name.endsWith('.d.mts')) return '.mts'
  if (name.endsWith('.d.cts')) return '.cts'
  const idx = name.lastIndexOf('.')
  return idx === -1 ? '' : name.slice(idx)
}

function isDeclarationFile(path: string): boolean {
  return /\.d\.[cm]?ts$/i.test(path)
}

function isScriptFile(path: string): boolean {
  return isDeclarationFile(path) || SCRIPT_EXTENSIONS.has(extname(path))
}

function isProjectFile(path: string): boolean {
  return !normalizePath(path).startsWith(BUNDLED_PREFIX)
}

function toBundledNodeModulePath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, '/')
  const marker = '/node_modules/'
  const idx = normalized.lastIndexOf(marker)
  if (idx === -1) return null
  return normalizePath(normalized.slice(idx + 1))
}

function addBundledFile(path: string, content: string): void {
  files.set(normalizePath(path), { content, version: 0, bundled: true })
}

function addBundledModules(): void {
  for (const [rawPath, content] of Object.entries(libModules)) {
    const name = basename(rawPath)
    addBundledFile(`/node_modules/typescript/lib/${name}`, content)
  }

  for (const [rawPath, content] of Object.entries(bundledTypeModules)) {
    const path = toBundledNodeModulePath(rawPath)
    if (path) addBundledFile(path, content)
  }

  addBundledFile(AMBIENT_FILE, [
    "declare module '*.css' { const classes: { readonly [key: string]: string }; export default classes }",
    "declare module '*.scss' { const classes: { readonly [key: string]: string }; export default classes }",
    "declare module '*.sass' { const classes: { readonly [key: string]: string }; export default classes }",
    "declare module '*.less' { const classes: { readonly [key: string]: string }; export default classes }",
    "declare module '*.module.css' { const classes: { readonly [key: string]: string }; export default classes }",
    "declare module '*.module.scss' { const classes: { readonly [key: string]: string }; export default classes }",
    "declare module '*.svg' { const src: string; export default src }",
    "declare module '*.png' { const src: string; export default src }",
    "declare module '*.jpg' { const src: string; export default src }",
    "declare module '*.jpeg' { const src: string; export default src }",
    "declare module '*.gif' { const src: string; export default src }",
    "declare module '*.webp' { const src: string; export default src }",
    "declare module '*.avif' { const src: string; export default src }",
    "declare module '*.ico' { const src: string; export default src }",
    '',
  ].join('\n'))
}

addBundledModules()

const defaultCompilerOptions: ts.CompilerOptions = {
  allowJs: true,
  allowSyntheticDefaultImports: true,
  checkJs: false,
  esModuleInterop: true,
  forceConsistentCasingInFileNames: false,
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.Node10,
  noEmit: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  strict: false,
  target: ts.ScriptTarget.ES2020,
  typeRoots: ['/node_modules/@types'],
  types: undefined,
  lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
}

const moduleAliases: Record<string, string> = {
  react: '/node_modules/@types/react/index.d.ts',
  'react/jsx-runtime': '/node_modules/@types/react/jsx-runtime.d.ts',
  'react/jsx-dev-runtime': '/node_modules/@types/react/jsx-dev-runtime.d.ts',
  'react-dom': '/node_modules/@types/react-dom/index.d.ts',
  'react-dom/client': '/node_modules/@types/react-dom/client.d.ts',
  'react-dom/server': '/node_modules/@types/react-dom/server.d.ts',
  csstype: '/node_modules/csstype/index.d.ts',
  vite: '/node_modules/vite/client.d.ts',
  'vite/client': '/node_modules/vite/client.d.ts',
}

function fileExists(path: string): boolean {
  return files.has(normalizePath(path))
}

function readFile(path: string): string | undefined {
  return files.get(normalizePath(path))?.content
}

function directoryExists(path: string): boolean {
  const prefix = normalizePath(path)
  const dir = prefix.endsWith('/') ? prefix : `${prefix}/`
  for (const file of files.keys()) {
    if (file.startsWith(dir)) return true
  }
  return false
}

function getDirectories(path: string): string[] {
  const prefix = normalizePath(path)
  const dir = prefix.endsWith('/') ? prefix : `${prefix}/`
  const result = new Set<string>()
  for (const file of files.keys()) {
    if (!file.startsWith(dir)) continue
    const rest = file.slice(dir.length)
    const first = rest.split('/')[0]
    if (first && first !== rest) result.add(first)
  }
  return [...result]
}

function readDirectory(rootDir: string, extensions?: readonly string[]): string[] {
  const root = normalizePath(rootDir)
  const dir = root.endsWith('/') ? root : `${root}/`
  const allowed = extensions?.length ? new Set(extensions.map(ext => ext.toLowerCase())) : PROJECT_EXTENSIONS
  return [...files.keys()].filter((path) => {
    if (!path.startsWith(dir)) return false
    if (path.includes('/node_modules/') && !files.get(path)?.bundled) return false
    if (path.includes('/dist/') || path.includes('/build/') || path.includes('/.next/')) return false
    if (isDeclarationFile(path)) return allowed.has('.ts') || allowed.has('.d.ts')
    return allowed.has(extname(path))
  })
}

const moduleResolutionHost: ts.ModuleResolutionHost = {
  fileExists,
  readFile,
  directoryExists,
  getDirectories,
  realpath: normalizePath,
  useCaseSensitiveFileNames: true,
}

function scriptKind(path: string): ts.ScriptKind {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (lower.endsWith('.json')) return ts.ScriptKind.JSON
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function findNearestTsconfig(fileName: string): string | undefined {
  const file = normalizePath(fileName)
  let best: string | undefined
  for (const candidate of files.keys()) {
    if (!/\/(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/i.test(candidate)) continue
    const dir = dirname(candidate)
    if (file === candidate || file.startsWith(`${dir}/`)) {
      if (!best || dir.length > dirname(best).length) best = candidate
    }
  }
  return best
}

function parseCompilerOptions(fileName: string): ts.CompilerOptions {
  const configPath = findNearestTsconfig(fileName)
  if (!configPath) {
    return {
      ...defaultCompilerOptions,
      baseUrl: '/',
      paths: {
        '@/*': ['src/*', 'frontend/src/*'],
      },
    }
  }

  const configText = readFile(configPath)
  if (!configText) return defaultCompilerOptions

  const parsedJson = ts.parseConfigFileTextToJson(configPath, configText)
  if (parsedJson.error) return defaultCompilerOptions

  const basePath = dirname(configPath)
  const parsed = ts.parseJsonConfigFileContent(parsedJson.config, {
    useCaseSensitiveFileNames: true,
    readDirectory,
    fileExists,
    readFile,
  }, basePath, defaultCompilerOptions, configPath)

  return {
    ...defaultCompilerOptions,
    ...parsed.options,
    allowJs: parsed.options.allowJs ?? true,
    checkJs: parsed.options.checkJs ?? false,
    noEmit: true,
    skipLibCheck: true,
  }
}

const host: ts.LanguageServiceHost = {
  getCompilationSettings: () => parseCompilerOptions(activeFileName),
  getCurrentDirectory: () => '/',
  getDefaultLibFileName: options => `/node_modules/typescript/lib/${ts.getDefaultLibFileName(options)}`,
  getNewLine: () => '\n',
  getProjectVersion: () => String(projectVersion),
  getScriptFileNames: () => {
    const result = new Set<string>()
    for (const path of files.keys()) {
      if (isScriptFile(path) || path.endsWith('.json')) result.add(path)
      if (path.startsWith('/node_modules/typescript/lib/') && path.endsWith('.d.ts')) result.add(path)
      if (path.startsWith('/node_modules/@types/') && path.endsWith('.d.ts')) result.add(path)
      if (path.startsWith('/node_modules/csstype/') && path.endsWith('.d.ts')) result.add(path)
      if (path.startsWith('/node_modules/undici-types/') && path.endsWith('.d.ts')) result.add(path)
      if (path.startsWith('/node_modules/vite/') && path.endsWith('.d.ts')) result.add(path)
    }
    return [...result]
  },
  getScriptKind: scriptKind,
  getScriptSnapshot: path => {
    const content = readFile(path)
    return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
  },
  getScriptVersion: path => String(files.get(normalizePath(path))?.version ?? 0),
  readDirectory,
  readFile,
  fileExists,
  directoryExists,
  getDirectories,
  realpath: normalizePath,
  useCaseSensitiveFileNames: () => true,
  resolveModuleNameLiterals(moduleLiterals, containingFile, _redirectedReference, options) {
    return moduleLiterals.map((literal) => {
      const alias = moduleAliases[literal.text]
      if (alias && fileExists(alias)) {
        return {
          resolvedModule: {
            resolvedFileName: alias,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: true,
          },
        }
      }

      const resolved = ts.resolveModuleName(literal.text, containingFile, options, moduleResolutionHost)
      return {
        resolvedModule: resolved.resolvedModule,
      }
    })
  },
}

const languageService = ts.createLanguageService(host, ts.createDocumentRegistry(true, '/'))

function upsertFile(path: string, content: string, bundled = false): void {
  const normalized = normalizeProjectPath(path)
  const prev = files.get(normalized)
  if (prev?.content === content) return
  files.set(normalized, {
    content,
    version: (prev?.version ?? 0) + 1,
    bundled: bundled || prev?.bundled,
  })
  projectVersion++
}

function resetProject(): void {
  for (const [path, file] of [...files.entries()]) {
    if (!file.bundled) files.delete(path)
  }
  projectVersion++
}

function syncActiveFile(path: string, content: string): string {
  const fileName = normalizeProjectPath(path)
  activeFileName = fileName
  upsertFile(fileName, content)
  return fileName
}

function lineRangeForTextSpan(sourceFile: ts.SourceFile, span: ts.TextSpan): LspRange {
  const start = sourceFile.getLineAndCharacterOfPosition(span.start)
  const end = sourceFile.getLineAndCharacterOfPosition(span.start + Math.max(0, span.length))
  return {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character },
  }
}

function rangeFromDiagnostic(diagnostic: ts.Diagnostic): LspRange {
  if (!diagnostic.file || typeof diagnostic.start !== 'number') {
    return {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    }
  }
  return lineRangeForTextSpan(diagnostic.file, {
    start: diagnostic.start,
    length: Math.max(1, diagnostic.length ?? 1),
  })
}

function severity(category: ts.DiagnosticCategory): LspSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error: return 'error'
    case ts.DiagnosticCategory.Warning: return 'warning'
    case ts.DiagnosticCategory.Suggestion: return 'hint'
    default: return 'info'
  }
}

function diagnosticMessage(messageText: string | ts.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(messageText, '\n')
}

function uniqueDiagnostics(diagnostics: ts.Diagnostic[]): ts.Diagnostic[] {
  const seen = new Set<string>()
  const result: ts.Diagnostic[] = []
  for (const diagnostic of diagnostics) {
    const fileName = diagnostic.file?.fileName ?? activeFileName
    const key = `${fileName}:${diagnostic.start ?? 0}:${diagnostic.length ?? 0}:${diagnostic.code}:${diagnosticMessage(diagnostic.messageText)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(diagnostic)
  }
  return result
}

function getDiagnostics(path: string, content: string): LspDiagnostic[] {
  const fileName = syncActiveFile(path, content)
  const program = languageService.getProgram()
  if (!program) return []

  const projectFiles = program.getSourceFiles().filter(sourceFile => {
    const normalized = normalizePath(sourceFile.fileName)
    if (!isProjectFile(normalized)) return false
    const file = files.get(normalized)
    return !file?.bundled
  })

  const diagnostics = uniqueDiagnostics(projectFiles.flatMap((sourceFile) => [
    ...languageService.getSyntacticDiagnostics(sourceFile.fileName),
    ...languageService.getSemanticDiagnostics(sourceFile.fileName),
    ...languageService.getSuggestionDiagnostics(sourceFile.fileName),
  ]))

  return diagnostics.map((diagnostic) => ({
    path: (diagnostic.file?.fileName ?? fileName).replace(/^\//, ''),
    range: rangeFromDiagnostic(diagnostic),
    severity: severity(diagnostic.category),
    message: diagnosticMessage(diagnostic.messageText),
    source: diagnostic.source ?? 'typescript',
    code: diagnostic.code,
  }))
}

function wordStart(content: string, offset: number): number {
  let pos = Math.max(0, Math.min(offset, content.length))
  while (pos > 0 && /[\w$]/.test(content[pos - 1])) pos--
  return pos
}

function completionType(kind: string): string {
  switch (kind) {
    case ts.ScriptElementKind.classElement: return 'class'
    case ts.ScriptElementKind.constElement: return 'constant'
    case ts.ScriptElementKind.enumElement: return 'enum'
    case ts.ScriptElementKind.functionElement: return 'function'
    case ts.ScriptElementKind.interfaceElement: return 'interface'
    case ts.ScriptElementKind.keyword: return 'keyword'
    case ts.ScriptElementKind.memberFunctionElement: return 'method'
    case ts.ScriptElementKind.memberVariableElement: return 'property'
    case ts.ScriptElementKind.moduleElement: return 'namespace'
    case ts.ScriptElementKind.typeElement: return 'type'
    case ts.ScriptElementKind.variableElement: return 'variable'
    default: return 'text'
  }
}

function getCompletion(path: string, content: string, offset: number): LspCompletionResult | null {
  const fileName = syncActiveFile(path, content)
  const info = languageService.getCompletionsAtPosition(fileName, offset, {
    allowIncompleteCompletions: true,
    allowRenameOfImportPath: true,
    includeAutomaticOptionalChainCompletions: true,
    includeCompletionsForImportStatements: true,
    includeCompletionsForModuleExports: true,
    includeCompletionsWithClassMemberSnippets: true,
    includeCompletionsWithInsertText: true,
    includeCompletionsWithSnippetText: false,
  })

  if (!info || info.entries.length === 0) return null

  const replacement = info.optionalReplacementSpan
  const from = replacement ? replacement.start : wordStart(content, offset)
  const to = replacement ? replacement.start + replacement.length : offset
  const options: LspCompletion[] = info.entries.slice(0, 300).map(entry => ({
    label: entry.name,
    detail: entry.source ? `${entry.kind} from ${entry.source}` : entry.kind,
    type: completionType(entry.kind),
    apply: entry.insertText || entry.name,
  }))

  return { from, to, options, isIncomplete: info.isIncomplete }
}

function displayParts(parts: ts.SymbolDisplayPart[] | undefined): string {
  return parts?.map(part => part.text).join('') ?? ''
}

function getHover(path: string, content: string, offset: number): LspHover | null {
  const fileName = syncActiveFile(path, content)
  const info = languageService.getQuickInfoAtPosition(fileName, offset)
  if (!info) return null

  const source = languageService.getProgram()?.getSourceFile(fileName)
  if (!source) return null

  const signature = displayParts(info.displayParts)
  const docs = displayParts(info.documentation)
  const tags = info.tags?.map(tag => `@${tag.name}${tag.text ? ` ${displayParts(tag.text)}` : ''}`).join('\n') ?? ''
  const contents = [signature, docs, tags].filter(Boolean).join('\n\n').trim()
  if (!contents) return null

  return {
    range: lineRangeForTextSpan(source, info.textSpan),
    contents,
  }
}

function definitionTarget(fileName: string, textSpan: ts.TextSpan): LspDefinitionTarget | null {
  const normalized = normalizePath(fileName)
  if (normalized.startsWith(BUNDLED_PREFIX)) return null
  const source = languageService.getProgram()?.getSourceFile(normalized)
  const content = readFile(normalized)
  if (!source || content === undefined) return null
  const range = lineRangeForTextSpan(source, textSpan)
  return {
    path: normalized.replace(/^\//, ''),
    line: range.start.line,
    character: range.start.character,
    range,
  }
}

function getDefinition(path: string, content: string, offset: number): LspDefinitionTarget | null {
  const fileName = syncActiveFile(path, content)
  const definitions = languageService.getDefinitionAtPosition(fileName, offset)
  if (!definitions?.length) return null

  for (const definition of definitions) {
    const target = definitionTarget(definition.fileName, definition.textSpan)
    if (target) return target
  }

  return null
}

function handleRequest(request: WorkerRequest): unknown {
  switch (request.type) {
    case 'resetProject':
      resetProject()
      return null
    case 'upsertFiles':
      for (const file of request.payload.files) upsertFile(file.path, file.content)
      return null
    case 'diagnostics':
      return getDiagnostics(request.payload.path, request.payload.content)
    case 'completion':
      return getCompletion(request.payload.path, request.payload.content, request.payload.offset)
    case 'hover':
      return getHover(request.payload.path, request.payload.content, request.payload.offset)
    case 'definition':
      return getDefinition(request.payload.path, request.payload.content, request.payload.offset)
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    const result = handleRequest(request)
    self.postMessage({ id: request.id, ok: true, result } satisfies WorkerResponse)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    self.postMessage({ id: request.id, ok: false, error } satisfies WorkerResponse)
  }
}
