// Max dimension recommended by Anthropic for vision models (1568×1568).
// Keeps token usage optimal and prevents 413s from API gateways.
const MAX_IMAGE_DIM = 1568
const JPEG_QUALITY = 0.85

/**
 * Resize a data-URL image so neither dimension exceeds MAX_IMAGE_DIM,
 * then re-encode as JPEG. Returns the original data-URL on any error.
 */
export function resizeImageForApi(dataUrl: string): Promise<string> {
  return new Promise(resolve => {
    let settled = false
    const done = (value: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height))
        if (scale === 1) {
          // Already within the size limit — resizing would only cost quality, not save anything
          done(dataUrl)
          return
        }
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) { done(dataUrl); return }
        ctx.drawImage(img, 0, 0, w, h)
        done(canvas.toDataURL('image/jpeg', JPEG_QUALITY))
      } catch {
        done(dataUrl)
      }
    }
    img.onerror = () => done(dataUrl)
    img.src = dataUrl
  })
}
