# Betopia Improvement Plan

Comparative analysis of Betopia vs Pi vs OpenCode — identifying gaps and
prioritizing improvements to the agent system, tool calling, and architecture.

## Overview

| Dimension | Betopia | Pi | OpenCode |
|---|---|---|---|
| Language | TypeScript + Rust | TypeScript | TypeScript (Effect) |
| Agent loop | Custom, 200 rounds | Three-layer loop | Effect-based, event-sourced |
| Built-in tools | 22 | 6 | 12 |
| Subagents | 6 built-in + custom + repo import | None | None (skill-based) |
| MCP | stdio/HTTP/SSE, presets | None | stdio/SSE/HTTP, OAuth |
| Providers | OpenAI-compatible only | 30+ | 20+ |
| Permissions | 4 modes, tool-level gates | Project trust, hooks | 3-tier deny/allow/ask |
| Context mgmt | Auto-compaction, trimming, capping | Iterative compaction, token estimation | Epoch-based, incremental diffs |
| Plugin system | None | Key-based | Scope-based |
| Session model | Linear with branching | Append-only tree | Event-sourced SQLite |
| Streaming | Custom parts-based | EventStream pattern | 15+ fine-grained events |
| Tool rendering | React components | TUI renderCall/renderResult | Text-based |

---

## Priority Matrix

| Area | Impact | Effort | Priority |
|---|---|---|---|
| Extension/plugin system | High | High | P0 |
| Tool operations abstraction | High | Medium | P1 |
| Session tree versioning | Medium | High | P1 |
| Permission rule engine | High | Medium | P1 |
| Apply-patch tool | Medium | Low | P2 |
| Fine-grained streaming events | Medium | Medium | P2 |
| System context epochs | Medium | High | P2 |
| Tool output bounding | Low | Low | P3 |
| Question tool | Low | Low | P3 |
| Agent switching mid-session | Medium | Medium | P3 |

---

## P0 — Critical

### 1. Extension / Plugin System ✓

**Inspiration:** Pi (full lifecycle hooks, pluggable tool operations, theme
hooks), OpenCode (scope-based registration, Effect layers).

**Current state:** Betopia has no extension mechanism. All tools, agents,
subagents, providers, MCP servers, and skills are hardcoded or config-driven
but never programmatically extensible. The only extensibility is:
- Custom agents via `agentsStore` (config, not code)
- Custom subagents via settings (config, not code)
- MCP servers via config (dynamic, but limited to tool exposure)

There is no way for third-party code to:
- Add a new tool with custom logic
- Register a new AI provider
- Contribute React UI components into panels
- Hook into the agent lifecycle
- Register Tauri commands

---

#### Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                        Plugin Manager                              │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Loader  │  │ Registry │  │ Scope    │  │ Hook Dispatcher   │  │
│  │ (npm /  │  │ (tools,  │  │ Manager  │  │ (agent loop       │  │
│  │  config)│  │  agents, │  │ (cleanup)│  │  integration)     │  │
│  └─────────┘  │  UI...)  │  └──────────┘  └───────────────────┘  │
│               └──────────┘                                         │
└────────────────────────────────────────────────────────────────────┘
         │                  │                   │
         ▼                  ▼                   ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐
│ Agent Loop   │  │ React UI     │  │ Tauri Backend        │
│ (hooks,      │  │ (panels,     │  │ (Rust commands,      │
│  tools)      │  │  components) │  │  fs/shell/net hooks) │
└──────────────┘  └──────────────┘  └──────────────────────┘
```

---

#### Plugin Interface (Full)

```typescript
interface BetopiaPlugin {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  license?: string

  // ── Lifecycle ──────────────────────────────────────────────────
  onActivate?: (ctx: PluginActivationContext) => PluginLifecycle | Promise<PluginLifecycle>
  onDeactivate?: (ctx: PluginDeactivationContext) => void | Promise<void>

  // ── Declarative Contributions ─────────────────────────────────
  contributions?: PluginContributions

  // ── Configuration Schema ──────────────────────────────────────
  // JSON Schema for plugin-specific settings, rendered in Settings UI
  configSchema?: Record<string, unknown>
  defaultConfig?: Record<string, unknown>
}
```

#### Lifecycle Return Value

```typescript
interface PluginLifecycle {
  // Dynamic subscriptions — cleaned up automatically on deactivation.
  // These are the runtime incarnation of the plugin after activation.
  // The plugin receives native APIs it can subscribe to.

