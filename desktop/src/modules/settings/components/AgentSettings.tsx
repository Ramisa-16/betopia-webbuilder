import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import ThemeSelector from './ThemeSelector'
import { getConfig, saveConfig, getApiKey, setApiKey } from '@/lib/config'
import type { AgentConfig, MCPServer, CustomSubagentDef } from '@/lib/config'
import { testMCPServer, type MCPTestResult } from '@/lib/mcp-manager'
import { MCP_PRESET_DATA } from '@/lib/mcp-presets'
import { PROVIDERS, getProvider, BETOPIA_PLATFORM_URL, normalizeBetopiaModelId } from '@/lib/providers'
import { useBetopiaModels } from '@/lib/useConfig'
import { loadCustomSkillsForSettings, invalidateSkillsCache, type Skill } from '@/lib/agent'
import { notifySkillsChanged } from '@/lib/skill-events'
import { validateCustomSubagents } from '@/lib/subagents'
import { writeProjectFile } from '@/lib/fs'
import { useAppStore } from '@/store/appStore'
import { invoke } from '@tauri-apps/api/core'
import {
  createRepoSkillDraftFromCandidate,
  createEmptySkillDraft,
  createManualSkillDraft,
  createRepoSkillDraft,
  nameToFolderName,
  serializeSkillDraft,
  slashForSkillName,
  validateSkillDraft,
  type RepoSkillImportCandidate,
  type SkillBuilderDraft,
} from '@/lib/skill-builder'
import {
  createDraftSubagentFromImportedRepo,
  validateDraftSubagent,
  type DraftSubagent,
  type RepoSubagentImportResult,
  type RepoSubagentTrustLevel,
} from '@/lib/subagent-builder'
import GeneralSection from './GeneralSection'
import ShortcutsSection from './ShortcutsSection'
import AboutSection from './AboutSection'

type Tab = 'model' | 'agents' | 'general' | 'shortcuts' | 'mcp' | 'theme' | 'about'

const CUSTOM_LLM_PROVIDERS = PROVIDERS.filter(p => p.id === 'betopia')
const CUSTOM_SKILLS_DIR = '.betopia/skills/custom'
const RECENT_PROJECTS_KEY = 'betopia_recent_projects_v2'
const LEGACY_RECENT_PROJECTS_KEY = 'betopia_recent_paths'

function sameModelId(a: string, b: string): boolean {
  return normalizeBetopiaModelId(a, a, 'betopia').toLowerCase() === normalizeBetopiaModelId(b, b, 'betopia').toLowerCase()
}

// ── Skills helpers ─────────────────────────────────────────────────────────────

type DraftSkill = SkillBuilderDraft

type SkillImportResult = {
  cache_id: string
  repo_path: string
  candidates: RepoSkillImportCandidate[]
  warnings: string[]
}

function getSkillStorageRoot(projectPath: string, originalPath?: string): string {
  if (!originalPath) return projectPath
  const normalized = originalPath.replace(/\\/g, '/').replace(/\/$/, '')
  const marker = '/.betopia/skills/'
  const idx = normalized.indexOf(marker)
  if (idx >= 0) return normalized.slice(0, idx)
  return projectPath
}

function skillRelPath(folder: string): string {
  return `${CUSTOM_SKILLS_DIR}/${folder}/SKILL.md`
}

function skillFolderAbsPath(storageRoot: string, folder: string): string {
  return `${storageRoot}/${CUSTOM_SKILLS_DIR}/${folder}`.replace(/\/+/g, '/')
}

function getKnownProjectPaths(projectPath: string): string[] {
  const paths = new Set<string>()
  if (projectPath) paths.add(projectPath)

  try {
    const recents = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? '[]') as Array<{ path?: string }>
    for (const recent of recents) {
      if (recent?.path) paths.add(recent.path)
    }
  } catch {}

  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_RECENT_PROJECTS_KEY) ?? '[]') as string[]
    for (const path of legacy) {
      if (path) paths.add(path)
    }
  } catch {}

  return [...paths]
}

function skillToDraft(s: Skill): DraftSkill {
  const normalized = s.path.replace(/\\/g, '/').replace(/\/$/, '')
  const parts = normalized.split('/').filter(Boolean)
  const folderName = parts[parts.length - 1]?.toLowerCase() === 'skill.md'
    ? (parts[parts.length - 2] ?? 'skill')
    : (parts[parts.length - 1]?.replace(/\.md$/i, '') ?? 'skill')
  return {
    name: s.name,
    slash: s.slash?.trim() || slashForSkillName(s.name),
    description: s.description,
    body: s.body,
    dependsOn: s.dependsOn ?? [],
    disableModelInvocation: s.disableModelInvocation ?? false,
    folderName,
    originalPath: s.path,
    sourceType: 'manual',
  }
}

// ── Skill Editor Dialog ────────────────────────────────────────────────────────

