// VS Code-style bottom status bar: git branch, problem count, active file + language.
// ponytail: line:col deferred — needs a CodeMirror cursor listener across editor instances.
const LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React',
  json: 'JSON', css: 'CSS', scss: 'SCSS', html: 'HTML', md: 'Markdown', mdx: 'MDX',
  py: 'Python', rs: 'Rust', go: 'Go', sh: 'Shell', bash: 'Shell', yml: 'YAML', yaml: 'YAML',
  toml: 'TOML', sql: 'SQL', java: 'Java', rb: 'Ruby', php: 'PHP', vue: 'Vue', svelte: 'Svelte',
}

function langOf(p?: string | null): string {
  if (!p) return ''
  const e = p.split('.').pop()?.toLowerCase() ?? ''
  return LANG[e] ?? (e ? e.toUpperCase() : 'Plain Text')
}

export default function StatusBar({ filePath, branch, errorCount }: {
  filePath?: string | null
  branch?: string | null
  errorCount: number
}) {
  const name = filePath ? filePath.split(/[/\\]/).pop() : null
  return (
    <div className="status-bar">
      {branch && <span className="status-item" title="Git branch">⎇ {branch}</span>}
      <span className={'status-item' + (errorCount ? ' status-errors' : '')} title="Problems">
        ⚠ {errorCount}
      </span>
      <span className="status-spacer" />
      {name && <span className="status-item">{name}</span>}
      {filePath && <span className="status-item">{langOf(filePath)}</span>}
    </div>
  )
}
