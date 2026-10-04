# Implementation Plan

Ordered execution plan for all remaining improvements. Each phase builds on the
previous one. Dependencies flow top-to-bottom.

---

## Phase 1 — Tool Operations Abstraction (P1)

**Goal:** Extract monolithic tool implementations behind swap-able operations
interfaces so backends can be swapped per-environment (local, sandboxed, remote,
test mock).

### Step 1.1 — Define operations interfaces

Create `desktop/src/lib/operations/`:

```
desktop/src/lib/operations/
├── types.ts              # Shared types across all operations
├── bash.ts               # BashOperations interface + default impl
├── write.ts              # WriteOperations interface + default impl
├── edit.ts               # EditOperations interface + default impl  
├── grep.ts               # GrepOperations interface + default impl
├── web-fetch.ts          # WebFetchOperations interface + default impl
├── file-read.ts          # FileReadOperations interface + default impl
└── index.ts              # OperationsProvider type + barrel export
```

Key types in `types.ts`:

```typescript
export interface OperationsProvider {
  bash: BashOperations
  write: WriteOperations
  edit: EditOperations
  grep: GrepOperations
  webFetch: WebFetchOperations
  fileRead: FileReadOperations
}

export class DefaultOperations implements OperationsProvider {
  // Each method delegates to the existing Tauri commands
}

export class SandboxOperations implements OperationsProvider {
  // Routes bash through Docker sandbox, filesystem through bind mount
}
```

### Step 1.2 — Plumb operations through agent loop

- Add `operations?: OperationsProvider` to `AgentCallbacks` in `agent-types.ts`
- In `agent.ts`, pass `operations` through to each tool call site
- `App.tsx` constructs the provider based on config (local vs sandbox) and passes it

Default behavior: if `operations` is not set, create `DefaultOperations` internally.

### Step 1.3 — Refactor `executeBuiltinTool` in `agent-tool-exec.ts`

Each tool case pulls from the provider instead of calling Tauri commands directly:

```typescript
// Before
if (name === 'bash') {
  const result = await invoke('shell_run_command', { ... })
  ...
}

// After
if (name === 'bash') {
  const result = await ops.bash.execute(command, opts)
  ...
}
```

### Step 1.4 — Add sandbox operations provider

- Wrap existing `sandbox/server.mjs` (Docker-based bash runner) behind `SandboxOperations`
- Add config toggle in `betopia_config.json`: `"sandbox": { "enabled": true, "timeout": 30000 }`

### Step 1.5 — Expose via plugin system

- Add `operations?: Partial<OperationsProvider>` to `PluginContributions`
- The plugin manager merges partial overrides into the active provider
- Plugin can override only `bash` while keeping default for everything else

**Files touched:** ~10 new files, ~6 modified files
**Risk:** Low — pure refactor, no behavior change until alternative provider is set
**Dependency:** None (can start immediately)

---

## Phase 2 — Permission Rule Engine (P1)

**Goal:** Replace the 4-mode permission system with a rule engine supporting
per-tool, per-path rules with saveable user preferences.

### Step 2.1 — Define rule types

Create `desktop/src/lib/permissions/rules.ts`:

```typescript
export type PermissionEffect = 'deny' | 'allow' | 'ask'

export interface PermissionRule {
  id: string
  action: string          // tool name or '*' for all
  resource?: string       // glob: '/path/**', 'http://**', or undefined for all
  effect: PermissionEffect
  savedAt?: number        // timestamp if user chose to save
}

export interface PermissionState {
  mode: 'default' | 'plan_mode' | 'auto_review' | 'full_access'
  rules: PermissionRule[]
  // mode still acts as top-level override:
  //   full_access → all rules evaluate to 'allow'
  //   auto_review → bash defaults to 'allow', edit/write still evaluate rules
}
```

### Step 2.2 — Implement rule evaluator

```typescript
// desktop/src/lib/permissions/evaluator.ts
export function evaluatePermission(
  action: string,
  resource: string | undefined,
  state: PermissionState,
): PermissionEffect {
  // 1. mode override
  if (state.mode === 'full_access') return 'allow'
  
  // 2. Find most specific matching rule (last match wins)
  const matching = state.rules.filter(r =>
    matchAction(r.action, action) &&
    (!r.resource || matchGlob(resource, r.resource))
  )
  if (matching.length > 0) return matching[matching.length - 1].effect

  // 3. Defaults based on mode
  if (state.mode === 'auto_review' && action === 'bash') return 'allow'
  return 'ask'
}
```

