export async function copyImageSourceToClipboard(src: string): Promise<boolean> {
  try {
    const response = await fetch(src)
    const blob = await response.blob()
    const mimeType = blob.type || 'image/png'

    if ('ClipboardItem' in window && navigator.clipboard?.write) {
      const item = new ClipboardItem({ [mimeType]: blob })
      await navigator.clipboard.write([item])
      return true
    }

    // Fall back to copying the source URL if binary clipboard support is unavailable.
    await navigator.clipboard.writeText(src)
    return true
  } catch (error) {
    console.error('[copyImageSourceToClipboard] Failed to copy image', error)
    return false
  }
}
