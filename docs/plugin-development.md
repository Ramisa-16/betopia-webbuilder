# Plugin Development Guide

Betopia's plugin system lets you extend the application with custom tools, panels, hooks, agents, providers, and more. Plugins are TypeScript modules loaded at runtime.

---

## Quick Start

### 1. Project Structure

A plugin is a single TypeScript file that exports a `BetopiaPlugin` as default:

```
my-plugin/
├── index.ts          # Plugin entry point
├── package.json      # (optional) for npm-published plugins
└── README.md
```

### 2. Minimal Plugin

```ts
// my-plugin/index.ts
import type { BetopiaPlugin } from 'betopia-webbuilder/desktop/src/lib/plugin'

const plugin: BetopiaPlugin = {
  manifest: {
    id: 'my:hello',
    name: 'Hello Plugin',
    version: '1.0.0',
    description: 'A friendly greeting plugin',
    author: 'You',
  },

  contributions: {
    commands: [
      {
        id: 'greet',
        label: 'Say hello',
        description: 'Insert a greeting into the chat',
        execute: () => '👋 Hello from my plugin!',
      },
    ],
  },
}

export default plugin
```

### 3. Registering the Plugin

Add the plugin to your `betopia_config.json`:

```json
{
  "plugins": [
    { "id": "builtin:core", "enabled": true, "source": "core" },
    { "id": "my:hello", "enabled": true, "source": "./my-plugin/index.ts" }
  ]
}
```

Plugin sources:
| `source` format | Type | Example |
|---|---|---|
| `builtin:*` | Built-in | `"source": "core"` → loads `src/plugins/core/index.ts` |
| `./path/to/file.ts` | Local | `"source": "./plugins/my-plugin/index.ts"` |
| `npm:package-name` | npm | `"id": "npm:betopia-plugin-stats"` |

---

## Plugin Anatomy

### Manifest

```ts
interface PluginManifest {
  id: string            // Unique ID, e.g. "my:weather"
  name: string          // Display name
  version: string       // Semver
  description?: string
  author?: string
  homepage?: string
  license?: string
  permissions?: PluginPermissionManifest   // Declare required permissions
  configSchema?: Record<string, unknown>   // JSON Schema for user settings
  defaultConfig?: Record<string, unknown>  // Default values for config
}
```

### Permissions

Declare what your plugin needs in `manifest.permissions`:

```ts
manifest: {
  // ...
  permissions: {
    network: { origins: ['https://api.weather.com/**'] },
    filesystem: {
      read: ['/projects/**/*.json'],
      write: ['/projects/**/output/*'],
    },
    shell: true,        // Allow executing shell commands
    userMessages: true, // Allow reading/sending chat messages
  },
}
```

If a plugin tries to access a resource without declaring the permission, the call is denied at runtime.

### Declarative Contributions (`contributions`)

Static resources the plugin provides. These are registered automatically on activation:

```ts
interface PluginContributions {
  tools?: ToolDefinition[]        // New tools the AI can call
  agents?: AgentDefinition[]      // Custom chat agents
  subagents?: SubagentDefinition[] // Read-only subagents
  providers?: ProviderDefinition[] // LLM providers
  panels?: PanelDefinition[]      // UI panels (React components)
  components?: ComponentDefinition[]
  commands?: SlashCommand[]       // /slash commands in chat
  keybindings?: Keybinding[]
  themes?: ThemeDefinition[]
  skills?: SkillDefinition[]
  customInstructions?: string     // Additional system prompt for the AI
  mcpServers?: MCPServerConfig[]  // MCP server definitions
}
```

### Dynamic Lifecycle (`onActivate` / `onDeactivate`)

For runtime behavior — hooks, dynamic registrations, setup/teardown:

```ts
onActivate: (ctx: PluginActivationContext) => PluginLifecycle | Promise<PluginLifecycle>
onDeactivate?: () => void | Promise<void>
```

`PluginLifecycle`:

```ts
interface PluginLifecycle {
  hooks?: PluginHooks
  teardown?: Array<() => void>  // Extra cleanup functions
}
```

---

## Writing Tools

The most common contribution. A tool tells the AI what it can call and provides the execution function.

### Basic Tool

