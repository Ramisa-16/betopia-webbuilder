import { invoke } from '@tauri-apps/api/core'
import { createProxyFetch } from './proxyFetch'
import { readProjectFile } from './fs'
import { stripFileUri } from './path'

const fetchUrl = createProxyFetch({ allowPrivateNetwork: true })
const DEFAULT_MAX_URLS = 3
const DEFAULT_MAX_CHARS = 8_000

function trimTrailingPunctuation(raw: string): string {
  let value = raw.trim()
  while (/[),.;!?]$/.test(value)) value = value.slice(0, -1)
  return value
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n...[truncated ${text.length - maxChars} chars]`
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function sanitizeBinaryText(text: string): string {
  return text
    .replace(/[^\t\n\r\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeFileTarget(raw: string): string {
  const trimmed = trimTrailingPunctuation(raw)
  if (/^file:/i.test(trimmed)) {
    try {
      return decodeURIComponent(stripFileUri(trimmed))
    } catch {
      return stripFileUri(trimmed)
    }
  }
  return trimmed
}

function looksLikeLocalPath(target: string): boolean {
  if (!target) return false
  if (/^[A-Za-z]:[\\/]/.test(target)) return true
  if (target.startsWith('/')) return true
  if (/^\.{1,2}[\\/]/.test(target)) return true
  return /^[^:\s<>"'`]+\.[A-Za-z0-9]{1,8}(?:[\\/][^:\s<>"'`]+\.[A-Za-z0-9]{1,8})*$/.test(target)
}

function extractLocalPaths(text: string): string[] {
  const matches = text.match(
    /file:\/\/[^\s<>"']+|[A-Za-z]:[\\/][^\s<>"']+|(?<![:/])\/[^\s<>"']+|\.{1,2}[\\/][^\s<>"']+|[^:\s<>"'`]+\.[A-Za-z0-9]{1,8}(?:[\\/][^:\s<>"'`]+\.[A-Za-z0-9]{1,8})*/gi,
  ) ?? []

  const seen = new Set<string>()
  const paths: string[] = []
  for (const match of matches) {
    const normalized = normalizeFileTarget(match)
    if (!looksLikeLocalPath(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    paths.push(normalized)
  }
  return paths
}

function collectHeadings(doc: Document, limit = 8): string[] {
  return Array.from(doc.querySelectorAll('h1, h2, h3, h4'))
    .map(node => normalizeWhitespace(node.textContent ?? ''))
    .filter(Boolean)
    .slice(0, limit)
}

function collectLinks(doc: Document, baseUrl: string, limit = 8): string[] {
  const links: string[] = []
  for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = anchor.getAttribute('href')?.trim()
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue
    try {
      const absolute = new URL(href, baseUrl).toString()
      if (!links.includes(absolute)) links.push(absolute)
    } catch {
      continue
    }
    if (links.length >= limit) break
  }
  return links
}

function collectUrlFromElementAttr(
  doc: Document,
  selector: string,
  attributeNames: string[],
  baseUrl: string,
  limit: number,
): string[] {
  const links: string[] = []
  for (const node of Array.from(doc.querySelectorAll<HTMLElement>(selector))) {
    const rawValue = attributeNames
      .map(attr => node.getAttribute(attr))
      .find(Boolean)
      ?.trim()
    if (!rawValue || rawValue.startsWith('data:') || rawValue.startsWith('javascript:')) continue
    const value = rawValue.split(',')[0]?.trim()
    if (!value || value.startsWith('data:') || value.startsWith('javascript:')) continue
    try {
      const absolute = new URL(value, baseUrl).toString()
      if (!links.includes(absolute)) links.push(absolute)
    } catch {
      continue
    }
    if (links.length >= limit) break
  }
  return links
}

function collectStylesheetLinks(doc: Document, baseUrl: string, limit = 6): string[] {
  const links: string[] = []
  for (const node of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel]'))) {
    const rel = (node.getAttribute('rel') ?? '').toLowerCase()
    if (!rel.includes('stylesheet')) continue
    const href = node.getAttribute('href')?.trim()
    if (!href) continue
    try {
      const absolute = new URL(href, baseUrl).toString()
      if (!links.includes(absolute)) links.push(absolute)
    } catch {
      continue
    }
    if (links.length >= limit) break
  }
  return links
}

function collectAssetLinks(doc: Document, baseUrl: string, limit = 12): string[] {
  const links = [
    ...collectUrlFromElementAttr(doc, 'img[src], img[data-src], img[srcset], source[src], source[srcset], video[poster]', ['src', 'data-src', 'srcset', 'poster'], baseUrl, limit),
    ...collectUrlFromElementAttr(doc, 'link[rel~="icon"][href]', ['href'], baseUrl, limit),
    ...collectUrlFromElementAttr(doc, 'meta[property="og:image"][content], meta[name="twitter:image"][content], meta[name="twitter:image:src"][content]', ['content'], baseUrl, limit),
  ]

  const unique: string[] = []
  for (const link of links) {
    if (!unique.includes(link)) unique.push(link)
    if (unique.length >= limit) break
  }
  return unique
}

function collectPageStructure(doc: Document, limit = 12): string[] {
  const semanticSelectors = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'form', 'button', 'input', 'textarea', 'select']
  const summary: string[] = []

  for (const selector of semanticSelectors) {
    const count = doc.querySelectorAll(selector).length
    if (count > 0) summary.push(`${selector}: ${count}`)
  }

  const headingText = Array.from(doc.querySelectorAll('h1, h2, h3'))
    .map(node => normalizeWhitespace(node.textContent ?? ''))
    .filter(Boolean)
    .slice(0, 5)

  if (headingText.length > 0) summary.push(`Key headings:\n- ${headingText.join('\n- ')}`)

  const navItems = Array.from(doc.querySelectorAll('nav a, header a, button, [role="button"]'))
    .map(node => normalizeWhitespace(node.textContent ?? ''))
    .filter(Boolean)
    .slice(0, limit)

  if (navItems.length > 0) summary.push(`Primary controls:\n- ${navItems.join('\n- ')}`)

  return summary
}

function summarizeStyleDeclaration(styleText: string, maxProps = 10): string {
  const interestingOrder = [
    'display',
    'position',
    'top',
    'right',
    'bottom',
    'left',
    'z-index',
    'gap',
    'row-gap',
    'column-gap',
    'align-items',
    'justify-content',
    'flex',
    'flex-direction',
    'grid',
    'grid-template-columns',
    'grid-template-rows',
    'padding',
    'margin',
    'width',
    'height',
    'max-width',
    'min-width',
    'max-height',
    'min-height',
    'border',
    'border-radius',
    'background',
    'background-color',
    'background-image',
    'box-shadow',
    'color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'letter-spacing',
    'text-transform',
    'text-align',
    'object-fit',
    'overflow',
    'opacity',
    'transform',
    'transition',
  ]

  const map = new Map<string, string>()
  for (const part of styleText.split(';')) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const prop = part.slice(0, idx).trim().toLowerCase()
    const value = part.slice(idx + 1).trim()
    if (!prop || !value) continue
    if (!interestingOrder.includes(prop)) continue
    map.set(prop, value)
  }

  const ordered = interestingOrder
    .filter(prop => map.has(prop))
    .slice(0, maxProps)
    .map(prop => `${prop}: ${map.get(prop)}`)

  return ordered.join('; ')
}

function collectInlineStyleHints(doc: Document, limit = 12): string[] {
  const selectors = ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'form', 'button', 'a[href]', 'img', '[style]']
  const seen = new Set<Element>()
  const hints: string[] = []

  for (const selector of selectors) {
    for (const node of Array.from(doc.querySelectorAll<HTMLElement>(selector))) {
      if (seen.has(node)) continue
      seen.add(node)
      const style = node.getAttribute('style')?.trim()
      const summary = style ? summarizeStyleDeclaration(style) : ''
      const text = normalizeWhitespace(node.textContent ?? '').slice(0, 120)
      const id = node.id ? `#${node.id}` : ''
      const classes = node.classList.length > 0 ? `.${Array.from(node.classList).slice(0, 3).join('.')}` : ''
      const descriptor = `${node.tagName.toLowerCase()}${id}${classes}`.trim()
      if (!descriptor) continue
      const parts: string[] = [descriptor]
      if (text) parts.push(`text="${text}"`)
      if (summary) parts.push(`style="${summary}"`)
      if (parts.length > 1) hints.push(parts.join(' | '))
      if (hints.length >= limit) return hints
    }
  }

  return hints
}

function collectEmbeddedStyleSummaries(doc: Document, limit = 3): string[] {
  const summaries: string[] = []
  for (const styleNode of Array.from(doc.querySelectorAll('style'))) {
    const cssText = normalizeWhitespace(styleNode.textContent ?? '')
    if (!cssText) continue
    const summary = summarizeCss(cssText, 8, 6)
    if (summary) summaries.push(truncate(summary, 2_000))
    if (summaries.length >= limit) break
  }
  return summaries
}

function collectCssAssetUrls(css: string, baseUrl: string, limit = 12): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const raw = match[2]?.trim()
    if (!raw || raw.startsWith('data:') || raw.startsWith('javascript:')) continue
    try {
      const absolute = new URL(raw, baseUrl).toString()
      if (!seen.has(absolute)) {
        seen.add(absolute)
        urls.push(absolute)
      }
    } catch {
      continue
    }
    if (urls.length >= limit) break
  }
  return urls
}