  hooks?: {
    beforeToolCall?: (toolCall: ToolCall, ctx: HookContext) => Promise<ToolCall | null | BlockedToolCall>
    afterToolCall?: (result: ToolResult, ctx: HookContext) => Promise<ToolResult>
    transformContext?: (messages: Message[], ctx: HookContext) => Promise<Message[]>
    onToolStream?: (event: StreamEvent, ctx: HookContext) => void
    onSessionEvent?: (event: SessionEvent) => void
    onFileChange?: (change: FileChangeEvent) => void
  }

  // Unsubscription functions (alternative to returning hooks)
  // Allows plugins to subscribe to stores, event emitters, etc.
  teardown?: Array<() => void>
}
```

#### Declarative Contributions

```typescript
interface PluginContributions {
  // ── Agent System ──────────────────────────────────────────────
  tools?: ToolDefinition[]
  agents?: AgentDefinition[]
  subagents?: SubagentDefinition[]
  providers?: ProviderDefinition[]
  mcpServers?: MCPServerConfig[]

  // ── UI ────────────────────────────────────────────────────────
  panels?: PanelDefinition[]
  components?: ComponentDefinition[]
  commands?: SlashCommand[]
  keybindings?: Keybinding[]
  themes?: ThemeDefinition[]
  contextMenuItems?: ContextMenuItem[]

  // ── Skills & Prompts ──────────────────────────────────────────
  skills?: SkillDefinition[]
  customInstructions?: string

  // ── Tauri ─────────────────────────────────────────────────────
  // Plugin can declare Tauri commands it needs.
  // The manager registers capabilities automatically.
  tauriCommands?: {
    invoke: string[]     // commands this plugin invokes
    provide: string[]    // commands this plugin provides (Rust side)
  }
}
```

**Tool name collision:** Plugin tools are prefixed `${pluginId}__${toolName}`.
The AgentLoop transparently strips the prefix when calling the tool. Plugins
can also opt into the global namespace by explicitly setting
`globalName: true`.

---

#### PluginActivationContext

The context passed to `onActivate` — the plugin's API surface:

```typescript
interface PluginActivationContext {
  // ── Identity ──────────────────────────────────────────────────
  id: string
  config: Record<string, unknown>       // Merged default + user config
  dataDir: string                       // appDataDir/plugins/<id>/

  // ── Tool Registration ─────────────────────────────────────────
  registerTool: (tool: ToolDefinition) => void
  unregisterTool: (name: string) => void

  // ── Hook Registration ─────────────────────────────────────────
  onBeforeToolCall: (handler: BeforeToolCallHandler) => () => void
  onAfterToolCall: (handler: AfterToolCallHandler) => () => void
  onTransformContext: (handler: ContextTransformer) => () => void
  onToolStream: (handler: StreamHandler) => () => void
  onSessionEvent: (handler: SessionEventHandler) => () => void
  onFileChange: (handler: FileChangeHandler) => () => void

  // ── UI Registration ───────────────────────────────────────────
  registerPanel: (panel: PanelDefinition) => () => void
  registerCommand: (cmd: SlashCommand) => () => void
  registerKeybinding: (kb: Keybinding) => () => void
  registerTheme: (theme: ThemeDefinition) => () => void

  // ── Store Access (read-only + subscribe) ──────────────────────
  stores: {
    chat: {
      getMessages: () => Message[]
      subscribe: (listener: () => void) => () => void
      sendMessage: (text: string) => void
    }
    session: {
      getActiveSession: () => Session | null
      getSessions: () => Session[]
    }
    app: {
      getConfig: () => AgentConfig
      getPermissionMode: () => PermissionMode
    }
  }

  // ── Tauri Bridge ──────────────────────────────────────────────
  tauri: {
    invoke: typeof import('@tauri-apps/api/core').invoke
    listen: typeof import('@tauri-apps/api/event').listen
  }

  // ── Filesystem (scoped to plugin data dir) ────────────────────
  fs: {
    readFile: (path: string) => Promise<string>
    writeFile: (path: string, content: string) => Promise<void>
    listDir: (path: string) => Promise<string[]>
    deleteFile: (path: string) => Promise<void>
  }

  // ── Logging ───────────────────────────────────────────────────
  log: {
    info: (msg: string, ...args: unknown[]) => void
    warn: (msg: string, ...args: unknown[]) => void
    error: (msg: string, ...args: unknown[]) => void
  }

  // ── Network ───────────────────────────────────────────────────
  fetch: typeof globalThis.fetch