```ts
contributions: {
  tools: [
    {
      name: 'get_weather',
      globalName: true,              // false = auto-prefixed with pluginId
      description: 'Get current weather for a city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
      execute: async (args, ctx) => {
        const city = String(args.city ?? '')
        const res = await fetch(
          `https://api.weather.com/current?q=${encodeURIComponent(city)}`
        )
        const data = await res.json()
        return { content: JSON.stringify(data) }
      },
    },
  ],
}
```

### Tool with Scoped Filesystem

```ts
execute: async (args, ctx) => {
  // ctx.projectPath — current project root (nullable)
  // ctx.sessionId   — current session ID (nullable)
  // ctx.signal      — AbortSignal (nullable)

  // Read/write only inside the plugin's data directory
  const config = await ctx.fs.readFile('config.json')
  await ctx.fs.writeFile('output.txt', 'done')
  const entries = await ctx.fs.listDir('.')
  await ctx.fs.deleteFile('temp.txt')

  return { content: 'ok' }
}
```

### Tool with Error Handling

```ts
execute: async (args) => {
  try {
    const result = await doSomething(args)
    return { content: result }
  } catch (err) {
    return {
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}
```

### Tool Name Scoping

By default, tool names are prefixed with `pluginId__` to avoid collisions:

- `pluginId: "my:weather"`, tool name `"get_weather"` → exposed as `"my:weather__get_weather"`
- Set `globalName: true` to expose as `"get_weather"` (use only for core/trusted plugins)

---

## Hooks

Hooks let plugins intercept and modify the agent's behavior at key points.

### beforeToolCall

Runs before every tool call. Can block, modify args, or pass through:

```ts
hooks: {
  beforeToolCall: async (toolCall, ctx) => {
    // Block dangerous commands
    if (toolCall.toolName === 'bash') {
      const cmd = String(toolCall.parsedArgs.command ?? '')
      if (cmd.includes('rm -rf')) {
        return { type: 'block', reason: 'rm -rf is not allowed' }
      }
    }
    // Modify arguments
    if (toolCall.toolName === 'write_file') {
      return {
        type: 'modify',
        toolCall: {
          ...toolCall,
          parsedArgs: {
            ...toolCall.parsedArgs,
            content: `// Auto-generated by ${ctx.pluginId}\n${toolCall.parsedArgs.content}`,
          },
        },
      }
    }
    // Pass through (don't interfere)
    return null
  },
}
```

### afterToolCall

Runs after execution. Can override result, flip error status, or terminate the agent loop:

```ts
hooks: {
  afterToolCall: async (result, ctx) => {
    if (result.toolName === 'bash' && result.result.includes('segmentation fault')) {
      return { result: 'Command crashed — try a different approach', isError: true }
    }
    return {}
  },
}
```

### transformContext

Runs before every LLM call. Can inject additional messages or modify history:

```ts
hooks: {
  transformContext: async (messages, ctx) => {
    if (messages.length > 0 && messages[0].role === 'system') {
      messages[0].content += '\n\nCurrent time: ' + new Date().toISOString()
    }
    return messages
  },
}
```

### onToolStream

Receive streaming events during LLM response generation:

```ts
hooks: {
  onToolStream: (event, ctx) => {
    if (event.type === 'text_delta') {
      console.log(`[${ctx.pluginId}] text chunk:`, event.data)
    }
  },
}
```

### onSessionEvent / onFileChange

React to session switches or file modifications:

```ts
hooks: {
  onSessionEvent: (event) => {
    if (event.type === 'session_switched') {
      console.log('Session changed to:', event.sessionId)
    }
  },
  onFileChange: (change) => {
    console.log(`File ${change.type}: ${change.path}`)
  },
}
```

---

## UI Panels

Plugins can add React panels to the sidebar, bottom area, modal dialogs, or tabs.

### Panel Definition

```ts
import { lazy } from 'react'

contributions: {
  panels: [
    {
      id: 'my-panel',
      title: 'My Panel',
      area: 'sidebar',             // 'sidebar' | 'bottom' | 'modal' | 'tab'
      defaultOpen: false,
      component: lazy(() => import('./MyPanelComponent')),
    },
  ],
}
```

### Panel Component

```tsx
// MyPanelComponent.tsx
import type { PanelProps } from 'betopia-webbuilder/desktop/src/lib/plugin'

export default function MyPanel({ pluginId, config }: PanelProps) {
  return <div>Hello from {pluginId}</div>
}
```

---

## Custom Agents, Subagents & Providers

### Agent

```ts
contributions: {
  agents: [
    {
      id: 'my-coder',
      name: 'My Coder',
      description: 'A custom coding agent',
      instructions: 'You are a specialized Python developer.',
      icon: '🐍',
      allowedTools: ['read_file', 'write_file', 'bash'],
      model: 'gpt-4o',
    },
  ],
}
```

### Subagent

```ts
contributions: {
  subagents: [
    {
      id: 'my-linter',
      label: 'My Linter',
      description: 'Run custom lint checks',
      systemPrompt: 'You are a strict linter for TypeScript.',
      writable: false,
      tools: ['view_file', 'grep_search'],
    },
  ],
}
```

### Provider

```ts
contributions: {
  providers: [
    {
      id: 'my-llm',
      name: 'My LLM',
      baseUrl: 'https://api.my-llm.com/v1',
      apiKeyEnv: 'MY_LLM_API_KEY',
      models: ['my-model-v1', 'my-model-v2'],
    },
  ],
}
```

---

## Plugin-to-Plugin Communication

Use the pubsub system to send messages between plugins:

```ts
onActivate: (ctx) => {
  // Subscribe
  const unsub = ctx.pubsub.subscribe('weather:update', (data) => {
    console.log('Weather update:', data)
  })

  // Publish
  ctx.pubsub.publish('weather:alert', { city: 'London', temp: 35 })

  return { teardown: [unsub] }
}
```

---

## Development Workflow

### Hot Reload

During development with `npm run tauri:dev`, plugin modules loaded via dynamic `import()` are cached. Call `PluginManager.reloadPlugin(id)` to invalidate the cache and re-activate.

In `App.tsx`, this is wired to the plugin store — disabling and re-enabling a plugin in the Settings UI triggers a reload.

### Testing

Vitest is the test runner. Example test for a plugin:

```ts
import { describe, it, expect } from 'vitest'
import { PluginHookRegistry, PluginRegistry, PluginScope, createPluginContext } from '../lib/plugin'
import type { BetopiaPlugin } from '../lib/plugin'

describe('my plugin', () => {
  it('registers a tool', () => {
    const hooks = new PluginHookRegistry()
    const registry = new PluginRegistry()
    const scope = new PluginScope()
    const ctx = createPluginContext('test:my', {}, '/tmp', hooks, registry, scope, {
      chat: { getMessages: () => [], sendMessage: () => {} },
      session: { getActiveSession: () => null },
      app: { getPermissionMode: () => 'default' },
    }, { publish: () => {}, subscribe: () => () => {} })

    const plugin: BetopiaPlugin = {
      manifest: { id: 'test:my', name: 'Test', version: '1.0.0' },
      onActivate: (ctx) => {
        ctx.registerTool({
          name: 'ping',
          description: 'Returns pong',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: 'pong' }),
        })
        return {}
      },
    }

    plugin.onActivate!(ctx)
    expect(registry.getAllTools()).toHaveLength(1)
    scope.dispose()
    expect(registry.getAllTools()).toHaveLength(0)
  })
})
```

---

## Example: Complete Weather Plugin

```ts
// plugins/weather/index.ts
import type { BetopiaPlugin, ToolResult } from 'betopia-webbuilder/desktop/src/lib/plugin'

