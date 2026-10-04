# Update Tracker — Betopia Web Builder

Running log of notable changes. Newest on top. Add an entry per meaningful change (feat / fix / perf / docs / refactor).

| Date | Type | Summary | Ref |
|------|------|---------|-----|
| 2026-06-24 | feat | VS Code-style IDE features | 988db7b |
| 2026-06-22 | fix | rewire shortcut dispatcher lost in dev merge | 40dc4be |
| 2026-06-22 | feat | add Focus chat/Toggle panels/Reload preview shortcuts | 7f6c1e7 |
| 2026-06-22 | feat | wire real shortcut dispatcher (rebindable, all keys work) | 7f6c1e7 |
| 2026-06-21 | refactor | drop dead header/menu rules post-merge | 5e3ecfb |
| 2026-06-21 | chore | Merge origin/main into Yamin-bropro | b68598a |
| 2026-06-21 | refactor | split index.css and make colors theme-safe | 9aad02e |
| 2026-06-21 | fix | repair header menu toggle and panel reopen | 64c946d |
| 2026-06-21 | build | drop deprecated baseUrl | 46296c3 |
| 2026-06-21 | fix | gate where_first to Windows builds | 15a9a02 |
| 2026-06-21 | build | check-then-install all prerequisites | 7866a5c |
| 2026-06-21 | chore | add onboarding docs, ignores, and rewrite setup.sh | 94449dc |
| 2026-06-21 | build | check-then-install all prerequisites | f67f2df |
| 2026-06-21 | docs | Add project `CLAUDE.md` guide + this update tracker; map architecture | this commit |

## Recent history (seeded from git, pre-tracker)

| Type | Summary | Commit |
|------|---------|--------|
| docs | Rewrite README for Tauri desktop web-builder architecture | 4654d59 |
| feat | Right-click context menu to remove projects from list | 57a534e |
| perf | Fix app hang during agent build | c528791 |
| feat | Conversation compact (context management) | b1688b3 |
| feat | Inject active MCP tools + Figma workflow into agent system prompt | e69d56d |
| feat | Auto-test MCP servers on tab open; status badges (Configured/Testing/Connected/Failed) | 9f918d9 |
| fix | Show SettingsSearch on homepage (picking status) so Ctrl+K works there | a0def18 |
| feat | MCP preset setup via Ctrl+K + transparent search modal | 76d0f5a |
| feat | Real brand SVG logos on MCP preset cards, 2-column grid | f287eef |
| feat | Modernize MCP settings with gallery of popular presets | 415e317 |
| feat | VS Code-like autocomplete with ghost text + Tab-to-accept | 3b4e04c |
| fix | Inline chat reliability + light mode color issues | 893650a |
| feat | Full MCP support: stdio, test button, auto-save | 6c09d0a |

---

## How to use

Rows are added **automatically** by the `.githooks/post-commit` hook on every commit. Manual editing is rarely needed.

- One row per change in the top table; newest first (hook inserts under the separator).
- `Type` ∈ feat | fix | perf | docs | refactor | chore | test (parsed from the conventional-commit prefix; defaults to `chore`).
- `Ref` = commit short hash, auto-filled.
- Merge commits and tracker-only commits are skipped.

### Enable the hook (once per clone)

`core.hooksPath` is local git config, so each clone must opt in:

```bash
git config core.hooksPath .githooks
```

Caveat: the hook amends the commit to fold in the new row, so the recorded short hash is the pre-amend value (off by the amend rewrite). Good enough for tracking; not a stable ref to `git show`.
