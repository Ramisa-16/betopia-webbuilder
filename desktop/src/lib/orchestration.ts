/**
 * orchestration.ts — Manager-driven multi-agent pipeline.
 *
 * Flow:
 *  1. Planning LLM call → Orchestrator streams a role-separated task list
 *  2. Parse tasks → group consecutive Coder tasks into parallel phases
 *  3. Execute phases: parallel Coder groups run simultaneously via Promise.all;
 *     all other agents run sequentially in order
 */

import { runAgent, type AgentCallbacks } from './agent'
import { BUILTIN_AGENTS } from './agents'
import type { Message, MessagePart } from '../types'

/* ── Config ──────────────────────────────────────────────────────────────── */

const PHASE_EMOJI: Record<string, string> = {
  'builtin:architect': '🏗️',
  'builtin:designer':  '🎨',
  'builtin:coder':     '💻',
  'builtin:reviewer':  '🔍',
  'builtin:security':  '🛡️',
}

// Maps names the LLM may write → agent IDs
const AGENT_NAME_MAP: Record<string, string> = {
  'architect':              'builtin:architect',
  'designer':               'builtin:designer',
  'coder':                  'builtin:coder',
  'developer':              'builtin:coder',
  'frontend coder':         'builtin:coder',
  'backend coder':          'builtin:coder',
  'frontend developer':     'builtin:coder',
  'backend developer':      'builtin:coder',
  'full-stack coder':       'builtin:coder',
  'fullstack coder':        'builtin:coder',
  'code reviewer':          'builtin:reviewer',
  'reviewer':               'builtin:reviewer',
  'code review':            'builtin:reviewer',
  'security':               'builtin:security',
  'security audit':         'builtin:security',
}

const ORCHESTRATOR_DEF = BUILTIN_AGENTS.find(a => a.id === 'builtin:orchestration')!

// Max chars from each previous agent's output forwarded as context
const MAX_CONTEXT_CHARS = 5000

/* ── Planning prompt ─────────────────────────────────────────────────────── */

function buildPlanningPrompt(userPrompt: string): string {
  return `You are an AI orchestration manager. Analyze the user request and create a specific task plan.

User request:
"""
${userPrompt}
"""

STRICT AGENT ROLES — enforced at runtime:
- Architect: reads project files, writes plan.md, outputs specs/data models/API contracts. NEVER creates code files.
- Designer: outputs CSS variables, design tokens, and visual specs. Only touches .css or .scss files.
- Coder: implements code files (JS, TS, Python, etc.) based on the Architect's plan.
- Code Reviewer: reviews ALL code AND immediately fixes every issue found using file editing.
- Security: audits for vulnerabilities and fixes them.

PARALLEL EXECUTION — Coder tasks run in parallel:
- If the project needs independent code areas (e.g., React frontend AND Python backend), create TWO separate Coder tasks listed consecutively.
- Each Coder task describes a fully independent area with no file overlap.
- Architect, Designer, Reviewer, and Security always run sequentially.

OUTPUT FORMAT: numbered list only — no intro text, no explanation after the list.
Format: N. [AgentName] — specific task description
AgentName must be exactly one of: Architect, Designer, Coder, Code Reviewer, Security
Use 3–6 tasks maximum.

Example for "build a React + FastAPI todo app":
1. [Architect] — Design project structure, data models, REST API endpoints, and complete file layout
2. [Coder] — Build the React frontend: components, state management, API client, and CSS styles
3. [Coder] — Scaffold the FastAPI backend: routes, Pydantic models, database config, and CORS setup
4. [Code Reviewer] — Review all code for correctness and fix every issue found

Example for "build a simple landing page":
1. [Architect] — Design the page structure, sections, and component breakdown
2. [Designer] — Define the color palette, typography, spacing scale, and design tokens
3. [Coder] — Implement the full landing page with all sections, responsive layout, and animations
4. [Code Reviewer] — Review code quality, accessibility, and fix any issues

Now output the task list for the user request above:`
}

/* ── Task plan parser ────────────────────────────────────────────────────── */

interface ParsedTask {
  num: number
  agentId: string
  agentName: string
  description: string
}

function parsePlan(planText: string): ParsedTask[] {
  const tasks: ParsedTask[] = []
  const lines = planText.split('\n')

  for (const line of lines) {
    // Match: "1. [Architect] — do something" or "1. Architect — do something"
    const m = line.match(/^(\d+)\.\s*\[?([^\]—–\-\n]+?)\]?\s*[—–-]\s*(.+)$/)
    if (!m) continue
    const rawName = m[2].trim().toLowerCase()
    const description = m[3].trim()
    // Exact match first, then prefix match
    const agentId = AGENT_NAME_MAP[rawName]
      ?? Object.entries(AGENT_NAME_MAP).find(([k]) => rawName.startsWith(k) || k.startsWith(rawName))?.[1]
    if (!agentId) continue
    const agentDef = BUILTIN_AGENTS.find(a => a.id === agentId)
    if (!agentDef) continue
    tasks.push({ num: parseInt(m[1]), agentId, agentName: agentDef.name, description })
  }

  return tasks
}

