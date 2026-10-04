import { useCallback, useEffect, useMemo, useState } from 'react'
import { readProjectFile } from '@/lib/fs'
import { loadCodeHistory, loadSnapshot } from '@/lib/codeHistory'
import DiffViewer from '@/components/DiffViewer'

interface SummaryFileRef {
  label: string
  path: string
}

interface SummarySection {
  title: string
  body: string
  files: SummaryFileRef[]
}

interface ParsedSummary {
  intro: string
  sections: SummarySection[]
}

interface FileDiffState {
  path: string
  originalContent: string
  proposedContent: string
  isNewFile: boolean
}

interface Props {
  text: string
  projectPath?: string | null
  durationMs?: number
}

interface DisplaySummary {
  sections: SummarySection[]
}

export default function TaskSummaryPanel({ text, projectPath, durationMs }: Props) {
  const [snapshotFiles, setSnapshotFiles] = useState<SummaryFileRef[]>([])
  const [fileDiff, setFileDiff] = useState<FileDiffState | null>(null)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!projectPath) {
      setSnapshotFiles([])
      return
    }
    const loadWithRetry = async (attempt = 0) => {
      const refs = await loadChangedFiles(projectPath)
      if (cancelled) return
      if (refs.length > 0 || attempt >= 4) {
        setSnapshotFiles(refs)
        return
      }
      window.setTimeout(() => {
        void loadWithRetry(attempt + 1)
      }, 250)
    }

    void loadWithRetry()
    return () => {
      cancelled = true
    }
  }, [projectPath, text])

  const display = useMemo<DisplaySummary | null>(() => {
    const parsed = parseSummary(text)
    const sections = parsed
      ? normalizeParsedSections(parsed, snapshotFiles)
      : synthesizeSections(text, snapshotFiles)
    if (sections.length === 0) return null
    return { sections }
  }, [snapshotFiles, text])

  const openFileDiff = useCallback(async (path: string) => {
    if (!projectPath) return
    setLoadingPath(path)
    try {
      const entries = loadCodeHistory(projectPath).filter(entry => entry.snapshotId).slice(0, 2)
      const latest = entries[0]?.snapshotId ? await loadSnapshot(entries[0].snapshotId) : null
      const previous = entries[1]?.snapshotId ? await loadSnapshot(entries[1].snapshotId) : null

      const latestSnapshotContent = latest?.files.find(f => f.path === path)?.content ?? ''
      const previousSnapshotContent = previous?.files.find(f => f.path === path)?.content ?? ''
      const currentDiskContent = await readProjectFile(projectPath, path).catch(() => '')

      const proposedContent = currentDiskContent || latestSnapshotContent
      const originalContent = previousSnapshotContent
      setFileDiff({
        path,
        originalContent,
        proposedContent,
        isNewFile: !originalContent && !!proposedContent,
      })
    } finally {
      setLoadingPath(null)
    }
  }, [projectPath])

  useEffect(() => {
    if (!fileDiff) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFileDiff(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fileDiff])

  if (!display) return null

  const fileSections = display.sections.filter(section => /files?( updated| history| changed| summary)?/i.test(section.title))
  const summarySections = display.sections.filter(section => !/files?( updated| history| changed| summary)?/i.test(section.title))

  return (
    <div className="task-summary-panel">
      <details className="task-summary-details" open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="task-summary-summary">
          <span className="task-summary-summary-left">
            <span className="task-summary-summary-dot" />
            <span className="task-summary-summary-title">
              Summary
            </span>
          </span>
          <span className="task-summary-summary-right">
            <span className="task-summary-summary-hint">{open ? 'Hide summary' : 'Show summary'}</span>
            <span className={'task-summary-summary-chevron' + (open ? ' is-open' : '')} aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </span>
        </summary>

        <div className="task-summary-body">
          <div className="task-summary-history">
            {summarySections.map(section => (
              <div key={section.title} className="task-summary-section">
                <div className="task-summary-section-title">
                  <span>{section.title}</span>
                  {section.files.length > 0 && <span className="task-summary-section-count">{section.files.length}</span>}
                </div>
                {section.body && <div className="task-summary-section-body">{renderWorkingsBody(section.body)}</div>}
                {section.files.length > 0 && (
                  <div className="task-summary-file-list">
                    {(section.files.length > 0 ? section.files : snapshotFiles).map(file => (
                      <button
                        key={file.path}
                        type="button"
                        className="task-summary-file-pill"
                        onClick={() => openFileDiff(file.path)}
                        disabled={loadingPath === file.path}
                        title="Open file history"
                      >
                        <span className="task-summary-file-icon" aria-hidden="true">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 4h10l6 6v10H4z" />
                            <path d="M14 4v6h6" />
                          </svg>
                        </span>
                        <span className="task-summary-file-name">{file.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {fileSections.map(section => (
              <div key={section.title + section.files.map(file => file.path).join('|')} className="task-summary-section">
                <div className="task-summary-section-title">
                  <span>{section.title}</span>
                  <span className="task-summary-section-count">{section.files.length}</span>
                </div>
                {section.body && <div className="task-summary-section-body">{renderWorkingsBody(section.body)}</div>}
                <div className="task-summary-file-list">
                  {section.files.map(file => (
                    <button
                      key={file.path}
                      type="button"
                      className="task-summary-file-pill"
                      onClick={() => openFileDiff(file.path)}
                      disabled={loadingPath === file.path}
                      title="Open file history"
                    >
                      <span className="task-summary-file-icon" aria-hidden="true">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 4h10l6 6v10H4z" />
                          <path d="M14 4v6h6" />
                        </svg>
                      </span>
                      <span className="task-summary-file-name">{file.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </details>

      {fileDiff && (
        <div className="task-summary-modal-overlay" onClick={() => setFileDiff(null)}>
          <div className="task-summary-modal" onClick={e => e.stopPropagation()}>
            <div className="task-summary-modal-header">
              <div className="task-summary-modal-title">{fileDiff.path}</div>
              <button className="task-summary-modal-close" onClick={() => setFileDiff(null)} aria-label="Close file history">
                x
              </button>
            </div>
            <div className="task-summary-modal-body">
              <DiffViewer
                path={fileDiff.path}
                originalContent={fileDiff.originalContent}
                proposedContent={fileDiff.proposedContent}
                status="approved"
                isNewFile={fileDiff.isNewFile}
                onAccept={() => {}}
                onReject={() => {}}
                showActions={false}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function normalizeParsedSections(parsed: ParsedSummary, snapshotFiles: SummaryFileRef[]): SummarySection[] {
  const sections = parsed.sections
    .map(section => {
      const isFileSection = /files?( updated| history| changed)?/i.test(section.title)
      const extractedFiles = extractFilesFromText(section.body)
      if (isFileSection) {
        return {
          ...section,
          files: dedupeFiles(section.files.length > 0 ? section.files : [...extractedFiles, ...snapshotFiles]),
          body: '',
        }
      }

      return {
        ...section,
        body: summarizeSectionBody(section.body, section.title),
        files: dedupeFiles([...section.files, ...extractedFiles]),
      }
    })
    .filter(section => section.files.length > 0 || section.body.length > 0)

  if (parsed.intro) {
    sections.unshift({
      title: 'What changed',
      body: summarizeSectionBody(parsed.intro, 'What changed'),
      files: [],
    })
  }

  if (snapshotFiles.length > 0 && !sections.some(section => /files?( updated| history| changed| summary)?/i.test(section.title))) {
    sections.push({
      title: 'Files updated',
      body: '',
      files: snapshotFiles,
    })
  }

  return sections
}

function synthesizeSections(text: string, snapshotFiles: SummaryFileRef[]): SummarySection[] {
  const cleaned = sanitizeTaskText(text)
  if (!cleaned && snapshotFiles.length === 0) return []

  const whatChanged = pickSummarySentence(
    cleaned,
    [
      /fix|fixed|change|changed|update|updated|add|added|remove|removed|create|created|implement|implemented|refine|rework|move|moved|adjust|adjusted|restore|replace|replaced|improve|improved|tighten|simplify|reorganize|clean up|cleanup/i,
    ],
    compactSummaryIntro(cleaned)
  )

  const result = pickSummarySentence(
    cleaned,
    [/done|finished|complete|completed|ready|resolved|verified|working|passes|passed|success|now/i],
    ''
  )

  const verification = extractVerificationSummary(cleaned)
  const files = snapshotFiles.length > 0 ? snapshotFiles : extractFilesFromText(cleaned)

  const sections: SummarySection[] = []
  if (whatChanged) sections.push({ title: 'What changed', body: whatChanged, files: extractFilesFromText(whatChanged) })
  if (result && result !== whatChanged) sections.push({ title: 'Result', body: result, files: extractFilesFromText(result) })
  if (verification) sections.push({ title: 'Verification', body: verification, files: extractFilesFromText(verification) })
  if (files.length > 0) sections.push({ title: 'Files updated', body: '', files })

  return sections
}

function parseSummary(text: string): ParsedSummary | null {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return null

  const headingPattern = /^(?:#{1,3}\s*)?([A-Za-z][A-Za-z0-9 &/+\-()]+):\s*$/
  const lines = normalized.split('\n')

  const sections: SummarySection[] = []
  const introLines: string[] = []
  let current: SummarySection | null = null
  let seenHeading = false

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const match = line.trim().match(headingPattern)
    if (match) {
      seenHeading = true
      if (current) sections.push(current)
      current = { title: match[1].trim(), body: '', files: [] }
      continue
    }

    if (!seenHeading) {
      if (line.trim()) introLines.push(line)
      continue
    }

    if (!current) current = { title: 'Summary', body: '', files: [] }
    current.body += (current.body ? '\n' : '') + line
  }

  if (current) sections.push(current)
  if (sections.length === 0) return null

  const parsedSections = sections.map(section => {
    const isFileSection = /files?( updated| history| changed)?/i.test(section.title)
    if (!isFileSection) return section

    const files: SummaryFileRef[] = []
    for (const rawLine of section.body.split('\n')) {
      const item = parseFileRef(rawLine)
      if (item) files.push(item)
    }

    return {
      ...section,
      files,
      body: files.length > 0 ? '' : section.body,
    }
  })

  return {
    intro: introLines.join('\n').trim(),
    sections: parsedSections,
  }
}

function compactSummaryIntro(text: string): string {
  const cleaned = sanitizeTaskText(text)
  if (!cleaned) return ''

  const sentences = splitSentences(cleaned)
  const filtered = sentences.filter(sentence => !isNoiseSentence(sentence))
  const firstTwo = filtered.slice(0, 2).join(' ').trim()
  const limit = 220
  if (firstTwo.length <= limit) return firstTwo
  return `${firstTwo.slice(0, limit - 3).trimEnd()}...`
}

function extractVerificationSummary(text: string): string {
  const cleaned = sanitizeTaskText(text)
  const hits = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => /build|test|verify|verification|passes|passed|compiled|compile|verified/i.test(line))
    .slice(0, 2)

  if (hits.length === 0) return ''
  return hits.map(compactSentence).join(' ')
}

function summarizeSectionBody(body: string, title: string): string {
  const cleaned = sanitizeTaskText(body)
  if (!cleaned) return ''

  if (/verification/i.test(title)) {
    return extractVerificationSummary(cleaned) || compactSentence(cleaned)
  }

  if (/result|outcome|status/i.test(title)) {
    return pickSummarySentence(cleaned, [/done|fixed|implemented|updated|verified|passed|working|ready/i], compactSummaryIntro(cleaned))
  }

  if (/what changed|summary|change/i.test(title)) {
    return pickSummarySentence(cleaned, [/fix|fixed|change|updated|added|removed|created|implemented|improved|moved|replaced|adjusted/i], compactSummaryIntro(cleaned))
  }

  const sentences = splitSentences(cleaned).filter(sentence => !isNoiseSentence(sentence))
  return compactSentence(sentences[0] || cleaned)
}

function pickSummarySentence(text: string, patterns: RegExp[], fallback: string): string {
  const sentences = splitSentences(text).filter(sentence => sentence && !isNoiseSentence(sentence))
  const hit = sentences.find(sentence => patterns.some(pattern => pattern.test(sentence)))
  if (hit) return compactSentence(hit)
  if (fallback) return compactSentence(fallback)
  return compactSentence(sentences.slice(0, 2).join(' '))
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
}

function isNoiseSentence(sentence: string): boolean {
  return /^(let me|i'?ll|now let me|here'?s|the current|let us|we can|want me to|if you want|i can also|next step|verifying|i will|i'm going to|checking|reading|looking at|let me check)/i.test(sentence)
    || /^\[.*\]$/.test(sentence)
}

function sanitizeTaskText(text: string): string {
  return text
    .replace(/^\s*\[(Retrying|Retry)[^\]]*\]\s*/i, '')
    .replace(/^\s*\[Retrying[^\]]*\]\s*/i, '')
    .replace(/\*\*/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function compactSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  const limit = 180
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 3).trimEnd()}...`
}

async function loadChangedFiles(projectPath: string): Promise<SummaryFileRef[]> {
  const entries = loadCodeHistory(projectPath).filter(entry => entry.snapshotId).slice(0, 2)
  const latest = entries[0]?.snapshotId ? await loadSnapshot(entries[0].snapshotId) : null
  const previous = entries[1]?.snapshotId ? await loadSnapshot(entries[1].snapshotId) : null
  if (!latest?.files?.length) return []

  const previousMap = new Map((previous?.files ?? []).map(file => [file.path, file.content]))
  const latestMap = new Map(latest.files.map(file => [file.path, file.content]))
  const paths = new Set<string>([...previousMap.keys(), ...latestMap.keys()])
  const changed = [...paths].filter(path => previousMap.get(path) !== latestMap.get(path))

  return changed.slice(0, 8).map(path => normalizeFileRef(path.split(/[/\\]/).pop() ?? path, path))
}

function extractFilesFromText(text: string): SummaryFileRef[] {
  const matches = new Set<string>()
  const refs: SummaryFileRef[] = []
  const patterns = [
    /\b(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]+/g,
    /`([^`]+\.[A-Za-z0-9]+)`/g,
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const path = (match[1] ?? match[0]).trim().replace(/^`|`$/g, '')
      if (!path || matches.has(path)) continue
      matches.add(path)
      refs.push(normalizeFileRef(path.split(/[/\\]/).pop() ?? path, path))
    }
  }

  return refs.slice(0, 8)
}

function dedupeFiles(files: SummaryFileRef[]): SummaryFileRef[] {
  const seen = new Set<string>()
  const output: SummaryFileRef[] = []
  for (const file of files) {
    const key = file.path.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(file)
  }
  return output
}

function parseFileRef(line: string): SummaryFileRef | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const clean = trimmed.replace(/^[•*\-\d.)\s]+/, '').trim()
  if (!clean) return null

  const markdownLink = clean.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
  if (markdownLink) {
    return normalizeFileRef(markdownLink[1], markdownLink[2])
  }

  const pathLike = clean.replace(/^`|`$/g, '')
  if (looksLikeFilePath(pathLike)) {
    return normalizeFileRef(pathLike.split(/[/\\]/).pop() ?? pathLike, pathLike)
  }

  return null
}

function normalizeFileRef(label: string, path: string): SummaryFileRef {
  return {
    label: label.trim().replace(/^`|`$/g, ''),
    path: path.trim().replace(/^`|`$/g, ''),
  }
}

function looksLikeFilePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.[a-z0-9]+$/i.test(value)
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

function renderCompactLines(text: string): string {
  const cleaned = sanitizeTaskText(text)
  if (!cleaned) return '...'

  const lines = cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^\s*(Updated|Result|Done|Verification|What changed)\s*:?\s*/i, ''))
    .map(line => line.replace(/^[-•*]\s*/, ''))
    .filter(Boolean)

  if (lines.length === 0) return compactSentence(cleaned)
  if (lines.length === 1) return compactSentence(lines[0])

  return lines.slice(0, 3).map(line => `• ${compactSentence(line)}`).join('\n')
}

function renderWorkingsPreview(text: string): string {
  const cleaned = sanitizeTaskText(text)
  if (!cleaned) return 'No working history available.'

  const sentences = splitSentences(cleaned)
    .filter(sentence => !isNoiseSentence(sentence))
    .map(sentence => sentence.replace(/^\s*[-•*]\s*/, '').trim())
    .filter(Boolean)

  if (sentences.length === 0) return compactSentence(cleaned)
  const preview = sentences.slice(0, 4).join(' ')
  return compactSentence(preview)
}

function renderWorkingsBody(text: string): string {
  const cleaned = text.replace(/\r\n/g, '\n').trim()
  if (!cleaned) return 'No working history available.'
  return cleaned
}
