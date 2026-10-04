import type { Attachment } from '@/types'

export const MAX_IMAGES = 15

export const FILE_MIME_TYPES: Record<string, string> = {
  '7z': 'application/x-7z-compressed',
  avif: 'image/avif',
  bmp: 'image/bmp',
  css: 'text/css',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif: 'image/gif',
  gz: 'application/gzip',
  heic: 'image/heic',
  heif: 'image/heif',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  jsx: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  odt: 'application/vnd.oasis.opendocument.text',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rar: 'application/vnd.rar',
  rtf: 'application/rtf',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  txt: 'text/plain',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
}

export const CHAT_FILE_ACCEPT = [
  'image/*',
  '.pdf',
  '.doc',
  '.docx',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.html',
  '.css',
  '.xml',
  '.yaml',
  '.yml',
  '.rtf',
  '.odt',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
].join(',')

const SUPPORTED_FILE_MIME_TYPES = new Set(Object.values(FILE_MIME_TYPES))

export function bytesToBase64(bytes: Uint8Array | number[]): string {
  return btoa(Array.from(bytes).map(byte => String.fromCharCode(byte)).join(''))
}

export function getAttachmentName(path: string, fallback = 'attachment'): string {
  return path.split(/[\\/]/).pop() ?? fallback
}

export function getMimeTypeFromPath(path: string): string | null {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  return FILE_MIME_TYPES[ext] ?? null
}

export function resolveAttachmentMimeType(pathOrName: string, fallbackMimeType?: string | null): string | null {
  const pathMimeType = getMimeTypeFromPath(pathOrName)
  if (pathMimeType) return pathMimeType
  if (fallbackMimeType?.startsWith('image/')) return fallbackMimeType
  if (fallbackMimeType && SUPPORTED_FILE_MIME_TYPES.has(fallbackMimeType)) return fallbackMimeType
  if (fallbackMimeType && /^(text|application)\//.test(fallbackMimeType)) return fallbackMimeType
  return null
}

export function extractAttachmentPathsFromText(text: string): string[] {
  const candidates = text
    .split(/\r?\n/)
    .map(line => line.trim().replace(/\r$/, ''))
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      if (line.startsWith('file://')) return decodeURIComponent(line.slice(7))
      return line
    })

  return candidates.filter(candidate => {
    if (!getMimeTypeFromPath(candidate)) return false
    return /^\/[^\n\r]+$/.test(candidate) || /^[A-Za-z]:[\\/][^\n\r]+$/.test(candidate)
  })
}

export function getAttachmentKind(mimeType: string): Attachment['type'] {
  return mimeType.startsWith('image/') ? 'image' : 'file'
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/svg+xml') return 'svg'
  return mimeType.split('/')[1]?.split('+')[0] || 'png'
}

export async function readClipboardImageAttachment(idPrefix = 'paste'): Promise<Attachment | null> {
  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<ClipboardItem[]>
  }
  if (!clipboard?.read) return null

  const items = await clipboard.read()
  for (const item of items) {
    const imageType = item.types.find(type => type.startsWith('image/'))
    if (!imageType) continue

    const blob = await item.getType(imageType)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return {
      id: `${idPrefix}-${Date.now()}`,
      type: 'image',
      name: `pasted-screenshot.${extensionForMimeType(imageType)}`,
      data: bytesToBase64(bytes),
      mimeType: imageType,
      size: blob.size,
    }
  }

  return null
}
