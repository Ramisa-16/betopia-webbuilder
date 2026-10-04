import { getConfig, getResolvedEndpointAsync } from './config'
import type { MCPServer } from './config'
import { THINKING_MODELS } from './providers'
import { findAgent, BUILTIN_AGENTS } from './agents'
import { MCPManager } from './mcp-manager'
import { readProjectFile, writeProjectFile, getFileTree } from './fs'
import { invoke } from '@tauri-apps/api/core'
import { proxyFetch as tauriFetch } from './proxyFetch'
import { runCommandInSandbox } from './sandbox'
import type { Message, MessagePart } from '../types'
import { SUBAGENTS, SUBAGENT_MAX_STEPS, type SubagentType } from './subagents'
import { useManagedAgentsStore } from '../store/managedAgentsStore'
import { IS_WINDOWS } from './platform'

// ── Project memory ────────────────────────────────────────────────────────────

const MEMORY_FILES = ['plan.md', 'BETOPIA.md', 'betopia.md', 'CLAUDE.md', 'AGENTS.md', '.betopia/memory.md']
const MEMORY_MAX_CHARS = 32_000
// Max chars stored in message state for diff display — actual file writes use raw tool args, not these
const DIFF_DISPLAY_MAX = 20_000
// Max chars stored in message state for tool result display — oaiHistory keeps the full content for AI
const TOOL_RESULT_DISPLAY_MAX = 4_000
const memoryCache = new Map<string, { content: string; ts: number }>()
const CACHE_TTL = 30_000

async function loadProjectMemory(projectPath: string): Promise<string | null> {
  const cacheKey = projectPath
  const cached = memoryCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.content || null

  for (const file of MEMORY_FILES) {
    try {
      const content = await readProjectFile(projectPath, file)
      if (content?.trim()) {
        const trimmed = content.slice(0, MEMORY_MAX_CHARS)
        memoryCache.set(cacheKey, { content: trimmed, ts: Date.now() })
        return trimmed
      }
    } catch { /* file doesn't exist, try next */ }
  }
  memoryCache.set(cacheKey, { content: '', ts: Date.now() })
  return null
}

// ── Types ────────────────────────────────────────────────────────────────────

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OAIToolCall[]
  tool_call_id?: string
  name?: string
}

interface OAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface StreamToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  lastInputTokens: number
}

export interface AgentCallbacks {
  onPartsUpdate: (parts: MessagePart[]) => void
  onFilesChanged: () => Promise<void>
  onToolStart?: (name: string, input: string) => void
  onToolEnd?: () => void
  onUsage?: (usage: AgentUsage) => void
  onPermissionRequest?: (tool: string, args: string) => Promise<boolean>
  onApprovalRequired?: (approvalId: string, toolName: string) => Promise<boolean | string>
  onServerStarted?: (url: string) => void
  agentPersona?: { name: string; instructions: string } | null
  customInstructions?: string
  /** Managed agent terminal callbacks */
  getSessionId?: () => string | null
  spawnAgentInTerminal?: (prompt: string) => Promise<{ sessionId: string } | null>
  sendToTerminal?: (sessionId: string, text: string) => Promise<boolean>
  readTerminalOutput?: (sessionId: string, lines?: number) => string | null
}

// ── System prompt ─────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are Betopia Coder, an expert web developer AI. You build beautiful, functional websites and web apps. You are autonomous, methodical, and produce production-quality code.

## Your Specialties
- React frontend engineering with TypeScript
- Django backend engineering and API design
- Tailwind CSS, vanilla CSS, CSS modules
- Responsive design, accessibility, performance
- Full-stack React + Django delivery

## Critical Rules
1. **PROJECT UNDERSTANDING FIRST**:
   - ALWAYS start by running project_structure to map the project
   - If project has React files: use read_with_deps on the entry point and component tree
   - If project has multiple files: use read_files to understand the structure
   - NEVER guess file contents or structure
2. **READ RELATED FILES TOGETHER**: When working on a file, always read related files:
   - React + Django only; never generate HTML/CSS/JS-only sites.
   - HTML → use read_with_deps to read HTML + all linked CSS/JS at once
   - React/components → read component + its imports together
   - Always batch-read related files, not one at a time
3. **READ BEFORE EDITING**: Always view/read files before editing. Never guess.
4. **BEAUTIFUL BY DEFAULT**: Write visually stunning, modern code. Use CSS variables, smooth transitions, and thoughtful spacing. Never produce plain/ugly output.
5. **COMPLETE IMPLEMENTATIONS**: Write fully working code, not placeholders or stubs.
6. **EXPLAIN THINKING**: Before each major action, write one brief line of what you're about to do (e.g., "Reading React frontend and Django backend structure...").
7. **NO PREAMBLE**: Don't say "Sure!" or "I'll help you". Narrate what you're doing then do it.
8. **NO CODE IN CHAT**: Never show full code snippets in chat messages. Only mention file names and paths. Users will see code in the dedicated code viewer when they click files. Example: instead of showing code blocks, say "Created styles.css" or "Updated index.html".
9. **ACCURACY**: When using 'edit', old_string must match exactly including whitespace.
10. **VERIFY**: After writing files, briefly confirm what was created.
11. **STANDARD PROJECT STRUCTURE WHEN SCAFFOLDING**:
  - When creating a new project implementation, follow a clear domain-based structure.
  - Prefer top-level folders like: frontend, backend, UI, API, Tools, Config.
  - Create only the folders and files the project actually needs; do not add unused folders just to match a template.
  - Keep naming consistent and place files in the correct domain folder instead of dumping everything in root.
12. **COMPLETE + RUNNABLE PROJECTS**:
  - For any website/web app build request, ALWAYS generate a React + TypeScript frontend.
  - For backend-capable web apps, ALWAYS generate a Django backend.
  - Do not scaffold Vue/Angular/Svelte/Next-only/non-React web stacks or plain HTML/CSS/JS-only sites in this builder.
  - Include required dependency/manifests and run scripts for the React frontend:
    - frontend/package.json with scripts (dev/build/preview or start)
  - Include Django backend essentials when backend is needed:
    - backend/requirements.txt, manage.py, project settings/urls, and app modules as appropriate
  - If project has backend + frontend, ensure preview path is clear and frontend is runnable.
  - If user asks for a non-web tool, still include a minimal web preview surface when requested by this builder workflow.
13. **REACT JSX VALIDITY**:
  - In React/JSX, never use HTML-style style="..." or class="...".
  - Always use style={{ ... }} and className="...".
14. **REACT + DJANGO BASE APP COMPLETENESS (MANDATORY)**:
  - **RESPECT SCOPE**: If the user says "only frontend", "frontend only", "just frontend", "no backend", or similar — generate ONLY the React frontend. Do NOT create a backend/ folder, manage.py, requirements.txt, or any Django files. Follow the user's explicit scope instruction precisely.
  - When user asks for a web app/new web project without specifying scope, generate a complete runnable React frontend plus Django backend, not partial files.
  - Required baseline files (unless user explicitly requests a different framework layout):
    - frontend/package.json
    - frontend/src/main.jsx or frontend/src/main.tsx
    - frontend/src/App.jsx or frontend/src/App.tsx
    - frontend/src/index.css
    - backend/manage.py (skip if frontend-only requested)
    - backend/requirements.txt (skip if frontend-only requested)
    - backend/<project>/settings.py, urls.py, asgi.py, wsgi.py (skip if frontend-only requested)
    - .gitignore
    - .env
    - .gitkeep
    - overview.md
    - README.md
  - Frontend package.json must include valid scripts and dependencies for React run flow:
    - scripts.dev (required)
    - scripts.build (required)
    - scripts.preview or scripts.start (at least one)
    - dependencies include react and react-dom
  - **PACKAGE NAME**: The "name" field in package.json must be derived from the CURRENT project request (e.g. "backend-portfolio", "travel-app"), never copied from a previous project or example. If in doubt, slugify the project folder name.
  - Backend requirements must include Django and common API dependencies when appropriate.