function summarizeCss(css: string, maxVars = 10, maxRules = 8): string {
  const cleaned = css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const vars = Array.from(cleaned.matchAll(/--([A-Za-z0-9_-]+)\s*:\s*([^;}{]+);/g))
    .slice(0, maxVars)
    .map((match) => `--${match[1]}: ${match[2].trim()}`)

  const ruleMatches = Array.from(cleaned.matchAll(/([^{}@]+)\{([^{}]+)\}/g))
  const usefulRules: string[] = []
  for (const [, selectorRaw, bodyRaw] of ruleMatches) {
    const selector = selectorRaw.trim().replace(/\s+/g, ' ')
    if (!selector || selector.length > 120) continue
    const body = bodyRaw.trim()
    const interesting = [
      /display\s*:/i,
      /position\s*:/i,
      /flex/i,
      /grid/i,
      /gap\s*:/i,
      /padding\s*:/i,
      /margin\s*:/i,
      /background/i,
      /font/i,
      /border/i,
      /box-shadow/i,
    ].some(pattern => pattern.test(body))
    if (!interesting) continue
    usefulRules.push(`${selector} { ${body.replace(/\s+/g, ' ').slice(0, 220)} }`)
    if (usefulRules.length >= maxRules) break
  }

  const parts: string[] = []
  if (vars.length > 0) parts.push(`CSS variables:\n- ${vars.join('\n- ')}`)
  if (usefulRules.length > 0) parts.push(`Style rules:\n- ${usefulRules.join('\n- ')}`)
  return parts.join('\n')
}