const plugin: BetopiaPlugin = {
  manifest: {
    id: 'my:weather',
    name: 'Weather Plugin',
    version: '1.0.0',
    description: 'Fetches current weather data',
    permissions: {
      network: { origins: ['https://api.open-meteo.com/**'] },
    },
    configSchema: {
      type: 'object',
      properties: {
        units: { type: 'string', enum: ['celsius', 'fahrenheit'], default: 'celsius' },
      },
    },
  },

  contributions: {
    commands: [
      {
        id: 'weather-config',
        label: 'Weather settings',
        description: 'Show weather plugin configuration',
        execute: () => 'Weather plugin is active.',
      },
    ],
    tools: [
      {
        name: 'get_weather',
        globalName: true,
        description: 'Get current temperature for a city (latitude/longitude).',
        parameters: {
          type: 'object',
          properties: {
            lat: { type: 'number' },
            lon: { type: 'number' },
          },
          required: ['lat', 'lon'],
        },
        execute: async (args, ctx): Promise<ToolResult> => {
          const { lat, lon } = args
          const units = (ctx.config?.units as string) === 'fahrenheit' ? 'fahrenheit' : 'celsius'
          try {
            const res = await fetch(
              `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&temperature_unit=${units}`
            )
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json()
            return {
              content: `Temperature: ${data.current_weather.temperature}°${units === 'celsius' ? 'C' : 'F'}`,
            }
          } catch (err) {
            return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
          }
        },
      },
    ],
  },
}

