import type { Attachment } from '@/types'

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type OcradFn = (image: HTMLCanvasElement | HTMLImageElement) => string

const DEFAULT_MAX_CHARS = 8_000
const IMAGE_OCR_MAX_DIM = 2200
const TEXTUAL_EXTENSIONS = new Set([
  'css', 'csv', 'html', 'htm', 'ini', 'js', 'jsx', 'json', 'md', 'markdown', 'mjs',
  'sh', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml',
])
const IMAGE_EXTENSIONS = new Set([
  'avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'webp',
])

const TEXTUAL_MIME_PREFIXES = ['text/']
const TEXTUAL_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/javascript',
  'application/ecmascript',
  'application/xml',
  'application/xhtml+xml',
  'application/yaml',
  'application/x-yaml',
  'application/csv',
  'application/rtf',
])

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '')
  const bin = atob(clean)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function getExtension(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase()
}

function isImageAttachment(att: Attachment): boolean {
  const mime = att.mimeType.toLowerCase()
  if (mime.startsWith('image/')) return true
  return IMAGE_EXTENSIONS.has(getExtension(att.name))
}

function isTextualAttachment(att: Attachment): boolean {
  const mime = att.mimeType.toLowerCase()
  if (TEXTUAL_MIME_PREFIXES.some(prefix => mime.startsWith(prefix))) return true
  if (TEXTUAL_MIME_TYPES.has(mime)) return true
  return TEXTUAL_EXTENSIONS.has(getExtension(att.name))
}

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function truncate(text: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`
}

function summarizeDecodedText(att: Attachment, decoded: string, maxChars = DEFAULT_MAX_CHARS): string {
  const ext = getExtension(att.name)
  const mime = att.mimeType || 'unknown'
  const body = ext === 'json' ? prettyPrintJson(decoded) : decoded
  return [
    `Attachment: ${att.name}`,
    `Content-Type: ${mime}`,
    'Readable content:',
    truncate(normalizeText(body) || '(empty file)', maxChars),
  ].join('\n')
}

function prettyPrintJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

declare global {
  interface Window {
    OCRAD?: OcradFn
  }
}

let ocradPromise: Promise<OcradFn | null> | null = null

async function loadOcrad(): Promise<OcradFn | null> {
  if (!ocradPromise) {
    ocradPromise = new Promise<OcradFn | null>((resolve) => {
      if (window.OCRAD) {
        resolve(window.OCRAD)
        return
      }

      const existing = document.querySelector<HTMLScriptElement>('script[data-ocrad-runtime="true"]')
      if (existing) {
        existing.addEventListener('load', () => resolve(window.OCRAD ?? null), { once: true })
        existing.addEventListener('error', () => resolve(null), { once: true })
        return
      }

      const script = document.createElement('script')
      script.src = '/vendor/ocrad.js'
      script.async = true
      script.dataset.ocradRuntime = 'true'
      script.onload = () => resolve(window.OCRAD ?? null)
      script.onerror = () => resolve(null)
      document.head.appendChild(script)
    })
  }
  return ocradPromise
}

async function extractImageText(bytes: Uint8Array, mimeType: string, maxChars: number): Promise<string> {
  const OCRAD = await loadOcrad()
  if (!OCRAD) return ''

  const rawBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const blob = new Blob([rawBytes], { type: mimeType || 'image/png' })
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Failed to read image data'))
    reader.readAsDataURL(blob)
  })

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('Failed to load image'))
    element.src = dataUrl
  })

  const scale = Math.min(1, IMAGE_OCR_MAX_DIM / Math.max(img.width || 1, img.height || 1))
  const width = Math.max(1, Math.round((img.width || 1) * scale))
  const height = Math.max(1, Math.round((img.height || 1) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(img, 0, 0, width, height)

  const recognized = normalizeText(OCRAD(canvas) || '')
  return truncate(recognized, maxChars)
}

async function extractPdfText(bytes: Uint8Array, maxChars: number): Promise<string> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as PdfJsModule
  try {
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString()
    }
  } catch {
    // If worker config fails, pdf.js may still work in some environments.
  }

  const loadingTask = pdfjs.getDocument({ data: bytes })
  const doc = await loadingTask.promise
  const pages: string[] = []
  const pageLimit = Math.min(doc.numPages, 12)

  for (let i = 1; i <= pageLimit; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items
      .map(item => {
        const text = (item as { str?: string }).str ?? ''
        return text
      })
      .join(' ')
    const cleaned = normalizeText(pageText)
    if (cleaned) pages.push(`Page ${i}:\n${cleaned}`)
    if (pages.join('\n\n').length >= maxChars) break
  }

  if (!pages.length) return '(no readable PDF text extracted)'
  return truncate(pages.join('\n\n'), maxChars)
}

async function extractDocxText(bytes: Uint8Array, maxChars: number): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({
    arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  })
  return truncate(normalizeText(result.value || ''), maxChars)
}

function collectXmlText(node: Element | Document | DocumentFragment): string {
  const texts: string[] = []
  node.querySelectorAll('t').forEach(el => {
    const value = normalizeText(el.textContent ?? '')
    if (value) texts.push(value)
  })
  return texts.join(' ')
}

async function extractXlsxText(bytes: Uint8Array, maxChars: number): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)

  const sharedStringsFile = zip.file('xl/sharedStrings.xml')
  const sharedStringsXml = sharedStringsFile ? await sharedStringsFile.async('text').catch(() => '') : ''
  const sharedStringsDoc = sharedStringsXml ? new DOMParser().parseFromString(sharedStringsXml, 'application/xml') : null
  const sharedStrings = sharedStringsDoc
    ? Array.from(sharedStringsDoc.querySelectorAll('si')).map(node => normalizeText(node.textContent ?? ''))
    : []

  const sheetFiles = Object.keys(zip.files)
    .filter(path => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, 8)

  const sheets: string[] = []
  for (const path of sheetFiles) {
    const file = zip.file(path)
    const xml = file ? await file.async('text').catch(() => '') : ''
    if (!xml) continue
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const rows: string[] = []
    doc.querySelectorAll('sheetData row').forEach(row => {
      const cells: string[] = []
      row.querySelectorAll('c').forEach(cell => {
        const type = cell.getAttribute('t') ?? ''
        const sharedIndex = cell.querySelector('v')?.textContent?.trim() ?? ''
        const inlineText = normalizeText(cell.querySelector('is')?.textContent ?? '')
        const value = type === 's'
          ? sharedStrings[Number(sharedIndex)] ?? ''
          : inlineText || normalizeText(cell.querySelector('v')?.textContent ?? '')
        if (value) cells.push(value)
      })
      if (cells.length) rows.push(cells.join(' | '))
    })
    if (rows.length) sheets.push(`[${path.split('/').pop() ?? path}]\n${rows.join('\n')}`)
    if (sheets.join('\n\n').length >= maxChars) break
  }

  if (!sheets.length) return '(no readable spreadsheet text extracted)'
  return truncate(sheets.join('\n\n'), maxChars)
}

async function extractPptxText(bytes: Uint8Array, maxChars: number): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const slideFiles = Object.keys(zip.files)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, 12)

  const slides: string[] = []
  for (const path of slideFiles) {
    const file = zip.file(path)
    const xml = file ? await file.async('text').catch(() => '') : ''
    if (!xml) continue
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const text = collectXmlText(doc)
    if (text) slides.push(`[${path.split('/').pop() ?? path}]\n${text}`)
    if (slides.join('\n\n').length >= maxChars) break
  }

  if (!slides.length) return '(no readable presentation text extracted)'
  return truncate(slides.join('\n\n'), maxChars)
}

async function extractGenericText(att: Attachment, bytes: Uint8Array, maxChars: number): Promise<string> {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return summarizeDecodedText(att, decoded, maxChars)
}

export async function extractReadableAttachmentContent(att: Attachment, maxChars = DEFAULT_MAX_CHARS): Promise<string | null> {
  const bytes = base64ToBytes(att.data)
  const ext = getExtension(att.name)
  const mime = att.mimeType.toLowerCase()

  if (isImageAttachment(att)) {
    try {
      const text = await extractImageText(bytes, mime, maxChars)
      if (text) {
        return [
          `Attachment: ${att.name}`,
          `Content-Type: ${mime || 'image/*'}`,
          'OCR extracted content:',
          text,
        ].join('\n')
      }
    } catch {
      // The image still gets sent to the vision model in the normal chat path.
    }
    return null
  }

  if (mime === 'application/pdf' || ext === 'pdf') {
    try { return await extractPdfText(bytes, maxChars) } catch { return summarizeDecodedText(att, new TextDecoder('utf-8', { fatal: false }).decode(bytes), maxChars) }
  }

  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
    try { return await extractDocxText(bytes, maxChars) } catch { return summarizeDecodedText(att, new TextDecoder('utf-8', { fatal: false }).decode(bytes), maxChars) }
  }

  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || ext === 'xlsx') {
    try { return await extractXlsxText(bytes, maxChars) } catch { return summarizeDecodedText(att, new TextDecoder('utf-8', { fatal: false }).decode(bytes), maxChars) }
  }

  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || ext === 'pptx') {
    try { return await extractPptxText(bytes, maxChars) } catch { return summarizeDecodedText(att, new TextDecoder('utf-8', { fatal: false }).decode(bytes), maxChars) }
  }

  if (isTextualAttachment(att)) {
    return extractGenericText(att, bytes, maxChars)
  }

  return null
}

export async function buildAttachmentContextBlock(
  attachments: Attachment[] | undefined,
  maxCharsPerAttachment = DEFAULT_MAX_CHARS,
): Promise<string | null> {
  if (!attachments?.length) return null

  const sections: string[] = []
  for (const att of attachments) {
    if (att.type !== 'file' && att.type !== 'image') continue
    const readable = await extractReadableAttachmentContent(att, maxCharsPerAttachment)
    if (!readable) {
      if (att.type === 'image') continue
      sections.push([
        `Attachment: ${att.name}`,
        `Content-Type: ${att.mimeType || 'unknown'}`,
        'Readable content: (unsupported attachment format in this build)',
      ].join('\n'))
      continue
    }
    sections.push(readable)
  }

  if (!sections.length) return null
  return [
    '[ATTACHMENT CONTEXT]',
    'The user attached one or more files in chat. Inspect the readable content below before answering.',
    ...sections,
  ].join('\n\n')
}