### Step 2.3 — Wire into agent loop

- Replace the scattered `if (!yoloMode && callbacks.onApprovalRequired && ...)` blocks with a single evaluator call
- `agent.ts` `executeTool`: one `evaluatePermission(action, resource, state)` → `'deny' | 'allow' | 'ask'`
  - `'deny'` → return blocked result immediately
  - `'allow'` → execute without prompt  
  - `'ask'` → create deferred approval request (existing flow)

### Step 2.4 — Persistence layer

- Store rules in `betopia_config.json` under `"permissionRules": [...]`
- When user clicks "Always allow" on an approval dialog, a new rule is added and persisted

### Step 2.5 — Settings UI

- Add a "Permissions" tab in the settings panel
- List of saved rules with enable/disable/delete
- Add-rule form: action dropdown, resource glob input, effect selector

**Files created:** `desktop/src/lib/permissions/rules.ts`, `desktop/src/lib/permissions/evaluator.ts`
**Files modified:** `agent-types.ts`, `agent.ts`, `config.ts`, `App.tsx`, `modules/settings/`
**Risk:** Medium — touches core approval flow, must handle migration from old modes
**Dependency:** Phase 1 (evaluator integrates with operations check)

---

## Phase 3 — Session Tree Versioning (P1)

**Goal:** Replace linear session model with an append-only tree supporting
branching, undo/redo, and fork-from-any-point.

### Step 3.1 — Define tree entry types

Add to `desktop/src/types.ts`:

```typescript
export interface SessionTreeNode {
  id: string
  parentId: string | null      // null for root
  sessionId: string             // all nodes sharing a sessionId form one tree
  timestamp: number
  kind: 'message' | 'model_change' | 'thinking_level_change'
      | 'active_tools_change' | 'compaction' | 'branch_summary' | 'label'
  // payload varies by kind — for 'message' it contains the Message
  data: unknown
}

export interface SessionTree {
  rootId: string
  activeLeafId: string
  nodes: Map<string, SessionTreeNode>
}
```

### Step 3.2 — Refactor persist.ts

- JSONL format: each line is a `SessionTreeNode` with `id` + `parentId`
- Append-only: new entries always append, never modify existing entries
- Branching: switching active message writes a new leaf with `parentId` pointing to the current leaf
- Load: reconstruct tree by reading all entries, build adjacency map, walk active path

### Step 3.3 — Refactor sessionStore

- Replace linear `messages[]` with `activePath: SessionTreeNode[]` (derived from tree)
- Add actions: `fork(fromNodeId)`, `undo()` (switch to parent), `redo()` (switch to child)
- Compaction: insert a `compaction` node with parentId linking to the last compacted node
- Session list shows branches with labels

### Step 3.4 — Session browser UI

- Tree visualization in the sessions panel (indented branches)
- Right-click → fork, label, delete branch
- Keyboard: `Ctrl+Z` undo (switch to parent), `Ctrl+Shift+Z` redo

**Side effect:** Also makes "undo" across compilation boundaries work naturally
(switch leaf pointer back).

**Files touched:** `types.ts`, `store/sessionStore.ts`, `lib/persist.ts`, `lib/agent-history.ts`, `modules/workspace/SessionBrowser.tsx`
**Risk:** High — touches persistence format, migration needed for existing `.betopia/sessions/` files
**Dependency:** Phase 2 (permission evaluator used in forked sessions)

---

## Phase 4 — Apply-Patch Tool (P2)

**Goal:** Add `apply_patch` tool that accepts unified diff format.

### Step 4.1 — Unified diff parser

Create `desktop/src/lib/patch-parser.ts`:

```typescript
export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  content: string[]   // lines with leading '+'/'-'/' '
}

export interface PatchFile {
  oldPath: string
  newPath: string
  hunks: PatchHunk[]
}

export function parseUnifiedDiff(diff: string): PatchFile[]
```

