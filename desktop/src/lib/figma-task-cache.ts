type FigmaRequestKind = 'tool' | 'resource'

export interface FigmaTaskContextInput {
  sessionId: string | null
  taskId: string
  userText?: string
}

export interface FigmaRequestDescriptor {
  kind: FigmaRequestKind
  serverName: string
  toolName: string
  args: Record<string, unknown>
  rawArgsJson?: string
  resourceUri?: string
}

interface FigmaNode {
  id?: string
  name?: string
  type?: string
  children?: FigmaNode[]
}

interface FigmaFileResponse {
  document?: FigmaNode
}

interface FigmaRequestTarget {
  fileKey: string | null
  nodeId: string | null
  refresh: boolean
  isAssetExport: boolean
}

interface CacheEntry {
  output: string
  timestamp: number
}

const FIGMA_SERVER_RE = /figma/i
const FIGMA_FILE_PATH_RE = /\/(?:file|design|proto)\/([^/?#]+)/i
const FIGMA_NODE_ID_RE = /[?&#]node-id=([^&#]+)/i
const FIGMA_ASSET_TOOL_RE = /\b(export|download|asset|image|screenshot)\b/i
const FIGMA_RATE_LIMIT_RE = /(rate[-\s]?limit|too many requests|429|quota exceeded|throttl)/i
const MAX_TOP_LEVEL_TARGETS = 12
const MAX_CHILDREN_PER_TOP_LEVEL = 20
const MAX_RESPONSE_CHARS = 120_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function findStringField(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(args[key])
    if (value) return value
  }
  return null
}

function booleanField(args: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    const value = args[key]
    if (value === true || value === 'true' || value === '1') return true
  }
  return false
}

function parseFigmaUrl(value: string): { fileKey: string | null; nodeId: string | null; refresh: boolean } {
  const fileKey = value.match(FIGMA_FILE_PATH_RE)?.[1] ?? null
  const nodeId = value.match(FIGMA_NODE_ID_RE)?.[1]
  return {
    fileKey,
    nodeId: nodeId ? decodeURIComponent(nodeId) : null,
    refresh: /[?&#](?:refresh|reload|force|nocache|no-cache)=?(?:1|true|yes)?/i.test(value),
  }
}

function firstFigmaUrlText(args: Record<string, unknown>, rawArgsJson?: string, resourceUri?: string, userText?: string): string | null {
  const candidates = [
    resourceUri,
    findStringField(args, ['url', 'uri', 'figmaUrl', 'figma_url', 'fileUrl', 'file_url']),
    rawArgsJson,
    userText,
  ]
  return candidates.find(value => typeof value === 'string' && /figma\.com|figma:\/\//i.test(value)) ?? null
}

function resolveTarget(
  descriptor: FigmaRequestDescriptor,
  userText: string,
): FigmaRequestTarget {
  const urlText = firstFigmaUrlText(descriptor.args, descriptor.rawArgsJson, descriptor.resourceUri, userText)
  const parsedUrl = urlText ? parseFigmaUrl(urlText) : { fileKey: null, nodeId: null, refresh: false }
  const fileKey = findStringField(descriptor.args, ['fileKey', 'file_key', 'documentKey', 'document_key']) ?? parsedUrl.fileKey
  const nodeId = findStringField(descriptor.args, ['nodeId', 'node_id', 'frameId', 'frame_id', 'pageId', 'page_id']) ?? parsedUrl.nodeId
  return {
    fileKey,
    nodeId,
    refresh: parsedUrl.refresh || booleanField(descriptor.args, ['refresh', 'reload', 'force', 'noCache', 'nocache', 'bypassCache']),
    isAssetExport: FIGMA_ASSET_TOOL_RE.test(descriptor.toolName),
  }
}

function parseFigmaFileResponse(output: string): FigmaFileResponse | null {
  const trimmed = output.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    return isPlainObject(parsed) ? parsed as FigmaFileResponse : null
  } catch {
    return null
  }
}

function childrenOf(node: FigmaNode | undefined): FigmaNode[] {
  return Array.isArray(node?.children) ? node.children : []
}

function findNode(node: FigmaNode | undefined, nodeId: string): FigmaNode | null {
  if (!node) return null
  if (node.id === nodeId) return node
  for (const child of childrenOf(node)) {
    const found = findNode(child, nodeId)
    if (found) return found
  }
  return null
}

function summarizeNode(node: FigmaNode): Record<string, unknown> {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    childCount: childrenOf(node).length,
    children: childrenOf(node).slice(0, MAX_CHILDREN_PER_TOP_LEVEL).map(child => ({
      id: child.id,
      name: child.name,
      type: child.type,
      childCount: childrenOf(child).length,
    })),
  }
}

function buildTargetSelection(fileKey: string | null, document: FigmaNode, reason: string): string {
  const targets = childrenOf(document).slice(0, MAX_TOP_LEVEL_TARGETS)
  const lines = [
    fileKey ? `Figma file ${fileKey} needs a target frame/page.` : 'Figma file needs a target frame/page.',
    reason,
    'Pick a target frame/page, or paste a Figma URL that includes node-id.',
  ]
  if (targets.length > 0) {
    lines.push('Available targets:')
    for (const target of targets) {
      lines.push(`- ${target.name ?? target.id ?? 'Untitled'}${target.type ? ` (${target.type})` : ''}${target.id ? ` [${target.id}]` : ''}`)
    }
  }
  return lines.join('\n')
}

function prepareDesignOutput(output: string, target: FigmaRequestTarget): string {
  const parsed = parseFigmaFileResponse(output)
  const document = parsed?.document
  if (!document) return output

  if (target.nodeId) {
    const node = findNode(document, target.nodeId)
    if (node) {
      return JSON.stringify({ fileKey: target.fileKey, target: summarizeNode(node) }, null, 2)
    }
  }

  const topLevelCount = childrenOf(document).length
  if (output.length > MAX_RESPONSE_CHARS || topLevelCount > MAX_TOP_LEVEL_TARGETS) {
    const reason = output.length > MAX_RESPONSE_CHARS
      ? `The Figma response is ${output.length.toLocaleString()} characters.`
      : `The file has ${topLevelCount} top-level pages/frames.`
    return buildTargetSelection(target.fileKey, document, reason)
  }

  return output
}

function isRateLimit(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '')
  return FIGMA_RATE_LIMIT_RE.test(message)
}

