const BASE = '/file-icons'

const EXT_MAP: Record<string, string> = {
  // TypeScript
  ts: 'typescript', tsx: 'react',
  // JavaScript
  js: 'javascript', jsx: 'react', mjs: 'javascript', cjs: 'javascript',
  // Web
  css: 'css', scss: 'sass', sass: 'sass', less: 'sass',
  html: 'html', htm: 'html', svg: 'html',
  // Data / config
  json: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  // Docs
  md: 'markdown', mdx: 'markdown',
  // Shell
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console',
  cmd: 'console', bat: 'console', ps1: 'powershell',
  // Systems / compiled
  go: 'go',
  rs: 'rust',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hh: 'cpp',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  // Scripting
  py: 'python',
  rb: 'ruby',
  php: 'php',
  lua: 'lua',
  r: 'r',
  // Functional / exotic
  hs: 'haskell',
  ex: 'elixir', exs: 'elixir',
  clj: 'clojure', cljs: 'clojure',
  scala: 'scala',
  groovy: 'groovy',
  nim: 'nim',
  zig: 'zig',
  odin: 'odin',
  // Web frameworks
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  // Database / API
  graphql: 'graphql', gql: 'graphql',
  prisma: 'prisma',
  // Lock / manifest
  lock: 'lock',
  // Misc
  log: 'log',
  sql: 'json',
  csv: 'file',
  txt: 'file',
}

const NAME_MAP: Record<string, string> = {
  'package.json': 'npm',
  'package-lock.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  'bun.lockb': 'lock',
  'vite.config.ts': 'vite',
  'vite.config.js': 'vite',
  'vite.config.mts': 'vite',
  'tailwind.config.ts': 'tailwindcss',
  'tailwind.config.js': 'tailwindcss',
  'tailwind.config.mjs': 'tailwindcss',
  '.prettierrc': 'prettier',
  '.prettierrc.json': 'prettier',
  '.prettierrc.js': 'prettier',
  '.prettierignore': 'prettier',
  '.eslintrc': 'eslint',
  '.eslintrc.js': 'eslint',
  '.eslintrc.json': 'eslint',
  '.eslintrc.cjs': 'eslint',
  'eslint.config.js': 'eslint',
  'eslint.config.ts': 'eslint',
  'eslint.config.mjs': 'eslint',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitkeep': 'git',
  'dockerfile': 'docker',
  'makefile': 'makefile',
  'tsconfig.json': 'json',
  'tsconfig.base.json': 'json',
  '.env': 'json',
  '.env.local': 'json',
  '.env.development': 'json',
  '.env.production': 'json',
  'readme.md': 'markdown',
}

const FOLDER_NAME_MAP: Record<string, string> = {
  src: 'folder-src',
  source: 'folder-src',
  components: 'folder-components',
  component: 'folder-components',
  lib: 'folder-lib',
  libs: 'folder-lib',
  utils: 'folder-lib',
  util: 'folder-lib',
  helpers: 'folder-lib',
  public: 'folder-public',
  static: 'folder-public',
  assets: 'folder-public',
  dist: 'folder-dist',
  build: 'folder-dist',
  out: 'folder-dist',
  output: 'folder-dist',
  node_modules: 'folder-node',
}

function icon(name: string): string {
  return `${BASE}/${name}.svg`
}

export function getFileIcon(filename: string): string {
  const lower = filename.toLowerCase()
  const byName = NAME_MAP[lower]
  if (byName) return icon(byName)

  const ext = lower.split('.').pop() ?? ''
  const byExt = EXT_MAP[ext]
  if (byExt) return icon(byExt)

  return icon('file')
}

export function getFolderIcon(name: string, expanded: boolean): string {
  const lower = name.toLowerCase()
  const specific = FOLDER_NAME_MAP[lower]
  if (specific) return icon(expanded ? `${specific}-open` : specific)
  return icon(expanded ? 'folder-open' : 'folder')
}
