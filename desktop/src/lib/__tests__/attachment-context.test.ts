import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAttachmentContextBlock, extractReadableAttachmentContent } from '../attachment-context'
import type { Attachment } from '../../types'

function makeAttachment(name: string, mimeType: string, content: string): Attachment {
  return {
    id: `${name}-id`,
    type: 'file',
    name,
    mimeType,
    data: Buffer.from(content, 'utf8').toString('base64'),
    size: Buffer.byteLength(content),
  }
}

function makeImageAttachment(name: string, mimeType: string, content = 'fake-image-bytes'): Attachment {
  return {
    id: `${name}-id`,
    type: 'image',
    name,
    mimeType,
    data: Buffer.from(content, 'utf8').toString('base64'),
    size: Buffer.byteLength(content),
  }
}

describe('attachment-context', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('extracts readable text attachments into prompt context', async () => {
    const att = makeAttachment('notes.txt', 'text/plain', 'Hello attachment\nSecond line')
    const text = await extractReadableAttachmentContent(att, 200)

    expect(text).toContain('Attachment: notes.txt')
    expect(text).toContain('Readable content:')
    expect(text).toContain('Hello attachment')
    expect(text).toContain('Second line')
  })

  it('pretty prints JSON attachments', async () => {
    const att = makeAttachment('data.json', 'application/json', '{"a":1,"b":true}')
    const text = await extractReadableAttachmentContent(att, 200)

    expect(text).toContain('"a": 1')
    expect(text).toContain('"b": true')
  })

  it('builds a block for multiple readable file attachments', async () => {
    const block = await buildAttachmentContextBlock([
      makeAttachment('one.txt', 'text/plain', 'Alpha'),
      makeAttachment('two.csv', 'text/csv', 'x,y\n1,2'),
    ])

    expect(block).toContain('[ATTACHMENT CONTEXT]')
    expect(block).toContain('Attachment: one.txt')
    expect(block).toContain('Attachment: two.csv')
    expect(block).toContain('Alpha')
    expect(block).toContain('x,y')
  })

  it('extracts OCR text from image attachments into prompt context', async () => {
    class MockFileReader {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      result: string | ArrayBuffer | null = null
      readAsDataURL() {
        this.result = 'data:image/png;base64,ZmFrZQ=='
        queueMicrotask(() => this.onload?.())
      }
    }

    class MockImage {
      width = 800
      height = 600
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }

    const drawImage = vi.fn()
    const originalCreateElement = document.createElement.bind(document)
    vi.stubGlobal('OCRAD', vi.fn(() => 'Detected image text'))
    vi.stubGlobal('FileReader', MockFileReader)
    vi.stubGlobal('Image', MockImage)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName.toLowerCase() !== 'canvas') return originalCreateElement(tagName, options)
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage, imageSmoothingEnabled: true }),
      } as unknown as HTMLCanvasElement
    }) as typeof document.createElement)

    const text = await extractReadableAttachmentContent(makeImageAttachment('capture.png', 'image/png'), 200)

    expect(text).toContain('Attachment: capture.png')
    expect(text).toContain('OCR extracted content:')
    expect(text).toContain('Detected image text')
    expect(drawImage).toHaveBeenCalled()
  })
})
