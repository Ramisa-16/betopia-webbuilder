import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const persistWriteMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const persistReadMock = vi.hoisted(() => vi.fn(() => Promise.resolve(null)))
const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('../persist', () => ({
  persistWrite: persistWriteMock,
  persistRead: persistReadMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

type MockStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  clear: () => void
  key: (index: number) => string | null
  length: number
}

function makeStorage(initial: Record<string, string> = {}): MockStorage & Record<string, unknown> {
  const store = new Map(Object.entries(initial))
  const storage: MockStorage & Record<string, unknown> = {
    get length() { return store.size },
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
      storage[key] = value
    },
    removeItem: (key: string) => {
      store.delete(key)
      delete storage[key]
    },
    clear: () => {
      for (const key of store.keys()) delete storage[key]
      store.clear()
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  }
  for (const [key, value] of store.entries()) storage[key] = value
  return storage
}

function setGlobalStorage(storage: Storage | MockStorage | undefined) {
  if (storage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage
    return
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

describe('config import safety', () => {
  const originalWindow = (globalThis as { window?: Window }).window
  const originalCustomEvent = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent

  beforeEach(() => {
    vi.resetModules()
    persistWriteMock.mockClear()
    persistReadMock.mockClear()
    invokeMock.mockClear()
    setGlobalStorage(undefined)
    Object.defineProperty(globalThis, 'window', {
      value: { dispatchEvent: vi.fn() },
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'CustomEvent', {
      value: class CustomEventMock {
        type: string
        constructor(type: string) { this.type = type }
      },
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    setGlobalStorage(undefined)
    if (originalWindow === undefined) delete (globalThis as { window?: Window }).window
    else Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true, writable: true })
    if (originalCustomEvent === undefined) delete (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent
    else Object.defineProperty(globalThis, 'CustomEvent', { value: originalCustomEvent, configurable: true, writable: true })
  })

  it('config can be imported when localStorage is undefined', async () => {
    const mod = await import('../config')
    expect(mod.getConfig().model.providerId).toBe('betopia')
  })

  it('indirect imports do not crash when localStorage is undefined', async () => {
    const historyMod = await import('../agent-history')
    const promptsMod = await import('../agent-prompts')
    expect(typeof historyMod.trimInferenceContext).toBe('function')
    expect(typeof promptsMod.renderAvailableSkills).toBe('function')
  })

  it('migration still runs when localStorage exists', async () => {
    const storage = makeStorage({
      betopia_ai_config: JSON.stringify({
        baseUrl: 'https://api.betopia.dev/v1',
        apiKey: 'legacy-key',
        model: 'legacy-model',
      }),
    })
    setGlobalStorage(storage)

    const mod = await import('../config')
    await mod.initConfig()

    const migrated = storage.getItem('betopia_agent_config')
    expect(migrated).toBeTruthy()
    expect(JSON.parse(migrated!)).toMatchObject({
      model: {
        providerId: 'betopia',
        model: 'legacy-model',
        apiKeys: { betopia: 'legacy-key' },
      },
    })
    expect(persistWriteMock).toHaveBeenCalled()
  })
})