  // ── Plugin-to-Plugin Communication ────────────────────────────
  pubsub: {
    publish: (channel: string, data: unknown) => void
    subscribe: (channel: string, handler: (data: unknown) => void) => () => void
  }
}
```

---

#### Plugin Kinds & Loading

```
Plugin
├── Built-in (bundled)
│   ├── desktop/src/plugins/<id>/index.ts
│   └── Registered at app startup, can't be disabled
│
├── Local (project or user directory)
│   ├── .betopia/plugins/<id>/
│   │   ├── index.ts (or .js)
│   │   └── package.json (optional, for metadata)
│   └── Loaded from project or ~/.betopia/plugins/
│
├── npm package (config-declared)
│   ├── betopia_config.json declares { "plugins": ["npm:betopia-plugin-xyz"] }
│   ├── Loaded via dynamic import() from node_modules
│   └── Version pinned in config
│
└── MCP-derived (future)
    └── MCP servers that expose plugin-like capabilities
```

**Load order (ascending priority, later overrides earlier):**
1. Built-in plugins
2. Global plugins (`~/.betopia/plugins/`)
3. Project plugins (`.betopia/plugins/`)
4. Npm plugins declared in config

---

#### Scope-Based Cleanup

Every plugin activation creates a `Scope`:

```typescript
class PluginScope {
  private cleanup: Array<() => void> = []

  add(disposer: () => void): void {
    this.cleanup.push(disposer)
  }

  dispose(): void {
    // Run in reverse registration order
    for (const dispose of this.cleanup.reverse()) {
      dispose()
    }
    this.cleanup.length = 0
  }
}
```

Each `registerTool()`, `registerPanel()`, `onBeforeToolCall()`, etc. returns a
disposer function that removes the registration. The scope collects these and
runs them all on deactivation.

**Hot-reload flow:**
1. User changes plugin config or file
2. Manager calls `scope.dispose()` on old scope
3. Manager calls `plugin.onDeactivate()`
4. Manager re-imports plugin module (clears require cache)
5. Manager creates new scope
6. Manager calls `plugin.onActivate(ctx)` with fresh scope
7. New scope collects new disposers

---

#### Hook Integration into Agent Loop

```typescript
// In agent.ts, around tool execution:

// Before any tool runs
for (const handler of hookRegistry.getBeforeToolCall()) {
  const result = await handler(toolCall, hookContext)
  if (result === null) {
    // Blocked — plugin vetoed the tool call
    return { type: 'blocked', reason: `Blocked by plugin ${handler.pluginId}` }
  }
  toolCall = result  // Plugin may have modified it
}

// After tool completes
for (const handler of hookRegistry.getAfterToolCall()) {
  result = await handler(result, hookContext)
  // Plugin may have modified result, flipped error, or terminated loop
}

// Context transformation before each LLM call
for (const handler of hookRegistry.getTransformContext()) {
  messages = await handler(messages, hookContext)
}
```

---

#### UI Panel Contribution

Plugins can contribute React panels into the main workspace:

```typescript
interface PanelDefinition {
  id: string
  title: string
  icon?: React.ComponentType<{ size?: number }>
  area: 'sidebar' | 'bottom' | 'modal' | 'tab'    // Where in the layout
  defaultOpen?: boolean
  component: React.LazyExoticComponent<React.ComponentType<PanelProps>>
  // ✗ Loaded via React.lazy() — bundled separately, fetched on demand
}

interface PanelProps {
  pluginId: string
  config: Record<string, unknown>
  theme: 'dark' | 'light'
  workspace: WorkspaceAPI
}
```

**Implementation:**
- Plugin panels are registered into a `panelStore` (Zustand)
- The workspace layout renders registered panels dynamically
- Panels are lazy-loaded (`React.lazy()` + `Suspense`)
- Plugin panel bundles are served from `appDataDir/plugins/<id>/ui/`
  or loaded as virtual modules via Vite's plugin system

**Workspace layout integration:**

```typescript
// store/panelStore.ts
interface PanelStore {
  panels: Map<string, PanelDefinition>
  openPanels: Set<string>
  registerPanel: (def: PanelDefinition) => () => void
  togglePanel: (id: string) => void
}
```

---

#### Tauri Command Contribution (Rust Side)

Plugins can provide Rust-side Tauri commands that are registered at runtime:

```rust
// In plugins.rs or as a shared library loaded via dlopen

