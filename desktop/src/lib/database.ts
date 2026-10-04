export type DatabaseProvider = 'postgres' | 'supabase' | 'mysql' | 'mongodb' | 'sqlite' | 'unknown'
export type DatabaseConnectionType = 'url' | 'file' | 'cloud-managed'
export type DatabaseSecretKey =
  | 'DATABASE_URL'
  | 'SUPABASE_URL'
  | 'MYSQL_URL'
  | 'MONGODB_URI'
  | 'SQLITE_DATABASE_URL'

export interface DatabaseConnectionMatch {
  kind:
    | 'postgres-url'
    | 'supabase-postgres-url'
    | 'supabase-project-url'
    | 'mysql-url'
    | 'mongodb-url'
    | 'sqlite-url'
    | 'sqlite-file'
  raw: string
  provider: DatabaseProvider
  connectionType: DatabaseConnectionType
  secretKey: DatabaseSecretKey
  runtimeEnvKey: DatabaseSecretKey
  databaseUrl?: string
  projectUrl?: string
  filePath?: string
  needsCredentials: boolean
  promptSuffix: string
}

export const DATABASE_CONNECTION_SECRET_KEYS: DatabaseSecretKey[] = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'MYSQL_URL',
  'MONGODB_URI',
  'SQLITE_DATABASE_URL',
]