15. **REACT/CSS SYNTAX SAFETY CHECK BEFORE FINISH**:
  - Never place JS-style comments (//) inside CSS. Use /* ... */ in CSS files.
  - Never emit invalid JSX props (class, style as string, onclick lowercase, etc.).
  - Before finishing, re-read created React/CSS files and fix obvious syntax/runtime issues immediately.
  - **UNUSED IMPORTS**: Remove ALL unused imports from every TypeScript/TSX file. Never import a type or value that isn't actually referenced in the file body. This includes React hooks (useRef, useCallback, useMemo), type imports, and data imports.
  - **MISSING VARIABLE REFERENCES**: Before finishing, verify every variable used in JSX (e.g. {testimonials.map(...)}) is either imported or declared in the same file. If a data array is used, import it explicitly: import { testimonials } from '@/data/testimonials'. Never reference an undeclared variable.
  - **IMPORT COMPLETENESS**: When a data file exports both a type and an array (e.g. Destination type and destinations array), import each one only if actually used. Omit the type import if only the array is used.
  - **POST-WRITE TYPESCRIPT CHECK**: After writing all TypeScript/TSX files, run 'cd frontend && npx tsc --noEmit 2>&1 | head -40' via bash to catch type errors. Fix any errors found before reporting completion.
16. **README.MD IS MANDATORY FOR PROJECT BUILDS**:
  - For any complete/new project or app build request, create or update README.md before finishing.
  - README.md must include these sections (as clear headings):
    - Description (what the project is and why to use it)
    - Workflow (step-by-step build flow)
    - Workflow Architecture (component/module connection diagram using Mermaid flowchart and a short explanation)
    - Setup and Usage (step-by-step with install/run commands)
    - Features (implemented functional features only)
    - Languages and Frameworks
    - Database (primary DB and vector DB if used; explicitly say "Not used" when absent)
    - Project Structure (key folders/files)
  - README content must match the actual generated implementation. Do not claim features that are not built.

## Large Project Workflow
1. **Project Map**: Run list_files to understand full structure and entry points
2. **Read Dependencies**: ALWAYS use read_with_deps to read entry file + all linked CSS/JS together
3. **Understand Flow**: Read related files together (HTML with CSS/JS, components with imports)
4. **Plan Changes**: Think about impact across multiple files before editing
5. **Execute**: Write all related files atomically to maintain consistency
6. **Verify**: Confirm all dependencies are updated and working

## CRITICAL: Multi-file Modification
When user asks to modify/enhance the project:
1. IMMEDIATELY use read_with_deps on the entry file (index.html, main.tsx, etc.)
2. Read ALL linked CSS, JS, and other dependencies
3. Understand how all files work together BEFORE making changes
4. Edit all necessary files to maintain consistency
5. Verify cross-file dependencies are correct

## Web Building Workflow
1. **Map Project**: List all files and understand the structure
2. **Read Core**: Read index.html, main entry points, and related assets together
3. **Scaffold**: If project is new, create standard folders first (frontend, backend, UI, API, Tools, Config) then add semantic implementation files.
  - Create only the folders and files that fit the project requirements.
4. **Style**: Write CSS coordinated with React component structure
5. **Enhance**: Add TypeScript and Django logic for interactivity and APIs
6. **Polish**: Ensure all files are consistent and working together

## Batch File Writing (IMPORTANT for speed)
When creating multiple files in one task, call write_file for ALL of them in a SINGLE response — do not wait for confirmation between files. The tool executor runs them sequentially and the UI updates after all are done. Batching 5-10 write_file calls in one round is faster and uses fewer rounds than one file per round. Example: call write_file(frontend/package.json), write_file(frontend/src/App.tsx), write_file(backend/manage.py) all in one response.

## Running Projects
When user asks to "run", "build", "start", "execute" the project, or says "run all necessary commands":
1. Create/modify all necessary files first
2. Detect project type from package.json or file structure
3. If package.json exists, check for scripts: prefer "dev" > "start" > "build"
4. **ALWAYS attempt bash tool** for install, build, migration, and short verification commands. Never claim commands cannot be run without trying first.
5. For React/Node projects: run dependency installation first (for example bash("cd frontend && npm install")) so node_modules exists.
6. Long-running servers must not run as a foreground bash command. Start them with run_in_background:true when available, or tell the user to click the Preview button. The Preview button auto-detects project type and starts npm/bun/pnpm/yarn, Django, Flask, FastAPI, Go, Rust, and static previews correctly.
7. For Django backend: run bash("pip install -r requirements.txt") and bash("python manage.py migrate") before starting the server with run_in_background:true or Preview.
8. If bash returns an actual error, report the exact error message, fix the root cause, then retry.
9. Only fall back to manual instructions if bash explicitly fails after at least one attempt.
10. **PACKAGE MANAGER**: Default to npm. Only use bun/pnpm/yarn if the project already has a lockfile for those tools.

## MCP Tools
MCP tools follow the naming pattern servername__toolname. Use them proactively when relevant.
When a user mentions a service (Figma, GitHub, Slack...) and the corresponding MCP server is active, call its tools immediately — do not ask permission first. Active servers and workflows are listed at the end of this prompt.

## Design Principles
- Use modern color palettes (not default browser blue)
- Add subtle shadows, borders, and depth
- Include hover states and micro-animations
- Make it mobile-responsive by default
- Use good typography hierarchy

## Finish
After completing, write a concise summary: what files were created/modified, how they work together, and what the result looks like. Only mention file names, not code content. If user asked to run it, always end with the command they need to execute in their terminal.
For project/app builds, explicitly confirm README.md was created/updated with the required sections.`

const CAVEMAN_SUFFIX: Record<string, string> = {
  lite: `\n\nRESPONSE STYLE: Keep articles (a/an/the). Drop: just/really/basically/certainly/of course/pleasantries. No filler sentences. Be direct.`,
  full: `\n\nRESPONSE STYLE (CAVEMAN FULL): Drop articles, filler, pleasantries, hedging. Fragments OK. Short synonyms: fix not "implement a solution", big not "extensive". Pattern: [thing] [action] [reason]. Technical terms exact. Code blocks unchanged.`,
  ultra: `\n\nRESPONSE STYLE (CAVEMAN ULTRA): Maximum compression. Single-word or fragment answers only. No explanations unless asked. Pure information. No warmth. Code blocks exact.`,
}

function buildMcpGuidance(tools: MCPTool[]): string {
  if (tools.length === 0) return ''

  const byServer = new Map<string, MCPTool[]>()
  for (const t of tools) {
    if (!byServer.has(t.serverName)) byServer.set(t.serverName, [])
    byServer.get(t.serverName)!.push(t)
  }

  let out = '\n\n## Active MCP Servers & Tools'
  for (const [server, serverTools] of byServer) {
    out += `\n- **${server}**: ${serverTools.map(t => `\`${t.name}\``).join(', ')}`
  }

  // Figma-specific workflow
  const figmaTools = tools.filter(t => t.serverName.toLowerCase().includes('figma'))
  if (figmaTools.length > 0) {
    const getDataTool = figmaTools.find(t => /get|data|file/.test(t.name.toLowerCase())) ?? figmaTools[0]
    const imgTool = figmaTools.find(t => /image|download|asset/.test(t.name.toLowerCase()))
    out += `

### Figma Design-to-Code Workflow
**IMPORTANT**: Whenever the user's message contains a Figma URL (figma.com/...) — even if they just say "build it", "make this", or paste the link with no extra context — you MUST:
1. Extract the **file key** from the URL (the segment after /file/ or /design/):
   - figma.com/file/**FILEKEY**/...
   - figma.com/design/**FILEKEY**/...
   - figma.com/proto/**FILEKEY**/...
2. Immediately call \`${getDataTool.name}\` with \`{ "fileKey": "FILEKEY" }\` — do NOT ask for clarification first
3. From the MCP response extract:
   - **Colors**: fill/stroke hex values → CSS custom properties (--color-primary etc)
   - **Typography**: fontFamily, fontSize, fontWeight, lineHeight → match exactly
   - **Spacing**: absoluteBoundingBox, padding, itemSpacing → px values
   - **Components**: named frames/groups → semantic HTML (header, nav, section, etc)
   - **Layout**: layoutMode HORIZONTAL/VERTICAL → flexbox row/column; layoutGrids → CSS grid
   - **Corner radius**: cornerRadius → border-radius
   - **Effects**: shadows, blurs → box-shadow / filter
4. Build a complete pixel-faithful implementation using the extracted values
${imgTool ? `5. Call \`${imgTool.name}\` for any image/icon node IDs found in the response` : ''}
Never guess or approximate — always fetch real Figma data first, then build.`
  }

  return out
}

function buildSystemPrompt(
  agentPersona?: { name: string; instructions: string } | null,
  customInstructions?: string,
  projectMemory?: string | null,
  mcpTools?: MCPTool[],
): string {
  const cfg = getConfig()
  let prompt = ''
  if (cfg.behavior.systemPromptPrefix?.trim()) {
    prompt += cfg.behavior.systemPromptPrefix.trim() + '\n\n'
  }
  prompt += BASE_SYSTEM_PROMPT
  if (IS_WINDOWS) {
    prompt += `\n\n## Shell Environment (Windows) — CRITICAL
