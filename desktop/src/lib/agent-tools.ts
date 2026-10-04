import { IS_WINDOWS } from './platform'

// ── MCP tool interface ────────────────────────────────────────────────────────

export interface MCPTool {
  serverId: string
  serverName: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

export type ToolSchema = {
  type?: string | string[]
  properties?: Record<string, ToolSchema>
  required?: string[]
  items?: ToolSchema
  enum?: unknown[]
  maxItems?: number
  maxLength?: number
}

export type ToolLike = { function?: { name?: string; parameters?: unknown } }

// ── Built-in tool definitions ─────────────────────────────────────────────────

export const MAX_SUBAGENT_TASKS = 4
export const MAX_SUBAGENT_PROMPT_CHARS = 8_000

export const BUILTIN_TOOLS = [
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
      description: 'Surgically replace text in a file. Use edits[] for multiple changes in one call (preferred). Falls back to old_string/new_string for a single change.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          edits: {
            type: 'array',
            description: 'Multiple replacements applied in order. Preferred over old_string/new_string for batch edits.',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'The exact text to replace (including indentation)' },
                new_string: { type: 'string', description: 'The replacement text' },
              },
              required: ['old_string', 'new_string'],
            },
          },
          old_string: { type: 'string', description: 'Single exact text to replace (use edits[] for multiple)' },
          new_string: { type: 'string', description: 'Single replacement text' },
        },
        required: ['path'],
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
      name: 'rename_file',
      description: 'Rename or move a file within the project.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Current relative file path' },
          to: { type: 'string', description: 'New relative file path' },
        },
        required: ['from', 'to'],
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
          timeout: { type: 'number', description: 'Timeout in seconds (default 30, max 600). Increase for slow operations like npm install or cargo build.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_subagent',
      description: `Spawn an isolated subagent with a fresh context to handle a self-contained task. Returns a text summary of what the subagent found or did.

Read-only types (auto-execute, no approval needed):
- explore: Codebase explorer — locates files, traces references, summarizes architecture.
- code-review: Reviews changed code for correctness, architecture, performance, security.
- security: Audits code/configuration for security risks (auth, injection, secrets, etc).
- general: General-purpose research across many files.

Write-capable types (each write/bash call requires user approval, same as main agent):
- coder: Full coding subagent — implements tasks by writing/editing files and running commands.
- fixer: Focused bug-fixer — minimal fix for a specific bug, no unrelated changes.

Custom subagents defined in Settings are also available by their id.`,
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Subagent type id. Built-in: explore, code-review, security, general, coder, fixer. Custom subagent ids are also accepted.',
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
      name: 'run_subagents',
      description: `Spawn multiple subagents IN PARALLEL and wait for all to finish. Use when the task naturally splits into independent investigations that can run simultaneously (e.g. "check auth logic AND check database schema" at the same time). Each subagent gets its own fresh context. Returns labeled results from all.

Subagent types: explore, code-review, security, general (read-only) | coder, fixer (write-capable, require approval per write). Custom subagent ids also accepted.

Prefer run_subagents over sequential run_subagent calls when tasks are independent.
Use run_subagent_chain instead when each step depends on the previous step's output.`,
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'List of subagent tasks to run in parallel.',
            maxItems: MAX_SUBAGENT_TASKS,
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', description: 'Subagent type id.' },
                prompt: {
                  type: 'string',
                  maxLength: MAX_SUBAGENT_PROMPT_CHARS,
                  description: 'Self-contained task prompt for this subagent.',
                },
                label: { type: 'string', description: 'Short label for the result section (e.g. "Auth check", "Schema review").' },
              },
              required: ['type', 'prompt'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_subagent_chain',
      description: `Run subagents SEQUENTIALLY, feeding each step's output into the next via {previous}. Use when steps have a strict dependency order — step 2 needs step 1's findings before it can act.

Example chain: explore finds the relevant files → coder uses {previous} to implement changes on exactly those files.

Each step's full output replaces every {previous} occurrence in the next step's prompt. Steps run in order and stop early on signal abort.

Subagent types: explore, code-review, security, general (read-only) | coder, fixer (write-capable, require approval per write). Custom subagent ids also accepted.

Use run_subagents instead when steps are independent and can run in parallel.`,
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Sequential steps. Each step runs after the previous completes. Use {previous} in prompt to inject the prior step output.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', description: 'Subagent type id.' },
                prompt: { type: 'string', description: 'Task prompt. Use {previous} to reference the prior step\'s full output.' },
                label: { type: 'string', description: 'Short label for the result section (e.g. "Explore", "Implement").' },
              },
              required: ['type', 'prompt'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_memory',
      description: `Write or append to the project memory file (.betopia/memory.md). Use after completing significant work to record architecture decisions, key facts, or design constraints so future agent runs have context. Keep entries concise — bullet points with file:line references are ideal. The memory file is read at the start of every agent session.`,
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Content to write. Supports markdown. Replaces the full file when mode is "replace", appends otherwise.',
          },
          mode: {
            type: 'string',
            enum: ['append', 'replace'],
            description: 'append: add to end (default). replace: overwrite entire file.',
          },
        },
        required: ['content'],
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
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description: 'Create or update a step-by-step plan shown to the user as a live checklist. Each call replaces the entire plan — always resend every step, not just the ones that changed. Exactly one step may be "in_progress" at a time.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'array',
            description: 'The full ordered list of steps for the current task.',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string', description: 'Short description of the step.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['step', 'status'],
            },
          },
          explanation: { type: 'string', description: 'Optional short note on why the plan changed.' },
        },
        required: ['plan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_list_resources',
      description: 'List all resources available on a given MCP server.',
      parameters: {
        type: 'object',
        properties: {
          server_name: { type: 'string', description: 'The name of the MCP server' },
        },
        required: ['server_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_read_resource',
      description: 'Read the contents of a resource from a given MCP server.',
      parameters: {
        type: 'object',
        properties: {
          server_name: { type: 'string', description: 'The name of the MCP server' },
          uri: { type: 'string', description: 'The URI of the resource' },
        },
        required: ['server_name', 'uri'],
      },
    },
  },
]
