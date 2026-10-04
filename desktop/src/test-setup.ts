/// <reference types="vitest/globals" />
import '@testing-library/jest-dom'

// jsdom stub — not implemented
Element.prototype.scrollIntoView = vi.fn()

// Stub Tauri globals used by lib/platform.ts and others
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => Promise.resolve('linux') }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { create: vi.fn() } }))