function SkillEditorDialog({ draft: initial, onClose, onSave }: {
  draft: DraftSkill; onClose: () => void; onSave: (d: DraftSkill) => Promise<void>
}) {
  const [draft, setDraft] = useState<DraftSkill>(initial)
  const [folderEdited, setFolderEdited] = useState(!!initial.originalPath)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const isNew = !initial.originalPath
  const canSave = draft.name.trim().length > 0 && draft.body.trim().length > 0 && !saving

  const setName = (name: string) => {
    const folder = folderEdited ? draft.folderName : nameToFolderName(name)
    const slash = draft.slash?.trim() ? draft.slash : slashForSkillName(name)
    setDraft(d => ({ ...d, name, folderName: folder, slash }))
  }

  const handleSave = async () => {
    setSaving(true); setErr(null)
    try { await onSave(draft) }
    catch (e) { setErr(String(e)); setSaving(false) }
  }

  return (
    <div className="agent-editor-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="agent-editor-dialog agent-editor-dialog--wide">

        <div className="agent-editor-header">
          <div className="agent-editor-title">{isNew ? 'New skill' : 'Edit skill'}</div>
          <div className="agent-editor-subtitle">
            Stored in <code className="skill-path-code">.betopia/skills/custom/&lt;skill&gt;/SKILL.md</code>. The chat shows only the skill name, while the agent receives the skill instructions as hidden context when selected.
          </div>
        </div>

        <div className="agent-editor-section">
          <div className="agent-editor-section-label">Identity</div>
          <div style={{ display: 'flex', gap: 10, flexDirection: 'column' }}>
            <div className="agent-editor-field" style={{ marginBottom: 0 }}>
              <label className="agent-editor-label">Name <span className="agent-editor-required">*</span></label>
              <input className="agent-editor-input" value={draft.name} autoFocus
                onChange={e => setName(e.target.value)} placeholder="e.g. Deploy to Vercel" />
            </div>
            <div className="agent-editor-field" style={{ marginBottom: 0 }}>
              <label className="agent-editor-label">Description</label>
              <input className="agent-editor-input" value={draft.description}
                onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                placeholder="One line — what this skill does (shown to the agent)" />
            </div>
            <div className="agent-editor-field" style={{ marginBottom: 0 }}>
              <label className="agent-editor-label">Slash trigger</label>
              <input
                className="agent-editor-input agent-editor-input--mono"
                value={draft.slash}
                onChange={e => {
                  const raw = e.target.value.trim()
                  const slash = raw ? (raw.startsWith('/') ? raw : `/${raw}`) : '/'
                  setDraft(d => ({ ...d, slash }))
                }}
                placeholder="/debug"
              />
            </div>
            <div className="agent-editor-field" style={{ marginBottom: 0 }}>
              <label className="agent-editor-label">Folder</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="skill-path-prefix">.betopia/skills/custom/</span>
                <input className="agent-editor-input agent-editor-input--mono" style={{ flex: 1 }}
                  value={draft.folderName}
                  onChange={e => { setFolderEdited(true); setDraft(d => ({ ...d, folderName: e.target.value })) }}
                  placeholder="my-skill" />
                <span className="skill-path-suffix">/SKILL.md</span>
              </div>
            </div>
          </div>
        </div>

        <div className="agent-editor-section">
          <div className="agent-editor-section-label">Content <span className="agent-editor-required">*</span></div>
          <div className="agent-editor-section-hint">Markdown. Write instructions, runbooks, API references — anything the agent should follow when this skill applies.</div>
          <textarea
            className="agent-editor-textarea agent-editor-textarea--prompt"
            value={draft.body}
            onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
            placeholder={"# Deploy to Vercel\n\nSteps:\n1. Run `npm run build`\n2. Run `vercel --prod`\n3. Paste the deployment URL back in chat."}
            rows={11}
          />
        </div>

        <div className="agent-editor-section">
          <div className="agent-editor-section-label">Options</div>
          <label className="agent-tool-radio" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.disableModelInvocation}
              onChange={e => setDraft(d => ({ ...d, disableModelInvocation: e.target.checked }))}
              style={{ accentColor: 'var(--accent)', flexShrink: 0 }} />
            <span className="agent-tool-radio-body">
              <span className="agent-tool-radio-label">Revoke from agent use</span>
              <span className="agent-tool-radio-hint">Skill stays editable, but is removed from AI context and slash menus until enabled again</span>
            </span>
          </label>
        </div>

        {err && <div style={{ padding: '0 24px', color: 'var(--red)', fontSize: 11 }}>{err}</div>}

        <div className="agent-editor-footer">
          <button className="agent-editor-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="agent-editor-save" disabled={!canSave} onClick={handleSave}>
            {saving ? 'Saving…' : isNew ? 'Create skill' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// â"€â"€ Agents Tab â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

function AgentsTab() {
  const projectPath = useAppStore(s => s.projectPath)

  const [editingSkill, setEditingSkill]       = useState<DraftSkill | null>(null)
  const [addingSkill, setAddingSkill]         = useState(false)
  const [newSkillMode, setNewSkillMode]       = useState<'manual' | 'repo'>('manual')
  const [newSkillDraft, setNewSkillDraft]     = useState<DraftSkill>(() => createEmptySkillDraft('manual'))
  const [repoSkillUrl, setRepoSkillUrl]       = useState('')
  const [newSkillSaving, setNewSkillSaving]   = useState(false)
  const [newSkillImportStatus, setNewSkillImportStatus] = useState<string | null>(null)
  const [newSkillErr, setNewSkillErr]         = useState<string | null>(null)
  const [repoImportResult, setRepoImportResult] = useState<SkillImportResult | null>(null)
  const [selectedRepoCandidateIds, setSelectedRepoCandidateIds] = useState<string[]>([])
  const [skills, setSkills]                   = useState<Skill[]>([])
  const [skillsLoading, setSkillsLoading]     = useState(false)
  const [customSubagents, setCustomSubagents] = useState<CustomSubagentDef[]>(() => getConfig().customSubagents ?? [])
  const [editingSubagent, setEditingSubagent] = useState<CustomSubagentDef | null>(null)
  const [addingSubagent, setAddingSubagent]   = useState(false)
  const [importingSubagent, setImportingSubagent] = useState(false)
  const [repoSubagentUrl, setRepoSubagentUrl] = useState('')
  const [repoSubagentPurpose, setRepoSubagentPurpose] = useState('')
  const [repoSubagentName, setRepoSubagentName] = useState('')
  const [repoSubagentTrust, setRepoSubagentTrust] = useState<RepoSubagentTrustLevel>('low')
  const [subagentImportStatus, setSubagentImportStatus] = useState<string | null>(null)
  const [subagentImportError, setSubagentImportError] = useState<string | null>(null)
  const [subagentImportResult, setSubagentImportResult] = useState<RepoSubagentImportResult | null>(null)
  const [subagentImportSaving, setSubagentImportSaving] = useState(false)

  // Caveman built-in skill — reads/writes config directly (no prop drilling needed)
  const [cavemanOn,        setCavemanOn]        = useState(() => getConfig().behavior.cavemanEnabled)
  const [cavemanIntensity, setCavemanIntensity] = useState<'lite'|'full'|'ultra'>(() => (getConfig().behavior.cavemanIntensity as 'lite'|'full'|'ultra') ?? 'full')

  const saveCaveman = useCallback((enabled: boolean, intensity: 'lite'|'full'|'ultra') => {
    const cfg = getConfig()
    saveConfig({ ...cfg, behavior: { ...cfg.behavior, cavemanEnabled: enabled, cavemanIntensity: intensity } })
  }, [])

  const saveSubagents = useCallback((list: CustomSubagentDef[]) => {
    const errors = validateCustomSubagents(list)
    if (errors.length) {
      console.warn('[subagents] validation errors:', errors)
      // Surface first error to user via window alert (settings panel, not main UI)
      window.alert(`Custom subagent error:\n${errors[0]}`)
      return
    }
    const cfg = getConfig()
    saveConfig({ ...cfg, customSubagents: list })
  }, [])

  const refreshSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      if (projectPath) invalidateSkillsCache(projectPath)
      const loaded = await loadCustomSkillsForSettings(projectPath ?? '', getKnownProjectPaths(projectPath ?? ''))
      setSkills(loaded)
    } catch { setSkills([]) }
    finally { setSkillsLoading(false) }
  }, [projectPath])

  useEffect(() => { refreshSkills() }, [refreshSkills])

  const draftFromManualInput = useMemo(
    () => createManualSkillDraft(newSkillDraft),
    [newSkillDraft],
  )
  const draftFromRepoInput = useMemo(
    () => createRepoSkillDraft(repoSkillUrl.trim(), '', newSkillDraft.name.trim()),
    [newSkillDraft.name, repoSkillUrl],
  )
  const newSkillValidation = useMemo(
    () => validateSkillDraft(newSkillMode === 'repo' ? draftFromRepoInput : draftFromManualInput, skills),
    [draftFromManualInput, draftFromRepoInput, newSkillMode, skills],
  )
  const hasNewSkillDraftInput = Boolean(
    newSkillDraft.name.trim() || newSkillDraft.description.trim() || newSkillDraft.body.trim() || repoSkillUrl.trim(),
  )
  const importedSubagentDraft = useMemo<DraftSubagent | null>(() => {
    if (!subagentImportResult) return null
    return createDraftSubagentFromImportedRepo(
      repoSubagentUrl.trim(),
      subagentImportResult.candidate,
      {
        purpose: repoSubagentPurpose.trim(),
        trustLevel: repoSubagentTrust,
        explicitName: repoSubagentName.trim(),
      },
    )
  }, [repoSubagentName, repoSubagentPurpose, repoSubagentTrust, repoSubagentUrl, subagentImportResult])
  const importedSubagentValidation = useMemo(
    () => importedSubagentDraft
      ? validateDraftSubagent(importedSubagentDraft, customSubagents, skills)
      : null,
    [customSubagents, importedSubagentDraft, skills],
  )

  const resetNewSkillBuilder = useCallback(() => {
    setNewSkillMode('manual')
    setRepoSkillUrl('')
    setNewSkillImportStatus(null)
    setNewSkillErr(null)
    setRepoImportResult(null)
    setSelectedRepoCandidateIds([])
    setNewSkillDraft(createEmptySkillDraft('manual'))
  }, [])
  const resetSubagentImportBuilder = useCallback(() => {
    setRepoSubagentUrl('')
    setRepoSubagentPurpose('')
    setRepoSubagentName('')
    setRepoSubagentTrust('low')
    setSubagentImportStatus(null)
    setSubagentImportError(null)
    setSubagentImportResult(null)
    setSubagentImportSaving(false)
  }, [])

  const handleSaveSkill = async (draft: DraftSkill) => {
    if (!projectPath && !draft.originalPath) throw new Error('No project open')
    const content = serializeSkillDraft(draft)
    const folder = nameToFolderName(draft.folderName || draft.name)
    const newRelPath = skillRelPath(folder)
    const storageRoot = getSkillStorageRoot(projectPath ?? '', draft.originalPath)
    const originalPath = draft.originalPath?.replace(/\\/g, '/').replace(/\/$/, '')
    const originalAbsPath = originalPath ?? null
    const newAbsPath = `${storageRoot}/${newRelPath}`.replace(/\/+/g, '/')
    const wasFolderSkill = Boolean(originalPath && originalPath.toUpperCase().endsWith('/SKILL.MD'))
    if (originalAbsPath && originalAbsPath !== newAbsPath && wasFolderSkill) {
      const oldFolderPath = originalPath.slice(0, -'/SKILL.md'.length)
      await invoke('fs_rename', { from: oldFolderPath, to: skillFolderAbsPath(storageRoot, folder) })
    }
    await writeProjectFile(storageRoot, newRelPath, content)
    if (originalAbsPath && originalAbsPath !== newAbsPath && !wasFolderSkill) {
      await invoke('fs_delete', { path: originalAbsPath })
    }
    await refreshSkills()
    notifySkillsChanged()
    setEditingSkill(null)
  }

  const handleCreateManualSkill = async () => {
    const draft = createManualSkillDraft(newSkillDraft)
    const report = validateSkillDraft(draft, skills)
    if (report.status === 'blocked') {
      setNewSkillErr(report.errors[0] ?? 'Fix validation errors before publishing.')
      return
    }
    setNewSkillSaving(true); setNewSkillErr(null)
    try {
      await handleSaveSkill(draft)
      setAddingSkill(false)
      resetNewSkillBuilder()
    } catch (e) { setNewSkillErr(String(e)) }
    finally { setNewSkillSaving(false) }
  }

  const handleInspectRepoSkills = async () => {
    if (!repoSkillUrl.trim()) return
    if (newSkillValidation.status === 'blocked') {
      setNewSkillErr(newSkillValidation.errors[0] ?? 'Fix validation errors before publishing.')
      return
    }
    setNewSkillSaving(true); setNewSkillErr(null)
    try {
      setNewSkillImportStatus('Cloning and scanning repository…')
      const result = await invoke<SkillImportResult>('skill_import_git_repo', { repoUrl: repoSkillUrl.trim() })
      setRepoImportResult(result)
      setSelectedRepoCandidateIds(result.candidates.map(candidate => candidate.id))
      setNewSkillImportStatus(result.candidates.length > 0
        ? `Detected ${result.candidates.length} skill candidate${result.candidates.length === 1 ? '' : 's'}. Choose what to import.`
        : 'No importable skills were found. Clone locally and choose the folder.')
    } catch (e) { setNewSkillErr(String(e)) }
    finally { setNewSkillSaving(false) }
  }

  const handleImportSelectedRepoSkills = async () => {
    if (!repoImportResult || !repoSkillUrl.trim() || selectedRepoCandidateIds.length === 0) return
    setNewSkillSaving(true); setNewSkillErr(null)
    try {
      setNewSkillImportStatus('Validating selected skills…')
      const selected = repoImportResult.candidates.filter(candidate => selectedRepoCandidateIds.includes(candidate.id))
      const drafts = selected.map(candidate => createRepoSkillDraftFromCandidate(
        repoSkillUrl.trim(),
        candidate,
        selected.length === 1 ? newSkillDraft.name.trim() : '',
      ))
      const blocked = drafts
        .map(draft => ({ draft, report: validateSkillDraft(draft, skills) }))
        .find(item => item.report.status === 'blocked')
      if (blocked) {
        setNewSkillErr(`${blocked.draft.name}: ${blocked.report.errors[0] ?? 'Generated skill did not pass validation.'}`)
        return
      }
      setNewSkillImportStatus(`Saving ${drafts.length} skill${drafts.length === 1 ? '' : 's'}…`)
      const { homeDir } = await import('@tauri-apps/api/path')
      const home = await homeDir()
      for (const draft of drafts) {
        await invoke('fs_write_file', {
          path: `${home}/${skillRelPath(nameToFolderName(draft.folderName || draft.name))}`,
          content: serializeSkillDraft(draft),
        })
      }
      invalidateSkillsCache(projectPath ?? '')
      await refreshSkills()
      notifySkillsChanged()
      setAddingSkill(false)
      resetNewSkillBuilder()
    } catch (e) { setNewSkillErr(String(e)) }
    finally {
      setNewSkillSaving(false)
      setNewSkillImportStatus(null)
    }
  }

  const handleDeleteSkill = async (s: Skill) => {
    const normalized = s.path.replace(/\\/g, '/').replace(/\/$/, '')
    const pathToDelete = normalized.toUpperCase().endsWith('/SKILL.MD')
      ? normalized.slice(0, -'/SKILL.md'.length)
      : normalized
    await invoke('fs_delete', { path: pathToDelete.startsWith('/') ? pathToDelete : `${projectPath ?? ''}/${pathToDelete}` })
    if (projectPath) invalidateSkillsCache(projectPath)
    setSkills(prev => prev.filter(sk => sk.path !== s.path))
    notifySkillsChanged()
  }

  const handleToggleSkillRevoked = async (s: Skill) => {
    await handleSaveSkill({
      ...skillToDraft(s),
      disableModelInvocation: !s.disableModelInvocation,
    })
  }

  const handleInspectRepoSubagent = async () => {
    if (!repoSubagentUrl.trim()) return
    setSubagentImportSaving(true)
    setSubagentImportError(null)
    try {
      setSubagentImportStatus('Cloning and analyzing repository…')
      const result = await invoke<RepoSubagentImportResult>('subagent_import_git_repo', { repoUrl: repoSubagentUrl.trim() })
      setSubagentImportResult(result)
      setSubagentImportStatus('Review the imported candidate and install when ready.')
    } catch (e) {
      setSubagentImportError(String(e))
    } finally {
      setSubagentImportSaving(false)
    }
  }

  const handleInstallImportedSubagent = () => {
    if (!importedSubagentDraft || !importedSubagentValidation) return
    if (importedSubagentValidation.status === 'blocked') {
      setSubagentImportError(importedSubagentValidation.errors[0] ?? 'Fix validation errors before install.')
      return
    }
    const { trustLevel: _trustLevel, ...installedSubagent } = importedSubagentDraft
    const next = [...customSubagents, installedSubagent]
    setCustomSubagents(next)
    saveSubagents(next)
    setImportingSubagent(false)
    resetSubagentImportBuilder()
  }

  return (
    <div className="agents-section">
      {/* Skills */}
      <div>
        <div className="agents-row">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="agents-label">Skills</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
              Reusable instructions stored in <code style={{ fontFamily: 'var(--mono)', background: 'var(--surface-3)', padding: '1px 5px', borderRadius: 3 }}>.betopia/skills/custom/</code> — injected as context
            </span>
          </div>
          <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
            onClick={() => {
              setAddingSkill(a => {
                if (a) resetNewSkillBuilder()
                return !a
              })
            }}>
            {addingSkill ? '✕ Cancel' : '+ New skill'}
          </button>
        </div>
        {/* ── Built-in skills ── */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 6, marginTop: 4 }}>Built-in</div>
          <div className="skill-row" style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px', flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>Caveman Mode</span>
                  <code style={{ fontFamily: 'var(--mono)', fontSize: 10, background: 'var(--surface-3)', padding: '1px 6px', borderRadius: 4, color: 'var(--text-3)' }}>/caveman</code>
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Terse responses — drops filler, articles, fluff. Activate via toggle or type <code style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>/caveman</code> in chat.</span>
              </div>
              <label className="toggle" style={{ flexShrink: 0 }}>
                <input type="checkbox" checked={cavemanOn} onChange={e => { setCavemanOn(e.target.checked); saveCaveman(e.target.checked, cavemanIntensity) }} />
                <span className="toggle-slider" />
              </label>
            </div>
            {cavemanOn && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div className="settings-radio-group">
                  {(['lite', 'full', 'ultra'] as const).map(v => (
                    <button key={v} className={`settings-radio${cavemanIntensity === v ? ' active' : ''}`}
                      onClick={() => { setCavemanIntensity(v); saveCaveman(cavemanOn, v) }}>
                      {v}
                    </button>
                  ))}
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {cavemanIntensity === 'lite'  && 'Keep articles. Drop pleasantries + filler.'}
                  {cavemanIntensity === 'full'  && 'Drop articles + filler. Fragments OK. Short synonyms.'}
                  {cavemanIntensity === 'ultra' && 'Maximum compression. Single-word answers where possible.'}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── Custom skills ── */}
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 6 }}>Custom</div>

        {addingSkill && (
          <div style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '14px 14px 12px', marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="settings-radio-group" style={{ alignSelf: 'flex-start' }}>
              <button className={`settings-radio${newSkillMode === 'manual' ? ' active' : ''}`}
                onClick={() => {
                  setNewSkillMode('manual')
                  setRepoImportResult(null)
                  setSelectedRepoCandidateIds([])
                  setNewSkillImportStatus(null)
                  setNewSkillErr(null)
                }}>
                Manual
              </button>
              <button className={`settings-radio${newSkillMode === 'repo' ? ' active' : ''}`}
                onClick={() => {
                  setNewSkillMode('repo')
                  setNewSkillImportStatus(null)
                  setNewSkillErr(null)
                }}>
                Git repo
              </button>
            </div>

            {newSkillMode === 'manual' ? (
              <>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Skill name <span style={{ color: 'var(--red)' }}>*</span></label>
                  <input className="settings-input" placeholder="e.g. Debugging and Error Recovery" value={newSkillDraft.name}
                    onChange={e => setNewSkillDraft(d => ({ ...d, name: e.target.value, folderName: nameToFolderName(e.target.value) || d.folderName }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>When to use <span style={{ color: 'var(--red)' }}>*</span></label>
                  <input className="settings-input" placeholder="e.g. When asked to debug failing code, runtime errors, or broken tests" value={newSkillDraft.description}
                    onChange={e => setNewSkillDraft(d => ({ ...d, description: e.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Details / prompt <span style={{ color: 'var(--red)' }}>*</span></label>
                  <textarea
                    className="settings-input"
                    style={{ minHeight: 130, resize: 'vertical', lineHeight: 1.45 }}
                    placeholder={"Write the workflow the agent should follow.\n\nExample:\n1. Reproduce the bug.\n2. Read logs and recent changes.\n3. Find root cause before editing.\n4. Add or run verification."}
                    value={newSkillDraft.body}
                    onChange={e => setNewSkillDraft(d => ({ ...d, body: e.target.value }))}
                  />
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 11, color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Skill name</label>
                    <input className="settings-input" placeholder="Optional. Used when importing one skill." value={newSkillDraft.name}
                      onChange={e => setNewSkillDraft(d => ({ ...d, name: e.target.value, folderName: nameToFolderName(e.target.value) || d.folderName }))} />
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>GitHub repo URL <span style={{ color: 'var(--red)' }}>*</span></label>
                  <input className="settings-input" placeholder="https://github.com/org/repo" value={repoSkillUrl}
                    onChange={e => {
                      setRepoSkillUrl(e.target.value)
                      setRepoImportResult(null)
                      setSelectedRepoCandidateIds([])
                      setNewSkillImportStatus(null)
                      setNewSkillErr(null)
                    }} />
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                    Clones the repo into a temporary read-only cache, detects skill folders, then imports selected skills to <code style={{ fontFamily: 'var(--mono)' }}>~/.betopia/skills/custom/&lt;skill&gt;/SKILL.md</code>. Private or blocked repos should be cloned locally and imported from folder later.
                  </div>
                </div>
              </>
            )}

            {newSkillMode === 'manual' && hasNewSkillDraftInput && (
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                Saves to <code style={{ fontFamily: 'var(--mono)' }}>.betopia/skills/custom/{nameToFolderName(newSkillDraft.folderName || newSkillDraft.name)}/SKILL.md</code>. The builder formats it as a structured skill before publishing.
              </div>
            )}

            {hasNewSkillDraftInput && !repoImportResult && (
              <div style={{ background: 'var(--surface-3)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>Draft validation</span>
                  <span className="skill-row-badge">{newSkillValidation.status} · {newSkillValidation.riskLevel} risk</span>
                </div>
                {newSkillValidation.errors.map(msg => <div key={msg} style={{ fontSize: 11, color: 'var(--red)' }}>{msg}</div>)}
                {newSkillValidation.warnings.map(msg => <div key={msg} style={{ fontSize: 11, color: '#fbbf24' }}>{msg}</div>)}
                {newSkillValidation.overlaps.map(item => (
                  <div key={`${item.path}-${item.reason}`} style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    Similar to <strong>{item.name}</strong>: {item.reason}
                  </div>
                ))}
              </div>
            )}

            {newSkillMode === 'repo' && repoImportResult && (
              <div style={{ background: 'var(--surface-3)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>Detected skills</span>
                  <span className="skill-row-badge">{selectedRepoCandidateIds.length} selected</span>
                </div>
                {repoImportResult.warnings.map(warning => (
                  <div key={warning} style={{ fontSize: 11, color: '#fbbf24' }}>{warning}</div>
                ))}
                {repoImportResult.candidates.map(candidate => {
                  const selected = selectedRepoCandidateIds.includes(candidate.id)
                  const draft = createRepoSkillDraftFromCandidate(
                    repoSkillUrl.trim(),
                    candidate,
                    repoImportResult.candidates.length === 1 ? newSkillDraft.name.trim() : '',
                  )
                  const report = validateSkillDraft(draft, skills)
                  return (
                    <label key={candidate.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={e => {
                          setSelectedRepoCandidateIds(prev => e.target.checked
                            ? [...prev, candidate.id]
                            : prev.filter(id => id !== candidate.id))
                        }}
                        style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                      />
                      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 12, color: 'var(--text-1)' }}>{draft.name}</strong>
                          <span className="skill-row-badge">{candidate.fallback ? 'docs fallback' : 'SKILL.md'}</span>
                          <span className="skill-row-badge">{report.status} · {report.riskLevel}</span>
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{candidate.description}</span>
                        <code className="skill-row-path">{candidate.source_path}</code>
                        {report.errors.map(msg => <span key={msg} style={{ fontSize: 11, color: 'var(--red)' }}>{msg}</span>)}
                        {report.warnings.slice(0, 2).map(msg => <span key={msg} style={{ fontSize: 11, color: '#fbbf24' }}>{msg}</span>)}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}

            {newSkillErr && <div style={{ fontSize: 11, color: 'var(--red)' }}>{newSkillErr}</div>}
            {newSkillImportStatus && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{newSkillImportStatus}</div>}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="agent-editor-cancel" onClick={() => { setAddingSkill(false); resetNewSkillBuilder() }}>Cancel</button>
              <button className="agent-editor-save"
                disabled={
                  newSkillSaving
                  || (newSkillMode === 'manual' && newSkillValidation.status === 'blocked')
                  || (newSkillMode === 'repo' && (!repoSkillUrl.trim() || (!repoImportResult && newSkillValidation.status === 'blocked') || (!!repoImportResult && selectedRepoCandidateIds.length === 0)))
                }
                onClick={newSkillMode === 'manual' ? handleCreateManualSkill : repoImportResult ? handleImportSelectedRepoSkills : handleInspectRepoSkills}>
                {newSkillSaving ? 'Working…' : newSkillMode === 'manual' ? 'Publish skill' : repoImportResult ? 'Import selected' : 'Inspect repo'}
              </button>
            </div>
          </div>
        )}

        {skillsLoading ? (
          <div className="snippets-empty" style={{ opacity: 0.5 }}>Loading…</div>
        ) : skills.length === 0 ? (
          <div className="snippets-empty">
            No custom skills yet. Custom skills are Markdown files you can edit, revoke, or remove from this list.
          </div>
        ) : (
          <div className="skills-list">
            {skills.map(s => {
              const displayPath = s.path.replace(/^.*\.betopia\/skills\//, '.betopia/skills/')
              return (
                <div key={s.path} className="skill-row">
                  <div className="skill-row-icon">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                      <polyline points="13 2 13 9 20 9" />
                    </svg>
                  </div>
                  <div className="skill-row-info">
                    <div className="skill-row-name">
                      {s.name}
                      {s.disableModelInvocation && <span className="skill-row-badge">revoked</span>}
                    </div>
                    {s.description && <div className="skill-row-desc">{s.description}</div>}
                    <code className="skill-row-path">{displayPath}</code>
                  </div>
                  <button className="agent-icon-btn" title={s.disableModelInvocation ? 'Enable skill' : 'Revoke skill'} onClick={() => handleToggleSkillRevoked(s)}>
                    {s.disableModelInvocation ? (
                      <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2.5 7.5l2.5 2.5 6-6" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="7" cy="7" r="5" />
                        <path d="M3.8 3.8l6.4 6.4" />
                      </svg>
                    )}
                  </button>
                  <button className="agent-icon-btn" title="Edit" onClick={() => setEditingSkill(skillToDraft(s))}>
                    <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M9.5 2.5l2 2L5 11H3V9l6.5-6.5z" />
                    </svg>
                  </button>
                  <button className="agent-icon-btn danger" title="Delete" onClick={() => handleDeleteSkill(s)}>
                    <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <polyline points="2,4 12,4" /><path d="M5 4V2h4v2" /><path d="M3 4l1 8h6l1-8" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Custom Subagents */}
      <div>
        <div className="agents-row">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="agents-label">Sub-agents</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
              Custom subagent types spawnable via <code style={{ fontFamily: 'var(--mono)', background: 'var(--surface-3)', padding: '1px 5px', borderRadius: 3 }}>run_subagent</code>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className={addingSubagent ? 'btn-primary' : 'btn-ghost'}
              style={{ fontSize: 11, padding: '4px 10px' }}
              onClick={() => {
                setImportingSubagent(false)
                setEditingSubagent(null)
                setAddingSubagent(true)
              }}
            >
              {addingSubagent ? 'Editing manual' : '+ Manual'}
            </button>
            <button
              className={importingSubagent ? 'btn-primary' : 'btn-ghost'}
              style={{ fontSize: 11, padding: '4px 10px' }}
              onClick={() => {
                setAddingSubagent(false)
                setEditingSubagent(null)
                setImportingSubagent(prev => {
                  if (prev) resetSubagentImportBuilder()
                  return !prev
                })
              }}
            >
              {importingSubagent ? '✕ Cancel import' : 'Import repo'}
            </button>
          </div>
        </div>
        {customSubagents.length === 0 && !addingSubagent && !importingSubagent && (
          <div className="snippets-empty">No custom sub-agents. Built-in: explore, code-review, security, general, coder, fixer.</div>
        )}
        {customSubagents.map(sa => (
          <div key={sa.id} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderRadius: 6, background: 'var(--bg-2)', marginBottom: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span>{sa.label}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.6 }}>({sa.id})</span>
                {sa.writable && <span style={{ fontSize: 10, color: 'var(--accent)' }}>write</span>}
                {sa.sourceType === 'repo' && <span className="skill-row-badge">repo import</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sa.description}</div>
              {sa.sourceUrl && <div style={{ fontSize: 10.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sa.sourceUrl}</div>}
            </div>
            <button className="icon-btn" onClick={() => { setImportingSubagent(false); setEditingSubagent(sa); setAddingSubagent(true) }} title="Edit">✎</button>
            <button className="icon-btn danger" onClick={() => {
              const next = customSubagents.filter(s => s.id !== sa.id)
              setCustomSubagents(next)
              saveSubagents(next)
            }} title="Delete">✕</button>
          </div>
        ))}
        {importingSubagent && (
          <div style={{ background: 'var(--bg-2)', borderRadius: 8, padding: 12, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Import Sub-agent from GitHub</div>
            <div className="settings-field" style={{ margin: 0 }}>
              <label className="settings-label">GitHub repo URL</label>
              <input
                className="settings-input"
                placeholder="https://github.com/org/repo"
                value={repoSubagentUrl}
                onChange={e => {
                  setRepoSubagentUrl(e.target.value)
                  setSubagentImportResult(null)
                  setSubagentImportError(null)
                }}
              />
            </div>
            <div className="settings-field" style={{ margin: 0 }}>
              <label className="settings-label">Short purpose</label>
              <input
                className="settings-input"
                placeholder="e.g. Use this repo's deployment workflow to review release changes"
                value={repoSubagentPurpose}
                onChange={e => setRepoSubagentPurpose(e.target.value)}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="settings-field" style={{ margin: 0 }}>
                <label className="settings-label">Display name override</label>
                <input
                  className="settings-input"
                  placeholder="Optional"
                  value={repoSubagentName}
                  onChange={e => setRepoSubagentName(e.target.value)}
                />
              </div>
              <div className="settings-field" style={{ margin: 0 }}>
                <label className="settings-label">Trust level</label>
                <div className="settings-radio-group">
                  {([
                    { value: 'low', label: 'Low', hint: 'Read-only, safest default' },
                    { value: 'medium', label: 'Medium', hint: 'Read-only, richer guidance' },
                    { value: 'high', label: 'High', hint: 'May keep repo write hints' },
                  ] as const).map(option => (
                    <button
                      key={option.value}
                      className={`settings-radio${repoSubagentTrust === option.value ? ' active' : ''}`}
                      onClick={() => setRepoSubagentTrust(option.value)}
                      title={option.hint}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {subagentImportResult && importedSubagentDraft && importedSubagentValidation && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <strong style={{ fontSize: 12, color: 'var(--text-1)' }}>{importedSubagentDraft.label}</strong>
                  <span className="skill-row-badge">{importedSubagentDraft.id}</span>
                  <span className="skill-row-badge">{importedSubagentValidation.status} · {importedSubagentValidation.riskLevel}</span>
                  {importedSubagentDraft.writable && <span className="skill-row-badge">write-capable</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{importedSubagentDraft.description}</div>
                <code className="skill-row-path">{subagentImportResult.candidate.source_path}</code>
                {subagentImportResult.analysis.warnings.map(warning => (
                  <div key={warning} style={{ fontSize: 11, color: '#fbbf24' }}>{warning}</div>
                ))}
                {importedSubagentValidation.errors.map(error => (
                  <div key={error} style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>
                ))}
                {importedSubagentValidation.warnings.map(warning => (
                  <div key={warning} style={{ fontSize: 11, color: '#fbbf24' }}>{warning}</div>
                ))}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11, color: 'var(--text-3)' }}>
                  <div>Model: <code>{importedSubagentDraft.model ?? 'inherit global'}</code></div>
                  <div>Tools: <code>{(importedSubagentDraft.tools ?? []).join(', ')}</code></div>
                </div>
                {subagentImportResult.candidate.linked_skills.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    Linked skills: {subagentImportResult.candidate.linked_skills.join(', ')}
                  </div>
                )}
                {subagentImportResult.candidate.import_notes.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {subagentImportResult.candidate.import_notes.slice(0, 4).map(note => (
                      <span key={note}>• {note}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {subagentImportError && <div style={{ fontSize: 11, color: 'var(--red)' }}>{subagentImportError}</div>}
            {subagentImportStatus && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{subagentImportStatus}</div>}

            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => { setImportingSubagent(false); resetSubagentImportBuilder() }}>
                Cancel
              </button>
              <button
                className="btn-primary"
                style={{ fontSize: 11, padding: '4px 10px' }}
                disabled={!repoSubagentUrl.trim() || subagentImportSaving || (!!subagentImportResult && importedSubagentValidation?.status === 'blocked')}
                onClick={subagentImportResult ? handleInstallImportedSubagent : handleInspectRepoSubagent}
              >
                {subagentImportSaving ? 'Working…' : subagentImportResult ? 'Install' : 'Inspect repo'}
              </button>
            </div>
          </div>
        )}
        {addingSubagent && (
          <SubagentForm
            initial={editingSubagent ?? undefined}
            onSave={sa => {
              const next = editingSubagent
                ? customSubagents.map(s => s.id === sa.id ? { ...s, ...sa } : s)
                : [...customSubagents, sa]
              setCustomSubagents(next)
              saveSubagents(next)
              setAddingSubagent(false)
              setEditingSubagent(null)
            }}
            onCancel={() => { setAddingSubagent(false); setEditingSubagent(null) }}
          />
        )}
      </div>

      {editingSkill && createPortal(
        <SkillEditorDialog draft={editingSkill} onClose={() => setEditingSkill(null)} onSave={handleSaveSkill} />,
        document.body
      )}
    </div>
  )
}

interface Props { onClose: () => void; initialTab?: string }

function uid() { return Math.random().toString(36).slice(2, 10) }

// ── MCP Preset gallery ────────────────────────────────────────────────────────

/* Brand SVG logos for preset cards */
const MCP_LOGOS: Record<string, React.ReactNode> = {
  Figma: (
    <svg viewBox="0 0 38 57" width="26" height="26" fill="none">
      <path d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" fill="#1ABCFE"/>
      <path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5A9.5 9.5 0 0 1 0 47.5z" fill="#0ACF83"/>
      <path d="M19 0v19h9.5a9.5 9.5 0 0 0 0-19H19z" fill="#FF7262"/>
      <path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" fill="#F24E1E"/>
      <path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" fill="#A259FF"/>
    </svg>
  ),
  GitHub: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
    </svg>
  ),
  Filesystem: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4.17a2 2 0 0 1 1.42.59l1.41 1.41A2 2 0 0 0 13.41 7H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
      <line x1="9" y1="13" x2="15" y2="13"/>
    </svg>
  ),
  PostgreSQL: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M12 2C8.5 2 5.5 4.5 5.5 8c0 1.4.5 2.7 1.3 3.7-.5.6-.8 1.4-.8 2.3 0 1.6.9 3 2.2 3.7-.1.4-.2.9-.2 1.3 0 1.7 1.3 3 3 3s3-1.3 3-3c0-.4-.1-.9-.2-1.3 1.3-.7 2.2-2.1 2.2-3.7 0-.9-.3-1.7-.8-2.3.8-1 1.3-2.3 1.3-3.7C18.5 4.5 15.5 2 12 2zm0 2c2.5 0 4.5 1.8 4.5 4 0 1-.4 2-1 2.7-1-.5-2.2-.7-3.5-.7s-2.5.2-3.5.7c-.6-.7-1-1.7-1-2.7C7.5 5.8 9.5 4 12 4zm0 8c1 0 2 .2 2.8.5.1.5.2 1 .2 1.5 0 1.7-1.3 3-3 3s-3-1.3-3-3c0-.5.1-1 .2-1.5.8-.3 1.8-.5 2.8-.5zm-1 8c0 .6-.4 1-1 1s-1-.4-1-1 .4-1 1-1 1 .4 1 1zm2 0c0 .6-.4 1-1 1s-1-.4-1-1 .4-1 1-1 1 .4 1 1z"/>
    </svg>
  ),
  'Brave Search': (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M20.09 7.39l-1.25-3.06A1.53 1.53 0 0 0 17.42 3.3l-5.4 1.41L6.6 3.3a1.53 1.53 0 0 0-1.42 1.03L3.91 7.39c-.58 1.41-.3 3.06.77 4.2l3.48 3.77c-.07.32-.12.65-.12.99 0 2.18 1.77 3.95 3.96 3.95s3.96-1.77 3.96-3.95c0-.34-.05-.67-.12-.99l3.48-3.77c1.07-1.14 1.35-2.79.77-4.2zM12 18.3c-1.1 0-1.98-.88-1.98-1.97S10.9 14.37 12 14.37s1.98.88 1.98 1.96S13.1 18.3 12 18.3zm5.46-7.27l-2.87 3.11a4.04 4.04 0 0 0-5.18 0L6.54 11.03a2.58 2.58 0 0 1-.52-2.85l1.04-2.57 4.94 1.29 4.94-1.29 1.04 2.57a2.58 2.58 0 0 1-.52 2.85z"/>
    </svg>
  ),
  Puppeteer: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="12" cy="12" r="4"/>
      <line x1="12" y1="2" x2="12" y2="8"/>
      <line x1="12" y1="16" x2="12" y2="22"/>
      <line x1="2" y1="12" x2="8" y2="12"/>
      <line x1="16" y1="12" x2="22" y2="12"/>
    </svg>
  ),
  Memory: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2"/>
      <path d="M6 6V4M10 6V4M14 6V4M18 6V4M6 18v2M10 18v2M14 18v2M18 18v2"/>
      <rect x="6" y="10" width="3" height="4" rx="0.5"/>
      <rect x="11" y="10" width="3" height="4" rx="0.5"/>
    </svg>
  ),
  Slack: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
      <path d="M5.76 14.72a2.88 2.88 0 1 1-2.88-2.88h2.88v2.88z" fill="#E01E5A"/>
      <path d="M7.2 14.72a2.88 2.88 0 0 1 5.76 0v7.2a2.88 2.88 0 1 1-5.76 0v-7.2z" fill="#E01E5A"/>
      <path d="M10.08 5.76a2.88 2.88 0 1 1 2.88-2.88v2.88h-2.88z" fill="#36C5F0"/>
      <path d="M10.08 7.2a2.88 2.88 0 0 1 0 5.76H2.88a2.88 2.88 0 1 1 0-5.76h7.2z" fill="#36C5F0"/>
      <path d="M19.04 10.08a2.88 2.88 0 1 1 2.88 2.88h-2.88v-2.88z" fill="#2EB67D"/>
      <path d="M17.6 10.08a2.88 2.88 0 0 1-5.76 0V2.88a2.88 2.88 0 1 1 5.76 0v7.2z" fill="#2EB67D"/>
      <path d="M14.72 19.04a2.88 2.88 0 1 1-2.88 2.88v-2.88h2.88z" fill="#ECB22E"/>
      <path d="M14.72 17.6a2.88 2.88 0 0 1 0-5.76h7.2a2.88 2.88 0 1 1 0 5.76h-7.2z" fill="#ECB22E"/>
    </svg>
  ),
  Notion: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466l1.823 1.447zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933l3.222-.187z"/>
    </svg>
  ),
  Linear: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
      <path d="M3.5 17.5L17.5 3.5M3.5 17.5h5M3.5 17.5v-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <path d="M10 3.5h10.5V14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  ),
}

interface MCPPreset {
  name: string
  desc: string
  category: string
  icon: string
  color: string
  fixedType?: MCPServer['type']
  partial: Partial<MCPServer>
  envKeys: string[]
}

// UI metadata (icon + color) keyed by preset name
const PRESET_UI: Record<string, { icon: string; color: string }> = {
  'Figma':       { icon: 'F',  color: '#a259ff' },
  'GitHub':      { icon: 'GH', color: '#4078c0' },
  'Filesystem':  { icon: 'FS', color: '#3b82f6' },
  'PostgreSQL':  { icon: 'PG', color: '#336791' },
  'Brave Search':{ icon: 'B',  color: '#fb542b' },
  'Puppeteer':   { icon: 'PP', color: '#00a8e8' },
  'Memory':      { icon: 'M',  color: '#f59e0b' },
  'Slack':       { icon: 'SL', color: '#611f69' },
  'Notion':      { icon: 'N',  color: '#37352f' },
  'Linear':      { icon: 'LN', color: '#5e6ad2' },
}

const FEATURED_MCPS: MCPPreset[] = MCP_PRESET_DATA.map(p => ({
  ...p,
  ...(PRESET_UI[p.name] ?? { icon: p.name.slice(0, 2).toUpperCase(), color: '#6366f1' }),
}))

const PRESET_COLORS = ['#6366f1','#3b82f6','#0ea5e9','#14b8a6','#22c55e','#f59e0b','#ef4444','#ec4899','#a855f7']

function serverIconColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PRESET_COLORS[h % PRESET_COLORS.length]
}

function serverInitials(name: string): string {
  return name.replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || name.slice(0, 2).toUpperCase()
}

// ── MCP Edit Form ─────────────────────────────────────────────────────────────

interface MCPFormProps {
  initial?: Partial<MCPServer> & { fixedType?: MCPServer['type'] }
  onSave: (s: MCPServer) => void
  onCancel: () => void
}

function MCPForm({ initial, onSave, onCancel }: MCPFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<MCPServer['type']>(initial?.fixedType ?? initial?.type ?? 'stdio')
  const [command, setCommand] = useState(initial?.command ?? '')
  const [argsText, setArgsText] = useState((initial?.args ?? []).join('\n'))
  const [envText, setEnvText] = useState(
    Object.entries(initial?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  )
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headersText, setHeadersText] = useState(
    Object.entries(initial?.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
  )
  const [timeout, setTimeout_] = useState(String(initial?.timeout ?? 15))
  const [error, setError] = useState('')
  const [testResult, setTestResult] = useState<(MCPTestResult & { testing?: boolean }) | null>(null)
  const lockedType = initial?.fixedType
  const effectiveType = lockedType ?? type

  const parseKV = (text: string, sep: string): Record<string, string> => {
    const r: Record<string, string> = {}
    for (const rawLine of text.split('\n')) {
      let t = rawLine.trim(); if (!t) continue
      // Auto-detect bare known API tokens missing KEY= prefix
      if (sep === '=' && !t.includes('=')) {
        if (/^figd_/.test(t)) t = `FIGMA_API_KEY=${t}`
        else if (/^sk-/.test(t)) t = `OPENAI_API_KEY=${t}`
        else if (/^ghp_|^github_pat_/.test(t)) t = `GITHUB_PERSONAL_ACCESS_TOKEN=${t}`
        else continue
      }
      const idx = t.indexOf(sep); if (idx === -1) continue
      r[t.slice(0, idx).trim()] = t.slice(idx + sep.length).trim()
    }
    return r
  }

  const buildServer = (): MCPServer => {
    const s: MCPServer = { id: initial?.id ?? uid(), name: name.trim(), type: effectiveType, disabled: initial?.disabled ?? false, timeout: Number(timeout) || 15 }
    if (effectiveType === 'stdio') {
      s.command = command.trim()
      s.args = argsText.split('\n').map(l => l.trim()).filter(Boolean)
      s.env = parseKV(envText, '=')
    } else {
      s.url = url.trim()
      s.headers = parseKV(headersText, ':')
    }
    return s
  }

  const isValid = () => {
    if (!name.trim()) return false
    if (effectiveType === 'stdio' && !command.trim()) return false
    if ((effectiveType === 'sse' || effectiveType === 'http' || effectiveType === 'json') && !url.trim()) return false
    return true
  }

  const handleTest = async () => {
    if (!isValid()) { setError('Fill all required fields to test'); return }
    setError('')
    setTestResult({ testing: true, ok: false, toolCount: 0 })
    const result = await testMCPServer(buildServer())
    setTestResult({ ...result, testing: false })
  }

  const submit = () => {
    if (!name.trim()) { setError('Name required'); return }
    if (effectiveType === 'stdio' && !command.trim()) { setError('Command required for stdio'); return }
    if ((effectiveType === 'sse' || effectiveType === 'http' || effectiveType === 'json') && !url.trim()) { setError('URL required'); return }
    setError('')
    onSave(buildServer())
  }

  const isEdit = !!initial?.id

  return (
    <div className="mcp-edit-box">
      <div className="mcp-form-header">
        <button className="mcp-form-back" onClick={onCancel} title="Back">←</button>
        <div>
          <div className="mcp-form-title">{isEdit ? `Edit: ${initial?.name ?? ''}` : 'Configure MCP Server'}</div>
          <div className="mcp-form-subtitle">
            {effectiveType === 'stdio' ? 'Runs a local process (npx, node, python…)' : 'Connects over the network (http / sse / json-rpc)'}
          </div>
        </div>
      </div>

      <div className="mcp-form">
        <div className="settings-field">
          <label className="settings-label">Name</label>
          <input className="settings-input" value={name} onChange={e => setName(e.target.value)} placeholder="my-mcp-server" />
        </div>
        <div className="settings-field">
          <label className="settings-label">Type</label>
          {lockedType ? (
            <div className="settings-hint-inline" style={{ display: 'block', marginTop: 6 }}>
              stdio
            </div>
          ) : (
            <div className="settings-radio-group">
              {(['stdio', 'sse', 'http', 'json'] as const).map(t => (
                <button
                  key={t}
                  className={`settings-radio${effectiveType === t ? ' active' : ''}`}
                  onClick={() => setType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
        {effectiveType === 'stdio' ? (
          <>
            <div className="settings-field">
              <label className="settings-label">Command</label>
              <input className="settings-input" value={command} onChange={e => setCommand(e.target.value)} placeholder="npx" />
            </div>
            <div className="settings-field">
              <label className="settings-label">Arguments <span className="settings-hint-inline">(one per line)</span></label>
              <textarea className="settings-textarea" value={argsText} onChange={e => setArgsText(e.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/home/user'} rows={3} />
            </div>
            <div className="settings-field">
              <label className="settings-label">Environment <span className="settings-hint-inline">(KEY=VALUE per line)</span></label>
              <textarea className="settings-textarea" value={envText} onChange={e => setEnvText(e.target.value)} placeholder="API_KEY=abc123" rows={2} />
            </div>
          </>
        ) : (
          <>
            <div className="settings-field">
              <label className="settings-label">URL</label>
              <input className="settings-input" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:3000" />
            </div>
            <div className="settings-field">
              <label className="settings-label">Headers <span className="settings-hint-inline">(Key: Value per line)</span></label>
              <textarea className="settings-textarea" value={headersText} onChange={e => setHeadersText(e.target.value)} placeholder="Authorization: Bearer token" rows={2} />
            </div>
          </>
        )}
        <div className="settings-field">
          <label className="settings-label">Timeout (seconds)</label>
          <input className="settings-input" style={{ width: 90 }} value={timeout} onChange={e => setTimeout_(e.target.value)} type="number" min={1} max={300} />
        </div>

        {testResult && !testResult.testing && (
          <div className={`mcp-test-banner ${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.ok
              ? `✓ Connected — ${testResult.toolCount} tool${testResult.toolCount !== 1 ? 's' : ''} available`
              : `✗ ${testResult.error ?? 'Connection failed'}`}
          </div>
        )}

        {error && <p style={{ fontSize: 12, color: 'var(--red)', margin: 0 }}>{error}</p>}

        <div className="mcp-form-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-ghost" onClick={handleTest} disabled={testResult?.testing} data-testid="mcp-test-btn">
            {testResult?.testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn-primary" onClick={submit}>{isEdit ? 'Update' : 'Add server'}</button>
        </div>
      </div>
    </div>
  )
}

// â"€â"€ Model Tab â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

// ── Thinking Level Dropup ─────────────────────────────────────────────────────

const THINKING_OPTIONS: { value: 'off'|'low'|'medium'|'high'; label: string }[] = [
  { value: 'off',    label: 'Off' },
  { value: 'low',    label: 'Low — fast, light reasoning' },
  { value: 'medium', label: 'Medium — balanced' },
  { value: 'high',   label: 'High — deepest reasoning' },
]

function ThinkingLevelDropup({ value, onChange }: { value: 'off'|'low'|'medium'|'high'; onChange: (v: 'off'|'low'|'medium'|'high') => void }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {THINKING_OPTIONS.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          style={{
            flex: 1,
            padding: '7px 4px',
            fontSize: 11,
            fontWeight: value === o.value ? 600 : 400,
            border: '1px solid',
            borderColor: value === o.value ? 'var(--accent, #5b8dd9)' : 'var(--border)',
            borderRadius: 6,
            background: value === o.value ? 'var(--accent-subtle, rgba(91,141,217,0.15))' : 'var(--bg-2)',
            color: value === o.value ? 'var(--accent, #5b8dd9)' : 'var(--text-2)',
            cursor: 'pointer',
            textAlign: 'center',
            whiteSpace: 'nowrap',
          }}
        >
          {o.value === 'off' ? 'Off' : o.value.charAt(0).toUpperCase() + o.value.slice(1)}
        </button>
      ))}
    </div>
  )
}

interface ModelTabProps {
  cfg: AgentConfig
  onChange: (m: AgentConfig['model']) => void
}

function ModelTab({ cfg, onChange }: ModelTabProps) {
  const [providerId, setProviderId] = useState('betopia')
  const [apiKey, setApiKeyState] = useState('')
  const [model, setModel] = useState(cfg.model.model ?? '')
  const [customBaseUrl, setCustomBaseUrl] = useState(cfg.model.customBaseUrl ?? '')
  const [temperature, setTemperature] = useState(cfg.model.temperature !== undefined ? String(cfg.model.temperature) : '')
  const [maxTokens, setMaxTokens] = useState(cfg.model.maxTokens !== undefined ? String(cfg.model.maxTokens) : '')
  const [topP, setTopP] = useState(cfg.model.topP !== undefined ? String(cfg.model.topP) : '')
  const [thinkingMode, setThinkingMode] = useState(cfg.model.thinkingMode ?? false)
  const [thinkingLevel, setThinkingLevel] = useState<'off'|'low'|'medium'|'high'>(cfg.model.thinkingLevel ?? 'off')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const { models: betopiaModels, loading: fetchingBetopiaModels } = useBetopiaModels()

  const provider = getProvider(providerId) ?? CUSTOM_LLM_PROVIDERS[0] ?? PROVIDERS[0]
  const modelOptions = providerId === 'betopia' ? betopiaModels : (provider?.models ?? [])

  useEffect(() => {
    setProviderId(cfg.model.providerId ?? 'betopia')
    setModel(cfg.model.model ?? '')
    setCustomBaseUrl(cfg.model.customBaseUrl ?? '')
    setTemperature(cfg.model.temperature !== undefined ? String(cfg.model.temperature) : '')
    setMaxTokens(cfg.model.maxTokens !== undefined ? String(cfg.model.maxTokens) : '')
    setTopP(cfg.model.topP !== undefined ? String(cfg.model.topP) : '')
    setThinkingMode(cfg.model.thinkingMode ?? false)
    setThinkingLevel(cfg.model.thinkingLevel ?? 'off')
  }, [cfg.model.providerId, cfg.model.model, cfg.model.customBaseUrl, cfg.model.temperature, cfg.model.maxTokens, cfg.model.topP, cfg.model.thinkingMode, cfg.model.thinkingLevel])

  useEffect(() => {
    let active = true
    getApiKey(providerId).then(k => {
      if (active) setApiKeyState(k)
    }).catch(() => {
      if (active) setApiKeyState('')
    })
    return () => { active = false }
  }, [providerId])

  const persist = (next: Partial<AgentConfig['model']> = {}) => {
    const nextProviderId = next.providerId ?? providerId
    const nextModel = next.model ?? model
    const nextBaseUrl = next.customBaseUrl !== undefined ? next.customBaseUrl : customBaseUrl
    const nextTemperature = next.temperature !== undefined ? next.temperature : (temperature !== '' ? Number(temperature) : undefined)
    const nextMaxTokens = next.maxTokens !== undefined ? next.maxTokens : (maxTokens !== '' ? Number(maxTokens) : undefined)
    const nextTopP = next.topP !== undefined ? next.topP : (topP !== '' ? Number(topP) : undefined)
    const nextThinkingMode = next.thinkingMode ?? thinkingMode
    const nextApiKeys = { ...cfg.model.apiKeys, ...(next.apiKeys ?? {}) }
    const keyToSave = next.apiKeys && Object.prototype.hasOwnProperty.call(next.apiKeys, nextProviderId)
      ? next.apiKeys[nextProviderId]
      : apiKey

    if (keyToSave) nextApiKeys[nextProviderId] = keyToSave
    else delete nextApiKeys[nextProviderId]

    onChange({
      ...cfg.model,
      ...next,
      providerId: nextProviderId,
      model: nextModel,
      customBaseUrl: nextBaseUrl.trim() ? nextBaseUrl.trim() : undefined,
      apiKeys: nextApiKeys,
      temperature: nextTemperature,
      maxTokens: nextMaxTokens,
      topP: nextTopP,
      thinkingMode: nextThinkingMode,
    })
  }

  const handleProviderChange = async (nextProviderId: string) => {
    const nextProvider = getProvider(nextProviderId) ?? PROVIDERS.find(p => p.id === nextProviderId) ?? provider
    const nextModels = nextProviderId === 'betopia' ? betopiaModels : (nextProvider?.models ?? [])
    const nextModel = nextModels.some(m => m.id === model) ? model : (nextModels[0]?.id ?? model)
    const nextKey = await getApiKey(nextProviderId).catch(() => '')

    setProviderId(nextProviderId)
    setModel(nextModel)
    setCustomBaseUrl('')
    setApiKeyState(nextKey)

    const nextApiKeys = { ...cfg.model.apiKeys }
    if (nextKey) nextApiKeys[nextProviderId] = nextKey
    else delete nextApiKeys[nextProviderId]

    onChange({
      ...cfg.model,
      providerId: nextProviderId,
      model: nextModel,
      customBaseUrl: undefined,
      apiKeys: nextApiKeys,
      temperature: temperature !== '' ? Number(temperature) : undefined,
      maxTokens: maxTokens !== '' ? Number(maxTokens) : undefined,
      topP: topP !== '' ? Number(topP) : undefined,
      thinkingMode,
    })
  }

  const handleSetKey = (k: string) => {
    setApiKeyState(k)
    setApiKey(providerId, k).catch(() => {})
    persist({ apiKeys: { [providerId]: k } })
  }

  const handleSetModel = (nextModel: string) => {
    const selected =
      modelOptions.find(m => sameModelId(m.id, nextModel) || sameModelId(m.name, nextModel)) ??
      null
    setModel(selected?.id ?? nextModel)
    persist({
      model: selected?.id ?? nextModel,
    })
  }

  const handleSetBaseUrl = (value: string) => {
    setCustomBaseUrl(value)
    persist({ customBaseUrl: value })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="settings-section">

        <div className="provider-grid" style={{ gridTemplateColumns: '1fr', marginBottom: 14 }}>
          {CUSTOM_LLM_PROVIDERS.map(p => (
            <button
              key={p.id}
              type="button"
              className={`provider-card${providerId === p.id ? ' active' : ''}`}
            >
              <span className="provider-card-name">{p.name}</span>
              <span className="provider-card-desc">{p.description}</span>
              <span className="provider-card-desc" style={{ fontFamily: 'var(--mono)' }}>{p.baseUrl}</span>
            </button>
          ))}
        </div>

        <div className="settings-field">
          <label className="settings-label">{provider.shortName ?? provider.name} API Key</label>
          {providerId === 'betopia' && (
            <span className="settings-hint" style={{ marginBottom: 8 }}>
              Get the API key from{' '}
              <a
                href={BETOPIA_PLATFORM_URL}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)', textDecoration: 'underline' }}
              >
                {BETOPIA_PLATFORM_URL}
              </a>
            </span>
          )}
          <input
            className="settings-input"
            type="password"
            value={apiKey}
            onChange={e => handleSetKey(e.target.value)}
            placeholder={`Your ${provider.shortName ?? provider.name} API key`}
          />
          <span className="settings-hint">Stored in OS keychain and local config. The builder uses this key for chat and generation.</span>
        </div>

        <div className="settings-field">
          <div className="settings-label" style={{ marginBottom: 6 }}>Model</div>
          {fetchingBetopiaModels && (
            <div className="settings-hint" style={{ marginBottom: 8 }}>Fetching Betopia models...</div>
          )}

          {modelOptions.length > 0 && (
            <div className="model-list">
              {modelOptions.map(m => (
                <button
                  key={m.id}
                  type="button"
                  className={`model-card${sameModelId(model, m.id) ? ' active' : ''}`}
                  onClick={() => handleSetModel(m.id)}
                >
                  <div className="model-card-header">
                    <span className="model-card-name">{m.name}</span>
                    {m.supportsThinking && <span className="model-badge think">thinking</span>}
                  </div>
                  {m.description && <span className="model-card-desc">{m.description}</span>}
                  <span className="model-card-id">{m.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="settings-section">
        <button
          className="settings-advanced-toggle"
          onClick={() => setShowAdvanced(v => !v)}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform 0.2s', transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0deg)' }}>
              <polyline points="2,4 6,8 10,4"/>
            </svg>
            Advanced Parameters
          </span>
          {(temperature || maxTokens || topP || thinkingMode) && (
            <span className="settings-badge">Configured</span>
          )}
        </button>

        {showAdvanced && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 12 }}>
            <div className="settings-row" style={{ alignItems: 'flex-start' }}>
              <div className="settings-field">
                <label className="settings-label">Temperature</label>
                <input className="settings-input" value={temperature} onChange={e => { setTemperature(e.target.value); persist({ temperature: e.target.value !== '' ? Number(e.target.value) : undefined }) }} type="number" step="0.1" min={0} max={2} placeholder="default" />
                <span className="settings-hint">0 = deterministic · 2 = creative</span>
              </div>
              <div className="settings-field">
                <label className="settings-label">Max Tokens</label>
                <input className="settings-input" value={maxTokens} onChange={e => { setMaxTokens(e.target.value); persist({ maxTokens: e.target.value !== '' ? Number(e.target.value) : undefined }) }} type="number" min={1} max={200000} placeholder="default" />
              </div>
              <div className="settings-field">
                <label className="settings-label">Top P</label>
                <input className="settings-input" value={topP} onChange={e => { setTopP(e.target.value); persist({ topP: e.target.value !== '' ? Number(e.target.value) : undefined }) }} type="number" step="0.05" min={0} max={1} placeholder="default" />
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-field" style={{ position: 'relative' }}>
                <label className="settings-label">Thinking Level</label>
                <ThinkingLevelDropup
                  value={thinkingLevel}
                  onChange={v => {
                    setThinkingLevel(v)
                    setThinkingMode(v !== 'off')
                    persist({ thinkingLevel: v, thinkingMode: v !== 'off' })
                  }}
                />
                <span className="settings-hint">Maps to reasoning_effort (OpenAI) or budget_tokens (Anthropic).</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Custom Subagent Form ──────────────────────────────────────────────────────

function SubagentForm({ initial, onSave, onCancel }: { initial?: CustomSubagentDef; onSave: (sa: CustomSubagentDef) => void; onCancel: () => void }) {
  const [id, setId] = useState(initial?.id ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '')
  const [writable, setWritable] = useState(initial?.writable ?? false)
  const [model, setModel] = useState(initial?.model ?? '')
  const isEdit = !!initial

  const handleSave = () => {
    const safeId = id.trim().replace(/\s+/g, '-').toLowerCase()
    if (!safeId || !label.trim() || !systemPrompt.trim()) return
    onSave({
      id: safeId,
      label: label.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      writable,
      model: model.trim() || undefined,
    })
  }

  return (
    <div style={{ background: 'var(--bg-2)', borderRadius: 8, padding: 12, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{isEdit ? `Edit: ${initial!.label}` : 'New Sub-agent'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div className="settings-field" style={{ margin: 0 }}>
          <label className="settings-label">ID <span style={{ fontStyle: 'italic', opacity: 0.5 }}>used in run_subagent</span></label>
          <input className="settings-input" value={id} onChange={e => setId(e.target.value)} placeholder="my-researcher" disabled={isEdit} />
        </div>
        <div className="settings-field" style={{ margin: 0 }}>
          <label className="settings-label">Display name</label>
          <input className="settings-input" value={label} onChange={e => setLabel(e.target.value)} placeholder="My Researcher" />
        </div>
      </div>
      <div className="settings-field" style={{ margin: 0 }}>
        <label className="settings-label">Description</label>
        <input className="settings-input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Short description shown to the main agent" />
      </div>
      <div className="settings-field" style={{ margin: 0 }}>
        <label className="settings-label">System prompt</label>
        <textarea className="settings-input" rows={5} value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} placeholder="You are a specialized subagent that..." style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }} />
      </div>
      <div className="settings-field" style={{ margin: 0 }}>
        <label className="settings-label">Model override <span style={{ fontStyle: 'italic', opacity: 0.5 }}>optional — leave blank to inherit global model</span></label>
        <input className="settings-input" value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. claude-haiku-4-5-20251001" style={{ fontFamily: 'monospace', fontSize: 11 }} />
      </div>
      <div className="settings-toggle-row" style={{ margin: 0, padding: 0 }}>
        <div className="settings-toggle-info">
          <span className="settings-toggle-label" style={{ fontSize: 12 }}>Write-capable</span>
          <span className="settings-toggle-desc" style={{ fontSize: 11 }}>Can write files and run bash (each write still requires user approval).</span>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={writable} onChange={e => setWritable(e.target.checked)} />
          <span className="toggle-slider" />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }} onClick={onCancel}>Cancel</button>
        <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={handleSave}>Save</button>
      </div>
    </div>
  )
}

// ── Integrations Tab ─────────────────────────────────────────────────────────

// ── Main Settings Panel ───────────────────────────────────────────────────────

export default function AgentSettings({ onClose, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>((initialTab as Tab) ?? 'model')
  const [cfg, setCfg] = useState<AgentConfig>(() => getConfig())
  const [addingTemplate, setAddingTemplate] = useState<(Partial<MCPServer> & { fixedType?: MCPServer['type'] }) | null>(null)
  const [editingMCP, setEditingMCP] = useState<MCPServer | null>(null)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstRender = useRef(true)

  const [mcpTestStates, setMcpTestStates] = useState<Record<string, MCPTestResult & { testing?: boolean }>>({})

  const testMCPItem = async (server: MCPServer) => {
    setMcpTestStates(s => ({ ...s, [server.id]: { testing: true, ok: false, toolCount: 0 } }))
    const result = await testMCPServer(server)
    setMcpTestStates(s => ({ ...s, [server.id]: { ...result, testing: false } }))
  }
  const [importJson, setImportJson] = useState('')
  const [showImportModal, setShowImportModal] = useState(false)
  const [saved, setSaved] = useState(false)

  const [systemPromptPrefix, setSystemPromptPrefix] = useState(cfg.behavior.systemPromptPrefix)
  const [yoloMode, setYoloMode] = useState(cfg.behavior.yoloMode)
  const [autoAccept, setAutoAccept] = useState(cfg.behavior.autoAccept ?? false)
  const [autoCompact, setAutoCompact] = useState(cfg.behavior.autoCompact ?? true)
  const [autoCompactThreshold, setAutoCompactThreshold] = useState(cfg.behavior.autoCompactThreshold ?? 0.75)
  const [sandboxEnabled, setSandboxEnabled] = useState(cfg.sandbox.enabled)
  const [sandboxEndpoint, setSandboxEndpoint] = useState(cfg.sandbox.endpoint)
  const [sandboxApiKey, setSandboxApiKey] = useState(cfg.sandbox.apiKey)
  const [sandboxImage, setSandboxImage] = useState(cfg.sandbox.image)
  const [sandboxCpuLimit, setSandboxCpuLimit] = useState(String(cfg.sandbox.cpuLimit))
  const [sandboxMemoryMb, setSandboxMemoryMb] = useState(String(cfg.sandbox.memoryMb))
  const [sandboxTimeoutSec, setSandboxTimeoutSec] = useState(String(cfg.sandbox.timeoutSec))
  const [sandboxAllowNetwork, setSandboxAllowNetwork] = useState(cfg.sandbox.allowNetwork)


  const exportMCPServers = () => {
    const mcpConfig = {
      mcpServers: cfg.mcpServers.reduce(
        (acc, s) => {
          acc[s.name] = {
            type: s.type,
            ...(s.command && { command: s.command }),
            ...(s.args && { args: s.args }),
            ...(s.env && { env: s.env }),
            ...(s.url && { url: s.url }),
            ...(s.headers && { headers: s.headers }),
          }
          return acc
        },
        {} as Record<string, any>,
      ),
    }
    const json = JSON.stringify(mcpConfig, null, 2)
    navigator.clipboard.writeText(json)
    alert('MCP configuration copied to clipboard!')
  }

  const importMCPServers = () => {
    try {
      const json = JSON.parse(importJson) as { mcpServers?: Record<string, any> }
      const servers = json.mcpServers ?? json
      let imported = 0

      for (const [name, config] of Object.entries(servers)) {
        const server: MCPServer = {
          id: Math.random().toString(36).slice(2, 10),
          name,
          type: (config as any).type ?? 'http',
          command: (config as any).command,
          args: (config as any).args,
          env: (config as any).env,
          url: (config as any).url,
          headers: (config as any).headers,
          timeout: (config as any).timeout ?? 15,
        }
        setCfg(prev => ({ ...prev, mcpServers: [...prev.mcpServers, server] }))
        imported++
      }

      setImportJson('')
      setShowImportModal(false)
      alert(`Imported ${imported} MCP server(s)!`)
    } catch (err) {
      alert(`Error importing: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleModelChange = (m: AgentConfig['model']) => {
    const next = { ...cfg, model: m }
    setCfg(next)
    saveConfig(next)
  }

  const handleSave = () => {
    const cpuLimit = Number(sandboxCpuLimit)
    const memoryMb = Number(sandboxMemoryMb)
    const timeoutSec = Number(sandboxTimeoutSec)

    const updated: AgentConfig = {
      ...cfg,
      behavior: {
        // Read caveman values live from config — AgentsTab saves them directly, so stale local state must not overwrite.
        cavemanEnabled: getConfig().behavior.cavemanEnabled,
        cavemanIntensity: getConfig().behavior.cavemanIntensity,
        systemPromptPrefix, yoloMode, autoAccept, autoCompact, autoCompactThreshold,
      },
      sandbox: {
        enabled: sandboxEnabled,
        endpoint: sandboxEndpoint.trim() || 'http://127.0.0.1:7879',
        apiKey: sandboxApiKey.trim(),
        image: sandboxImage.trim() || 'node:20-alpine',
        cpuLimit: Number.isFinite(cpuLimit) && cpuLimit > 0 ? cpuLimit : 1,
        memoryMb: Number.isFinite(memoryMb) && memoryMb >= 256 ? Math.round(memoryMb) : 1024,
        timeoutSec: Number.isFinite(timeoutSec) && timeoutSec >= 5 ? Math.round(timeoutSec) : 120,
        allowNetwork: sandboxAllowNetwork,
      },
    }
    saveConfig(updated)
    setCfg(updated)
  }

  const addMCP = (s: MCPServer) => {
    setCfg(p => { const n = { ...p, mcpServers: [...p.mcpServers, s] }; saveConfig(n); return n })
    setAddingTemplate(null)
  }
  const updateMCP = (s: MCPServer) => {
    setCfg(p => { const n = { ...p, mcpServers: p.mcpServers.map(m => m.id === s.id ? s : m) }; saveConfig(n); return n })
    setEditingMCP(null)
  }
  const deleteMCP = (id: string) => {
    setCfg(p => { const n = { ...p, mcpServers: p.mcpServers.filter(m => m.id !== id) }; saveConfig(n); return n })
    setMcpTestStates(s => { const c = { ...s }; delete c[id]; return c })
  }
  const toggleMCPDisabled = (id: string) => {
    setCfg(p => { const n = { ...p, mcpServers: p.mcpServers.map(m => m.id === id ? { ...m, disabled: !m.disabled } : m) }; saveConfig(n); return n })
  }

  useEffect(() => {
    const handler = () => setCfg(getConfig())
    window.addEventListener('betopia:config-changed', handler)
    return () => window.removeEventListener('betopia:config-changed', handler)
  }, [])

  // Auto-test all enabled servers when MCP tab is opened
  useEffect(() => {
    if (tab !== 'mcp') return
    const untested = cfg.mcpServers.filter(s => !s.disabled && !mcpTestStates[s.id])
    if (untested.length === 0) return
    untested.forEach(s => testMCPItem(s))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="stt-dialog">

        <div className="stt-header">
          <div className="stt-tabs-list">
            {([['model', 'Model'], ['agents', 'Agents'], ['general', 'General'], ['shortcuts', 'Shortcuts'], ['mcp', 'MCP'], ['theme', 'Appearance'], ['about', 'About']] as [Tab, string][]).map(([t, label]) => (
              <button key={t} className={'stt-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>{label}</button>
            ))}
          </div>
          <button className="stt-close" onClick={onClose}>✕</button>
        </div>

        <div className="stt-body">
          <div className="stt-content-inner">

          {tab === 'model'        && <ModelTab cfg={cfg} onChange={handleModelChange} />}
          {tab === 'agents' && (
            <>
              <AgentsTab />

              <div className="settings-section">
                <div className="settings-section-title">Permissions</div>
                <div className="settings-toggle-row">
                  <div className="settings-toggle-info">
                    <span className="settings-toggle-label">Auto Compact</span>
                    <span className="settings-toggle-desc">Automatically summarize and compress the conversation when context usage exceeds the threshold. Prevents inference failures on long sessions.</span>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={autoCompact} onChange={e => setAutoCompact(e.target.checked)} />
                    <span className="toggle-slider" />
                  </label>
                </div>
                {autoCompact && (
                  <div className="settings-field" style={{ paddingTop: 0 }}>
                    <label className="settings-label">
                      Compact threshold — {Math.round(autoCompactThreshold * 100)}% of context window
                    </label>
                    <input
                      type="range" min="0.5" max="0.95" step="0.05"
                      value={autoCompactThreshold}
                      onChange={e => setAutoCompactThreshold(Number(e.target.value))}
                      style={{ width: '100%', accentColor: 'var(--accent)' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                      <span>50%</span><span>75% (default)</span><span>95%</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          {tab === 'general'      && <GeneralSection onDirty={() => setSaved(false)} />}
          {tab === 'shortcuts'    && <ShortcutsSection onDirty={() => setSaved(false)} />}
          {tab === 'about'        && <AboutSection />}

          {tab === 'mcp' && (
            <>
              {/* ── Form mode: adding or editing ── */}
              {(addingTemplate !== null || editingMCP !== null) ? (
                editingMCP ? (
                  <MCPForm initial={editingMCP} onSave={updateMCP} onCancel={() => setEditingMCP(null)} />
                ) : (
                  <MCPForm initial={addingTemplate ?? {}} onSave={addMCP} onCancel={() => setAddingTemplate(null)} />
                )
              ) : (
                /* ── Browse mode: gallery + list ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

                  {/* Popular presets */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <span className="mcp-section-label">Popular integrations</span>
                    </div>
                    <div className="mcp-gallery">
                      {FEATURED_MCPS.map(preset => (
                        <button
                          key={preset.name}
                          className="mcp-preset-card"
                          onClick={() => setAddingTemplate({ ...preset.partial, fixedType: preset.fixedType ?? preset.partial.type })}
                          type="button"
                        >
                          <div className="mcp-preset-row">
                            <div className="mcp-preset-icon" style={{ background: preset.color + '1a', color: preset.color }}>
                              {MCP_LOGOS[preset.name] ?? preset.icon}
                            </div>
                            <div className="mcp-preset-body">
                              <div className="mcp-preset-name-row">
                                <span className="mcp-preset-name">{preset.name}</span>
                                <span className="mcp-preset-category">{preset.category}</span>
                              </div>
                              <div className="mcp-preset-desc">{preset.desc}</div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Configured servers */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <span className="mcp-section-label">Your servers {cfg.mcpServers.length > 0 && `(${cfg.mcpServers.length})`}</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }} onClick={() => setShowImportModal(true)}>Import</button>
                        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }} onClick={exportMCPServers}>Export</button>
                        <button className="btn-primary" style={{ fontSize: 11, padding: '3px 9px' }} onClick={() => setAddingTemplate({})}>+ Custom</button>
                      </div>
                    </div>

                    {cfg.mcpServers.length === 0 ? (
                      <div className="mcp-empty">
                        <span style={{ fontSize: 26 }}>🔌</span>
                        <span style={{ fontWeight: 500, color: 'var(--text-2)' }}>No servers yet</span>
                        <span>Pick a preset above or add a custom server.</span>
                      </div>
                    ) : (
                      <div className="mcp-list">
                        {cfg.mcpServers.map(s => {
                          const ts = mcpTestStates[s.id]
                          const color = serverIconColor(s.name)
                          const initials = serverInitials(s.name)
                          return (
                            <div key={s.id} className={`mcp-item${s.disabled ? ' mcp-item-disabled' : ''}`}>
                              <div className="mcp-item-icon" style={{ background: color + '22', color }}>
                                {initials}
                              </div>
                              <div className="mcp-item-body">
                                <div className="mcp-item-row1">
                                  <span className="mcp-item-name">{s.name}</span>
                                  <span className="mcp-item-type">{s.type}</span>
                                  {s.disabled
                                    ? <span className="mcp-item-status disabled">Disabled</span>
                                    : ts?.testing
                                      ? <span className="mcp-item-status testing">Testing…</span>
                                      : ts
                                        ? <span className={`mcp-item-status ${ts.ok ? 'ok' : 'err'}`}>
                                            {ts.ok ? `✓ ${ts.toolCount} tools` : '✗ Failed'}
                                          </span>
                                        : <span className="mcp-item-status configured">Configured</span>
                                  }
                                </div>
                                <span className="mcp-item-cmd">{s.type === 'stdio' ? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ') : s.url}</span>
                              </div>
                              <div className="mcp-item-actions">
                                <button className="icon-btn" onClick={() => testMCPItem(s)} title="Test connection" disabled={ts?.testing} data-testid={`mcp-test-${s.id}`}>
                                  {ts?.testing ? '…' : '⚡'}
                                </button>
                                <button className="icon-btn" onClick={() => toggleMCPDisabled(s.id)} title={s.disabled ? 'Enable' : 'Disable'}>{s.disabled ? '▶' : '⏸'}</button>
                                <button className="icon-btn" onClick={() => setEditingMCP(s)} title="Edit">✎</button>
                                <button className="icon-btn danger" onClick={() => deleteMCP(s.id)} title="Delete">✕</button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}


          {tab === 'theme' && (
            <div className="settings-section">
              <div className="settings-section-title">Color Theme</div>
              <div className="settings-section-body">
                <ThemeSelector onDirty={() => {}} />
              </div>
            </div>
          )}
          </div>{/* stt-content-inner */}
        </div>{/* stt-body */}


      </div>{/* stt-dialog */}

      {showImportModal && (
        <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) setShowImportModal(false) }}>
          <div className="settings-panel" style={{ maxWidth: 600 }}>
            <div className="settings-header">
              <div>
                <div className="settings-title">Import MCP Servers</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>Paste your MCP configuration JSON</div>
              </div>
              <button className="settings-close" onClick={() => setShowImportModal(false)}>✕</button>
            </div>

            <div className="settings-body" style={{ padding: 16 }}>
              <textarea
                className="settings-textarea"
                value={importJson}
                onChange={e => setImportJson(e.target.value)}
                placeholder={`{
  "mcpServers": {
    "figma": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "figma-developer-mcp", "--stdio"],
      "env": {"FIGMA_API_KEY": "your-token"}
    }
  }
}`}
                rows={12}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
                <button className="btn-ghost" onClick={() => setShowImportModal(false)}>Cancel</button>
                <button
                  className="btn-primary"
                  onClick={importMCPServers}
                  disabled={!importJson.trim()}
                >
                  Import
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
