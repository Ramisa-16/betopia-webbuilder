// IndexedDB storage for background images — same approach as terax-ai

const DB_NAME = 'betopia-bg-images'
const STORE_NAME = 'images'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function putBgImage(id: string, blob: Blob): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(blob, id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getBgImage(id: string): Promise<Blob | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function deleteBgImage(id: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function isAnimated(file: File): boolean {
  const lower = file.name.toLowerCase()
  return lower.endsWith('.gif') || lower.endsWith('.webp') || lower.endsWith('.apng')
}

async function resizeImage(file: File, maxPx = 2560, quality = 0.88): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Encode failed')), 'image/jpeg', quality)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Load failed')) }
    img.src = url
  })
}

export async function importBgImageFromFile(file: File): Promise<string> {
  const animated = isAnimated(file)
  const maxSize = animated ? 10 * 1024 * 1024 : 30 * 1024 * 1024

  if (file.size > maxSize) {
    throw new Error(`File too large (max ${animated ? '10' : '30'} MB)`)
  }

  let blob: Blob
  if (!animated && (file.size > 2 * 1024 * 1024 || file.type !== 'image/jpeg')) {
    blob = await resizeImage(file)
  } else {
    blob = file
  }

  const id = `bg-${Date.now()}`
  await putBgImage(id, blob)
  return id
}

// ── Preferences (localStorage fast path) ─────────────────────────────────────

const BG_KIND_LS   = 'betopia:bg:kind'
const BG_IMAGE_LS  = 'betopia:bg:imageId'
const BG_OPACITY_LS = 'betopia:bg:opacity'
const BG_BLUR_LS   = 'betopia:bg:blur'

export type BgKind = 'none' | 'image'

export function getBgKind(): BgKind {
  try { return (localStorage.getItem(BG_KIND_LS) as BgKind) ?? 'none' } catch { return 'none' }
}
export function setBgKind(v: BgKind) { try { localStorage.setItem(BG_KIND_LS, v) } catch {} }

export function getBgImageId(): string | null {
  try { return localStorage.getItem(BG_IMAGE_LS) } catch { return null }
}
export function setBgImageId(id: string | null) {
  try {
    if (id) localStorage.setItem(BG_IMAGE_LS, id)
    else localStorage.removeItem(BG_IMAGE_LS)
  } catch {}
}

export function getBgOpacity(): number {
  try { return parseFloat(localStorage.getItem(BG_OPACITY_LS) ?? '0.5') } catch { return 0.5 }
}
export function setBgOpacity(v: number) { try { localStorage.setItem(BG_OPACITY_LS, String(v)) } catch {} }

export function getBgBlur(): number {
  try { return parseFloat(localStorage.getItem(BG_BLUR_LS) ?? '0') } catch { return 0 }
}
export function setBgBlur(v: number) { try { localStorage.setItem(BG_BLUR_LS, String(v)) } catch {} }
