/**
 * Shared MCP preset definitions.
 * Used by both the settings UI gallery and the Ctrl+K intent parser.
 */

import type { MCPServer } from './config'

export interface MCPPresetData {
  name: string
  desc: string
  category: string
  envKeys: string[]
  fixedType?: MCPServer['type']
  partial: Partial<MCPServer>
}

export const MCP_PRESET_DATA: MCPPresetData[] = [
  {
    name: 'Figma',
    desc: 'Read designs, components and assets from Figma files.',
    category: 'Design',
    envKeys: ['FIGMA_API_KEY'],
    partial: { name: 'Figma', type: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'] },
  },
  {
    name: 'Brave Search',
    desc: 'Privacy-first web search via Brave Search API.',
    category: 'Search',
    envKeys: ['BRAVE_API_KEY'],
    partial: { name: 'Brave Search', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
  },
  {
    name: 'Puppeteer',
    desc: 'Browser automation — screenshots, scraping, forms.',
    category: 'Browser',
    envKeys: [],
    fixedType: 'stdio',
    partial: { name: 'Puppeteer', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
  },
]

// Natural-language patterns → preset name
const PRESET_PATTERNS: [RegExp, string][] = [
  [/\bfigma\b/, 'Figma'],
  [/\bbrave(?:\s*search)?\b/, 'Brave Search'],
  [/\bpuppeteer\b/, 'Puppeteer'],
]

export function findPresetByText(text: string): MCPPresetData | null {
  const lower = text.toLowerCase()
  for (const [re, name] of PRESET_PATTERNS) {
    if (re.test(lower)) {
      return MCP_PRESET_DATA.find(p => p.name === name) ?? null
    }
  }
  return null
}

/** Extract KEY=VALUE pairs from a string (uppercase keys only, ≥4 chars). */
export function extractEnvKV(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  const re = /\b([A-Z][A-Z0-9_]{3,})=([^\s,;'"]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    result[m[1]] = m[2]
  }
  return result
}
