import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { readProjectRuntime, updateProjectRuntime, type ProjectRuntimeState } from '@/lib/project-runtime'
import {
  DATABASE_CONNECTION_SECRET_KEYS,
  extractDatabaseConnectionMatch,
  getDatabaseProviderLabel,
  type DatabaseConnectionMatch,
  type DatabaseProvider,
  type DatabaseSecretKey,
} from '@/lib/database'

interface Props {
  onAskAI?: (msg: string) => void
  projectPath?: string | null
  projectName?: string
  publishedUrl?: string | null
  isPublished?: boolean
  onMakeCopy?: () => void
}

type DatabaseState = NonNullable<ProjectRuntimeState['database']>

const PROVIDERS: Array<{ id: DatabaseProvider; hint: string; placeholder: string }> = [
  { id: 'postgres', hint: 'PostgreSQL URL', placeholder: 'postgresql://user:password@host:5432/database' },
  { id: 'supabase', hint: 'Supabase Postgres URL', placeholder: 'postgresql://postgres:password@db.project.supabase.co:5432/postgres' },
  { id: 'mysql', hint: 'MySQL URL', placeholder: 'mysql://user:password@host:3306/database' },
  { id: 'mongodb', hint: 'MongoDB URI', placeholder: 'mongodb+srv://user:password@cluster.example.com/database' },
  { id: 'sqlite', hint: 'SQLite file or URL', placeholder: '/absolute/path/app.db or sqlite:///absolute/path/app.db' },
]

const SECRET_PROVIDER: Record<DatabaseSecretKey, DatabaseProvider> = {
  DATABASE_URL: 'postgres',
  SUPABASE_URL: 'supabase',
  MYSQL_URL: 'mysql',
  MONGODB_URI: 'mongodb',
  SQLITE_DATABASE_URL: 'sqlite',
}

const EMPTY_STATE: DatabaseState = {
  status: 'disconnected',
  provider: 'unknown',
  connectionType: 'url',
  url: null,
  message: 'No database connected yet.',
  updatedAt: '',
}

function describeMatch(match: DatabaseConnectionMatch | null, provider: DatabaseProvider): string {
  if (!match) return `Paste a ${getDatabaseProviderLabel(provider)} connection value to begin.`
  if (match.needsCredentials) return 'Project URL detected. A full database connection string is still required for runtime verification.'
  return `${getDatabaseProviderLabel(match.provider)} connection detected.`
}

