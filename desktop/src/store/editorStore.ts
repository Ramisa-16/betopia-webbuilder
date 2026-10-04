import { create } from 'zustand'
import type { FileEntry, TabEntry } from '@/types'

interface EditorState {
  files: FileEntry[]
  selectedFile: string | null
  fileContent: string
  tabs: TabEntry[]
  entryFile: string | null
  showEntryPicker: boolean
  explorerSearch: string

  setFiles: (files: FileEntry[]) => void
  setSelectedFile: (path: string | null) => void
  setFileContent: (content: string) => void
  setTabs: (tabs: TabEntry[] | ((prev: TabEntry[]) => TabEntry[])) => void
  setEntryFile: (path: string | null) => void
  setShowEntryPicker: (show: boolean) => void
  setExplorerSearch: (query: string) => void
  reset: () => void
}

export const useEditorStore = create<EditorState>((set) => ({
  files: [],
  selectedFile: null,
  fileContent: '',
  tabs: [],
  entryFile: null,
  showEntryPicker: false,
  explorerSearch: '',

  setFiles: (files) => set({ files }),
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  setFileContent: (fileContent) => set({ fileContent }),
  setTabs: (tabs) =>
    set((s) => ({ tabs: typeof tabs === 'function' ? tabs(s.tabs) : tabs })),
  setEntryFile: (entryFile) => set({ entryFile }),
  setShowEntryPicker: (showEntryPicker) => set({ showEntryPicker }),
  setExplorerSearch: (explorerSearch) => set({ explorerSearch }),

  reset: () =>
    set({
      files: [],
      selectedFile: null,
      fileContent: '',
      tabs: [],
      entryFile: null,
      showEntryPicker: false,
      explorerSearch: '',
    }),
}))
