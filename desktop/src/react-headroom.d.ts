declare module 'react-headroom' {
  import type { ComponentType, CSSProperties, ReactNode } from 'react'

  export interface ReactHeadroomProps {
    children?: ReactNode
    className?: string
    style?: CSSProperties
    wrapperStyle?: CSSProperties
    parent?: () => HTMLElement
    disable?: boolean
    pin?: boolean
    offset?: number
    pinStart?: number
    tolerance?: number | { up?: number; down?: number }
    upTolerance?: number
    downTolerance?: number
    onPin?: () => void
    onUnpin?: () => void
    onUnfix?: () => void
    calcHeightOnResize?: boolean
  }

  const ReactHeadroom: ComponentType<ReactHeadroomProps>
  export default ReactHeadroom
}