Parse algorithm: split on `^--- ` / `^+++ `, then `^@@ ` for hunks.

### Step 4.2 — Patch applier

```typescript
// In patch-parser.ts or separate apply.ts
export function applyPatch(content: string, hunks: PatchHunk[]): string
export function applyPatchToFile(path: string, hunks: PatchHunk[]): Promise<void>
```

- Each hunk: find the context lines in content, replace with new lines
- If context doesn't match → return `{ error: 'Hunk at line N failed to apply' }`

### Step 4.3 — Tool definition

Add to `BUILTIN_TOOLS` (or register via plugin system):

```typescript
{
  name: 'apply_patch',
  description: 'Apply a unified diff patch to the project. The model should use `git diff` or similar to generate patches.',
  parameters: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'Unified diff patch text' },
    },
    required: ['patch'],
  },
}
```

### Step 4.4 — Execution in agent-tool-exec.ts

```typescript
if (name === 'apply_patch') {
  const { patch } = args
  if (!patch || typeof patch !== 'string') return 'Error: patch required'
  const files = parseUnifiedDiff(patch)
  const results: string[] = []
  for (const file of files) {
    const targetPath = file.newPath || file.oldPath
    const content = await readProjectFile(projectPath, targetPath)
    const newContent = applyPatch(content, file.hunks)
    await writeProjectFile(projectPath, targetPath, newContent)
    results.push(`Applied patch to ${targetPath}`)
  }
  return results.join('\n')
}
```

### Step 4.5 — Diff preview UI

- When `apply_patch` is called, show a diff preview in the chat using existing `DiffViewer` component
- Parse the patch and render before/after for user approval

**Files created:** `lib/patch-parser.ts`, `lib/agent-tools/apply-patch.ts`
**Files modified:** `agent-tools.ts`, `agent-tool-exec.ts`, `modules/editor/DiffViewer.tsx`
**Risk:** Low — standalone tool, no refactoring needed
**Dependency:** None

---

## Phase 5 — Fine-Grained Streaming Events (P2)

**Goal:** Replace the single `onPartsUpdate` callback with a typed stream event
system (15+ events) separating live (delta) from durable (terminal) events.

### Step 5.1 — Define event types

Add to `desktop/src/lib/agent-types.ts`:

```typescript
export type StreamEvent =
  | { type: 'text_start'; index: number }
  | { type: 'text_delta'; index: number; delta: string }
  | { type: 'text_end'; index: number }
  | { type: 'reasoning_start'; index: number }
  | { type: 'reasoning_delta'; index: number; delta: string }
  | { type: 'reasoning_end'; index: number }
  | { type: 'tool_call_start'; index: number; name: string; id: string }
  | { type: 'tool_call_delta'; index: number; delta: string }
  | { type: 'tool_call_end'; index: number }
  | { type: 'tool_result'; index: number; toolCallId: string; result: ToolResult }
  | { type: 'step_start' }
  | { type: 'step_end'; finishReason: FinishReason }
  | { type: 'finish' }
  | { type: 'error'; error: AgentError }
```

### Step 5.2 — Event emitter

Create `desktop/src/lib/stream-events.ts`:

```typescript
export type StreamEventListener = (event: StreamEvent) => void

export class StreamEventEmitter {
  private liveListeners: Set<StreamEventListener> = new Set()
  private durableListeners: Set<StreamEventListener> = new Set()

  onLive(handler: StreamEventListener): () => void { ... }
  onDurable(handler: StreamEventListener): () => void { ... }
  emit(event: StreamEvent): void { ... }
}
```

### Step 5.3 — Integrate into agent.ts

- `streamChat()` yields raw chunks → convert to `StreamEvent`s and emit
- Delta events (`text_delta`, `tool_call_delta`) → live listeners only
- Terminal events (`text_end`, `tool_result`, `step_end`) → both live + durable
- The existing `parts` array is built from terminal events (same as current behavior)

### Step 5.4 — Wire into chat UI

- Chat panel subscribes to `onLive` for real-time rendering
- Session persistence subscribes to `onDurable` for history
- Plugin hook `onToolStream` receives live events (already exists)

### Step 5.5 — Update agent callbacks

