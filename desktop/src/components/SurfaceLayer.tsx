import { useState, useEffect, useRef } from 'react'
import { getBgKind, getBgImageId, getBgOpacity, getBgBlur, getBgImage } from '@/lib/bgImageStore'

export default function SurfaceLayer() {
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [opacity, setOpacity] = useState(getBgOpacity)
  const [blur, setBlur] = useState(getBgBlur)
  const prevUrlRef = useRef<string | null>(null)

  const loadImage = async () => {
    const kind = getBgKind()
    if (kind !== 'image') { setImgUrl(null); return }
    const id = getBgImageId()
    if (!id) { setImgUrl(null); return }
    try {
      const blob = await getBgImage(id)
      if (!blob) { setImgUrl(null); return }
      const url = URL.createObjectURL(blob)
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current)
      prevUrlRef.current = url
      setImgUrl(url)
    } catch { setImgUrl(null) }
  }

  const sync = () => {
    setOpacity(getBgOpacity())
    setBlur(getBgBlur())
    loadImage()
  }

  useEffect(() => {
    sync()
    const handler = () => sync()
    window.addEventListener('betopia:bg:changed', handler)
    return () => {
      window.removeEventListener('betopia:bg:changed', handler)
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current)
    }
  }, [])

  if (!imgUrl) return null

  return (
    <div
      className="surface-layer"
      style={{
        backgroundImage: `url(${imgUrl})`,
        opacity,
        filter: blur > 0 ? `blur(${blur}px)` : undefined,
      }}
    />
  )
}
