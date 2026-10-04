import { afterEach, describe, expect, it, vi } from 'vitest'
import { resizeImageForApi } from '../image-utils'

class MockImage {
  width = 3200
  height = 1600
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

describe('resizeImageForApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves the original data URL when canvas export throws', async () => {
    const dataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'
    vi.stubGlobal('Image', MockImage)
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName.toLowerCase() !== 'canvas') return originalCreateElement(tagName, options)
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => { throw new Error('canvas export failed') },
      } as unknown as HTMLCanvasElement
    }) as typeof document.createElement)

    await expect(resizeImageForApi(dataUrl)).resolves.toBe(dataUrl)
  })

  it('resolves the original data URL when canvas draw throws', async () => {
    const dataUrl = 'data:image/png;base64,abc'
    vi.stubGlobal('Image', MockImage)
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      if (tagName.toLowerCase() !== 'canvas') return originalCreateElement(tagName, options)
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => { throw new Error('draw failed') } }),
        toDataURL: () => 'data:image/jpeg;base64,resized',
      } as unknown as HTMLCanvasElement
    }) as typeof document.createElement)

    await expect(resizeImageForApi(dataUrl)).resolves.toBe(dataUrl)
  })
})
