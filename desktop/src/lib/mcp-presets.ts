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
    name: 'GitHub',
    desc: 'Search repos, manage issues and PRs via GitHub API.',
    category: 'Dev',
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    partial: { name: 'GitHub', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
  },
  {
    name: 'Filesystem',
    desc: 'Read and write files on your local filesystem.',
    category: 'System',
    envKeys: [],
    partial: { name: 'Filesystem', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/'] },
  },
  {
    name: 'PostgreSQL',
    desc: 'Query and inspect PostgreSQL databases.',
    category: 'Database',
    envKeys: [],
    partial: { name: 'PostgreSQL', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'] },
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
    partial: { name: 'Puppeteer', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
  },
  {
    name: 'Memory',
    desc: 'Persistent KV memory that survives across sessions.',
    category: 'Utility',
    envKeys: [],
    partial: { name: 'Memory', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  },
  {
    name: 'Slack',
    desc: 'Send and read messages, manage Slack channels.',
    category: 'Comms',
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    partial: { name: 'Slack', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'] },
  },
  {
    name: 'Notion',
    desc: 'Read and update Notion pages, databases and blocks.',
    category: 'Productivity',
    envKeys: ['NOTION_API_KEY'],
    partial: { name: 'Notion', type: 'stdio', command: 'npx', args: ['-y', 'notion-mcp-server'] },
  },
  {
    name: 'Linear',
    desc: 'Manage Linear issues, projects and teams.',
    category: 'Dev',
    envKeys: ['LINEAR_API_KEY'],
    partial: { name: 'Linear', type: 'stdio', command: 'npx', args: ['-y', '@linear/mcp-server'] },
  },
]

// Natural-language patterns → preset name
const PRESET_PATTERNS: [RegExp, string][] = [
  [/\bfigma\b/, 'Figma'],
  [/\bgit\s*hub\b/, 'GitHub'],
  [/\bfilesystem\b|\bfile[\s-]?system\b/, 'Filesystem'],
  [/\bpostgres(?:ql)?\b|\bpg\b/, 'PostgreSQL'],
  [/\bbrave(?:\s*search)?\b/, 'Brave Search'],
  [/\bpuppeteer\b/, 'Puppeteer'],
  [/\bmemory\b/, 'Memory'],
  [/\bslack\b/, 'Slack'],
  [/\bnotion\b/, 'Notion'],
  [/\blinear\b/, 'Linear'],
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