#[tauri::command]
fn my_plugin_command(app: tauri::AppHandle, input: String) -> Result<String, String> {
    // ...
}
```

**Implementation approach:**
- Phase 1: Plugins define only TypeScript tools + hooks. Rust commands are
  statically compiled (core set). Plugin tools invoke existing Tauri commands.
- Phase 2: Dynamic command registration via Tauri's `invoke_handler`
  extension mechanism. Plugin-provided Rust code compiles as shared
  libraries or WASM plugins.
- Phase 3: Plugins can define their own Tauri commands in a sandboxed
  WASM runtime (wasmtime/wasi).

**Recommended: Start with Phase 1.** The TypeScript API surface is sufficient
for 90% of plugin use cases. Tauri bridge is already available via
`context.tauri.invoke()`.

---

#### Plugin Configuration in betopia_config.json

```json
{
  "plugins": [
    {
      "id": "npm:betopia-plugin-figma",
      "version": "^1.0.0",
      "enabled": true,
      "config": {
        "personalAccessToken": ""
      }
    },
    {
      "id": "local:my-project-helper",
      "enabled": true,
      "source": ".betopia/plugins/my-project-helper"
    }
  ]
}
```

#### Built-in Plugin Examples (for reference)

**`@betopia/plugin-figma`** (replacing MCP Figma preset):
- Contributions: custom tool `figma_get_design`, panel for Figma design preview
- Hook: `onToolStream` to annotate Figma references in model output
- Config: personal access token, team ID

**`@betopia/plugin-terminal`** (replacing hardcoded terminal):
- Contributions: panel for embedded terminal
- Commands: `/terminal`, `/clear`
- No agent hooks (independent UI)

**`@betopia/plugin-code-sandbox`** (replacing sandbox/server.mjs):
- Contributions: `BashOperations` override (sandboxed execution)
- Hook: `beforeToolCall` to route bash commands through Docker sandbox
- Config: image, CPU, memory, timeout

---

#### Security & Sandboxing

```
┌──────────────────────────────────────────┐
│            Plugin Manager                 │
│  ┌────────────────────────────────────┐   │
│  │          Permission Check           │   │
│  │  ┌─────────┐  ┌───────────────┐   │   │
│  │  │Declared  │  │  Runtime      │   │   │
│  │  │Perms     │→│  Enforcer    │   │   │
│  │  │(manifest)│  │  (hook)      │   │   │
│  │  └─────────┘  └───────────────┘   │   │
│  └────────────────────────────────────┘   │
└──────────────────────────────────────────┘
```

- Each plugin declares permissions in its manifest
- The hook dispatcher enforces permission boundaries at runtime
- Tool/hook execution is wrapped in try/catch — plugin errors never crash
  the agent loop
- File system access is scoped to `dataDir` unless explicitly permitted
- Network access requires `network` permission
- UI components render in an isolated DOM subtree (future: Shadow DOM)
- Sensitive data (API keys, tokens) is never passed to plugin context

**Permission manifest example:**

```typescript
const MyPlugin: BetopiaPlugin = {
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',
  permissions: {
    network: {
      origins: ['https://api.github.com/*', 'https://raw.githubusercontent.com/*']
    },
    filesystem: {
      read: ['project:/src/**', 'project:/public/**'],
      write: ['project:/src/generated/**']
    },
    shell: false,          // No shell access
    userMessages: true,    // Can send messages to chat
  },
  // ...
}
```

---

#### Migration Strategy

**Phase 1 — Internal tools → Plugins (2-3 weeks)**

1. Define the `BetopiaPlugin` interface and `PluginManager`
2. Internally refactor all built-in tools as a built-in `@betopia/plugin-core`
   plugin
3. Implement the hook system in the agent loop
4. Write tests with mock plugins

**Phase 2 — UI extension (1-2 weeks)**

1. Add `PanelDefinition` support to workspace layout
2. Create `panelStore` for dynamic panel management
3. Port the terminal and settings panels to plugin system
4. Add lazy-loading infrastructure

**Phase 3 — External plugins (2-3 weeks)**

1. Implement npm package loader (dynamic `import()`)
2. Implement local file loader (dynamic `import()` from project dir)
3. Add plugin settings UI in settings panel
4. Add plugin marketplace/discovery (future)

**Phase 4 — Rust/WASM (future)**

1. WASM runtime for sandboxed plugin execution
2. Dynamic Tauri command registration
3. Plugin SDK with TypeScript types

---

#### Files to create

```
desktop/src/lib/plugin/
├── plugin-api.ts          # BetopiaPlugin, PluginContributions, etc.
├── plugin-manager.ts      # Lifecycle management, load/unload/reload
├── plugin-scope.ts        # Scope-based cleanup
├── plugin-registry.ts     # Registry for tools, hooks, panels, etc.
├── plugin-loader.ts       # Load plugins from npm / local / built-in
├── plugin-context.ts      # PluginActivationContext factory
├── plugin-permissions.ts  # Permission declaration + runtime check
├── hooks.ts               # Hook registry + dispatcher
├── stores.ts              # Zustand stores for plugin state + panels
└── errors.ts              # Typed plugin errors
```

#### Files to touch

| File | Change |
|---|---|
| `desktop/src/lib/agent.ts` | Inject hook dispatcher calls (before/after tool call, context transform) |
| `desktop/src/lib/agent-tools.ts` | Register tools via plugin system, fall back to hardcoded if no plugins loaded |
| `desktop/src/lib/agent-prompts.ts` | Allow plugins to inject prompt segments |
| `desktop/src/lib/agent-tool-exec.ts` | Use plugin-registered operations providers |
| `desktop/src/lib/config.ts` | Plugin configuration schema + loading |
| `desktop/src/store/appStore.ts` | Plugin state, panel state, enabled/disabled |
| `desktop/src/App.tsx` | Initialize plugin manager on startup |
| `desktop/src/modules/workspace/` | Dynamic panel rendering from panel registry |
| `desktop/src/modules/settings/` | Plugin list UI, enable/disable, per-plugin config |
| `desktop/src-tauri/Cargo.toml` | (Phase 4) WASM runtime dependency |
| `desktop/vite.config.ts` | (Phase 3) Virtual module resolution for local plugins |

---

#### Key Decisions & Rationale

| Decision | Rationale |
|---|---|
| **Functional hooks over EventEmitter** | Each hook is a typed function with clear return contract. Chain-of-responsibility pattern allows plugins to block/modify/pass through. |
| **Scope-based cleanup** | Ensures no stale subscriptions, tools, or UI components remain after plugin deactivation. Prevents memory leaks. |
| **Separate `onActivate` return vs `contributions`** | Declarative `contributions` are registered automatically by the manager. The `onActivate` return value is for dynamic, runtime-only subscriptions. Simplifies simple plugins while enabling complex ones. |
| **Prefixed tool names** | Avoids name collisions between plugins and between plugins and built-in tools. Transparent to the model. |
| **Plugin data directory** | Each plugin gets an isolated `appDataDir/plugins/<id>/` for storing state, caches, and UI bundles. No cross-plugin file access. |
| **React.lazy for panel loading** | Plugin UI bundles are loaded on demand, not at app startup. Keeps the main bundle size small. |
| **Phase 1 TypeScript-only** | TypeScript plugins have full access to the Betopia API surface. Rust/WASM is a future optimization for performance-sensitive plugins. |
| **Config schema per plugin** | Each plugin defines its own JSON Schema for configuration. The settings UI renders a generic form from the schema. No per-plugin UI needed. |
| **Plugin-to-plugin pubsub** | Enables cross-plugin communication without tight coupling. The Figma plugin can publish "design updated", the preview plugin subscribes and refreshes. |

---

## P1 — High Priority

### 3. Tool Operations Abstraction

**Inspiration:** Pi's pluggable operations pattern.

**Current state:** Betopia's tool implementations are monolithic. `bash` always
runs locally, `write_file` always writes to the local filesystem. There is no
way to swap implementations for remote execution, sandboxing, or testing.

**Improvement:**

Extract operations interfaces for each tool:

```typescript
interface BashOperations {
  execute(command: string, opts: { timeout?: number; cwd?: string; env?: Record<string,string>; signal?: AbortSignal }): AsyncIterable<{ type: 'stdout' | 'stderr'; text: string }>
}

