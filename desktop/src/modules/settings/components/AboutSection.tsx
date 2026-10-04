import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { platform, arch } from '@tauri-apps/plugin-os'
import { useUpdater } from '@/lib/useUpdater'
import { IS_LINUX } from '@/lib/platform'

const GITHUB_URL = 'https://github.com/betopialimited/betopia-coder'
const WEBSITE_URL = 'https://betopia.ai'
const BUNDLE_ID = 'com.betopia.webbuilder'

const PLATFORM_LABEL: Record<string, string> = {
  macos: 'macOS', windows: 'Windows', linux: 'Linux', freebsd: 'FreeBSD',
}

async function openUrl(url: string) {
  try {
    // Try Tauri shell open (available without plugin-opener)
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('plugin:shell|open', { path: url })
  } catch {
    window.open(url, '_blank')
  }
}

export default function AboutSection() {
  const [version, setVersion] = useState('')
  const [build, setBuild] = useState('')
  const { status, check, install } = useUpdater({ autoCheck: false })

  const checking    = status.kind === 'checking'
  const downloading = status.kind === 'downloading'
  const available   = status.kind === 'available'
  const manualAvail = status.kind === 'manual-available'
  const ready       = status.kind === 'ready'

  const checkLabel =
    status.kind === 'uptodate'      ? "You're up to date" :
    status.kind === 'error'         ? 'Check failed — retry' :
    checking                        ? 'Checking…' :
    downloading                     ? `Downloading…` :
    ready                           ? 'Restart to install' :
    available                       ? `Install v${(status as any).update.version}` :
    manualAvail                     ? `Update to v${(status as any).info.version}` :
                                      'Check for updates'

  const onUpdateClick = () => {
    if (available) void install()
    else if (manualAvail) void openUrl((status as any).info.releaseUrl)
    else void check({ manual: true })
  }

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {})
    try {
      const p = platform()
      const a = arch()
      setBuild(`${PLATFORM_LABEL[p] ?? p} · ${a}`)
    } catch { setBuild('') }
  }, [])

  const pct = downloading && (status as any).contentLength
    ? Math.min(100, Math.round(((status as any).downloaded / (status as any).contentLength) * 100))
    : null

  return (
    <div className="about-section">
      {/* App identity card */}
      <div className="about-card">
        <div className="about-logo">
          <img src="/favicon.ico" alt="Betopia Coder" width={40} height={40} draggable={false} />
        </div>
        <div className="about-identity">
          <div className="about-name">Betopia Coder</div>
          <div className="about-tagline">AI-powered web app builder</div>
          <div className="about-version">v{version || '—'}</div>
        </div>
      </div>

      {/* Info grid */}
      <dl className="about-grid">
        <dt>Build</dt>
        <dd className="mono">{build ? `${build} · v${version}` : `v${version}`}</dd>

        <dt>Bundle ID</dt>
        <dd className="mono">{BUNDLE_ID}</dd>

        <dt>License</dt>
        <dd>FSL-1.1-MIT</dd>

        <dt>Website</dt>
        <dd>
          <button className="about-link" onClick={() => void openUrl(WEBSITE_URL)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
            betopia.ai
          </button>
        </dd>

        <dt>Source</dt>
        <dd>
          <button className="about-link" onClick={() => void openUrl(GITHUB_URL)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
            betopialimited/betopia-coder
          </button>
        </dd>
      </dl>

      {/* Update + actions */}
      <div className="about-actions">
        <div className="about-btn-row">
          <button
            className={`about-update-btn${ready ? ' ready' : available || manualAvail ? ' available' : ''}`}
            onClick={onUpdateClick}
            disabled={checking || downloading || ready}
          >
            {pct !== null ? (
              <span className="about-progress-bar" style={{ '--pct': `${pct}%` } as React.CSSProperties}>
                <span>{pct}%</span>
              </span>
            ) : checkLabel}
          </button>

          <button className="about-btn-outline" onClick={() => void openUrl(GITHUB_URL)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
            GitHub
          </button>

          <button className="about-btn-ghost" onClick={() => void openUrl(`${GITHUB_URL}/issues/new`)}>
            Report issue
          </button>
        </div>

        {status.kind === 'error' && (
          <p className="about-error">{status.message}</p>
        )}

        {manualAvail && IS_LINUX && (
          <div className="about-linux-update">
            <p className="about-linux-note">New version v{(status as any).info.version} available. Update via your package manager:</p>
            <code className="about-linux-cmd">sudo dpkg -i betopia-coder_*.deb</code>
            <p className="about-linux-note" style={{ marginTop: 4 }}>
              Or download from <button className="about-link" onClick={() => void openUrl((status as any).info.releaseUrl)}>GitHub Releases</button>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
