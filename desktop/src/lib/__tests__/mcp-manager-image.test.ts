import { describe, expect, it } from 'vitest'

describe('MCP image serialization', () => {
  it('serializes Figma-like tool content with text and image payloads', async () => {
    const mod = await import('../mcp-manager')
    const anyMod = mod as unknown as {
      __test__: {
        extractMcpContent: (result: any) => string
        extractResourceContent: (result: any) => string
      }
    }

    const toolResult = {
      content: [
        { type: 'text', text: 'Selected node: Frame 1' },
        { type: 'image', image: 'YWJjMTIz', mimeType: 'image/png' },
        { type: 'image', blob: 'ZGVmNDU2', mime_type: 'image/jpeg' },
        { type: 'image_url', url: 'data:image/webp;base64,ZWZnaA==' },
      ],
    }

    const serialized = anyMod.__test__.extractMcpContent(toolResult)
    expect(serialized).toContain('Selected node: Frame 1')
    expect(serialized).toContain('__IMAGE_DATA__:data:image/png;base64,YWJjMTIz')
    expect(serialized).toContain('__IMAGE_DATA__:data:image/jpeg;base64,ZGVmNDU2')
    expect(serialized).toContain('__IMAGE_DATA__:data:image/webp;base64,ZWZnaA==')
  })

  it('serializes MCP resource blobs as image data urls', async () => {
    const mod = await import('../mcp-manager')
    const anyMod = mod as unknown as {
      __test__: {
        extractResourceContent: (result: any) => string
      }
    }

    const resourceResult = {
      contents: [
        { text: 'Preview asset' },
        { blob: 'aGVsbG8=', mimeType: 'image/png' },
        { data: 'd29ybGQ=', type: 'image', mime_type: 'image/gif' },
      ],
    }

    const serialized = anyMod.__test__.extractResourceContent(resourceResult)
    expect(serialized).toContain('Preview asset')
    expect(serialized).toContain('__IMAGE_DATA__:data:image/png;base64,aGVsbG8=')
    expect(serialized).toContain('__IMAGE_DATA__:data:image/gif;base64,d29ybGQ=')
  })
})