interface WriteOperations {
  write(path: string, content: string): Promise<void>
  mkdir(dir: string): Promise<void>
}

interface EditOperations {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  applyEdits(path: string, edits: EditOperation[]): Promise<EditResult>
}

interface GrepOperations {
  search(pattern: string, opts: { path?: string; glob?: string; ignoreCase?: boolean; context?: number }): Promise<GrepMatch[]>
}
```

Default implementations use Tauri commands (local filesystem/shell). Alternative
implementations can be registered:
- **Docker sandbox** (existing `sandbox/server.mjs`)
- **SSH remote** (via `ssh` + `rsync`)
- **Virtual in-memory** (for testing)
- **Plugin-provided** (for custom backends)

**Key benefit:** Separating operations from tool logic makes testing trivial
(mock operations), enables sandboxing by default, and allows plugins to provide
custom execution environments.

**Files to touch:**
- `desktop/src/lib/agent-tools.ts` — refactor each tool to use operations
  interfaces
- `desktop/src/lib/agent-tool-exec.ts` — inject operations via config/context
- `desktop/src/lib/config.ts` — operations provider configuration

---

### 4. Permission Rule Engine

**Inspiration:** OpenCode's three-tier permission model with wildcard matching
and deferred approval.

**Current state:** Betopia has 4 coarse permission modes (default, plan_mode,
auto_review, full_access). There's no per-tool, per-path, or per-project
permission granularity. Users can't "always allow" specific operations.

**Improvement:**

Replace the 4-mode system with a rule engine:

```typescript
type PermissionEffect = 'deny' | 'allow' | 'ask'

