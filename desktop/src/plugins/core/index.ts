import type { BetopiaPlugin, ToolExecutionContext, ToolResult, ToolSchema } from '../../lib/plugin'
import { fetchReadableUrlContext } from '../../lib/url-context'
import { raceTimeout } from '../../lib/agent-types'

const plugin: BetopiaPlugin = {
  manifest: {
    id: 'builtin:core',
    name: 'Core Tools',
    version: '0.1.0',
    description: 'Built-in file, shell, search, and project exploration tools.',
    author: 'Betopia',
  },

  contributions: {
    tools: [
      {
        name: 'web_fetch',
        globalName: true,
        description: 'Fetch a URL or local file path and return readable content from webpages, docs, JSON, markdown, text files, and other inspectable resources.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'http, https, file://, or local file path to inspect' },
            max_chars: { type: 'number', description: 'Maximum characters to return from the fetched page (default: 8000)' },
          },
          required: ['url'],
        } as ToolSchema,
        execute: async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> => {
          const url = String(args.url ?? '')
          if (!url) return { content: 'Error: url required', isError: true }
          const safeMax = typeof args.max_chars === 'number' && Number.isFinite(args.max_chars)
            ? Math.min(Math.max(500, Math.floor(args.max_chars)), 20_000)
            : 8_000
          try {
            const content = await raceTimeout(fetchReadableUrlContext(url, safeMax, ctx.projectPath ?? ''), 'web_fetch')
            return { content }
          } catch (err) {
            return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
          }
        },
      },
    ],

    commands: [
      {
        id: 'clear',
        label: 'Clear conversation',
        description: 'Clear the current chat conversation',
        execute: () => 'CLEAR_CHAT',
      },
    ],
  },

  onActivate: () => {
    return {
      hooks: {
        beforeToolCall: async (toolCall) => {
          return { type: 'pass', toolCall }
        },
        afterToolCall: async (result) => {
          return result
        },
      },
    }
  },
}

export default plugin