const DATABASE_URL_RE = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|sqlite):\/\/[^\s<>"'`]+/i
const FILE_SQLITE_URL_RE = /\bfile:\/\/\/[^\s<>"'`]+/i
const SQLITE_FILE_RE = /(?:^|\s)(\/[^\s<>"'`]+\.(?:sqlite|sqlite3|db))(?:\s|$)/i
const SUPABASE_PROJECT_URL_RE = /\bhttps?:\/\/[a-z0-9-]+\.supabase\.co\b[^\s<>"'`]*\/?/i

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;]+$/g, '')
}

function providerLabel(provider: DatabaseProvider): string {
  if (provider === 'supabase') return 'Supabase'
  if (provider === 'postgres') return 'PostgreSQL'
  if (provider === 'mysql') return 'MySQL'
  if (provider === 'mongodb') return 'MongoDB'
  if (provider === 'sqlite') return 'SQLite'
  return 'Database'
}

export function getDatabaseProviderLabel(provider: DatabaseProvider): string {
  return providerLabel(provider)
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isSupabaseHost(host: string): boolean {
  return host.toLowerCase().endsWith('.supabase.co')
}

function buildUrlMatch(raw: string): DatabaseConnectionMatch | null {
  const parsed = safeUrl(raw)
  if (!parsed) return null
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()

  if (scheme === 'postgres' || scheme === 'postgresql') {
    const provider: DatabaseProvider = isSupabaseHost(parsed.hostname) ? 'supabase' : 'postgres'
    return {
      kind: provider === 'supabase' ? 'supabase-postgres-url' : 'postgres-url',
      raw,
      provider,
      connectionType: 'url',
      secretKey: 'DATABASE_URL',
      runtimeEnvKey: 'DATABASE_URL',
      databaseUrl: raw,
      needsCredentials: false,
      promptSuffix: [
        `A ${providerLabel(provider)} connection string was provided.`,
        'Use it as DATABASE_URL for the backend.',
        'Generate the schema/client wiring, env example, and runtime checks needed to verify the database connection.',
      ].join(' '),
    }
  }

  if (scheme === 'mysql') {
    return {
      kind: 'mysql-url',
      raw,
      provider: 'mysql',
      connectionType: 'url',
      secretKey: 'MYSQL_URL',
      runtimeEnvKey: 'MYSQL_URL',
      databaseUrl: raw,
      needsCredentials: false,
      promptSuffix: [
        'A MySQL connection string was provided.',
        'Use it as MYSQL_URL for the backend.',
        'Generate the schema/client wiring, env example, and runtime checks needed to verify the database connection.',
      ].join(' '),
    }
  }

  if (scheme === 'mongodb' || scheme === 'mongodb+srv') {
    return {
      kind: 'mongodb-url',
      raw,
      provider: 'mongodb',
      connectionType: scheme === 'mongodb+srv' ? 'cloud-managed' : 'url',
      secretKey: 'MONGODB_URI',
      runtimeEnvKey: 'MONGODB_URI',
      databaseUrl: raw,
      needsCredentials: false,
      promptSuffix: [
        'A MongoDB connection string was provided.',
        'Use it as MONGODB_URI for the backend.',
        'Generate the model/client wiring, env example, and runtime checks needed to verify the database connection.',
      ].join(' '),
    }
  }

  if (scheme === 'sqlite' || scheme === 'file') {
    return {
      kind: 'sqlite-url',
      raw,
      provider: 'sqlite',
      connectionType: 'file',
      secretKey: 'SQLITE_DATABASE_URL',
      runtimeEnvKey: 'SQLITE_DATABASE_URL',
      databaseUrl: raw,
      needsCredentials: false,
      promptSuffix: [
        'A SQLite database URL was provided.',
        'Use it as SQLITE_DATABASE_URL for the backend.',
        'Generate the local database wiring, env example, and runtime checks needed to verify the database connection.',
      ].join(' '),
    }
  }

  return null
}

function buildSqliteFileMatch(raw: string): DatabaseConnectionMatch {
  return {
    kind: 'sqlite-file',
    raw,
    provider: 'sqlite',
    connectionType: 'file',
    secretKey: 'SQLITE_DATABASE_URL',
    runtimeEnvKey: 'SQLITE_DATABASE_URL',
    databaseUrl: raw,
    filePath: raw,
    needsCredentials: false,
    promptSuffix: [
      'A SQLite database file path was provided.',
      'Use it as SQLITE_DATABASE_URL for the backend.',
      'Generate the local database wiring, env example, and runtime checks needed to verify the database connection.',
    ].join(' '),
  }
}

export function extractDatabaseConnectionMatch(
  text: string,
  preferredProvider?: DatabaseProvider,
): DatabaseConnectionMatch | null {
  const input = text.trim()
  if (!input) return null

  const dbUrlMatch = input.match(DATABASE_URL_RE) ?? input.match(FILE_SQLITE_URL_RE)
  if (dbUrlMatch) {
    const raw = stripTrailingPunctuation(dbUrlMatch[0])
    const match = buildUrlMatch(raw)
    if (match) return match
  }

  const supabaseMatch = input.match(SUPABASE_PROJECT_URL_RE)
  if (supabaseMatch && /\bsupabase\b/i.test(input)) {
    const raw = stripTrailingPunctuation(supabaseMatch[0])
    return {
      kind: 'supabase-project-url',
      raw,
      provider: 'supabase',
      connectionType: 'cloud-managed',
      secretKey: 'SUPABASE_URL',
      runtimeEnvKey: 'SUPABASE_URL',
      projectUrl: raw,
      needsCredentials: true,
      promptSuffix: [
        'A Supabase project URL was provided, but that alone is not enough to open a SQL connection.',
        'Ask for the full PostgreSQL connection string or DATABASE_URL, then wire the backend to it.',
      ].join(' '),
    }
  }

  const sqliteFileMatch = input.match(SQLITE_FILE_RE)
  if (sqliteFileMatch && (preferredProvider === 'sqlite' || /\.((sqlite3?)|db)$/i.test(sqliteFileMatch[1]))) {
    return buildSqliteFileMatch(stripTrailingPunctuation(sqliteFileMatch[1]))
  }

  return null
}

export function buildDatabaseSetupPrompt(match: DatabaseConnectionMatch): string {
  return [
    '[INTENT: DATABASE_SETUP]',
    `You are connecting this project to ${providerLabel(match.provider)}.`,
    match.promptSuffix,
    match.databaseUrl ? `${match.runtimeEnvKey}: ${match.databaseUrl}` : '',
    match.projectUrl ? `Supabase project URL: ${match.projectUrl}` : '',
    `Provider: ${match.provider}`,
    `Connection type: ${match.connectionType}`,
    'Keep the implementation scoped to the active project only.',
    'Do not expose the secret in the chat reply or write it into source control.',
  ].filter(Boolean).join('\n')
}