You are running on Windows. The bash tool uses cmd.exe — NOT bash/WSL.
FORBIDDEN (cmd.exe does not have these):
- test -d / test -f / [ -d ... ] — never use Unix test commands
- Unix-only binaries without PATH: grep, ls, cat, find — use built-in tools (grep_search, list_files, view_file) instead
ALLOWED in cmd.exe:
- && chaining works: "cd frontend && npm install" is fine
- npm, node, python, pip, npx — all work directly
- cd, mkdir, del, copy, move — Windows shell built-ins
DEV SERVERS (critical): npm run dev, vite, python manage.py runserver NEVER EXIT — always pass run_in_background:true when starting them. Never use shell_run_command for a server.
IMPORTANT: Never say the bash tool is broken. Always attempt bash for npm/python commands. Report only actual errors returned by the tool.`
  }
  if (mcpTools && mcpTools.length > 0) {
    prompt += buildMcpGuidance(mcpTools)
  }
  if (projectMemory?.trim()) {
    prompt += `\n\n## PROJECT MEMORY (BETOPIA.md)\n${projectMemory.trim()}`
  }
  if (agentPersona?.instructions.trim()) {
    prompt += `\n\n## ACTIVE AGENT — ${agentPersona.name}\n${agentPersona.instructions.trim()}`
  }
  const ci = customInstructions ?? (() => {
    try { return localStorage.getItem('betopia:custom-instructions') ?? '' } catch { return '' }
  })()
  if (ci.trim()) {
    prompt += `\n\n## USER CUSTOM INSTRUCTIONS\n${ci.trim()}`
  }
  if (cfg.behavior.cavemanEnabled) {
    prompt += CAVEMAN_SUFFIX[cfg.behavior.cavemanIntensity] ?? CAVEMAN_SUFFIX.full
  }
  return prompt
}

// ── Built-in tool definitions ─────────────────────────────────────────────────

const BUILTIN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or overwrite an existing one with complete content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Complete file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Surgically replace a block of text in a file. Requires an exact match of the old string.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          old_string: { type: 'string', description: 'The exact text to replace (including indentation)' },
          new_string: { type: 'string', description: 'The replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path to delete' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_file',
      description: 'Read the content of a file, optionally restricted to a line range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          start_line: { type: 'number', description: 'Starting line (1-indexed)' },
          end_line: { type: 'number', description: 'Ending line (1-indexed)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Recursively list all files in the project.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List contents of a specific directory (non-recursive).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (defaults to root ".")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_files',
      description: 'Read all files recursively under a directory path. Returns file contents with paths.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (defaults to root ".")' },
          max_files: { type: 'number', description: 'Maximum number of files to read (default: 100)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_structure',
      description: 'Get a high-level overview of the project structure with file counts and entry points (index.html, main.tsx, etc.)',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_with_deps',
      description: 'Read a file and automatically detect and read its dependencies (CSS files, JS imports, etc.)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path to read (e.g., index.html)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search for a text pattern in all project files.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The text or pattern to search for' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: IS_WINDOWS
        ? 'Execute a shell command in the project root using cmd.exe. Use npm, node, python directly — they all work. Chaining with && is supported. Set run_in_background:true for dev servers (npm run dev, vite, runserver) so they stay alive without timing out.'
        : 'Execute a shell command in the project root. Set run_in_background:true for long-running servers (npm run dev, vite, runserver) so they stay alive.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run' },
          run_in_background: { type: 'boolean', description: 'Set true for dev servers and watch processes that should keep running. They start immediately and you get a confirmation without waiting for them to exit.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_subagent',
      description: `Spawn an isolated read-only subagent with a fresh context to handle a self-contained investigation (large search, code review, security audit) without polluting your own context. Returns a single text summary.

Types:
- explore: Read-only codebase explorer. Locates files, traces references, summarizes architecture.
- code-review: Reviews changed code for correctness, architecture, performance, security.
- security: Audits code/configuration for security risks (auth, injection, secrets, etc).
- general: General-purpose worker for multi-step research questions that span many files.

Auto-executes (no approval) — subagents are read-only by design.`,
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['explore', 'code-review', 'security', 'general'],
            description: 'Subagent type matching the task',
          },
          prompt: {
            type: 'string',
            description: 'Self-contained instruction. The subagent has no memory of prior conversation — include all relevant context.',
          },
          description: {
            type: 'string',
            description: 'Short label shown in the chat UI for the spawn card.',
          },
        },
        required: ['type', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_coding_agent',
      description: 'Spawn a Claude Code agent in the terminal and give it a prompt. Use when the user wants work delegated to Claude Code. Craft a complete, self-contained prompt first.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The full, self-contained task prompt for the Claude Code agent.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_agent',
      description: 'Send a follow-up instruction to the active Claude Code agent in the terminal. Read its latest output first so the follow-up is informed.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: 'One clear, self-contained instruction for the agent. No control characters.',
          },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_agent_output',
      description: 'Read the active Claude Code agent terminal output. Call this first when handling a delegation request to see whether an agent is active and what it has done.',
      parameters: {
        type: 'object',
        properties: {
          lines: {
            type: 'number',
            description: 'Trailing lines of the agent terminal to return. Default 120.',
          },
        },
      },
    },
  },
]

// ── MCP Tool Interface ────────────────────────────────────────────────────

interface MCPTool {
  serverId: string
  serverName: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeId() {
  return Math.random().toString(36).slice(2, 10)
}

const TOOL_RESULT_MAX = 12000
const HISTORY_MAX_MESSAGES = 40 // keep last N messages to cap context size

function historyToOAI(history: Message[]): OAIMessage[] {
  const result: OAIMessage[] = []
  // Only send recent history to avoid unbounded context growth
  const recent = history.length > HISTORY_MAX_MESSAGES
    ? history.slice(-HISTORY_MAX_MESSAGES)
    : history
  for (const msg of recent) {
    if (msg.role === 'user') {
      const text = msg.parts.find(p => p.type === 'text')
      result.push({ role: 'user', content: (text?.data as { text: string })?.text ?? '' })
    } else if (msg.role === 'assistant') {
      const text = msg.parts.find(p => p.type === 'text')
      const toolCalls = msg.parts.filter(p => p.type === 'tool_call')
      const toolResults = msg.parts.filter(p => p.type === 'tool_result')
      const textContent = (text?.data as { text: string })?.text || ''
      const parsedToolCalls = toolCalls.map(p => {
        const d = p.data as { id: string; name: string; input: string }
        return { id: d.id, type: 'function' as const, function: { name: d.name, arguments: d.input } }
      })
      const parsedToolResults = toolResults.map(p => {
        const d = p.data as { tool_call_id: string; name: string; content: string }
        // Truncate large tool results so old history doesn't bloat the context
        const content = d.content.length > TOOL_RESULT_MAX
          ? d.content.slice(0, TOOL_RESULT_MAX) + '\n…[truncated]'
          : d.content
        return { role: 'tool' as const, content, tool_call_id: d.tool_call_id, name: d.name }
      })

      // Keep only assistant tool calls that have matching tool results.
      // This prevents invalid history after interrupted/failed tool rounds.
      const resultIds = new Set(parsedToolResults.map(t => t.tool_call_id).filter(Boolean))
      const validToolCalls = parsedToolCalls.filter(tc => Boolean(tc.id) && resultIds.has(tc.id))
      const validCallIds = new Set(validToolCalls.map(tc => tc.id))
      const validToolResults = parsedToolResults.filter(tr => Boolean(tr.tool_call_id) && validCallIds.has(tr.tool_call_id))

      const oai: OAIMessage = { role: 'assistant', content: textContent || null }
      if (validToolCalls.length > 0) {
        oai.tool_calls = validToolCalls
      }
      if (textContent || validToolCalls.length > 0) {
        result.push(oai)
      }
      for (const tr of validToolResults) {
        result.push(tr)
      }
    }
  }
  return result
}

// ── Per-model capability cache (process lifetime) ────────────────────────────
// 'stream'      — supports stream:true + tools (normal)
// 'nostream'    — needs stream:false, supports tools
// 'notoolstream'— needs stream:false AND no tools
type ModelCap = 'stream' | 'nostream' | 'notoolstream'
const _modelCap = new Map<string, ModelCap>()

// ── Streaming SSE parser ──────────────────────────────────────────────────────

async function* streamChat(
  messages: OAIMessage[],
  tools: unknown[],
  signal?: AbortSignal,
): AsyncGenerator<{ text?: string; thinkText?: string; toolCalls?: StreamToolCall[]; finishReason?: string; usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }> {
  const cfg = getConfig()
  const modelCfg = cfg.model
  const { baseUrl, apiKey, model } = await getResolvedEndpointAsync()

  const baseBody: Record<string, unknown> = {
    model,
    messages,
  }
  if (tools.length > 0) {
    baseBody.tools = tools
    baseBody.tool_choice = 'auto'
  }
  if (modelCfg.temperature !== undefined) baseBody.temperature = modelCfg.temperature
  // Always set max_tokens so the inference backend reserves output headroom.
  // Without this, the backend may try to emit unlimited tokens, get truncated
  // mid-JSON (tool call arguments), and return a 502 "Unterminated string".
  baseBody.max_tokens = modelCfg.maxTokens ?? 32768
  if (modelCfg.topP !== undefined) baseBody.top_p = modelCfg.topP
  // For thinking-capable models (Qwen3.6, etc.) explicitly control thinking mode.
  // Without enable_thinking: false, Qwen3.6 defaults to thinking ON → very slow on Windows.
  if (THINKING_MODELS.has(model)) {
    baseBody.enable_thinking = modelCfg.thinkingMode === true
  }

  const reqHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }

  const doFetch = (body: Record<string, unknown>) =>
    tauriFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal,
    } as any)

  const bodyNoTools: Record<string, unknown> = { ...baseBody }
  delete bodyNoTools.tools
  delete bodyNoTools.tool_choice

  // Use cached capability to skip known-failing tiers
  const capKey = `${baseUrl}::${model}`
  const knownCap = _modelCap.get(capKey)

  let res: Awaited<ReturnType<typeof doFetch>>
  let streaming: boolean

  if (knownCap === 'notoolstream') {
    res = await doFetch({ ...bodyNoTools, stream: false })
    streaming = false
  } else if (knownCap === 'nostream') {
    res = await doFetch({ ...baseBody, stream: false })
    streaming = false
  } else {
    // Tier 1: stream=true + tools
    res = await doFetch({ ...baseBody, stream: true })
    streaming = true

    // Tier 2: stream=false + tools
    // Only cache capability change when the alternative tier actually succeeds — avoids
    // permanently poisoning _modelCap on transient inference 502s.
    if (!res.ok && res.status >= 500) {
      const tier2 = await doFetch({ ...baseBody, stream: false })
      if (tier2.ok) _modelCap.set(capKey, 'nostream')
      res = tier2
      streaming = false
    }

    // Tier 3: stream=false + no tools
    if (!res.ok && res.status >= 500) {
      const tier3 = await doFetch({ ...bodyNoTools, stream: false })
      if (tier3.ok) _modelCap.set(capKey, 'notoolstream')
      res = tier3
      streaming = false
    }
  }

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`AI API error ${res.status}: ${err}`)
  }

  // Cache successful capability on first discovery
  if (!knownCap) _modelCap.set(capKey, streaming ? 'stream' : 'nostream')

  // Helper: parse JSON response body and yield events
  async function* yieldFromJson(body: string): AsyncGenerator<{ text?: string; thinkText?: string; toolCalls?: StreamToolCall[]; finishReason?: string; usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }> {
    let data: any
    try { data = JSON.parse(body.trimStart()) } catch { return }

    const rawContent: string = data.content ?? data.choices?.[0]?.message?.content ?? ''
    const rawToolCalls: any[] = data.tool_calls ?? data.choices?.[0]?.message?.tool_calls ?? []

    if (rawContent) {
      if (rawContent.includes('<think>') || rawContent.includes('</think>')) {
        let remainder = rawContent
        const thinkMatches = rawContent.match(/<think>([\s\S]*?)<\/think>/g)
        if (thinkMatches) {
          for (const block of thinkMatches) {
            const inner = block.slice(7, -8)
            if (inner.trim() && modelCfg.thinkingMode === true) yield { thinkText: inner }
            remainder = remainder.replace(block, '')
          }
        } else if (rawContent.includes('<think>')) {
          const idx = rawContent.indexOf('<think>')
          if (modelCfg.thinkingMode === true) yield { thinkText: rawContent.slice(idx + 7) }
          remainder = rawContent.slice(0, idx)
        } else if (rawContent.includes('</think>')) {
          const idx = rawContent.indexOf('</think>')
          if (modelCfg.thinkingMode === true) yield { thinkText: rawContent.slice(0, idx) }
          remainder = rawContent.slice(idx + 8)
        }
        if (remainder.trim()) yield { text: remainder }
      } else {
        yield { text: rawContent }
      }
    }

    if (rawToolCalls.length > 0) {
      const calls: StreamToolCall[] = rawToolCalls.map((tc: any, i: number) => ({
        index: i,
        id: tc.id ?? `call_${i}`,
        name: tc.function?.name ?? tc.name ?? '',
        arguments: typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
      }))
      yield { finishReason: 'tool_calls', toolCalls: calls }
    } else {
      yield { finishReason: 'stop' }
    }
  }

  // Non-streaming: read full body, parse as JSON
  if (!streaming) {
    const fullText: string = res.body
      ? await (async () => {
          const rdr = (res.body as ReadableStream<Uint8Array>).getReader()
          const dec = new TextDecoder()
          let t = ''
          while (true) { const { done, value } = await rdr.read(); if (done) break; t += dec.decode(value, { stream: true }) }
          return t
        })()
      : await res.text()
    yield* yieldFromJson(fullText)
    return
  }

  // Streaming: read first chunk to detect JSON vs SSE
  if (!res.body) return
  const sseReader = (res.body as ReadableStream<Uint8Array>).getReader()
  const sseDec = new TextDecoder()

  const firstRead = await sseReader.read()
  if (firstRead.done) return
  const firstChunk = sseDec.decode(firstRead.value, { stream: true })

  // Some providers return JSON even with stream:true — detect from first bytes
  if (firstChunk.trimStart().startsWith('{') || firstChunk.trimStart().startsWith('[')) {
    let jsonBuf = firstChunk
    while (true) {
      const r = await sseReader.read()
      if (r.done) break
      jsonBuf += sseDec.decode(r.value, { stream: true })
    }
    yield* yieldFromJson(jsonBuf)
    return
  }

  // True SSE: process lines incrementally as chunks arrive (no full-buffer)
  const accumToolCalls: Record<number, StreamToolCall> = {}
  let lineBuffer = firstChunk

  outer:
  while (true) {
    // Drain all complete lines from buffer before reading more
    let nl: number
    while ((nl = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, nl).replace(/\r$/, '')
      lineBuffer = lineBuffer.slice(nl + 1)

      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (raw === '[DONE]') break outer

      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null
            reasoning_content?: string | null
            tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
          }
          finish_reason?: string | null
        }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          input_tokens?: number
          output_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
          prompt_cache_hit_tokens?: number
        }
      }
      try { chunk = JSON.parse(raw) } catch { continue }

      if (chunk.usage) {
        const u = chunk.usage
        const input = u.input_tokens ?? u.prompt_tokens ?? 0
        const output = u.output_tokens ?? u.completion_tokens ?? 0
        const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0
        yield { usage: { inputTokens: input, outputTokens: output, cachedInputTokens: cached } }
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta

      if (delta?.reasoning_content && modelCfg.thinkingMode === true) yield { thinkText: delta.reasoning_content }
      if (delta?.content) {
        const tok = delta.content
        if (tok.includes('<think>') || tok.includes('</think>')) {
          const thinkMatch = tok.match(/<think>([\s\S]*?)<\/think>/g)
          let remainder = tok
          if (thinkMatch) {
            for (const block of thinkMatch) {
              const inner = block.slice(7, -8)
              if (inner && modelCfg.thinkingMode === true) yield { thinkText: inner }
              remainder = remainder.replace(block, '')
            }
          } else if (tok.includes('<think>')) {
            if (modelCfg.thinkingMode === true) yield { thinkText: tok.replace('<think>', '') }
            remainder = ''
          } else if (tok.includes('</think>')) {
            const idx = tok.indexOf('</think>')
            if (modelCfg.thinkingMode === true) yield { thinkText: tok.slice(0, idx) }
            remainder = tok.slice(idx + 8)
          }
          if (remainder.trim()) yield { text: remainder }
        } else {
          yield { text: tok }
        }
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!accumToolCalls[tc.index]) {
            accumToolCalls[tc.index] = { index: tc.index, id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' }
          }
          accumToolCalls[tc.index].arguments += tc.function?.arguments ?? ''
          if (tc.id) accumToolCalls[tc.index].id = tc.id
          if (tc.function?.name) accumToolCalls[tc.index].name = tc.function.name
        }
      }

      if (choice.finish_reason) {
        if (Object.keys(accumToolCalls).length > 0) {
          yield { toolCalls: Object.values(accumToolCalls), finishReason: choice.finish_reason }
        } else {
          yield { finishReason: choice.finish_reason }
        }
      }
    }

    // Read next network chunk
    const r = await sseReader.read()
    if (r.done) break
    lineBuffer += sseDec.decode(r.value, { stream: true })
  }
}