interface PermissionRule {
  action: string          // 'edit' | 'bash' | 'write_file' | 'delete_file' | 'web_fetch' | ...
  resource?: string       // glob pattern: '/path/to/**', 'http://**'
  effect: PermissionEffect
  save?: boolean          // persist as user preference
}

interface PermissionState {
  rules: PermissionRule[]
  mode: 'default' | 'plan_mode' | 'auto_review' | 'full_access'
  // mode still acts as a top-level override:
  //   full_access → all rules default to 'allow'
  //   auto_review → bash_rules default to 'allow', edit/write still evaluate
  //   plan_mode   → no special override, but planning prompt is injected
  //   default     → all rules evaluate normally
}
```

**Rule evaluation (OpenCode-inspired):**
```
configuredRules + savedRules + modeOverride
  → evaluate(action, resource)
  → findLast matching rule → 'deny' | 'allow' | 'ask'
```

- Rules are checked in priority order (most specific first)
- `'deny'` blocks immediately without user prompt
- `'allow'` proceeds without approval
- `'ask'` creates a deferred permission request (non-blocking)
- Users can save decisions as persistent rules
- Saved rules auto-approve other pending requests matching the pattern

**File-level permissions (OpenCode-inspired):**
- `external_directory` permission for reads/writes outside project root
- `network` permission for web fetch and HTTP MCP tools

**Files to touch:**
- `desktop/src/lib/agent-types.ts` — add permission types
- `desktop/src/lib/agent.ts` — integrate permission engine into tool execution
- `desktop/src/store/appStore.ts` — extend with rules state
- `desktop/src/lib/config.ts` — persist rules
- `desktop/src/modules/settings/` — permission rule UI

---

### 5. Session Tree Versioning

**Inspiration:** Pi's append-only session tree with branching and compaction
summaries.

**Current state:** Betopia has linear sessions with experimental branching. The
JSONL format is simple but there's no session tree navigation, no undo/redo, no
fork from arbitrary history points.

**Improvement:**

Adopt Pi's session tree model:

- **Append-only JSONL** — entries have `id`, `parentId`, `timestamp`
- **Branching** — changing the active leaf creates a new branch without rewriting history
- **Entry types**: `message`, `model_change`, `thinking_level_change`,
  `active_tools_change`, `compaction`, `branch_summary`, `label`
- **Context reconstruction**: Walk path from leaf to root, applying model/tool
  changes inline, injecting compaction summaries and branch summaries
- **Session operations**: create, open, resume, fork (from any entry), clone

**Benefits:**
- True undo/redo (switch leaf pointer)
- Forking for experimentation without data loss
- Cleaner compaction integration (summaries are entries in the tree)
- Session diffs for sharing and debugging

**Files to touch:**
- `desktop/src/store/sessionStore.ts` — refactor for tree model
- `desktop/src/lib/persist.ts` — update JSONL format
- `desktop/src/lib/agent-history.ts` — update compaction for tree context
- `desktop/src/modules/workspace/` — session browser UI

---

## P2 — Medium Priority

### 6. Apply-Patch Tool

**Inspiration:** OpenCode's `apply_patch` tool — unified diff-based patching.

**Current state:** Betopia only has `edit` (exact-text replacement) and
`write_file`. The `edit` tool uses the same multi-edit applier as preview, but
there's no way to apply a full unified diff patch.

**Improvement:**

Add an `apply_patch` tool that accepts unified diff format:

```typescript
tool({
  name: 'apply_patch',
  description: 'Apply a unified diff patch to the project',
  parameters: {
    patch: { type: 'string', description: 'Unified diff patch text' }
  },
  execute: async ({ patch }) => {
    // Parse unified diff → list of add/update/delete hunks
    // Validate all targets exist / don't exist
    // Execute mutations sequentially
    // Report results per-file
  }
})
```

**Additional enhancement:** Build a diff preview UI component that shows the
patch before applying, reusing Betopia's existing `DiffViewer` component.

**Files to create:**
- `desktop/src/lib/agent-tools/apply-patch.ts`
- `desktop/src/lib/patch-parser.ts` — unified diff parser

**Files to touch:**
- `desktop/src/lib/agent-tools.ts` — register tool
- `desktop/src/modules/editor/components/DiffViewer.tsx` — extend for patch preview

---

### 7. Fine-Grained Streaming Events

**Inspiration:** OpenCode's 15+ event types with durable + live separation.

**Current state:** Betopia uses a simpler parts-based streaming model. Events
flow through callbacks (`onPartsUpdate`, `onToolStart`, `onToolEnd`). The
granularity is sufficient for the current UI but limits real-time updates and
durable event sourcing.

**Improvement:**

Introduce a stream event ADT (algebraic data type):

```typescript
type StreamEvent =
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