async function extractHtmlReadableContent(html: string, baseUrl: string, maxChars: number): Promise<{
  title: string
  description: string
  headings: string[]
  structure: string[]
  links: string[]
  stylesheetLinks: string[]
  assets: string[]
  cssAssets: string[]
  inlineStyles: string[]
  embeddedStyles: string[]
  cssSummary: string
  text: string
}> {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  doc.querySelectorAll('script, style, noscript, template, svg, canvas, iframe').forEach(node => node.remove())

  const title = normalizeWhitespace(doc.title ?? '')
  const description = normalizeWhitespace(doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? '')
  const headings = collectHeadings(doc)
  const structure = collectPageStructure(doc)
  const links = collectLinks(doc, baseUrl)
  const stylesheetLinks = collectStylesheetLinks(doc, baseUrl)
  const assets = collectAssetLinks(doc, baseUrl)
  const inlineStyles = collectInlineStyleHints(doc)
  const embeddedStyles = collectEmbeddedStyleSummaries(doc)
  const bodyText = normalizeWhitespace(doc.body?.innerText || doc.documentElement?.textContent || html)

  const cssSnippets: string[] = []
  const cssAssetLinks: string[] = []
  for (const stylesheetUrl of stylesheetLinks.slice(0, 4)) {
    try {
      const response = await fetchUrl(stylesheetUrl, { headers: { Accept: 'text/css,*/*;q=0.8' } })
      if (!response.ok) continue
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (contentType.includes('text') || contentType.includes('css') || contentType.includes('plain') || contentType === '') {
        const cssText = await response.text()
        const summary = summarizeCss(cssText)
        if (summary) {
          cssSnippets.push(`Stylesheet: ${stylesheetUrl}\n${truncate(summary, Math.max(1_000, Math.min(maxChars, 3_000)))}`)
        }
        for (const assetUrl of collectCssAssetUrls(cssText, stylesheetUrl)) {
          if (!cssAssetLinks.includes(assetUrl)) cssAssetLinks.push(assetUrl)
        }
      }
    } catch {
      continue
    }
  }

  const cssSummary = cssSnippets.join('\n\n')

  return {
    title,
    description,
    headings,
    structure,
    links,
    stylesheetLinks,
    assets,
    cssAssets: cssAssetLinks,
    inlineStyles,
    embeddedStyles,
    cssSummary,
    text: bodyText,
  }
}