/**
 * Group consecutive Coder tasks into parallel phases.
 * All other agent types are always solo sequential phases.
 */
function groupIntoPhases(tasks: ParsedTask[]): ParsedTask[][] {
  const phases: ParsedTask[][] = []
  let i = 0
  while (i < tasks.length) {
    const task = tasks[i]
    if (task.agentId === 'builtin:coder') {
      // Collect all consecutive Coder tasks into one parallel group
      const group: ParsedTask[] = [task]
      while (i + 1 < tasks.length && tasks[i + 1].agentId === 'builtin:coder') {
        i++
        group.push(tasks[i])
      }
      phases.push(group)
    } else {
      phases.push([task])
    }
    i++
  }
  return phases
}

/* ── Context builder ─────────────────────────────────────────────────────── */

function buildContextHeader(outputs: { name: string; text: string }[], taskDesc: string): string {
  if (outputs.length === 0) return taskDesc
  const sections = outputs
    .map(o =>
      `### ${o.name} Output\n${o.text.trim().slice(0, MAX_CONTEXT_CHARS)}${o.text.length > MAX_CONTEXT_CHARS ? '\n…(truncated)' : ''}`
    )
    .join('\n\n')
  return (
    `## Context from previous agents\n\n${sections}\n\n` +
    `## Your task\n${taskDesc}\n\n` +
    `IMPORTANT: Before creating any file, check if it already exists. ` +
    `Implement ONLY what is described in your task — do not redo work already done by other agents.`
  )
}

function textPart(text: string): MessagePart {
  return { type: 'text' as const, data: { text } }
}

function prettifyPlanText(text: string): string {
  return text.replace(/\[([A-Za-z][A-Za-z ]*?)\]/g, '`$1`')
}

/* ── URL extraction ──────────────────────────────────────────────────────── */

/**
 * Parse all agent outputs for mentioned localhost URLs, classify each as
 * frontend or backend based on port number and surrounding context text.
 */
function extractAgentUrls(outputs: { name: string; text: string }[]): { frontend?: string; backend?: string } {
  const fullText = outputs.map(o => o.text).join('\n')

  // Ports known to belong to each tier
  const FRONTEND_PORTS = new Set([5173, 5174, 5175, 5176, 3000, 3001, 4000, 4173, 8080])
  const BACKEND_PORTS  = new Set([8000, 8001, 8002, 5000, 5001, 1337, 4567, 9000, 8888])

  let frontend: string | undefined
  let backend:  string | undefined

  const urlRegex = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{3,5})/gi
  for (const m of fullText.matchAll(urlRegex)) {
    const port = parseInt(m[1])
    if (port < 1000 || port > 65535) continue
    const raw = m[0]
    const url = (raw.startsWith('http') ? raw : `http://${raw}`).replace('127.0.0.1', 'localhost')
    const idx = m.index ?? 0
    const ctx = fullText.slice(Math.max(0, idx - 150), idx + 120).toLowerCase()
    const isFront = FRONTEND_PORTS.has(port) || /frontend|react|vite|npm run dev/.test(ctx)
    const isBack  = BACKEND_PORTS.has(port)  || /backend|django|fastapi|flask|python|runserver/.test(ctx)
    if (isFront && !frontend) frontend = url
    if (isBack  && !backend && url !== frontend) backend = url
  }

  return { frontend, backend }
}

/* ── Main runner ─────────────────────────────────────────────────────────── */

