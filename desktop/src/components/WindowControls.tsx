import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { USE_CUSTOM_WINDOW_CONTROLS } from '@/lib/platform'

interface Props {
  closeOnly?: boolean
}

export function WindowControls({ closeOnly = false }: Props) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!USE_CUSTOM_WINDOW_CONTROLS || closeOnly) return
    const w = getCurrentWindow()
    void w.isMaximized().then(setMaximized)
    let unlisten: (() => void) | undefined
    void w.onResized(() => void w.isMaximized().then(setMaximized)).then(u => { unlisten = u })
    return () => unlisten?.()
  }, [closeOnly])

  if (!USE_CUSTOM_WINDOW_CONTROLS) return null

  const w = getCurrentWindow()

  return (
    <div
      className="win-controls"
      onPointerDown={e => e.stopPropagation()}
    >
      {!closeOnly && (
        <>
          <WinBtn label="Minimize" cls="win-min" onClick={() => void w.minimize()}>
            <svg width="10" height="2" viewBox="0 0 10 2">
              <line x1="0" y1="1" x2="10" y2="1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </WinBtn>
          <WinBtn label={maximized ? 'Restore' : 'Maximize'} cls="win-max" onClick={() => void w.toggleMaximize()}>
            {maximized ? (
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                <rect x="2.5" y="0.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M0.5 2.5v5a1 1 0 001 1h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                <rect x="0.5" y="0.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              </svg>
            )}
          </WinBtn>
        </>
      )}
      <WinBtn label="Close" cls="win-close" onClick={() => void w.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </WinBtn>
    </div>
  )
}

function WinBtn({ label, cls, onClick, children }: {
  label: string; cls: string; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      className={`win-btn ${cls}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={e => e.stopPropagation()}
    >
      {children}
    </button>
  )
}