function isInferenceError(err: unknown): boolean {
  const msg = String(err)
  return /AI API error 5\d\d/.test(msg) && (
    msg.includes('inference') || msg.includes('Unterminated') || msg.includes('inference failed')
  )
}

function estimateHistoryChars(history: OAIMessage[]): number {
  let total = 0
  for (const m of history) {
    if (typeof m.content === 'string') total += m.content.length
    const tc = (m as any).tool_calls
    if (tc) for (const t of tc) total += (t.function?.arguments?.length ?? 0)
  }
  return total
}

// Emergency cap on all tool results in a history snapshot (does NOT mutate original).
function capToolResults(history: OAIMessage[], cap: number): OAIMessage[] {
  return history.map(m => {
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > cap) {
      return { ...m, content: m.content.slice(0, cap) + '\n…[truncated for context budget]' }
    }
    return m
  })
}

// Returns a copy of history that fits within ~MAX_CHARS (≈100K tokens).
// Strategy: 1) cap tool results to 2K, 2) remove old assistant+tool pairs.
function sanitizeHistorySize(history: OAIMessage[]): OAIMessage[] {
  const MAX_CHARS = 400_000
  if (estimateHistoryChars(history) <= MAX_CHARS) return history

  // Pass 1: emergency-cap all tool results
  let h = capToolResults(history, 2_000)
  if (estimateHistoryChars(h) <= MAX_CHARS) return h

  // Pass 2: remove old assistant+tool pairs
  return trimInferenceContext(h)
}

// Remove old tool call/result pairs from the middle of the history.
// Keeps: system prompt, first user message, last KEEP_TAIL messages.
// On each call removes ~50% of removable pairs (more aggressive than before).
function trimInferenceContext(history: OAIMessage[]): OAIMessage[] {
  const KEEP_TAIL = 6
  const systemMsgs = history.filter(m => m.role === 'system')
  const rest = history.filter(m => m.role !== 'system')
  if (rest.length <= KEEP_TAIL + 2) return history

  const firstUserIdx = rest.findIndex(m => m.role === 'user')
  const targetRemove = Math.max(2, Math.floor(rest.length * 0.50))
  let removed = 0
  const trimmed: OAIMessage[] = []

  for (let i = 0; i < rest.length; i++) {
    if (i === firstUserIdx || i >= rest.length - KEEP_TAIL) {
      trimmed.push(rest[i]); continue
    }
    const m = rest[i] as any
    if (removed < targetRemove && m.role === 'assistant' && m.tool_calls?.length > 0) {
      let j = i + 1
      while (j < rest.length - KEEP_TAIL && rest[j].role === 'tool') j++
      removed += j - i
      i = j - 1; continue
    }
    trimmed.push(rest[i])
  }

  if (trimmed.length >= rest.length) return history
  return [...systemMsgs, trimmed[0], ...trimmed.slice(1)]
}

function toolCallPriority(name: string): number {
  if (name === 'delete_file') return 0
  if (name === 'rename_file') return 1
  if (name === 'edit') return 2
  if (name === 'write_file') return 3
  return 10
}