- Keep `onPartsUpdate` as a backward-compatible shim that builds parts from terminal events
- Add `onStreamEvent` to `AgentCallbacks` for consumers that want raw events

**Files created:** `lib/stream-events.ts`
**Files modified:** `agent-types.ts`, `agent.ts`, `agent-history.ts`, `modules/chat/`, `App.tsx`
**Risk:** Medium — streaming is the hottest path in the agent loop; must be zero-overhead when unused
**Dependency:** Phase 4 (can be done in parallel)

---

## Phase 6 — System Context Epochs (P2)

**Goal:** Replace full system prompt rebuild with incremental context sources
that produce diffs, reducing token usage on turns where context hasn't changed.

### Step 6.1 — Define context source interface

```typescript
// desktop/src/lib/context/context-source.ts
export type ContextDiff =
  | { type: 'unchanged' }
  | { type: 'updated'; text: string }
  | { type: 'replace'; text: string }

export interface ContextSource<T> {
  key: string
  load(ctx: LoadContext): Promise<T>
  baseline(value: T): string
  reconcile(prev: T, curr: T): ContextDiff
}

export interface LoadContext {
  projectPath: string | null
  agentId: string | null
}
```

### Step 6.2 — Implement individual sources

```
desktop/src/lib/context/sources/
├── project-memory.ts      # BETOPIA.md / CLAUDE.md / AGENTS.md
├── skills.ts              # .betopia/skills/ directory
├── active-agent.ts        # Agent persona + prompt
├── mcp.ts                 # MCP server descriptions
├── custom-instructions.ts # User custom instructions
└── date.ts                # Current date/time
```

Each source:
- `load()`: reads from filesystem or store
- `baseline()`: formats the value as prompt text
- `reconcile()`: string comparison — unchanged/updated/replace

### Step 6.3 — Epoch manager

```typescript
// desktop/src/lib/context/context-epoch.ts
export class ContextEpoch {
  private sources: ContextSource<unknown>[]
  private previous = new Map<string, unknown>()

  async build(ctx: LoadContext): Promise<string> {
    const parts: string[] = []
    for (const source of this.sources) {
      const value = await source.load(ctx)
      const prev = this.previous.get(source.key)
      if (!prev) {
        parts.push(source.baseline(value))
      } else {
        const diff = source.reconcile(prev, value)
        if (diff.type !== 'unchanged') parts.push(diff.text)
      }
      this.previous.set(source.key, value)
    }
    return parts.join('\n\n')
  }

  reset(): void {
    this.previous.clear()
  }
}
```

### Step 6.4 — Integrate into agent.ts

- Replace `buildSystemPrompt()` call with `epoch.build(ctx)`
- Cached in agent loop, rebuilt only when sources change
- On session switch or agent switch, call `epoch.reset()` to force full rebuild

### Step 6.5 — Wire compaction

- Compaction stores the current epoch state snapshot
- On restore, `epoch.previous` is pre-populated so first turn regenerates everything

**Files created:** `lib/context/context-source.ts`, `lib/context/context-epoch.ts`, `lib/context/sources/*.ts`
**Files modified:** `agent-prompts.ts`, `agent.ts`, `agent-history.ts`
**Risk:** Medium — changes the hottest path in the system prompt builder
**Dependency:** Phase 3 (compaction integration requires session tree)

---

## Phase 7 — Agent Switching Mid-Session (P3)

**Goal:** Allow changing the active agent mid-conversation without resetting
history.

### Step 7.1 — Switch event type

Add to session history types:

```typescript
// types.ts
export interface AgentSwitchEntry {
  type: 'agent_switch'
  fromAgentId: string
  toAgentId: string
  timestamp: number
}
```

### Step 7.2 — Store action

- `agentsStore`: add `switchAgentInSession(agentId: string)` action
- Writes an `agent_switch` entry to session history
- Sets `activeAgentId` on the store

### Step 7.3 — Agent loop handles switch

In `agent.ts`, at the start of each round:
- Check if `activeAgentId` changed since last round
- If yes: inject a synthetic assistant message explaining the switch, reset system prompt

### Step 7.4 — UI indicator

- Chat timeline shows an "Agent switched: Coder → Reviewer" badge
- Agent selector dropdown is always visible (not just at session start)

