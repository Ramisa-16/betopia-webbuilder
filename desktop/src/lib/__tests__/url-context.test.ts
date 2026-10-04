import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'

const fetchMock = vi.hoisted(() => vi.fn())
const readProjectFileMock = vi.hoisted(() => vi.fn())
const invokeMock = vi.mocked(invoke)

vi.mock('../proxyFetch', () => ({
  createProxyFetch: vi.fn(() => fetchMock),
}))

vi.mock('../fs', () => ({
  readProjectFile: readProjectFileMock,
}))

import { buildUrlContextBlock, extractHttpUrls, fetchReadableUrlContext } from '../url-context'

describe('extractHttpUrls', () => {
  it('extracts and deduplicates urls', () => {
    expect(extractHttpUrls('see https://example.com/page, and https://example.com/page) plus http://localhost:3000')).toEqual([
      'https://example.com/page',
      'http://localhost:3000/',
    ])
  })
})

describe('fetchReadableUrlContext', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    readProjectFileMock.mockReset()
    invokeMock.mockReset()
  })

  it('extracts readable HTML content', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        '<!doctype html><html><head><title>Example Page</title><meta name="description" content="A sample page"><link rel="stylesheet" href="/styles/main.css"><meta property="og:image" content="/images/hero.png"></head><body><h1>Hello</h1><p>Readable text here.</p><a href="/docs">Docs</a><img src="/images/inline.png" /></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    )
    fetchMock.mockResolvedValueOnce(
      new Response(
        ':root { --brand: #123456; }\n.hero { display: grid; gap: 16px; padding: 24px; background: #fff; }\n.card { box-shadow: 0 4px 12px rgba(0,0,0,0.1); }',
        { headers: { 'content-type': 'text/css; charset=utf-8' } },
      ),
    )

    const result = await fetchReadableUrlContext('https://example.com')
    expect(result).toContain('URL: https://example.com')
    expect(result).toContain('Title: Example Page')
    expect(result).toContain('Description: A sample page')
    expect(result).toContain('Hello')
    expect(result).toContain('Readable text here.')
    expect(result).toContain('https://example.com/docs')
    expect(result).toContain('Stylesheets:')
    expect(result).toContain('Style hints:')
    expect(result).toContain('--brand: #123456')
    expect(result).toContain('.hero {')
    expect(result).toContain('Assets:')
    expect(result).toContain('https://example.com/images/hero.png')
    expect(result).toContain('https://example.com/images/inline.png')
  })

  it('formats json content', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"name":"Betopia","nested":{"ok":true}}', { headers: { 'content-type': 'application/json' } }),
    )

    const result = await fetchReadableUrlContext('https://example.com/data.json')
    expect(result).toContain('"name": "Betopia"')
    expect(result).toContain('"ok": true')
  })

  it('reads local file links through the filesystem', async () => {
    invokeMock.mockResolvedValueOnce('local file content')

    const result = await fetchReadableUrlContext('file:///C:/temp/readme.txt')
    expect(result).toContain('Path:')
    expect(result).toContain('readme.txt')
    expect(result).toContain('local file content')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads local folder trees recursively', async () => {
    invokeMock.mockImplementation(async (command: string, args?: any) => {
      if (command === 'fs_read_dir' && args?.root === 'C:/temp/output') {
        return [
          { name: 'docs', isDirectory: true },
          { name: 'readme.txt', isDirectory: false },
        ]
      }
      if (command === 'fs_read_dir' && args?.root === 'C:/temp/output/docs') {
        return [
          { name: 'nested.txt', isDirectory: false },
        ]
      }
      if (command === 'fs_read_file' && args?.path === 'C:/temp/output/readme.txt') {
        return 'root file content'
      }
      if (command === 'fs_read_file' && args?.path === 'C:/temp/output/docs/nested.txt') {
        return 'nested file content'
      }
      throw new Error(`unexpected command: ${command}`)
    })

    const result = await fetchReadableUrlContext('C:/temp/output')
    expect(result).toContain('Path: C:/temp/output')
    expect(result).toContain('Type: folder')
    expect(result).toContain('docs/')
    expect(result).toContain('readme.txt')
    expect(result).toContain('root file content')
    expect(result).toContain('nested.txt')
    expect(result).toContain('nested file content')
  })
})

describe('buildUrlContextBlock', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    readProjectFileMock.mockReset()
    invokeMock.mockReset()
  })

  it('builds a single block for urls in free text', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html><body><h1>Guide</h1><p>Use this page.</p></body></html>', { headers: { 'content-type': 'text/html' } }),
    )

    const block = await buildUrlContextBlock('check https://example.com/guide')
    expect(block).toContain('[URL CONTEXT]')
    expect(block).toContain('Use this page.')
  })

  it('includes local project files when given a relative path', async () => {
    readProjectFileMock.mockResolvedValueOnce('project relative content')

    const block = await buildUrlContextBlock('read ./docs/guide.md', { projectPath: '/project' })
    expect(block).toContain('[URL CONTEXT]')
    expect(block).toContain('project relative content')
    expect(block).toContain('Path: /project/docs/guide.md')
  })
})