function normalizeEscapedMultiline(input: unknown): string {
  if (typeof input !== 'string') return String(input ?? '')
  if (input.includes('\n')) return input

  const escapedNewlines = (input.match(/\\n/g) ?? []).length
  if (escapedNewlines < 2) return input

  // Only normalize when it strongly looks like flattened multiline code.
  const looksLikeCode =
    /(import\s+|export\s+|function\s+|const\s+|className=|return\s*\(|<\w+|{\s*$|;\s*$)/m.test(input)
  if (!looksLikeCode) return input

  return input
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractServerPort(command: string): number {
  const m = command.match(/--port[=\s]+(\d+)|:(\d+)\b/)
  if (m) return parseInt(m[1] ?? m[2])
  if (/runserver|django|uvicorn/.test(command)) return 8000
  return 5173 // vite / npm run dev default
}

// ── Built-in tool executor ────────────────────────────────────────────────────

async function executeBuiltinTool(
  projectPath: string,
  name: string,
  argsJson: string,
  onFilesChanged: () => Promise<void>,
  onPermissionRequest?: (tool: string, args: string) => Promise<boolean>,
): Promise<string> {
  let args: Record<string, any>
  try { args = JSON.parse(argsJson) as Record<string, any> } catch { return 'Error: invalid tool arguments JSON' }

  try {
    if (name === 'write_file') {
      const { path, content } = args
      if (!path || content === undefined) return 'Error: path and content required'
      if (onPermissionRequest) {
        const allowed = await onPermissionRequest('write_file', argsJson)
        if (!allowed) return `Permission denied: user declined to write ${path}`
      }
      const normalizedContent = normalizeEscapedMultiline(content)
      await writeProjectFile(projectPath, path, normalizedContent)
      await onFilesChanged()
      return `File written: ${path}`
    }

    if (name === 'edit') {
      const { path, old_string, new_string } = args
      if (!path || old_string === undefined || new_string === undefined) return 'Error: path, old_string, and new_string required'
      if (onPermissionRequest) {
        const allowed = await onPermissionRequest('edit', argsJson)
        if (!allowed) return `Permission denied: user declined to edit ${path}`
      }
      const content = await readProjectFile(projectPath, path)
      const rawOld = String(old_string)
      const rawNew = String(new_string)
      const normalizedOld = normalizeEscapedMultiline(rawOld)
      const normalizedNew = normalizeEscapedMultiline(rawNew)

      let matchOld = rawOld
      let replaceWith = rawNew
      let index = content.indexOf(matchOld)
      if (index === -1 && normalizedOld !== rawOld) {
        matchOld = normalizedOld
        replaceWith = normalizedNew
        index = content.indexOf(matchOld)
      }
      if (index === -1) return 'Error: old_string not found. Make sure it matches exactly, including whitespace.'
      const lastIndex = content.lastIndexOf(matchOld)
      if (index !== lastIndex) return 'Error: old_string appears multiple times. Provide more context to make it unique.'
      const newContent = content.slice(0, index) + replaceWith + content.slice(index + matchOld.length)
      await writeProjectFile(projectPath, path, newContent)
      await onFilesChanged()
      return `File edited: ${path}`
    }

    if (name === 'delete_file') {
      const { path } = args
      if (!path) return 'Error: path required'
      if (onPermissionRequest) {
        const allowed = await onPermissionRequest('delete_file', argsJson)
        if (!allowed) return `Permission denied: user declined to delete ${path}`
      }
      try {
        const fullPath = path === '.' ? projectPath : `${projectPath}/${path}`.replace(/\/+/g, '/')
        await invoke('fs_delete', { path: fullPath })
        await onFilesChanged()
        return `Deleted: ${path}`
      } catch (err) {
        return `Error deleting: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'view_file') {
      const { path, start_line, end_line } = args
      if (!path) return 'Error: path required'
      const content = await readProjectFile(projectPath, path)
      if (start_line !== undefined || end_line !== undefined) {
        const lines = content.split('\n')
        const start = (start_line || 1) - 1
        const end = end_line || lines.length
        return lines.slice(start, end).join('\n')
      }
      return content
    }

    if (name === 'list_files') {
      const tree = await getFileTree(projectPath)
      const flatten = (entries: any[], indent = 0): string =>
        entries.map(e =>
          '  '.repeat(indent) + (e.is_dir ? '📁 ' : '📄 ') + e.name +
          (e.is_dir && e.children ? '\n' + flatten(e.children, indent + 1) : ''),
        ).join('\n')
      return flatten(tree) || '(empty project)'
    }

    if (name === 'list_dir') {
      const { path = '.' } = args
      const abs = path === '.' ? projectPath : `${projectPath}/${path}`
      try {
        // Use plugin-fs readDir (proven, no custom command naming issues)
        const { readDir } = await import('@tauri-apps/plugin-fs')
        const entries = await readDir(abs)
        return entries.map((e: any) => (e.isDirectory ? '📁 ' : '📄 ') + e.name).join('\n') || '(empty)'
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'read_files') {
      const { path = '.', max_files = 100 } = args
      const tree = await getFileTree(projectPath)
      const results: Array<{ path: string; content: string }> = []

      const filterByPath = (entries: any[], targetPath: string): any[] => {
        if (targetPath === '.' || targetPath === '') return entries
        const parts = targetPath.split('/').filter(Boolean)
        let current = entries
        for (const part of parts) {
          const found = current.find(e => e.name === part && e.is_dir)
          if (!found) return []
          current = found.children || []
        }
        return current
      }

      const collectFiles = async (entries: any[]) => {
        if (results.length >= max_files) return
        for (const e of entries) {
          if (results.length >= max_files) break
          if (e.is_dir && e.children) {
            await collectFiles(e.children)
          } else {
            try {
              const content = await readProjectFile(projectPath, e.path)
              results.push({ path: e.path, content })
            } catch { /* skip */ }
          }
        }
      }

      const filteredEntries = filterByPath(tree, path)
      await collectFiles(filteredEntries)

      if (results.length === 0) return '(no files found)'
      return results.map(f => `📄 ${f.path}\n${'─'.repeat(40)}\n${f.content}`).join('\n\n')
    }

    if (name === 'project_structure') {
      const tree = await getFileTree(projectPath)

      const countFiles = (entries: any[]): { files: number; dirs: number } => {
        let files = 0, dirs = 0
        for (const e of entries) {
          if (e.is_dir) {
            dirs++
            if (e.children) {
              const c = countFiles(e.children)
              files += c.files
              dirs += c.dirs
            }
          } else {
            files++
          }
        }
        return { files, dirs }
      }

      const findEntryPoints = (entries: any[]): string[] => {
        const entryPoints: string[] = []
        const search = (entries: any[], prefix = '') => {
          for (const e of entries) {
            const fullPath = prefix ? `${prefix}/${e.name}` : e.name
            if (!e.is_dir && (e.name === 'index.html' || e.name === 'main.tsx' || e.name === 'main.ts' || e.name === 'app.tsx' || e.name === 'index.jsx' || e.name === 'index.tsx')) {
              entryPoints.push(fullPath)
            }
            if (e.is_dir && e.children) {
              search(e.children, fullPath)
            }
          }
        }
        search(entries)
        return entryPoints
      }

      const { files, dirs } = countFiles(tree)
      const entryPoints = findEntryPoints(tree)

      const flatten = (entries: any[], indent = 0, maxDepth = 2): string => {
        if (indent > maxDepth) return '...'
        return entries.map(e =>
          '  '.repeat(indent) + (e.is_dir ? '📁 ' : '📄 ') + e.name +
          (e.is_dir && e.children ? '\n' + flatten(e.children, indent + 1, maxDepth) : ''),
        ).join('\n')
      }

      return `Project Structure:
Files: ${files}, Directories: ${dirs}
Entry Points: ${entryPoints.length > 0 ? entryPoints.join(', ') : 'none found'}

Tree (2 levels deep):
${flatten(tree)}`
    }

    if (name === 'read_with_deps') {
      const { path } = args
      if (!path) return 'Error: path required'

      try {
        const content = await readProjectFile(projectPath, path)
        const results = [{ path, content }]

        // Detect dependencies (CSS, JS imports)
        const deps = new Set<string>()

        // Find CSS links in HTML: href="style.css"
        const cssMatches = content.matchAll(/href=["']([^"']*\.css)['"]/g)
        for (const m of cssMatches) {
          let depPath = m[1]
          if (depPath.startsWith('./')) depPath = depPath.slice(2)
          if (!depPath.startsWith('/')) {
            const dir = path.split('/').slice(0, -1).join('/')
            if (dir) depPath = dir + '/' + depPath
          }
          deps.add(depPath)
        }

        // Find JS imports in HTML: src="script.js"
        const jsMatches = content.matchAll(/src=["']([^"']*\.(js|jsx|ts|tsx))['"]/g)
        for (const m of jsMatches) {
          let depPath = m[1]
          if (depPath.startsWith('./')) depPath = depPath.slice(2)
          if (!depPath.startsWith('/')) {
            const dir = path.split('/').slice(0, -1).join('/')
            if (dir) depPath = dir + '/' + depPath
          }
          deps.add(depPath)
        }

        // Read dependencies
        for (const dep of deps) {
          try {
            const depContent = await readProjectFile(projectPath, dep)
            results.push({ path: dep, content: depContent })
          } catch { /* skip */ }
        }

        return results.map(f => `📄 ${f.path}\n${'─'.repeat(50)}\n${f.content}`).join('\n\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'grep_search') {
      const { query } = args
      if (!query) return 'Error: query required'
      try {
        const matches = await invoke<Array<{ path: string; line: number; text: string }>>('fs_grep', {
          root: projectPath,
          pattern: query,
          case_sensitive: false,
          max_results: 100,
        })
        if (matches.length === 0) return 'No matches found'
        return matches.map(m => `${m.path}:${m.line}: ${m.text.trim()}`).join('\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (name === 'bash') {
      const { command, run_in_background } = args
      if (!command) return 'Error: command required'
      if (onPermissionRequest) {
        const allowed = await onPermissionRequest('bash', argsJson)
        if (!allowed) return `Permission denied: user declined to run: ${command}`
      }

      // Detect dev servers and watch processes — these never exit so must run in background
      const isServer = run_in_background === true || /npm run dev|npm start|npm run start|npx vite|vite\b|runserver|--watch|uvicorn|nodemon|next dev|gatsby develop/.test(command)

      const cfg = getConfig()
      if (cfg.sandbox?.enabled && !isServer) {
        try {
          const result = await runCommandInSandbox(projectPath, command, cfg.sandbox)
          const out = result.stdout ?? ''
          const err = result.stderr ?? ''
          if (result.timedOut) return `Error: sandbox timed out after ${cfg.sandbox.timeoutSec}s\n${err || out}`
          if (result.exitCode !== 0) return `Error (code ${result.exitCode}):\n${err || out}`
          return out || 'OK'
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      if (isServer) {
        // Long-running server — start in background, return immediately
        const bgId = `server-${command.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}`
        try {
          await invoke('shell_bg_start', { id: bgId, command, cwd: projectPath })
          const port = extractServerPort(command)
          const serverUrl = `http://localhost:${port}`
          return `Server started in background (id: ${bgId}). Running at ${serverUrl} — click the Preview ▶ button to open it.`
        } catch (err) {
          return `Error starting server: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      try {
        const result = await invoke<{ stdout: string; stderr: string; exit_code: number }>('shell_run_command', {
          command,
          cwd: projectPath,
        })
        const code = result.exit_code ?? (result as any).exitCode ?? 0
        if (code !== 0) return `Error (code ${code}):\n${result.stderr || result.stdout}`
        return result.stdout || 'OK'
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    return `Error: unknown tool "${name}"`
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ── Sub-agent runner ──────────────────────────────────────────────────────────

async function runSubagentInline(
  projectPath: string,
  type: SubagentType,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const def = SUBAGENTS[type]
  if (!def) return `Error: unknown subagent type "${type}"`

  const subagentTools = BUILTIN_TOOLS.filter(t => def.tools.includes(t.function.name))

  const messages: OAIMessage[] = [
    { role: 'system', content: def.systemPrompt },
    { role: 'user', content: prompt },
  ]

  let stepCount = 0
  let finalText = ''

  while (stepCount < SUBAGENT_MAX_STEPS) {
    if (signal?.aborted) break

    let text = ''
    let toolCalls: StreamToolCall[] = []
    let finishReason = ''

    for await (const chunk of streamChat(messages, subagentTools, signal)) {
      if (signal?.aborted) break
      if (chunk.text) text += chunk.text
      if (chunk.toolCalls) toolCalls = chunk.toolCalls
      if (chunk.finishReason) finishReason = chunk.finishReason
    }

    finalText = text

    const assistantMsg: OAIMessage = { role: 'assistant', content: text || null }
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((tc, i) => ({
        id: tc.id || `call_${stepCount}_${i}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
    }
    messages.push(assistantMsg)

    if (finishReason !== 'tool_calls' || toolCalls.length === 0) break

    for (const tc of toolCalls) {
      const tcId = tc.id || `call_${stepCount}_${makeId()}`
      const result = await executeBuiltinTool(projectPath, tc.name, tc.arguments, async () => {})
      messages.push({ role: 'tool', content: result, tool_call_id: tcId, name: tc.name })
    }

    stepCount++
  }

  return finalText || '(subagent returned no output)'
}

// ── Main agent loop ───────────────────────────────────────────────────────────

export async function runAgent(
  projectPath: string,
  history: Message[],
  userText: string,
  callbacks: AgentCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const cfg = getConfig()

  const mcpManager = new MCPManager()
  const enabledServers = (cfg.mcpServers ?? []).filter(s => !s.disabled)
  const mcpToolsFlat: MCPTool[] = []
  const serverMap = new Map<string, string>() // toolId -> toolRawName

  for (const server of enabledServers) {
    try {
      const serverInstance = await mcpManager.initServer(server)
      if (serverInstance && serverInstance.tools.length > 0) {
        for (const tool of serverInstance.tools) {
          const toolId = `${server.name}__${tool.name}`
          mcpToolsFlat.push({
            serverId: server.id,
            serverName: server.name,
            name: toolId,
            description: `[${server.name}] ${tool.description ?? tool.name}`,
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          })
          serverMap.set(toolId, tool.name)
        }
        console.log(`✓ Loaded ${serverInstance.tools.length} tools from ${server.type} server: ${server.name}`)
      } else if (serverInstance) {
        console.warn(`Server "${server.name}" (${server.type}) initialized but no tools discovered`)
      }
    } catch (err) {
      console.error(`Failed to initialize MCP server ${server.name} (${server.type}):`, err)
    }
  }

  // Build full tool list: built-ins + MCP
  const allTools = [
    ...BUILTIN_TOOLS,
    ...mcpToolsFlat.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
  ]

  // Load project memory (BETOPIA.md / CLAUDE.md / AGENTS.md) — cached 30s
  const projectMemory = await loadProjectMemory(projectPath)

  let oaiHistory: OAIMessage[] = [
    { role: 'system', content: buildSystemPrompt(callbacks.agentPersona, callbacks.customInstructions, projectMemory, mcpToolsFlat) },
    ...historyToOAI(history),
    { role: 'user', content: userText },
  ]

  const parts: MessagePart[] = []

  // Throttle streaming updates — only flush to React every 80ms during text/think
  // chunks to avoid hundreds of re-renders/sec freezing the WebView.
  let _flushTimer: ReturnType<typeof setTimeout> | null = null
  let _pendingFlush = false
  const flushParts = () => { callbacks.onPartsUpdate([...parts]); _pendingFlush = false; _flushTimer = null }
  const scheduledFlush = () => {
    if (_pendingFlush) return
    _pendingFlush = true
    _flushTimer = setTimeout(flushParts, 80)
  }
  const immediateFlush = () => {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
    flushParts()
  }

  const pushPart = (p: MessagePart) => { parts.push(p); immediateFlush() }

  const updateLastText = (text: string) => {
    const last = parts[parts.length - 1]
    if (last?.type === 'text') {
      ;(last.data as { text: string }).text += text
    } else {
      parts.push({ type: 'text', data: { text } })
    }
    scheduledFlush()
  }

  const updateLastThink = (text: string) => {
    const last = parts[parts.length - 1]
    if (last?.type === 'reasoning') {
      ;(last.data as { thinking: string }).thinking += text
    } else {
      parts.push({ type: 'reasoning', data: { thinking: text } })
    }
    scheduledFlush()
  }

  for (let round = 0; round < 48; round++) {
    if (signal?.aborted) {
      await mcpManager.shutdownAll()
      break
    }

    let collectedToolCalls: StreamToolCall[] = []
    let finishReason = ''
    let roundInputTokens = 0
    let roundOutputTokens = 0
    let roundCachedTokens = 0

    // Pre-sanitize: cap tool results and remove old pairs if history is too large.
    // Always done before the first attempt to prevent 502s proactively.
    const sanitized = sanitizeHistorySize(oaiHistory)

    // Retry up to 3 times on inference/502 errors, each time trimming harder.
    // 502 "Unterminated string" means the backend truncated the model output
    // mid-JSON (usually a large tool call argument). Trimming context gives the
    // backend more output headroom.
    for (let attempt = 0; attempt < 3; attempt++) {
      const histToSend = attempt === 0 ? sanitized : sanitizeHistorySize(oaiHistory)
      let streamErr: unknown = null
      try {
        for await (const chunk of streamChat(histToSend, allTools, signal)) {
          if (signal?.aborted) break
          if (chunk.thinkText) updateLastThink(chunk.thinkText)
          if (chunk.text) updateLastText(chunk.text)
          if (chunk.toolCalls) collectedToolCalls = chunk.toolCalls
          if (chunk.finishReason) finishReason = chunk.finishReason
          if (chunk.usage) {
            roundInputTokens = chunk.usage.inputTokens
            roundOutputTokens = chunk.usage.outputTokens
            roundCachedTokens = chunk.usage.cachedInputTokens
          }
        }
      } catch (e) { streamErr = e }

      if (!streamErr) break  // success

      if (isInferenceError(streamErr)) {
        if (attempt < 2) {
          // Aggressively trim oaiHistory so next attempt sends less
          oaiHistory = trimInferenceContext(oaiHistory)
          collectedToolCalls = []; finishReason = ''; roundInputTokens = 0; roundOutputTokens = 0; roundCachedTokens = 0
          continue
        }
        throw new Error(`Inference failed — context too large. Use /compact to summarize the conversation, then try again.`)
      }

      throw streamErr
    }

    if (roundInputTokens > 0 && callbacks.onUsage) {
      callbacks.onUsage({
        inputTokens: roundInputTokens,
        outputTokens: roundOutputTokens,
        cachedInputTokens: roundCachedTokens,
        lastInputTokens: roundInputTokens,
      })
    }
    // Flush any buffered text before processing tool calls
    immediateFlush()

    if (signal?.aborted) break

    if (collectedToolCalls.length === 0) {
      pushPart({ type: 'finish', data: { reason: finishReason, time: Date.now() } })
      // Cleanup MCP servers
      await mcpManager.shutdownAll()
      break
    }

    // Normalize tool call IDs once so assistant/tool messages always match.
    const normalizedToolCalls = collectedToolCalls.map(tc => ({
      ...tc,
      id: tc.id || `call_${makeId()}`,
    }))

    // Append assistant message with tool_calls to history
    oaiHistory.push({
      role: 'assistant',
      content: null,
      tool_calls: normalizedToolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    })

    // Execute tools
    for (const tc of [...normalizedToolCalls].sort((a, b) => toolCallPriority(a.name) - toolCallPriority(b.name))) {
      // Yield to the browser event loop between tool calls so React can flush
      // pending state updates (pushPart calls). Without this, rapid-fire tool
      // execution floods the webview with synchronous work → "Not Responding".
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (signal?.aborted) break

      const callId = tc.id
      // Cap display input; write_file args can include full file contents.
      // tc.arguments remains intact in oaiHistory and actual execution.
      const displayInput = tc.arguments.length > TOOL_RESULT_DISPLAY_MAX
        ? tc.arguments.slice(0, TOOL_RESULT_DISPLAY_MAX) + '…[truncated]'
        : tc.arguments
      pushPart({ type: 'tool_call', data: { id: callId, name: tc.name, input: displayInput, finished: false } })
      callbacks.onToolStart?.(tc.name, tc.arguments)

      let result: string
      const isMCPTool = serverMap.has(tc.name)
      const yoloMode = getConfig().behavior.yoloMode

      // For file-mutating tools: compute diff and show for review, but write immediately (non-blocking)
      if (!yoloMode && callbacks.onApprovalRequired && !isMCPTool && (tc.name === 'write_file' || tc.name === 'edit')) {
        let toolArgs: Record<string, any> = {}
        try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
        const filePath = String(toolArgs.path ?? '')

        const originalContent = filePath ? await readProjectFile(projectPath, filePath).catch(() => '') : ''
        let proposedContent = originalContent

        if (tc.name === 'write_file') {
          proposedContent = normalizeEscapedMultiline(String(toolArgs.content ?? ''))
        } else if (tc.name === 'edit') {
          const rawOld = String(toolArgs.old_string ?? '')
          const rawNew = String(toolArgs.new_string ?? '')
          const normOld = normalizeEscapedMultiline(rawOld)
          const normNew = normalizeEscapedMultiline(rawNew)
          let matchIdx = originalContent.indexOf(rawOld)
          let matchOld = rawOld, replaceWith = normNew
          if (matchIdx === -1 && normOld !== rawOld) {
            matchOld = normOld
            matchIdx = originalContent.indexOf(normOld)
          }
          if (matchIdx !== -1) {
            proposedContent = originalContent.slice(0, matchIdx) + replaceWith + originalContent.slice(matchIdx + matchOld.length)
          }
        }

        const approvalId = makeId()
        pushPart({
          type: 'approval_request',
          data: {
            id: approvalId,
            toolName: tc.name,
            path: filePath,
            originalContent: originalContent.length > DIFF_DISPLAY_MAX
              ? originalContent.slice(0, DIFF_DISPLAY_MAX) + '\n…(truncated for display)'
              : originalContent,
            proposedContent: proposedContent.length > DIFF_DISPLAY_MAX
              ? proposedContent.slice(0, DIFF_DISPLAY_MAX) + '\n…(truncated for display)'
              : proposedContent,
            isNewFile: !originalContent,
            status: 'pending',
          },
        })
        immediateFlush()

        // Non-blocking: App.tsx auto-resolves immediately for file tools
        // so the agent continues writing without pausing for user input
        void callbacks.onApprovalRequired(approvalId, tc.name)

        // Update status to approved immediately (file will be written by executeBuiltinTool below)
        const apprIdx = parts.findIndex(p => p.type === 'approval_request' && (p.data as { id: string }).id === approvalId)
        if (apprIdx !== -1) (parts[apprIdx].data as { status: string }).status = 'approved'
        // (fall through to executeBuiltinTool which writes the file)
      }

      // For bash: ask for approval in chat before running (blocking)
      if (!yoloMode && callbacks.onApprovalRequired && !isMCPTool && tc.name === 'bash') {
        let bashArgs: Record<string, any> = {}
        try { bashArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
        const bashCommand = String(bashArgs.command ?? '')

        const approvalId = makeId()
        pushPart({
          type: 'approval_request',
          data: {
            id: approvalId,
            toolName: 'bash',
            path: '',
            command: bashCommand,
            originalContent: '',
            proposedContent: '',
            isNewFile: false,
            status: 'pending',
          },
        })
        immediateFlush()

        const bashApproved = Boolean(await callbacks.onApprovalRequired(approvalId, 'bash'))

        const bapprIdx = parts.findIndex(p => p.type === 'approval_request' && (p.data as { id: string }).id === approvalId)
        if (bapprIdx !== -1) (parts[bapprIdx].data as { status: string }).status = bashApproved ? 'approved' : 'rejected'
        immediateFlush()

        if (!bashApproved) {
          const tcIdx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
          if (tcIdx !== -1) (parts[tcIdx].data as { finished: boolean }).finished = true
          const rejectResult = `Permission denied: user declined to run: ${bashCommand}`
          pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: rejectResult, is_error: false } })
          immediateFlush()
          callbacks.onToolEnd?.()
          oaiHistory.push({ role: 'tool', content: rejectResult, tool_call_id: callId, name: tc.name })
          continue
        }
      }

      if (isMCPTool) {
        let parsedArgs: unknown = {}
        try { parsedArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
        result = await mcpManager.callTool(tc.name, parsedArgs)
      } else if (tc.name === 'run_subagent') {
        let toolArgs: Record<string, any> = {}
        try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
        const saType = toolArgs.type as SubagentType
        const saPrompt = String(toolArgs.prompt ?? '')
        if (!saType || !saPrompt) {
          result = 'Error: run_subagent requires type and prompt'
        } else if (!(saType in SUBAGENTS)) {
          result = `Error: unknown subagent type "${saType}"`
        } else {
          result = await runSubagentInline(projectPath, saType, saPrompt, signal)
        }
      } else if (tc.name === 'spawn_coding_agent') {
        let toolArgs: Record<string, any> = {}
        try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
        const prompt = String(toolArgs.prompt ?? '').trim()
        if (!prompt) {
          result = 'Error: prompt is required'
        } else if (!callbacks.spawnAgentInTerminal) {
          result = 'Error: terminal not available'
        } else {
          const sessionId = callbacks.getSessionId?.() ?? makeId()
          const spawned = await callbacks.spawnAgentInTerminal(prompt)
          if (!spawned) {
            result = 'Error: could not spawn agent in terminal'
          } else {
            useManagedAgentsStore.getState().register({
              sessionId,
              terminalSessionId: spawned.sessionId,
              task: prompt,
              maxRounds: 3,
            })
            result = `Claude Code agent spawned in terminal (session: ${spawned.sessionId}). It will start working shortly.`
          }
        }
      } else if (tc.name === 'send_to_agent') {
        let toolArgs: Record<string, any> = {}
        try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
        const instruction = String(toolArgs.instruction ?? '').replace(/\s*\r?\n\s*/g, ' ').trim()
        if (!instruction) {
          result = 'Error: instruction is required'
        } else if (!callbacks.sendToTerminal) {
          result = 'Error: terminal not available'
        } else {
          const sessionId = callbacks.getSessionId?.() ?? ''
          const managed = useManagedAgentsStore.getState().getBySessionId(sessionId)
          if (!managed) {
            result = 'Error: no Claude Code agent active in this session; spawn one with spawn_coding_agent'
          } else {
            const ok = await callbacks.sendToTerminal(managed.terminalSessionId, instruction + '\r')
            if (!ok) {
              result = 'Error: agent terminal is no longer available'
            } else {
              useManagedAgentsStore.getState().bumpRound(sessionId)
              result = `Instruction sent to agent: ${instruction}`
            }
          }
        }
      } else if (tc.name === 'read_agent_output') {
        let toolArgs: Record<string, any> = {}
        try { toolArgs = JSON.parse(tc.arguments) } catch { /* ok */ }
        const lines = Number(toolArgs.lines ?? 120)
        const sessionId = callbacks.getSessionId?.() ?? ''
        const managed = useManagedAgentsStore.getState().getBySessionId(sessionId)
        if (!managed) {
          result = JSON.stringify({ active: false })
        } else if (!callbacks.readTerminalOutput) {
          result = JSON.stringify({ active: true, phase: managed.phase, rounds: managed.rounds, output: '' })
        } else {
          const raw = callbacks.readTerminalOutput(managed.terminalSessionId, lines)
          result = JSON.stringify({ active: true, phase: managed.phase, rounds: managed.rounds, output: raw ?? '' })
        }
      } else {
        // File tools and bash are handled at loop level — don't double-prompt via legacy permission dialog
        const permReq = (yoloMode || (callbacks.onApprovalRequired && (tc.name === 'write_file' || tc.name === 'edit' || tc.name === 'bash')))
          ? undefined
          : callbacks.onPermissionRequest
        result = await executeBuiltinTool(projectPath, tc.name, tc.arguments, callbacks.onFilesChanged, permReq)
      }

      callbacks.onToolEnd?.()

      // Mark tool call finished
      const idx = parts.findIndex(p => p.type === 'tool_call' && (p.data as { id: string }).id === callId)
      if (idx !== -1) (parts[idx].data as { finished: boolean }).finished = true

      const displayContent = result.length > TOOL_RESULT_DISPLAY_MAX
        ? result.slice(0, TOOL_RESULT_DISPLAY_MAX) + '\n…(truncated for display)'
        : result
      pushPart({ type: 'tool_result', data: { tool_call_id: callId, name: tc.name, content: displayContent, is_error: result.startsWith('Error:') } })

      // Cap tool results stored in history — limits per-result size to control context growth
      const histResult = result.length > 6000 ? result.slice(0, 6000) + '\n…[truncated]' : result
      oaiHistory.push({ role: 'tool', content: histResult, tool_call_id: callId, name: tc.name })
    }
  }
}

/**
 * Simple streaming text call for inline chat — no tools, no agent loop.
 * Calls onChunk for each text delta; resolves with the full accumulated text.
 */
export async function streamInlineEdit(
  prompt: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { baseUrl, apiKey, model } = await getResolvedEndpointAsync()
  const body = {
    model,
    stream: true,
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content:
          'You are an expert code editor. When asked to modify code, output the COMPLETE modified file content inside a single markdown code block. When asked to explain code, respond with a clear explanation.',
      },
      { role: 'user', content: prompt },
    ],
  }
  const res = await tauriFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  } as any)
  if (!res.ok) throw new Error(`API error ${res.status}`)
  const raw = await (res as any).text() as string
  let full = ''
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') break
    try {
      const parsed = JSON.parse(data)
      const delta = parsed.choices?.[0]?.delta?.content ?? ''
      if (delta) { full += delta; onChunk(delta) }
    } catch { /* skip malformed lines */ }
  }
  return full
}