function parseJsonReadableContent(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function extractHttpUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? []
  const seen = new Set<string>()
  const urls: string[] = []
  for (const match of matches) {
    const normalized = trimTrailingPunctuation(match)
    try {
      const url = new URL(normalized).toString()
      if (!seen.has(url)) {
        seen.add(url)
        urls.push(url)
      }
    } catch {
      continue
    }
  }
  return urls
}

function isHttpUrl(target: string): boolean {
  return /^https?:\/\//i.test(target)
}

function isFileLikeTarget(target: string): boolean {
  return /^file:/i.test(target) || looksLikeLocalPath(target)
}

function normalizeLocalFsPath(target: string): string {
  return normalizeFileTarget(target)
    .replace(/\\/g, '/')
    .replace(/^\/([A-Za-z]:\/)/, '$1')
}

function resolveLocalDisplayPath(target: string, projectPath?: string): string {
  const normalized = normalizeLocalFsPath(target)
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('/')
  if (projectPath && !isAbsolute) {
    return `${projectPath.replace(/\\/g, '/')}/${normalized.replace(/^\.\/+/, '').replace(/^\/+/, '')}`.replace(/\/+/g, '/')
  }
  return normalized
}

function isLikelyDirectoryTarget(path: string): boolean {
  return !path.includes('.')
}

function normalizeRelativeTarget(path: string): string {
  return normalizeLocalFsPath(path).replace(/^\.\/+/, '').replace(/^\/+/, '')
}

type LocalDirEntry = { name?: string; isDirectory?: boolean; is_dir?: boolean }

function isDirEntry(entry: LocalDirEntry): boolean {
  return Boolean(entry.isDirectory ?? entry.is_dir)
}