**Files modified:** `store/agentsStore.ts`, `lib/agent-prompts.ts`, `lib/agent-history.ts`, `modules/chat/`
**Risk:** Low — straightforward addition, no refactoring
**Dependency:** Phase 3 (session tree provides the branching model for switch entries)

---

## Phase 8 — Tool Output Bounding (P3)

**Goal:** Store full tool outputs on disk when they exceed a threshold, keep only
truncated versions in memory.

### Step 8.1 — Output store

```typescript
// desktop/src/lib/tool-output-store.ts
export class ToolOutputStore {
  private baseDir: string

  async store(sessionId: string, callId: string, output: string): Promise<string>
  async retrieve(sessionId: string, callId: string): Promise<string | null>
  async cleanUp(olderThan: number): Promise<void>
}
```

Files stored at `appDataDir/tool-outputs/<sessionId>/<callId>.json`.

### Step 8.2 — Integrate into agent.ts

In `executeTool`, after result is produced:
- If result length > 4000 chars:
  1. Store full result via `ToolOutputStore.store()`
  2. Truncate in-memory result to 4000 chars + `\n…[truncated, see .betopia/tool-outputs/<id>]`
  3. The reference path is included so the model can call `read_files` to retrieve it

### Step 8.3 — Cleanup cron

- Run cleanup on app start and every hour
- Delete outputs older than 7 days (configurable)

**Files created:** `lib/tool-output-store.ts`
**Files modified:** `agent.ts`, `persist.ts`
**Risk:** Low
**Dependency:** None (can start immediately)

---

## Phase 9 — Question Tool (P3)

**Goal:** Let the agent ask the user questions mid-execution (beyond just permission
approvals).

### Step 9.1 — Tool definition

```typescript
{
  name: 'question',
  description: 'Ask the user a question to clarify intent or gather information. Use when the task is ambiguous.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional answer choices' },
    },
    required: ['question'],
  },
}
```

### Step 9.2 — Deferred execution pattern

```typescript
// In agent.ts executeTool:
if (name === 'question') {
  const { question, options } = args
  const answer = await new Promise<string>((resolve) => {
    // Show question in chat UI with optional answer buttons
    // Store resolver so chat component can call it on user response
    pendingQuestion = { question, options, resolve, timestamp: Date.now() }
    pushPart({ type: 'question', data: { question, options } })
    immediateFlush()
  })
  return `User answered: ${answer}`
}
```

### Step 9.3 — Chat UI component

- `ChatPanel` or inline component renders question bubble with text + buttons
- On click, calls `pendingQuestion.resolve(selectedAnswer)` and removes the question UI
- User can also type a free-form answer in the input

### Step 9.4 — Timeout

- If user doesn't answer within 5 minutes, resolve with empty string and return "User did not respond"

**Files created:** `lib/agent-tools/question.ts`
**Files modified:** `agent-tools.ts`, `agent.ts`, `modules/chat/`
**Risk:** Low
**Dependency:** Phase 2 (question tool needs permission rule)

---

## Summary

| Phase | Item | Est. Effort | Key Risk | Depends On |
|---|---|---|---|---|
| 1 | Tool Operations Abstraction | Medium | Pure refactor, no behavior change | — |
| 2 | Permission Rule Engine | Medium | Core approval flow changes | Phase 1 |
| 3 | Session Tree Versioning | High | Persistence migration needed | Phase 2 |
| 4 | Apply-Patch Tool | Low | Standalone | — |
| 5 | Fine-Grained Streaming Events | Medium | Hot path must be zero-overhead | — |
| 6 | System Context Epochs | High | Changes system prompt builder | Phase 3 |
| 7 | Agent Switching Mid-Session | Medium | Straightforward addition | Phase 3 |
| 8 | Tool Output Bounding | Low | Standalone | — |
| 9 | Question Tool | Low | Deferred promise pattern | Phase 2 |

**Recommended order:** Phase 1 → Phase 4 → Phase 5 → Phase 2 → Phase 8 → Phase 9 → Phase 3 → Phase 6 → Phase 7

This runs the standalone items (1, 4, 5, 8) first for quick wins, then the
permission system (2, 9) which feeds into the session tree (3, 6, 7).