export async function runOrchestration(
  projectPath: string,
  history: Message[],
  userPrompt: string,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<{ frontend?: string; backend?: string }> {

  // ── Step 1: Planning phase — stream a role-separated task list ────────────
  callbacks.onPartsUpdate([textPart('## 📋 Creating task plan…\n\n')])

  let planText = ''
  let planStreamParts: MessagePart[] = []

  await runAgent(
    projectPath,
    history,
    buildPlanningPrompt(userPrompt),
    {
      ...callbacks,
      agentPersona: { name: ORCHESTRATOR_DEF.name, instructions: ORCHESTRATOR_DEF.instructions },
      onPartsUpdate: (parts) => {
        planStreamParts = parts.filter(p => p.type !== 'finish')
        planText = planStreamParts
          .filter(p => p.type === 'text')
          .map(p => (p.data as { text: string }).text)
          .join('')
        const displayParts = planStreamParts.map(p =>
          p.type === 'text'
            ? { ...p, data: { ...(p.data as { text: string }), text: prettifyPlanText((p.data as { text: string }).text) } }
            : p
        )
        callbacks.onPartsUpdate([textPart('## 📋 Task Plan\n\n'), ...displayParts])
      },
    },
    signal,
  )

  if (signal?.aborted) return

  // ── Step 2: Parse tasks and group into execution phases ───────────────────
  const tasks = parsePlan(planText)
  if (tasks.length === 0) return

  const phases = groupIntoPhases(tasks)

  // ── Step 3: Execute each phase ────────────────────────────────────────────
  let completedParts: MessagePart[] = [
    textPart('## 📋 Task Plan\n\n'),
    ...planStreamParts,
  ]

  const phaseOutputs: { name: string; text: string }[] = []

  for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
    if (signal?.aborted) break

    const group = phases[phaseIdx]
    const isLastPhase = phaseIdx === phases.length - 1

    if (group.length === 1) {
      // ── Sequential single task ────────────────────────────────────────────
      const task    = group[0]
      const agentDef = BUILTIN_AGENTS.find(a => a.id === task.agentId)!
      const emoji   = PHASE_EMOJI[task.agentId] ?? '▶️'

      const phaseHeader = textPart(
        `\n\n---\n\n### ${emoji} Task ${task.num} — ${task.agentName}\n*${task.description}*\n\n`
      )
      const phasePrefix: MessagePart[] = [...completedParts, phaseHeader]
      callbacks.onPartsUpdate([...phasePrefix])

      const prompt = buildContextHeader(phaseOutputs, task.description)
      let phaseText = ''

      await runAgent(
        projectPath,
        history,
        prompt,
        {
          ...callbacks,
          agentPersona: { name: agentDef.name, instructions: agentDef.instructions },
          onPartsUpdate: (currentParts) => {
            phaseText = currentParts
              .filter(p => p.type === 'text')
              .map(p => (p.data as { text: string }).text)
              .join('')

            const stripped = isLastPhase ? currentParts : currentParts.filter(p => p.type !== 'finish')
            callbacks.onPartsUpdate([...phasePrefix, ...stripped])

            if (currentParts.some(p => p.type === 'finish')) {
              completedParts = [
                ...phasePrefix,
                ...currentParts.filter(p => p.type !== 'finish'),
              ]
            }
          },
        },
        signal,
      )

      phaseOutputs.push({ name: task.agentName, text: phaseText })

    } else {
      // ── Parallel Coder group ──────────────────────────────────────────────
      // Each task streams independently; we merge their outputs into one display.
      const taskBuffers: MessagePart[][] = group.map(() => [])
      const taskTexts: string[] = group.map(() => '')

      const groupHeader = textPart(
        `\n\n---\n\n### ⚡ Parallel Build — ${group.map(t => t.agentName).join(' + ')}\n`
      )
      const parallelBase: MessagePart[] = [...completedParts, groupHeader]

      // Build merged display from all task buffers
      const buildDisplay = (): MessagePart[] => {
        const parts = [...parallelBase]
        for (let j = 0; j < group.length; j++) {
          const t = group[j]
          const emoji = PHASE_EMOJI[t.agentId] ?? '▶️'
          parts.push(
            textPart(`\n\n#### ${emoji} Task ${t.num} — ${t.agentName}\n*${t.description}*\n\n`)
          )
          parts.push(...taskBuffers[j])
        }
        return parts
      }

      callbacks.onPartsUpdate(buildDisplay())

      // Run all Coder tasks in parallel
      await Promise.all(group.map(async (task, idx) => {
        const agentDef = BUILTIN_AGENTS.find(a => a.id === task.agentId)!
        const prompt   = buildContextHeader(phaseOutputs, task.description)

        await runAgent(
          projectPath,
          history,
          prompt,
          {
            ...callbacks,
            agentPersona: { name: agentDef.name, instructions: agentDef.instructions },
            onPartsUpdate: (currentParts) => {
              taskTexts[idx] = currentParts
                .filter(p => p.type === 'text')
                .map(p => (p.data as { text: string }).text)
                .join('')
              // Strip finish from individual task display — we emit one combined finish at the end
              taskBuffers[idx] = currentParts.filter(p => p.type !== 'finish')
              callbacks.onPartsUpdate(buildDisplay())
            },
          },
          signal,
        )
      }))

      // After all parallel tasks complete, update completedParts and emit finish if last phase
      const finalDisplay = buildDisplay()
      completedParts = finalDisplay

      if (isLastPhase) {
        callbacks.onPartsUpdate([
          ...finalDisplay,
          { type: 'finish' as const, data: { reason: 'stop', time: Date.now() } },
        ])
      } else {
        callbacks.onPartsUpdate(finalDisplay)
      }

      // Accumulate outputs for next phase's context
      phaseOutputs.push(...group.map((t, idx) => ({ name: t.agentName, text: taskTexts[idx] })))
    }
  }

  return extractAgentUrls(phaseOutputs)
}
