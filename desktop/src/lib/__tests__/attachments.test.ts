import { describe, expect, it } from 'vitest'
import {
  CHAT_FILE_ACCEPT,
  extractAttachmentPathsFromText,
  getMimeTypeFromPath,
  resolveAttachmentMimeType,
} from '../attachments'

describe('attachments', () => {
  it('recognizes common image, document, text, and archive formats', () => {
    expect(getMimeTypeFromPath('/tmp/screenshot.png')).toBe('image/png')
    expect(getMimeTypeFromPath('/tmp/photo.jpg')).toBe('image/jpeg')
    expect(getMimeTypeFromPath('/tmp/report.pdf')).toBe('application/pdf')
    expect(getMimeTypeFromPath('/tmp/spec.docx')).toContain('wordprocessingml')
    expect(getMimeTypeFromPath('/tmp/archive.zip')).toBe('application/zip')
    expect(getMimeTypeFromPath('/tmp/archive.7z')).toBe('application/x-7z-compressed')
    expect(getMimeTypeFromPath('/tmp/notes.txt')).toBe('text/plain')
  })

  it('accepts browser-provided text and application mime types for unknown extensions', () => {
    expect(resolveAttachmentMimeType('download', 'application/octet-stream')).toBe('application/octet-stream')
    expect(resolveAttachmentMimeType('clipboard', 'text/plain')).toBe('text/plain')
  })

  it('extracts supported local paths from file uri and plain path lists', () => {
    const paths = extractAttachmentPathsFromText([
      'file:///home/mamun/Desktop/a.pdf',
      '/home/mamun/Desktop/b.zip',
      'C:\\Users\\mamun\\Desktop\\c.docx',
      'not-a-file',
    ].join('\n'))

    expect(paths).toEqual([
      '/home/mamun/Desktop/a.pdf',
      '/home/mamun/Desktop/b.zip',
      'C:\\Users\\mamun\\Desktop\\c.docx',
    ])
  })

  it('exposes the new formats in the file picker accept list', () => {
    expect(CHAT_FILE_ACCEPT).toContain('.docx')
    expect(CHAT_FILE_ACCEPT).toContain('.pdf')
    expect(CHAT_FILE_ACCEPT).toContain('.zip')
    expect(CHAT_FILE_ACCEPT).toContain('image/*')
  })
})