function rateLimitMessage(fileKey: string | null): string {
  return [
    fileKey ? `Figma file ${fileKey} hit a rate limit.` : 'Figma hit a rate limit.',
    'Stop retrying this task. Retry later, use a screenshot, or export PNG/SVG manually.',
  ].join('\n')
}

function cacheKey(sessionId: string | null, taskId: string, target: FigmaRequestTarget, descriptor: FigmaRequestDescriptor): string {
  if (target.isAssetExport) {
    return [
      'asset',
      sessionId ?? 'no-session',
      taskId,
      descriptor.serverName,
      descriptor.toolName,
      JSON.stringify(descriptor.args),
      descriptor.resourceUri ?? '',
    ].join('|')
  }
  return [
    'design',
    sessionId ?? 'no-session',
    taskId,
    target.fileKey ?? 'unknown-file',
    target.nodeId ?? 'root',
  ].join('|')
}

export class FigmaTaskCache {
  private readonly sessionId: string | null
  private readonly taskId: string
  private readonly userText: string
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<string>>()
  private rateLimitedFileKey: string | null = null

  constructor(input: FigmaTaskContextInput) {
    this.sessionId = input.sessionId
    this.taskId = input.taskId
    this.userText = input.userText ?? ''
  }

  async run(descriptor: FigmaRequestDescriptor, execute: () => Promise<string>): Promise<string> {
    if (!FIGMA_SERVER_RE.test(descriptor.serverName)) return execute()

    const target = resolveTarget(descriptor, this.userText)
    const key = cacheKey(this.sessionId, this.taskId, target, descriptor)

    if (this.rateLimitedFileKey && !target.refresh) {
      return rateLimitMessage(this.rateLimitedFileKey)
    }

    if (!target.refresh) {
      const cached = this.cache.get(key)
      if (cached) return cached.output
      const pending = this.inflight.get(key)
      if (pending) return pending
    }

    const pending = (async () => {
      try {
        const raw = await execute()
        if (isRateLimit(raw)) {
          this.rateLimitedFileKey = target.fileKey
          return rateLimitMessage(target.fileKey)
        }
        if (/^(Error:|Permission denied:|Aborted$)/i.test(raw.trim())) return raw

        const output = target.isAssetExport ? raw : prepareDesignOutput(raw, target)
        this.cache.set(key, { output, timestamp: Date.now() })
        return output
      } catch (err) {
        if (isRateLimit(err)) {
          this.rateLimitedFileKey = target.fileKey
          return rateLimitMessage(target.fileKey)
        }
        throw err
      }
    })()

    this.inflight.set(key, pending)
    try {
      return await pending
    } finally {
      this.inflight.delete(key)
    }
  }
}

export function createFigmaTaskCache(input: FigmaTaskContextInput): FigmaTaskCache {
  return new FigmaTaskCache(input)
}

export const __test__ = {
  parseFigmaUrl,
  resolveTarget,
  prepareDesignOutput,
  isRateLimit,
}