function formatVerifiedAt(value?: string): string {
  if (!value) return 'Never'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

function providerFromMatch(match: DatabaseConnectionMatch | null, fallback: DatabaseProvider): DatabaseProvider {
  return match?.provider && match.provider !== 'unknown' ? match.provider : fallback
}

export default function DatabasePanel({ onAskAI, projectPath }: Props) {
  const [provider, setProvider] = useState<DatabaseProvider>('postgres')
  const [value, setValue] = useState('')
  const [state, setState] = useState<DatabaseState>(EMPTY_STATE)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState('')

  const selectedProvider = PROVIDERS.find(item => item.id === provider) ?? PROVIDERS[0]
  const match = useMemo(() => extractDatabaseConnectionMatch(value, provider), [value, provider])

  const syncRuntime = useCallback(async (patch: Partial<DatabaseState>) => {
    if (!projectPath) return
    await updateProjectRuntime(projectPath, { database: { ...state, ...patch } })
  }, [projectPath, state])

  const clearOtherSecrets = useCallback(async (keep?: DatabaseSecretKey) => {
    if (!projectPath) return
    await Promise.all(
      DATABASE_CONNECTION_SECRET_KEYS
        .filter(key => key !== keep)
        .map(key => invoke('project_secret_delete', { projectPath, key }).catch(() => {})),
    )
  }, [projectPath])

  const load = useCallback(async () => {
    if (!projectPath) return
    const runtime = await readProjectRuntime(projectPath).catch(() => null)
    const savedPairs = await Promise.all(
      DATABASE_CONNECTION_SECRET_KEYS.map(async key => ({
        key,
        value: await invoke<string | null>('project_secret_get', { projectPath, key }).catch(() => null),
      })),
    )
    const saved = savedPairs.find(item => item.value)
    if (saved?.value) {
      setValue(saved.value)
      setProvider(SECRET_PROVIDER[saved.key])
    }
    const db = runtime?.database
    if (db) {
      setState({ ...EMPTY_STATE, ...db })
      if (db.provider && db.provider !== 'unknown') setProvider(db.provider)
    } else {
      setState(EMPTY_STATE)
    }
  }, [projectPath])

  useEffect(() => { void load() }, [load])

  const saveConnection = useCallback(async () => {
    if (!projectPath) return
    const current = value.trim()
    const detected = extractDatabaseConnectionMatch(current, provider)
    if (!detected) {
      const msg = `Unsupported ${getDatabaseProviderLabel(provider)} connection format.`
      setInfo(msg)
      setState(prev => ({ ...prev, status: 'failed', provider, message: msg, updatedAt: new Date().toISOString() }))
      return
    }

    setBusy(true)
    try {
      const secretValue = detected.databaseUrl ?? detected.projectUrl ?? detected.raw
      await clearOtherSecrets(detected.secretKey)
      await invoke('project_secret_set', { projectPath, key: detected.secretKey, value: secretValue })
      const next: DatabaseState = {
        status: detected.needsCredentials ? 'needs_credentials' : 'connected',
        provider: providerFromMatch(detected, provider),
        connectionType: detected.connectionType,
        url: secretValue,
        message: detected.needsCredentials
          ? 'Project URL saved. Add the full database connection string to verify runtime access.'
          : `${detected.runtimeEnvKey} saved for this project.`,
        updatedAt: new Date().toISOString(),
      }
      setState(next)
      await updateProjectRuntime(projectPath, { database: next })
      setInfo(detected.needsCredentials ? 'Saved, but credentials are still required.' : 'Saved. Use Test connection to verify reachability.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setInfo(msg)
      setState(prev => ({ ...prev, status: 'failed', provider, message: msg, updatedAt: new Date().toISOString() }))
      await syncRuntime({ status: 'failed', provider, message: msg, updatedAt: new Date().toISOString() })
    } finally {
      setBusy(false)
    }
  }, [projectPath, value, provider, clearOtherSecrets, syncRuntime])

  const testConnection = useCallback(async () => {
    if (!projectPath) return
    const detected = extractDatabaseConnectionMatch(value.trim(), provider)
    if (!detected?.databaseUrl) {
      const msg = 'A full connection URL or SQLite file path is required to test.'
      setInfo(msg)
      setState(prev => ({ ...prev, status: 'needs_credentials', provider, message: msg, updatedAt: new Date().toISOString() }))
      await syncRuntime({ status: 'needs_credentials', provider, message: msg, updatedAt: new Date().toISOString() })
      return
    }

    setBusy(true)
    const testing: DatabaseState = {
      ...state,
      status: 'testing',
      provider: providerFromMatch(detected, provider),
      connectionType: detected.connectionType,
      url: detected.databaseUrl,
      message: 'Testing database connection...',
      updatedAt: new Date().toISOString(),
    }
    setState(testing)
    await updateProjectRuntime(projectPath, { database: testing })

    try {
      const result = await invoke<{ ok: boolean; provider: DatabaseProvider; message: string; urlKind: string }>('project_database_test', {
        databaseUrl: detected.databaseUrl,
      })
      const resultProvider = result.provider && result.provider !== 'unknown' ? result.provider : providerFromMatch(detected, provider)
      const next: DatabaseState = {
        status: result.ok ? 'connected' : 'failed',
        provider: resultProvider,
        connectionType: detected.connectionType,
        url: detected.databaseUrl,
        message: result.message,
        updatedAt: new Date().toISOString(),
      }
      setState(next)
      await updateProjectRuntime(projectPath, { database: next })
      setInfo(result.ok ? 'Connection value verified.' : result.message)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const next: DatabaseState = {
        status: 'failed',
        provider: providerFromMatch(detected, provider),
        connectionType: detected.connectionType,
        url: detected.databaseUrl,
        message: msg,
        updatedAt: new Date().toISOString(),
      }
      setState(next)
      await updateProjectRuntime(projectPath, { database: next })
      setInfo(msg)
    } finally {
      setBusy(false)
    }
  }, [projectPath, value, provider, state, syncRuntime])

  const removeConnection = useCallback(async () => {
    if (!projectPath) return
    setBusy(true)
    try {
      await clearOtherSecrets()
      const next: DatabaseState = {
        status: 'disconnected',
        provider: 'unknown',
        connectionType: 'url',
        url: null,
        message: 'Database connection removed.',
        updatedAt: new Date().toISOString(),
      }
      setValue('')
      setState(next)
      await updateProjectRuntime(projectPath, { database: next })
      setInfo('Connection removed from this project.')
    } finally {
      setBusy(false)
    }
  }, [projectPath, clearOtherSecrets])

  return (
    <div className="workspace-panel database-panel">
      <div className="empty-panel" style={{ maxWidth: 760, margin: '0 auto' }}>
        <div className="empty-panel-icon">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="32" cy="14" rx="22" ry="8" />
            <path d="M10 14v12c0 4.4 9.8 8 22 8s22-3.6 22-8V14" />
            <path d="M10 26v12c0 4.4 9.8 8 22 8s22-3.6 22-8V26" />
            <path d="M10 38v8c0 4.4 9.8 8 22 8s22-3.6 22-8v-8" />
          </svg>
        </div>
        <h3 className="empty-panel-title">Database</h3>
        <p className="empty-panel-desc">{describeMatch(match, provider)}</p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 12 }}>
          {PROVIDERS.map(item => (
            <button
              key={item.id}
              className="empty-panel-btn"
              onClick={() => setProvider(item.id)}
              style={{
                opacity: provider === item.id ? 1 : 0.72,
                borderColor: provider === item.id ? 'rgba(125, 160, 255, 0.8)' : undefined,
              }}
              type="button"
            >
              {getDatabaseProviderLabel(item.id)}
            </button>
          ))}
        </div>

        <textarea
          className="empty-panel-input"
          placeholder={selectedProvider.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          style={{ width: '100%', resize: 'vertical', marginTop: 12 }}
        />
        <div style={{ opacity: 0.65, fontSize: 12, marginTop: 6 }}>{selectedProvider.hint}</div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, justifyContent: 'center' }}>
          <button className="empty-panel-btn" onClick={() => void saveConnection()} disabled={busy || !projectPath}>
            Save
          </button>
          <button className="empty-panel-btn" onClick={() => void testConnection()} disabled={busy || !projectPath}>
            Test connection
          </button>
          <button className="empty-panel-btn" onClick={() => void removeConnection()} disabled={busy || !projectPath}>
            Remove
          </button>
          <button
            className="empty-panel-btn"
            onClick={() => onAskAI?.(`Please connect this project to ${getDatabaseProviderLabel(provider)} and verify the connection.`)}
            disabled={!onAskAI}
          >
            Ask AI
          </button>
        </div>

        <div style={{ marginTop: 16, padding: 12, borderRadius: 12, background: 'rgba(255,255,255,0.04)', textAlign: 'left' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Status: <span style={{ textTransform: 'capitalize' }}>{state.status.replace(/_/g, ' ')}</span>
          </div>
          <div style={{ opacity: 0.85, fontSize: 13, lineHeight: 1.5 }}>{state.message || info || 'No status yet.'}</div>
          <div style={{ opacity: 0.65, fontSize: 12, marginTop: 8 }}>
            Provider: {getDatabaseProviderLabel(state.provider ?? 'unknown')}
          </div>
          <div style={{ opacity: 0.65, fontSize: 12, marginTop: 4 }}>
            Connection type: {state.connectionType ?? 'url'}
          </div>
          <div style={{ opacity: 0.65, fontSize: 12, marginTop: 4 }}>
            Last verified: {formatVerifiedAt(state.updatedAt)}
          </div>
          {info && (
            <div style={{ opacity: 0.75, fontSize: 12, marginTop: 8 }}>
              {info}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