**Durable vs live separation (OpenCode pattern):**
- Delta events (`text_delta`, `reasoning_delta`, `tool_call_delta`) are live-only
- Terminal events (`text_end`, `reasoning_end`, `tool_call_end`, `tool_result`,
  `step_end`) are persisted durably
- Session replay uses terminal events, not delta events

**Implementation:**
- Publish events via a small EventEmitter (or Zustand subscription)
- The chat UI subscribes to live events for rendering
- Session persistence subscribes to durable events
- Agent loop publishes both

**Files to touch:**
- `desktop/src/lib/agent-types.ts` — add stream event types
- `desktop/src/lib/agent.ts` — emit events during streaming
- `desktop/src/lib/agent-history.ts` — persist durable events
- `desktop/src/modules/chat/` — consume live events for rendering

---

### 8. System Context Epochs

**Inspiration:** OpenCode's `SessionContextEpoch` — typed, composable,
refreshable context sources with incremental diffs.

**Current state:** `buildSystemPrompt()` in `agent-prompts.ts` rebuilds the
entire system prompt every turn. While it's fast enough with caching, the output
is a static string. There's no way to incrementally update parts of the context
or track context changes over time.

**Improvement:**

Structural context sources that produce diffs rather than full rebuilds:

```typescript
interface ContextSource<T> {
  key: string
  load(ctx: LoadContext): Promise<T>
  baseline(value: T): string         // Full text for first render
  reconcile(prev: T, curr: T): ContextDiff  // 'unchanged' | { type: 'updated', text: string } | { type: 'replace', text: string }
}

const sources = [
  new ProjectMemorySource(),
  new SkillsSource(),
  new ActiveAgentSource(),
  new MCPSource(),
  new CustomInstructionsSource(),
  new DateSource(),
]
```