async function readLocalDirectoryTree(rootAbsPath: string, displayPath: string, maxChars: number): Promise<string> {
  const MAX_DEPTH = 4
  const MAX_FILES = 24
  const MAX_ENTRIES_PER_DIR = 40
  const MAX_FILE_PREVIEW = Math.max(500, Math.min(maxChars, 2_000))
  let filesShown = 0
  let dirsShown = 0

  const formatNode = async (absPath: string, shownPath: string, depth: number): Promise<string> => {
    if (depth > MAX_DEPTH) return `${'  '.repeat(depth)}...`

    let entries: LocalDirEntry[]
    try {
      entries = await invoke<LocalDirEntry[]>('fs_read_dir', { root: absPath, respectGitignore: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Unable to read directory: ${message}`)
    }

    const sorted = [...entries]
      .filter(entry => Boolean(entry.name))
      .sort((a, b) => {
        const aDir = isDirEntry(a)
        const bDir = isDirEntry(b)
        if (aDir !== bDir) return aDir ? -1 : 1
        return String(a.name).localeCompare(String(b.name))
      })
      .slice(0, MAX_ENTRIES_PER_DIR)

    const lines: string[] = []
    for (const entry of sorted) {
      const name = String(entry.name ?? '').trim()
      if (!name) continue

      const childAbs = `${absPath.replace(/\/$/, '')}/${name}`.replace(/\/+/g, '/')
      const childShown = `${shownPath.replace(/\/$/, '')}/${name}`.replace(/\/+/g, '/')
      const indent = '  '.repeat(depth)

      if (isDirEntry(entry)) {
        dirsShown++
        lines.push(`${indent}${name}/`)
        if (filesShown + dirsShown >= MAX_FILES) {
          lines.push(`${indent}  ...`)
          continue
        }
        lines.push(await formatNode(childAbs, childShown, depth + 1))
        continue
      }

      filesShown++
      lines.push(`${indent}${name}`)
      if (filesShown >= MAX_FILES) {
        lines.push(`${indent}  ...`)
        continue
      }

      try {
        const content = await invoke<string>('fs_read_file', { path: childAbs })
        const extension = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
        const preview = extension === 'json'
          ? normalizeWhitespace(parseJsonReadableContent(content))
          : normalizeWhitespace(content)
        lines.push(`${indent}  Readable content:`)
        lines.push(truncate(preview || '(empty file)', MAX_FILE_PREVIEW).split('\n').map(line => `${indent}  ${line}`).join('\n'))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        lines.push(`${indent}  Error reading file: ${message}`)
      }
    }

    return lines.join('\n')
  }

  const tree = await formatNode(rootAbsPath, displayPath, 0)
  return [
    `Path: ${displayPath}`,
    'Type: folder',
    'Contents:',
    tree || '(empty folder)',
  ].join('\n')
}

async function readLocalReadableContent(target: string, maxChars: number, projectPath?: string): Promise<string> {
  const normalized = normalizeLocalFsPath(target)
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith('/')
  const relativeTarget = normalizeRelativeTarget(target)
  const filePath = projectPath && !isAbsolute
    ? `${projectPath.replace(/\\/g, '/')}/${relativeTarget}`.replace(/\/+/g, '/')
    : normalized
  const displayPath = resolveLocalDisplayPath(target, projectPath)

  if (isLikelyDirectoryTarget(normalized)) {
    try {
      return await readLocalDirectoryTree(filePath, displayPath, maxChars)
    } catch {
      // Fall through and try as a file. Some files do not have extensions.
    }
  }

  let content: string
  if (projectPath && !isAbsolute) {
    content = await readProjectFile(projectPath, relativeTarget)
  } else {
    content = await invoke<string>('fs_read_file', { path: filePath })
  }

  const extension = filePath.includes('.') ? filePath.split('.').pop()!.toLowerCase() : ''
  if (extension === 'json') {
    return [
      `Path: ${displayPath}`,
      'Content-Type: application/json',
      'Readable content:',
      truncate(normalizeWhitespace(parseJsonReadableContent(content)), maxChars),
    ].join('\n')
  }

  return [
    `Path: ${displayPath}`,
    'Readable content:',
    truncate(normalizeWhitespace(content), maxChars),
  ].join('\n')
}

export async function fetchReadableUrlContext(
  url: string,
  maxChars = DEFAULT_MAX_CHARS,
  projectPath?: string,
): Promise<string> {
  const target = normalizeFileTarget(url)

  if (isFileLikeTarget(target)) {
    try {
      return await readLocalReadableContent(target, maxChars, projectPath)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return `Path: ${resolveLocalDisplayPath(target, projectPath)}\nError reading local file: ${message}`
    }
  }

  if (!isHttpUrl(target)) {
    return `Unsupported link type: ${target}`
  }

  const safeUrl = trimTrailingPunctuation(target)
  const res = await fetchUrl(safeUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.8',
    },
  })

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const rawText = await res.text()
  const fallbackText = sanitizeBinaryText(rawText)
  const preview = truncate(fallbackText, maxChars)

  if (!res.ok) {
    return [
      `URL: ${safeUrl}`,
      `Status: ${res.status} ${res.statusText || ''}`.trim(),
      contentType ? `Content-Type: ${contentType}` : null,
      preview ? `Body:\n${preview}` : null,
    ].filter(Boolean).join('\n')
  }

  if (contentType.includes('json')) {
    return [
      `URL: ${safeUrl}`,
      `Content-Type: ${contentType || 'application/json'}`,
      'Readable content:',
      truncate(normalizeWhitespace(parseJsonReadableContent(rawText)), maxChars),
    ].join('\n')
  }

  if (contentType.includes('html') || contentType.includes('xml')) {
    const extracted = await extractHtmlReadableContent(rawText, safeUrl, maxChars)
    const sections: string[] = [
      `URL: ${safeUrl}`,
      `Content-Type: ${contentType || 'text/html'}`,
    ]
    if (extracted.title) sections.push(`Title: ${extracted.title}`)
    if (extracted.description) sections.push(`Description: ${extracted.description}`)
    if (extracted.headings.length > 0) sections.push(`Headings:\n- ${extracted.headings.join('\n- ')}`)
    if (extracted.structure.length > 0) sections.push(`Page structure:\n- ${extracted.structure.join('\n- ')}`)
    if (extracted.links.length > 0) sections.push(`Links:\n- ${extracted.links.join('\n- ')}`)
    if (extracted.stylesheetLinks.length > 0) sections.push(`Stylesheets:\n- ${extracted.stylesheetLinks.join('\n- ')}`)
    if (extracted.assets.length > 0) sections.push(`Assets:\n- ${extracted.assets.join('\n- ')}`)
    if (extracted.cssAssets.length > 0) sections.push(`CSS assets:\n- ${extracted.cssAssets.join('\n- ')}`)
    if (extracted.inlineStyles.length > 0) sections.push(`Inline style hints:\n- ${extracted.inlineStyles.join('\n- ')}`)
    if (extracted.embeddedStyles.length > 0) sections.push(`Embedded styles:\n- ${extracted.embeddedStyles.join('\n- ')}`)
    if (extracted.cssSummary) sections.push(`Style hints:\n${truncate(extracted.cssSummary, maxChars)}`)
    sections.push('Readable content:', truncate(extracted.text || preview || '(no readable text extracted)', maxChars))
    return sections.join('\n')
  }

  if (contentType.startsWith('text/') || contentType.includes('markdown') || contentType.includes('csv') || contentType.includes('yaml') || contentType.includes('toml') || contentType.includes('javascript')) {
    return [
      `URL: ${safeUrl}`,
      `Content-Type: ${contentType || 'text/plain'}`,
      'Readable content:',
      truncate(normalizeWhitespace(rawText), maxChars),
    ].join('\n')
  }

  return [
    `URL: ${safeUrl}`,
    contentType ? `Content-Type: ${contentType}` : 'Content-Type: unknown',
    'Readable content (best effort):',
    truncate(preview || rawText || '(no readable text extracted)', maxChars),
  ].join('\n')
}

export async function buildUrlContextBlock(
  text: string,
  opts: { projectPath?: string; maxUrls?: number; maxCharsPerUrl?: number } = {},
): Promise<string | null> {
  const urls = extractHttpUrls(text)
  const localTargets = extractLocalPaths(text)
  if (urls.length === 0 && localTargets.length === 0) return null

  const maxTargets = Math.max(1, opts.maxUrls ?? DEFAULT_MAX_URLS)
  const maxCharsPerTarget = Math.max(500, opts.maxCharsPerUrl ?? DEFAULT_MAX_CHARS)
  const targets = [...urls, ...localTargets].slice(0, maxTargets)
  const sections: string[] = []

  for (const target of targets) {
    try {
      sections.push(await fetchReadableUrlContext(target, maxCharsPerTarget, opts.projectPath))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sections.push(`${isFileLikeTarget(target) ? 'Path' : 'URL'}: ${target}\nError reading link: ${message}`)
    }
  }

  if (sections.length === 0) return null

  const remaining = urls.length + localTargets.length - sections.length
  return [
    '[URL CONTEXT]',
    'The user included one or more links or file paths. Inspect the readable content below before answering.',
    ...sections,
    remaining > 0 ? `...and ${remaining} more link(s) were omitted for brevity.` : null,
  ].filter(Boolean).join('\n\n')
}
