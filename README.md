<div align="center">

# ✦ Betopia Web Builder

**Desktop AI web-app builder.**
Chat to scaffold, edit, preview, and publish projects — locally, on your machine.

<br/>

[![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![License](https://img.shields.io/badge/License-FSL--1.1--MIT-8B5CF6?style=flat-square)](./LICENSE.md)

</div>

---

## ✦ What it is

Betopia Web Builder is a **Tauri 2 desktop application** that turns a chat prompt into a working
web project. You describe what you want; an AI agent plans it, writes the files, runs commands,
and renders a live preview — all inside one native window.

The AI engine runs **inline in the frontend** (no separate backend service). The Rust side is a
thin native layer: filesystem, shell, terminal (PTY), secrets, an HTTP proxy to LLM providers,
and an embedded live-preview server.

---

## ✦ Features

- **Chat-to-build** — describe a project; the agent plans, then scaffolds and edits files
- **Plan-then-build orchestration** — large requests produce a step-by-step plan you approve before building
- **Agentic tool loop** — file read/write/edit, `grep`, project structure, `bash`, subagents
- **Multi-provider** — OpenAI, Betopia AI (company model), and any OpenAI-compatible endpoint (e.g. Ollama)
- **Built-in agents** — Coder, Architect, Code Reviewer, Security, Designer (+ custom agents)
- **Subagents** — read-only `explore`, `code-review`, `security`, `general` spawned by the main agent
- **Managed CLI agents** — spawn Claude Code / Codex inside a terminal and drive them from chat
- **Live preview** — embedded static **and** runtime server with auto-refresh and runtime-error auto-fix
- **Code editor** — CodeMirror with tabs, inline chat, diff viewer, file-tree explorer
- **Integrated terminal** — `xterm` with shell auto-detection (bash/zsh/fish/PowerShell/WSL…)
- **MCP support** — connect Model Context Protocol servers (stdio / SSE / HTTP / JSON-RPC)
- **Publish & export** — serve a project locally or export to a `.zip`
- **Optional Docker sandbox** — isolate agent `bash` execution in a container
- **Persistence** — per-project sessions, code-history snapshots, secrets in the OS keychain

---

## ✦ Architecture

```
betopia-webbuilder/
└── desktop/
    ├── src/                      # Frontend — React 18 + TS + Vite 8 + Tailwind 4
    │   ├── App.tsx               #   wiring layer (state ↔ logic ↔ UI), no backend calls of its own
    │   ├── modules/              #   UI feature modules (one folder each)
    │   │   ├── chat/             #     ChatPanel, LandingChat, MessageBubble
    │   │   ├── editor/           #     CodePanel, CodeViewer, TabBar, InlineChatPopup
    │   │   ├── explorer/         #     FileTree, ContextMenu
    │   │   ├── preview/          #     LivePreview (iframe over the Rust live server)
    │   │   ├── terminal/         #     xterm-based Terminal
    │   │   ├── settings/         #     SettingsPanel, AgentSettings, ThemeSelector, SettingsSearch
    │   │   ├── workspace/        #     Header, ProjectPicker, Publish/Permission dialogs, panels
    │   │   ├── ai/               #     AgentSwitcher, SnippetPicker, notifications
    │   │   └── agents/           #     NotificationBell
    │   ├── lib/                  #   Logic (no React)
    │   │   ├── agent.ts          #     the AI engine: agentic tool loop + streaming
    │   │   ├── subagents.ts      #     subagent definitions (explore/review/security/general)
    │   │   ├── agents.ts         #     built-in agent personas
    │   │   ├── providers.ts      #     provider/model catalog
    │   │   ├── config.ts         #     persisted config + keychain migration
    │   │   ├── mcp-manager.ts    #     universal MCP client (stdio/sse/http/json)
    │   │   ├── fs.ts / api.ts    #     filesystem + HTTP helpers (call Tauri commands)
    │   │   └── …                 #     sandbox, snippets, themes, error-detector, scaffold, …
    │   └── store/                #   Zustand state (app, chat, editor, ui, session, agents, …)
    │
    └── src-tauri/                # Native shell — Rust + Tauri 2
        ├── src/lib.rs            #   command registry + app bootstrap
        ├── src/server.rs         #   embedded live-preview server (static/runtime) + zip export
        └── src/modules/
            ├── fs/               #     read/write/stat/grep/search/tree/glob
            ├── shell/            #     run command + background processes
            ├── pty/              #     terminal sessions + coding-agent detection
            ├── secrets.rs        #     OS keychain (keyring)
            ├── net.rs            #     LLM HTTP request/stream proxy (CORS-free)
            └── agent.rs          #     Claude Code hooks integration

sandbox/server.mjs               # Optional Docker-based isolated bash runner (Node service)
```

**How a request flows**

1. You type a prompt in **chat** (frontend).
2. `lib/agent.ts` builds context (project memory `BETOPIA.md`/`CLAUDE.md`, file tree, active agent persona)
   and streams from the selected provider through the Rust **`net`** HTTP proxy.
3. The agent calls tools — `write_file`, `edit`, `bash`, `grep_search`, `run_subagent`, etc. —
   which invoke **Tauri commands** in `src-tauri` (fs / shell / pty).
4. File changes refresh the **explorer** and **preview**; the embedded `server.rs` serves the result.
5. Sessions and code-history snapshots persist per project; secrets go to the OS keychain.

| Layer | Tech | Responsibility |
|-------|------|----------------|
| UI | React 18, Tailwind 4, CodeMirror, xterm | Panels, editor, terminal, preview |
| State | Zustand (`store/*`) | App / chat / editor / UI / session state |
| AI engine | `lib/agent.ts` (TS) | Agentic tool loop, streaming, subagents |
| Native shell | Tauri 2 (Rust) | fs, shell, PTY, secrets, HTTP proxy, preview server |
| Sandbox (opt) | Node + Docker | Isolated `bash` execution |

---

## ✦ Tech stack

- **Shell:** [Tauri 2](https://tauri.app) (Rust) — `portable-pty`, `keyring`, `reqwest`, `ignore`, `walkdir`, `tiny_http`
- **Frontend:** React 18, TypeScript 5, [Vite 8](https://vite.dev), Tailwind CSS 4, Zustand
- **Editor:** [CodeMirror 6](https://codemirror.net) (`@uiw/react-codemirror`, `@codemirror/merge`)
- **Terminal:** [xterm.js](https://xtermjs.org)
- **Markdown:** react-markdown + remark-gfm + rehype-highlight

---

## ✦ Getting started

All app code lives in [desktop/](desktop/).

**Prerequisites:** [Rust](https://rustup.rs) (stable), [Node 18+](https://nodejs.org) or [Bun](https://bun.sh),
and the Tauri system dependencies for your OS.

**One-shot setup (Linux/macOS)** — installs Rust + system deps + JS deps:
```bash
cd desktop
./setup.sh
```

**Manual setup**
```bash
cd desktop
npm install          # or: bun install
```

**Run in development** (Vite dev server + native window with hot reload):
```bash
npm run tauri:dev    # or: bun run tauri dev
```

**Build a production bundle:**
```bash
npm run tauri:build  # or: bun run tauri build
```

**Other scripts**
```bash
npm run dev            # Vite frontend only (no native shell)
npm run build          # tsc + vite build → dist/
npm run test           # vitest
npm run sandbox:start  # start the optional Docker sandbox service
```

---

## ✦ Configuration

App config persists to `betopia_config.json` (managed in-app via **Settings**). It holds the
active provider/model, behavior flags (e.g. permission mode), MCP servers, and custom agents.
API keys are migrated out of the config into the **OS keychain** automatically.

**Providers** — OpenAI and Betopia AI ship built in. Add any OpenAI-compatible endpoint
(Ollama, vLLM, a self-hosted server) by configuring its base URL and model in Settings.

**Project memory** — the agent reads a memory file from the open project, if present, in this order:
`BETOPIA.md` → `betopia.md` → `CLAUDE.md` → `AGENTS.md` → `.betopia/memory.md`.

---

## ✦ Local models (Ollama)

Point a provider at your local Ollama server (OpenAI-compatible API):

| Field | Value |
|-------|-------|
| Base URL | `http://localhost:11434/v1` |
| API key | `ollama` (any non-empty string) |
| Model | e.g. `qwen2.5-coder`, `llama3.1` |

---

## ✦ Optional Docker sandbox

A Manus/Claude-style isolated execution layer for agent `bash` commands. It copies the workspace
into a container, runs commands via `docker exec` with CPU/memory/pid limits and no outbound
network by default, then optionally writes results back.

```bash
cd desktop
npm run sandbox:start          # serves http://127.0.0.1:7879
```

See [desktop/sandbox/README.md](desktop/sandbox/README.md) for the full API and env vars.

---

## ✦ Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + I` | Toggle chat sidebar |
| `Ctrl/Cmd + K` | Settings search (spotlight) |
| `Ctrl/Cmd + Shift + E` | Code view |
| `Ctrl/Cmd + Shift + P` | Live preview |
| `` Ctrl/Cmd + ` `` | Toggle terminal |
| `Ctrl/Cmd + C` | Cancel a running agent |

---

<div align="center">

Built with [Tauri](https://tauri.app) · [React](https://react.dev) · [Vite](https://vite.dev) · [CodeMirror](https://codemirror.net)

Licensed under [FSL-1.1-MIT](./LICENSE.md)

</div>
