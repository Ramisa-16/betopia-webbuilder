import ReactHeadroom from 'react-headroom'

interface Props {
  children: React.ReactNode
  /** px before headroom kicks in (default: 0) */
  offset?: number
  /** ms scroll tolerance before hiding (default: 0) */
  tolerance?: number
  /** extra className on the outer wrapper */
  className?: string
  /** called when header pins (sticks at top) */
  onPin?: () => void
  /** called when header unpins (scrolling down) */
  onUnpin?: () => void
  /** called when header is at top */
  onUnfix?: () => void
}

export default function Headroom({
  children,
  offset = 0,
  tolerance = 0,
  className,
  onPin,
  onUnpin,
  onUnfix,
}: Props) {
  return (
    <ReactHeadroom
      offset={offset}
      tolerance={tolerance}
      className={className}
      onPin={onPin}
      onUnpin={onUnpin}
      onUnfix={onUnfix}
      style={{ zIndex: 100 }}
    >
      {children}
    </ReactHeadroom>
  )
}
