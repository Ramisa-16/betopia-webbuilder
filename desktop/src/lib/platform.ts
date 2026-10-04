import { platform } from '@tauri-apps/plugin-os'

const PLATFORM = (() => {
  try { return platform() } catch { return '' }
})()

export const IS_MAC     = PLATFORM === 'macos'
export const IS_LINUX   = PLATFORM === 'linux'
export const IS_WINDOWS = PLATFORM === 'windows'
export const MOD_PROP   = IS_MAC ? 'meta' : 'ctrl'
export const MOD_LABEL  = IS_MAC ? '⌘' : 'Ctrl'

// On macOS, native traffic lights are shown via titleBarStyle:Overlay — no custom controls needed.
// On Linux and Windows, we render our own min/max/close buttons.
export const USE_CUSTOM_WINDOW_CONTROLS = !IS_MAC && PLATFORM !== ''
