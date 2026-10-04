import { vi } from 'vitest'
import { describe, it, expect } from 'vitest'
import {
  BACKEND_CLEANUP_PORTS,
  BACKEND_PROBE_PORTS,
  extractProjectApiEndpointsFromSource,
  extractRouteTokensFromSource,
  isSpecForCurrentProject,
  resolveNodeBackendInfo,
} from '../backend-routing'

const existsMock = vi.hoisted(() => vi.fn())
const readTextFileMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: existsMock,
  readTextFile: readTextFileMock,
  readDir: vi.fn(),
}))

describe('backend routing helpers', () => {
  it('extracts Nest controller prefixes and method routes', () => {
    const source = `
      @Controller('orders')
      export class OrdersController {
        @Get('summary')
        summary() {}

        @Post('drafts')
        createDraft() {}
      }
    `

    const tokens = extractRouteTokensFromSource('orders.controller.ts', source)

    expect(tokens.has('orders')).toBe(true)
    expect(tokens.has('summary')).toBe(true)
    expect(tokens.has('drafts')).toBe(true)
  })

  it('fails closed when project routes or spec routes cannot be identified', () => {
    expect(isSpecForCurrentProject({ endpoints: [{ path: '/tts' }] }, new Set())).toBe(false)
    expect(isSpecForCurrentProject({ endpoints: [] }, new Set(['orders']))).toBe(false)
  })

  it('accepts a spec only when route tokens overlap with the current project', () => {
    const projectTokens = new Set(['orders', 'summary'])
    const spec = {
      endpoints: [
        { path: '/api/orders/summary' },
        { path: '/api/orders/:id' },
      ],
    }

    expect(isSpecForCurrentProject(spec, projectTokens)).toBe(true)
  })

  it('keeps cleanup ports broad enough to evict stale backend servers', () => {
    expect(BACKEND_CLEANUP_PORTS).toContain(8002)
    expect(BACKEND_CLEANUP_PORTS).toContain(8080)
    expect(BACKEND_PROBE_PORTS).toContain(8002)
  })

  it('detects a Nest backend package inside a backend subfolder', async () => {
    existsMock.mockImplementation(async (path: string) => path === '/home/test/project/backend/package.json')
    readTextFileMock.mockResolvedValue(JSON.stringify({
      dependencies: { '@nestjs/core': '^10.0.0' },
      scripts: { 'start:dev': 'nest start --watch' },
    }))

    const info = await resolveNodeBackendInfo('/home/test/project')

    expect(info).toEqual({
      label: 'Node.js',
      command: 'npm run start:dev',
      injectsPort: false,
      cwd: '/home/test/project/backend',
    })
  })

  it('infers a listen port from a Nest entry file', async () => {
    existsMock.mockImplementation(async (path: string) => {
      return path === '/home/test/project/backend/package.json'
        || path === '/home/test/project/backend/src/main.ts'
    })
    readTextFileMock.mockImplementation(async (path: string) => {
      if (path === '/home/test/project/backend/package.json') {
        return JSON.stringify({
          dependencies: { '@nestjs/core': '^10.0.0' },
          scripts: { dev: 'nest start --watch' },
        })
      }
      if (path === '/home/test/project/backend/src/main.ts') {
        return `
          async function bootstrap() {
            await app.listen(process.env.PORT ?? 3000)
          }
        `
      }
      throw new Error('not found')
    })

    const info = await resolveNodeBackendInfo('/home/test/project')

    expect(info?.preferredPort).toBe(3000)
  })

  it('extracts codebase API endpoints from Nest controllers', () => {
    const source = `
      @Controller('orders')
      export class OrdersController {
        @Get('summary')
        summary() {}

        @Post('drafts')
        createDraft() {}
      }
    `

    const endpoints = extractProjectApiEndpointsFromSource('orders.controller.ts', source)

    expect(endpoints).toContainEqual({ method: 'get', path: '/orders/summary' })
    expect(endpoints).toContainEqual({ method: 'post', path: '/orders/drafts' })
  })
})
