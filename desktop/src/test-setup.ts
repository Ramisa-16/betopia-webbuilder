/// <reference types="vitest/globals" />
import '@testing-library/jest-dom'

// jsdom stub — not implemented
Element.prototype.scrollIntoView = vi.fn()

if (typeof globalThis.localStorage?.getItem !== 'function') {
  const store = new Map<string, string>()
  const localStorageMock = {
    get length() {
      return store.size
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => { store.delete(key) }),
    setItem: vi.fn((key: string, value: string) => { store.set(key, String(value)) }),
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorageMock,
  })
}

// Stub Tauri globals used by lib/platform.ts and others
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => Promise.resolve('linux') }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { create: vi.fn() } }))