On each turn:
1. Load all sources in parallel (they're independent).
2. Compute diffs from previous epoch state.
3. For unchanged sources, skip prompt injection.
4. For updated sources, inject only the diff.
5. For new/replaced sources, inject full baseline.
6. Store current epoch state for next turn comparison.

**Benefits:**
- Reduces token usage on turns where context hasn't changed.
- Cleaner separation of concerns — each source is independently testable.
- Diffs can be displayed to the user as context change notifications.
- Compaction can reference epoch snapshots for reconstruction.

**Files to create:**
- `desktop/src/lib/context/context-source.ts` — source interface
- `desktop/src/lib/context/context-epoch.ts` — epoch manager
- `desktop/src/lib/context/sources/` — individual sources

**Files to touch:**
- `desktop/src/lib/agent-prompts.ts` — refactor to use context epoch
- `desktop/src/lib/agent.ts` — integrate epoch into loop
- `desktop/src/store/agentStore.ts` — track epoch state

---

## P3 — Lower Priority

### 9. Tool Output Bounding

**Inspiration:** OpenCode's `ToolOutputStore` — large outputs stored in managed
storage with bounded in-memory content.

**Current state:** Betopia caps tool results at 2K chars in history and 4K for
display. But there's no mechanism to store the full output for later access.

**Improvement:**

When a tool result exceeds a threshold (e.g., 4K chars):
1. Truncate the in-memory result to N chars with a truncation marker.
2. Store the full result in a structured file
   (`appDataDir/tool-outputs/<session-id>/<tool-call-id>.json`).
3. Include a reference in the tool result message that the model can use to
   retrieve the full output (e.g., by calling `read_files` on the stored path).
4. Periodically clean up old tool outputs based on retention policy.

**Files to touch:**
- `desktop/src/lib/agent.ts` — integrate output bounding
- `desktop/src/lib/agent-tools.ts` — adjust result handling
- `desktop/src/lib/persist.ts` — tool output storage

---

### 10. Question Tool

**Inspiration:** OpenCode's `question` tool — ask the user questions during
execution.

**Current state:** Betopia has no mechanism for the agent to ask the user
questions mid-execution (besides permission approvals).

**Improvement:**

Add a `question` tool:

```typescript
tool({
  name: 'question',
  description: 'Ask the user a question to clarify intent or gather information',
  parameters: {
    question: { type: 'string', description: 'The question to ask the user' },
    options: { type: 'array', items: { type: 'string' }, description: 'Optional answer choices' },
  },
  execute: async ({ question, options }) => {
    // Pause agent loop, show question in chat UI
    // Await user response (deferred)
    // Return answer to model
  }
})
```

**Integration:**
- Chat UI shows the question with optional answer buttons.
- User's answer is returned as tool result text.
- Agent loop pauses while waiting (non-blocking via deferred promise).
- Works with the permission system (question tool itself requires
  `question` permission).

**Files to create:**
- `desktop/src/lib/agent-tools/question.ts`

**Files to touch:**
- `desktop/src/lib/agent-tools.ts` — register tool
- `desktop/src/lib/agent.ts` — integrate question flow
- `desktop/src/modules/chat/` — question UI component

---

### 11. Agent Switching Mid-Session

**Inspiration:** OpenCode's `AgentV2.Service` — agents can be switched
mid-session, with the new agent's system prompt replacing the old one.

**Current state:** Betopia's active agent is selected before a conversation
starts. Changing agents resets the session. There's no way to switch agents
mid-conversation or delegate sub-tasks to a different agent.

**Improvement:**

Allow agent switching mid-session:
1. Add `agent-switched` event type to session history.
2. When agent switches, inject a synthetic message explaining the switch.
3. The new agent's system prompt replaces the previous one's prompt.
4. All previous conversation context remains available but the agent persona
   changes.
5. UI shows an agent switch indicator in the chat timeline.

**Files to touch:**
- `desktop/src/store/agentsStore.ts` — allow mid-session switch
- `desktop/src/lib/agent-prompts.ts` — handle agent switch in context
- `desktop/src/lib/agent-history.ts` — persist agent switch events
- `desktop/src/modules/chat/` — switch indicator UI

---

## Appendix: Architecture Comparison Summary

### Agent Loop Depth

| Project | Loop Pattern | Max Rounds | Retry | Circuit Breaker | Steering |
|---|---|---|---|---|---|
| **Betopia** | Custom while + stream | 200 | 3 attempts, backoff | 3 flaky rounds | None |
| **Pi** | EventStream + state machine | Configurable | Exponential backoff | None | steer/followUp queues |
| **OpenCode** | Effect + FiberSet | Configurable | 1 overflow retry | None | steer/queue input |

### Tool System

| Project | Tool Count | Schema | Execution | Subagents | MCP |
|---|---|---|---|---|---|
| **Betopia** | 22 | JSON Schema | Parallel + file lock | Built-in + custom + repo | stdio/HTTP/SSE |
| **Pi** | 6 | TypeBox | Parallel + mutation queue | None | None |
| **OpenCode** | 12 | Effect Schema | Parallel fibers | Skill-based | stdio/SSE/HTTP + OAuth |

### Context Management

| Project | Compaction | Token Estimation | Incremental Context | Persistence |
|---|---|---|---|---|
| **Betopia** | LLM summary | None | None | JSONL + localStorage |
| **Pi** | Iterative LLM summary | 4:1 char/token | None | Append-only tree JSONL |
| **OpenCode** | LLM summary + overflow | `Token.estimate()` | Epoch-based diffs | SQLite events |

### Provider Layer

| Project | Count | Protocol Abstraction | Capability Flags | Caching |
|---|---|---|---|---|
| **Betopia** | OpenAI-compatible | None | Minimal | Anthropic-style |
| **Pi** | 30+ | `convertToLlm` | `compat` field | Anthropic + OpenAI session |
| **OpenCode** | 20+ | Route (protocol/endpoint/auth/framing) | Per-route flags | OpenAI session |

### Permission/Approval

| Project | Granularity | Rule Engine | Saved Decisions | Deferred |
|---|---|---|---|---|
| **Betopia** | 4 coarse modes | None | None | Promise-based |
| **Pi** | Trust level | None | Yes (trust.json) | None |
| **OpenCode** | Per-tool + per-path | 3-tier + wildcard | Yes | Deferred promise |
