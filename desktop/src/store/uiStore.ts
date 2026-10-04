import { create } from 'zustand'
import type { ViewMode, LogEntry, DetectedError } from '@/types'

export type LiveServerMode = 'build' | 'static' | 'runtime'

interface UiState {
  viewMode: ViewMode
  previewKey: number
  liveServerUrl: string | null
  liveServerMode: LiveServerMode | null
  publishedUrl: string | null
  isPublishing: boolean
  logs: LogEntry[]
  runtimeErrors: DetectedError[]
  logsOpen: boolean
  chatWidth: number
  explorerWidth: number
  isResizingChat: boolean
  isResizingExplorer: boolean
  showSettings: boolean
  settingsInitialTab: string
  showPublishDialog: boolean
  showNewModal: boolean

  setViewMode: (v: ViewMode) => void
  bumpPreviewKey: () => void
  setLiveServerUrl: (url: string | null) => void
  setLiveServerMode: (mode: LiveServerMode | null) => void
  setPublishedUrl: (url: string | null) => void
  setIsPublishing: (v: boolean) => void
  addLog: (log: LogEntry) => void
  clearLogs: () => void
  addRuntimeError: (err: DetectedError) => void
  clearRuntimeErrors: () => void
  setLogsOpen: (open: boolean) => void
  setChatWidth: (w: number | ((prev: number) => number)) => void
  setExplorerWidth: (w: number | ((prev: number) => number)) => void
  setIsResizingChat: (v: boolean) => void
  setIsResizingExplorer: (v: boolean) => void
  setShowSettings: (v: boolean) => void
  setSettingsInitialTab: (tab: string) => void
  setShowPublishDialog: (v: boolean) => void
  setShowNewModal: (v: boolean) => void
  reset: () => void
}

const CHAT_WIDTH_DEFAULT = 344
const EXPLORER_WIDTH_DEFAULT = 220

function readWidth(key: string, fallback: number): number {
  try {
    const raw = Number(window.localStorage.getItem(key))
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
  } catch {
    return fallback
  }
}

export const useUiStore = create<UiState>((set) => ({
  viewMode: 'code',
  previewKey: 0,
  liveServerUrl: null,
  liveServerMode: null,
  publishedUrl: null,
  isPublishing: false,
  logs: [],
  runtimeErrors: [],
  logsOpen: false,
  chatWidth: readWidth('betopia:chat-width', CHAT_WIDTH_DEFAULT),
  explorerWidth: readWidth('betopia:explorer-width', EXPLORER_WIDTH_DEFAULT),
  isResizingChat: false,
  isResizingExplorer: false,
  showSettings: false,
  settingsInitialTab: 'model',
  showPublishDialog: false,
  showNewModal: false,

  setViewMode: (viewMode) => set({ viewMode }),
  bumpPreviewKey: () => set((s) => ({ previewKey: s.previewKey + 1 })),
  setLiveServerUrl: (liveServerUrl) => set({ liveServerUrl }),
  setLiveServerMode: (liveServerMode) => set({ liveServerMode }),
  setPublishedUrl: (publishedUrl) => set({ publishedUrl }),
  setIsPublishing: (isPublishing) => set({ isPublishing }),

  addLog: (log) =>
    set((s) => {
      const logs = [...s.logs.slice(-499), log]
      return { logs, logsOpen: log.level === 'error' ? true : s.logsOpen }
    }),

  clearLogs: () => set({ logs: [], runtimeErrors: [] }),

  addRuntimeError: (err) =>
    set((s) => ({ runtimeErrors: [...s.runtimeErrors.slice(-49), err], logsOpen: true })),

  clearRuntimeErrors: () => set({ runtimeErrors: [] }),

  setLogsOpen: (logsOpen) => set({ logsOpen }),

  setChatWidth: (w) =>
    set((s) => {
      const next = typeof w === 'function' ? w(s.chatWidth) : w
      try { window.localStorage.setItem('betopia:chat-width', String(next)) } catch {}
      return { chatWidth: next }
    }),

  setExplorerWidth: (w) =>
    set((s) => {
      const next = typeof w === 'function' ? w(s.explorerWidth) : w
      try { window.localStorage.setItem('betopia:explorer-width', String(next)) } catch {}
      return { explorerWidth: next }
    }),

  setIsResizingChat: (isResizingChat) => set({ isResizingChat }),
  setIsResizingExplorer: (isResizingExplorer) => set({ isResizingExplorer }),
  setShowSettings: (showSettings) => set({ showSettings }),
  setSettingsInitialTab: (settingsInitialTab) => set({ settingsInitialTab }),
  setShowPublishDialog: (showPublishDialog) => set({ showPublishDialog }),
  setShowNewModal: (showNewModal) => set({ showNewModal }),

  reset: () =>
    set({
      viewMode: 'code',
      previewKey: 0,
      liveServerUrl: null,
      liveServerMode: null,
      publishedUrl: null,
      isPublishing: false,
      logs: [],
      runtimeErrors: [],
      logsOpen: false,
      isResizingChat: false,
      isResizingExplorer: false,
    }),
}))