export default plugin
```

Register in config:

```json
{
  "plugins": [
    { "id": "builtin:core", "enabled": true, "source": "core" },
    { "id": "my:weather", "enabled": true, "source": "./plugins/weather/index.ts", "config": { "units": "celsius" } }
  ]
}
```

---

## Reference

### PluginActivationContext API

Available inside `onActivate(ctx)`:

| Method / Property | Description |
|---|---|
| `ctx.id` | Plugin ID |
| `ctx.config` | User-provided config merged with defaults |
| `ctx.dataDir` | Scoped filesystem path for this plugin |
| `ctx.registerTool(tool)` | Register a tool (returns disposer) |
| `ctx.unregisterTool(name)` | Unregister by prefixed name |
| `ctx.onBeforeToolCall(handler)` | Subscribe to beforeToolCall hook |
| `ctx.onAfterToolCall(handler)` | Subscribe to afterToolCall hook |
| `ctx.onTransformContext(handler)` | Subscribe to transformContext hook |
| `ctx.onSessionEvent(handler)` | Subscribe to session events |
| `ctx.onFileChange(handler)` | Subscribe to file change events |
| `ctx.registerPanel(panel)` | Register a UI panel |
| `ctx.registerCommand(cmd)` | Register a slash command |
| `ctx.registerKeybinding(kb)` | Register a keyboard shortcut |
| `ctx.registerTheme(theme)` | Register a theme |
| `ctx.stores.chat.getMessages()` | Get chat messages |
| `ctx.stores.chat.sendMessage(text)` | Send a message programmatically |
| `ctx.stores.session.getActiveSession()` | Get current session |
| `ctx.stores.app.getPermissionMode()` | Get current permission mode |
| `ctx.tauri.invoke(cmd, args)` | Call any Tauri command |
| `ctx.tauri.listen(event, handler)` | Listen for Tauri events |
| `ctx.fs.readFile(path)` | Read file from plugin data dir |
| `ctx.fs.writeFile(path, content)` | Write file in plugin data dir |
| `ctx.fs.listDir(path)` | List directory in plugin data dir |
| `ctx.fs.deleteFile(path)` | Delete file in plugin data dir |
| `ctx.log.info/warn/error(msg)` | Log with plugin prefix |
| `ctx.pubsub.publish(channel, data)` | Broadcast to other plugins |
| `ctx.pubsub.subscribe(channel, handler)` | Listen for messages from other plugins |

### Lifecycle Flow

```
PluginManager.configure([...entries])
  │
  ├─ PluginManager.loadAndActivateAll()
  │    │
  │    └─ for each enabled entry:
  │         │
  │         ├─ PluginLoader.loadPlugin(entry)
  │         │    ├─ detectSourceType() → 'built-in' | 'local' | 'npm'
  │         │    └─ dynamic import() → BetopiaPlugin
  │         │
  │         ├─ createPluginContext(id, config, dataDir, hooks, registry, scope, stores, pubsub)
  │         │
  │         ├─ registerContributions() — tools, agents, panels, etc.
  │         │
  │         ├─ plugin.onActivate(ctx) → PluginLifecycle
  │         │    ├─ registerHookContributions() — beforeToolCall, afterToolCall, etc.
  │         │    └─ scope.add() for each teardown function
  │         │
  │         └─ emit('plugin:activated')
  │
  └─ PluginManager.deactivatePlugin(id)
       ├─ plugin.onDeactivate()
       ├─ scope.dispose() — runs all cleanup in reverse order
       ├─ hooks.removeAllForPlugin(id)
       ├─ registry.removeAllForPlugin(id)
       └─ emit('plugin:deactivated')
```

### Source Types

| Type | Detection | `source` format | Example |
|---|---|---|---|
| `built-in` | `id` starts with `builtin:` | `"source": "core"` → `src/plugins/core/index.ts` |
| `local` | Else | `"source": "./path/to/plugin.ts"` |
| `npm` | `id` starts with `npm:` or `source` is `npm` | `"source": "npm"`, `"id": "npm:my-plugin"` |
