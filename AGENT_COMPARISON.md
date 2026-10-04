# Agent Comparison: Pi vs Betopia

Pi (`/home/akash/projects/pi`) is a standalone multi-provider CLI coding agent framework.
Betopia (`desktop/src/lib/agent.ts`) is an agent embedded inside a Tauri desktop app — the AI engine runs inline in the frontend, with Rust as a thin native layer.

---

## 1. Architecture

| Dimension | Pi | Betopia |
|---|---|---|
| Delivery | Standalone CLI / npm packages | Embedded in Tauri + React desktop app |
| AI layer | `@earendil-works/pi-ai` (npm) — provider SDK | `lib/agent.ts` — single TypeScript runtime for prompting, tools, providers, skills, compaction |
| Native bridge | None | Rust (`src-tauri/`) — fs, shell, PTY, HTTP proxy, preview server |
| State management | JSONL session files on disk | Zustand stores + localStorage metadata + per-session JSONL files in app data |
| Package structure | 5 packages: `pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `pi-orchestrator` | Monolithic: `lib/agent.ts` + `lib/agents.ts` |

**Betopia key point:** The Rust layer is intentionally thin. All agent logic, tool execution, and prompt construction run in TypeScript in the WebView. Rust only provides OS primitives (file I/O, shell commands, TCP probe, keychain).

---

## 2. Agent Loop

| Dimension | Pi | Betopia |
|---|---|---|
| Loop driver | `agentLoop()` — event-stream, async generator | `runAgent()` — `for (round = 0; round < 200; round++)` |
| Round cap | No hard cap (loops until no tool calls) | 200 rounds max |
| Streaming | `AssistantMessageEventStream` — decoupled transport from consumption | Direct JSON-parse of SSE stream chunks |
| Tool execution | Parallel by default; per-tool `executionMode` override | Parallel per model response; UI streams results as they finish, history commits in source order |
| Parallel tools | Yes — preflight sequential, execute concurrent, emit in source order | Yes — executes each tool-call batch concurrently, with same-file mutation serialization |
| Abort | `agent.abort()` on `Agent` wrapper | `AbortController` signal threaded through all calls |
| Mid-turn injection | `agent.steer()` — inject message during active turn | Not supported |
| Post-turn follow-up | `agent.followUp()` — queue after completion | Not supported |
| Model swap mid-run | `prepareNextTurn` callback — can change model per turn | Not supported; model fixed per session |

**Key difference:** both systems can run tool batches in parallel. Pi exposes a reusable package-level loop and per-tool execution modes; Betopia implements parallel execution inside the desktop runtime and serializes writes to the same file to avoid races.

---

## 3. Tool System

### Definition

| Dimension | Pi | Betopia |
|---|---|---|
| Schema | TypeBox (`Type.Object(...)`) — compile-time type safety | JSON Schema object literal in `BUILTIN_TOOLS` array |
| Tool interface | `AgentTool<TParameters>` — typed execute function | String dispatch in `executeBuiltinTool()` switch-like block |
| Tool factory pattern | `createReadTool(cwd, opts)`, `createBashTool(cwd, opts)` — composable factories | Single `executeBuiltinTool()` function handles all tools |
| File mutation queue | `withFileMutationQueue()` wrapper serializes concurrent writes | Per-round same-file lock serializes concurrent mutations to the same path |
| Result format | `{ content: (TextContent\|ImageContent)[], details: T, terminate?: boolean }` | Plain string returned to LLM |
| Streaming result | `onUpdate()` callback during execution | Not supported |

### Built-in Tools

| Tool | Pi | Betopia |
|---|---|---|
| Read file | `read` | `view_file`, `read_files`, `read_with_deps` |
| Write file | `write` | `write_file` |
| Edit file | `edit` (diff-based, multiple edits per call) | `edit` (single replace per call) |
| Shell command | `bash` | `bash` (+ background via `shell_bg_start`) |
| Grep | `grep` | `grep_search` |
| Find files | `find` | `list_files`, `list_dir` |
| List dir | `ls` | `list_dir`, `project_structure` |
| Subagent | — | `run_subagent` (inline, not separate process) |
| Background server | — | `bash` with `run_in_background: true` → `shell_bg_start` |
| MCP tools | — | Dynamic — loaded from configured MCP servers |

### Tool Restrictions (Betopia only)

Betopia enforces per-agent tool whitelists in code — not just via prompt:

```ts
const allowedSet = callbacks.agentAllowedTools ? new Set(callbacks.agentAllowedTools) : null
const allTools = [...BUILTIN_TOOLS, ...mcpTools].filter(t => !allowedSet || allowedSet.has(t.function.name))
```

Pi has no equivalent — any tool can be called by any prompt.

---

## 4. Multi-Agent & Specialization

| Dimension | Pi | Betopia |
|---|---|---|
| Built-in agents | None — single coding assistant persona | 6 built-in: Coder, Architect, Code Fixer, Code Reviewer, Security, Designer |
| Custom agents | Via system prompt / extensions | Via Settings UI — stored in `agentsStore` |
| Tool restrictions per agent | None | Yes — `allowedTools?: string[]` enforced at runtime |
| Subagents | No native support | `run_subagent` — spawns inline read-only agent (explore / code-review / security / general) |
| Orchestration | `pi-orchestrator` — experimental, spawns separate RPC processes | Removed — single Coder agent self-orchestrates via `run_subagents` / `run_subagent_chain` |
| Agent-to-agent comms | RPC over stdio (orchestrator only) | Shared conversation history + plan.md file as handoff |
| Persona conflict prevention | N/A | Persona injected FIRST in system prompt with "STRICT PRECEDENCE" header before base instructions |

**Key difference:** Betopia uses a single capable agent that self-orchestrates using `run_subagents` (parallel batch) and `run_subagent_chain` (sequential). Pi's orchestrator spawns real parallel processes but is marked experimental.

---

## 5. System Prompt & Persona Construction

| Dimension | Pi | Betopia |
|---|---|---|
| Construction order | Custom prompt OR default → guidelines → project files (AGENTS.md/CLAUDE.md) → skills → date/cwd | Config prefix → agent persona → `BASE_SYSTEM_PROMPT` → platform/MCP/permission guidance → project memory → skills → custom subagents → custom instructions → date/cwd |
| Project memory auto-load | `AGENTS.md` / `CLAUDE.md` from cwd and all parent directories | Primary `architecture.md` + `design.md`; fallback `BETOPIA.md`, `betopia.md`, `CLAUDE.md`, `AGENTS.md`, `.betopia/memory.md` |
| Skills system | Yes — `SKILL.md` files in `.pi/skills/` or custom paths, with YAML frontmatter, loaded into `<available_skills>` blocks | Yes — `.betopia/skills/` and `~/.betopia/skills/` markdown files with frontmatter, loaded into `<available_skills>` |
| Prompt templates | Yes — `.pi/prompts/` templates with variable substitution, callable via slash commands | No equivalent |
| Custom guidelines | `promptGuidelines` array appended to prompt | `customInstructions` string injected after `BASE_SYSTEM_PROMPT` |
| Tool list in prompt | Yes — tool names + one-line snippets in prompt | Yes — MCP tools listed; built-in tools described in `BASE_SYSTEM_PROMPT` |
| Thinking support | Yes — `thinkingLevel` param (off/minimal/low/medium/high/xhigh) per model | Yes — UI/model `effortLevel` maps to Anthropic `thinking_budget_tokens` or OpenAI `reasoning_effort` |

---

## 6. History & Context Management

| Dimension | Pi | Betopia |
|---|---|---|
| Storage format | JSONL files (`~/.pi/sessions/`) — persistent across restarts | Per-session JSONL files in Tauri app data; localStorage keeps metadata only |
| Max history | No hard cap; compaction triggers on token limit | `HISTORY_MAX_MESSAGES = 60` for request conversion, with compaction before the cap is hit |
| Compaction | Auto — summarize old messages into `compactionSummary` when context full | Auto — `compactHistory()` summarizes old messages into a `compaction` message and preserves a recent tail |
| Session branching | Yes — fork, branch, clone conversation tree | Yes — branch current session or branch from a selected message into a new JSONL-backed session |
| Resume interrupted | Yes — `agentLoopContinue()` resumes from saved state | Partial — detects interrupted last assistant message, prepends context note |
| Image support | Yes — `ImageContent` in tool results | Yes — base64 data URIs in `OAIContentBlock` |
| Custom message types | Yes — `bashExecution`, `compactionSummary`, `branchSummary`, `custom` (filtered before LLM call) | Yes — UI `MessagePart` variants include tool calls/results, reasoning, approvals, image URLs, and compaction summaries |

---

## 7. Process & Server Management

| Dimension | Pi | Betopia |
|---|---|---|
| Shell execution | `bash` tool → child_process in Node | `bash` tool → Rust `shell_run_command` via Tauri IPC |
| Background processes | No native support — bash tool exits when process ends | `shell_bg_start` (Rust) — tracks processes in `HashMap`, returns immediately |
| Process group isolation | N/A | `process_group(0)` on Unix — each bg process in own pgid so `kill -9 -- -pgid` kills full subtree |
| Server detection | N/A | Regex on command: `npm run dev`, `uvicorn`, `vite`, etc. → auto-routes to background |
| `--host` auto-injection | N/A | Auto-appends `--host 127.0.0.1` to Vite/npm dev commands on Linux (Node 18+ resolves `localhost` → `::1`) |
| Port probe | N/A | Rust `probe_port` — checks both `127.0.0.1` and `::1` via TCP connect (400ms timeout each) |
| Server readiness wait | N/A | Background async loop polls `probe_port` every 500ms (30s timeout) before firing `onServerStarted` |
| Preview server | N/A | Rust `server.rs` — embedded HTTP server for static/built projects |
| Cleanup on close | N/A | `cleanupWorkspace()`: `shell_bg_stop_all` → PID file → fuser sweep → Rust server stop |

---

## 8. Provider Support

| Provider | Pi | Betopia |
|---|---|---|
| Anthropic Claude | Yes | Yes (via Betopia AI proxy or direct) |
| OpenAI | Yes | Yes |
| Google Gemini | Yes | No |
| AWS Bedrock | Yes | No |
| Mistral | Yes | No |
| GitHub Copilot | Yes (OAuth) | No |
| Ollama | No (needs explicit config) | Yes — any OpenAI-compatible endpoint |
| Betopia AI | No | Yes (built-in, with streaming + tools fallback) |
| Custom OpenAI-compat | No | Yes |
| API key storage | `auth.json` in `~/.pi/` | OS keychain via Rust `secrets.rs` (keyring crate) |

---

## 9. Unique Features

### Pi only
- **Skills system** — `SKILL.md` files with frontmatter; loaded into prompt; agent can fetch full content on demand
- **Prompt templates** — stored in `.pi/prompts/`, variable substitution, slash-command callable
- **Session tree** — branch, fork, clone, navigate non-linear conversation history
- **Auto compaction** — summarizes old messages when context window fills (no data loss)
- **Thinking levels** — explicit `thinkingLevel` control per model (off → xhigh)
- **Extensions** — load TypeScript/JS modules; register tools, commands, hooks, UI widgets
- **Parallel tool execution** — multiple tools execute concurrently per round
- **Per-tool execution mode** — override parallel/sequential per tool
- **Model swap mid-run** — `prepareNextTurn` can change model between LLM calls in same run
- **Multiple output modes** — interactive TUI, print, RPC (JSON-RPC 2.0), JSON
- **TUI** — `pi-tui` with differential rendering, keybindings, themes
- **Session export to HTML** — with tool renderers per tool type

### Betopia only
- **Tauri native integration** — full OS access: PTY terminals, keychain, file system dialogs
- **Integrated preview server** — Rust HTTP server serves built/static projects in iframe
- **Multi-agent system** — 6 specialized agents with defined roles and handoff via plan.md; single Coder agent self-orchestrates via `run_subagents` / `run_subagent_chain`
- **Per-agent tool restrictions** — `allowedTools` enforced at runtime in code, not just prompt
- **Background server lifecycle** — start, track, probe, and kill long-running dev servers
- **IPv6/IPv4 port probing** — `probe_port` checks both addresses for Node 18+ compatibility
- **MCP server support** — stdio / SSE / HTTP / JSON-RPC MCP tools loaded dynamically
- **Inline subagents** — `run_subagent` runs a read-only nested agent within the same turn
- **Parallel tool batches** — multiple tool calls from one model response run concurrently, while same-file writes stay ordered
- **Project/user skills** — markdown skills from `.betopia/skills/` and `~/.betopia/skills/` are advertised and loaded on demand
- **Preview port detection** — parallel `Promise.all` probe of 8 ports (800ms max) to find existing dev server
- **Server readiness probe** — `onServerStarted` fires only after `probe_port` confirms the server is up
- **Approval system** — per-tool permission dialogs; user can approve/reject file writes or shell commands
- **Code history snapshots** — save/restore project file state before agent runs
- **Diff viewer** — inline Accept/Reject UI for agent file changes in chat
- **Error detection** — `scanAgentOutputForErrors()` parses agent text for runtime errors

---

## 10. Summary: Key Tradeoffs

| | Pi | Betopia |
|---|---|---|
| **Strength** | Robust agent loop: parallel tools, compaction, branching, skills, extensions | Deep OS integration: native preview, server lifecycle, tool approvals, Tauri |
| **Context management** | Compaction handles infinite sessions gracefully | Auto-compaction plus request-size sanitization; older raw turns still capped during conversion |
| **Tool execution** | Parallel — faster for multi-file tasks | Parallel batches with same-file mutation locks |
| **Multi-agent** | Experimental orchestrator via RPC | Single agent self-orchestrates via `run_subagents`; 6 specialist personas with tool restrictions |
| **Provider coverage** | Wide (7+ providers, OAuth) | Narrower (OpenAI-compat + Betopia AI) |
| **Extensibility** | High — TypeScript extension API, custom tools, hooks | Medium — MCP tools, skills, custom agents, and custom subagents; no general extension API |
| **Server management** | None | Full lifecycle: spawn, probe, kill, cleanup on close |
| **Session durability** | Persistent JSONL with branching | Persistent JSONL with branch sessions, plus metadata fallback |

---

*Updated: 2026-06-30. Comparing `/home/akash/projects/pi` (Pi agent framework) vs `/home/akash/projects/betopia-webbuilder/desktop/src/lib/` (Betopia embedded agent).*
