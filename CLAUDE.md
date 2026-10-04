# Betopia Web Builder — Project Guide

Desktop AI web-app builder. Chat → scaffold, edit, preview, publish web projects locally.
Tauri 2 native window. AI engine runs **inline in frontend** (no backend service); Rust = thin native layer (fs, shell, PTY, secrets, HTTP proxy, preview server).

## Layout

All app code in [desktop/](desktop/).

```
desktop/
├── src/                  # Frontend — React 18 + TS 5 + Vite 8 + Tailwind 4 + Zustand
│   ├── App.tsx           #   wiring layer (state ↔ logic ↔ UI); no backend calls of its own
│   ├── main.tsx          #   entry
│   ├── modules/          #   UI feature modules: agents, ai, chat, editor, explorer,
│   │                     #     preview, settings, terminal, workspace
│   ├── lib/              #   logic: agent.ts (AI tool loop), agents, subagents, mcp-*,
│   │                     #     providers, config, fs, codeHistory, publish, project-scaffold…
│   ├── store/            #   Zustand: app/chat/editor/ui/session/agent(s)/managedAgents/snippets
│   ├── components/       #   DiffViewer, WindowControls
│   └── types.ts
├── src-tauri/src/        # Rust native layer
│   ├── lib.rs, main.rs
│   ├── server.rs         #   embedded live-preview HTTP server
│   └── modules/          #   fs/ (file,grep,tree,search), shell/, pty/ (session,agent_detect),
│                         #     net.rs (LLM proxy, CORS-free), secrets.rs (keychain), agent.rs
└── sandbox/server.mjs    # Optional Docker-based isolated bash runner (Node service)
```

## Tech Stack

- **Shell:** Tauri 2 (Rust) — `portable-pty`, `keyring`, `reqwest`, `ignore`, `walkdir`, `tiny_http`
- **Frontend:** React 18, TypeScript 5, Vite 8, Tailwind CSS 4, Zustand
- **Editor:** CodeMirror 6 (`@uiw/react-codemirror`, `@codemirror/merge`)
- **Terminal:** xterm.js
- **Markdown:** react-markdown + remark-gfm + rehype-highlight

## Request Flow

1. Prompt typed in **chat** (frontend).
2. `lib/agent.ts` builds context (project memory `BETOPIA.md`/`CLAUDE.md`, file tree, active agent persona), streams from selected provider via Rust **`net`** HTTP proxy.
3. Agent calls tools — `write_file`, `edit`, `bash`, `grep_search`, `run_subagent`, … — invoking **Tauri commands** in `src-tauri` (fs/shell/pty).
4. File changes refresh **explorer** + **preview**; `server.rs` serves result.
5. Sessions + code-history snapshots persist per project; secrets → OS keychain.

## Key Concepts

- **Providers:** OpenAI + Betopia AI built in; any OpenAI-compatible endpoint (Ollama: `http://localhost:11434/v1`, key `ollama`).
- **Built-in agents:** Coder, Architect, Code Reviewer, Security, Designer (+ custom).
- **Subagents:** read-only `explore`, `code-review`, `security`, `general`.
- **MCP:** stdio / SSE / HTTP / JSON-RPC servers.
- **Config:** `betopia_config.json` (in-app Settings); API keys migrated to OS keychain.
- **Project memory order agent reads:** `BETOPIA.md` → `betopia.md` → `CLAUDE.md` → `AGENTS.md` → `.betopia/memory.md`.

## Commands (run from `desktop/`)

```bash
./setup.sh            # one-shot setup (Linux/macOS): Rust + system deps + JS deps
npm install           # or: bun install
npm run tauri:dev     # Vite dev server + native window, hot reload
npm run tauri:build   # production bundle
npm run dev           # Vite frontend only (no native shell)
npm run build         # tsc + vite build → dist/
npm run test          # vitest
npm run sandbox:start # optional Docker sandbox service
```

Prereqs: Rust stable, Node 18+ or Bun, Tauri system deps.

## License

FSL-1.1-MIT.
