# Bug Report — Betopia Web Builder (full audit)

Branch `dev` / `Yamin-bropro` @ `9d348a3`. Read-only audit, **no fixes applied** (except 2 already fixed earlier this session, marked ✅). 6 parallel scanners across AI engine, app/stores, chat, editor/explorer/preview, lib/settings, Rust.

Severity counts (incl. deep pass 2 + comb-out pass 3): **Critical 2 · High 20 · Medium 26 · Low 46 (~94)**. Security issues marked 🔒.

---

## CRITICAL

### C1 🔒 Preview server path traversal — arbitrary file read
- **Type**: path traversal · **Loc**: `src-tauri/src/server.rs:663`
- **Evidence**: `root_path.join(&file_path)` then `if !full_path.starts_with(root_path) 403`. `file_path` from raw URL, no `..` removal/percent-decode. `Path::starts_with` is lexical — doesn't resolve `..`, so `/preview/../../../etc/passwd` passes, `fs::read` follows it. Reproduced.
- **Repro**: `curl --path-as-is http://127.0.0.1:PORT/preview/../../../../etc/passwd` → file contents.
- **Root cause**: traversal guard on non-canonicalized path.
- **Fix**: `canonicalize()` both, verify prefix; reject `Component::ParentDir`; percent-decode before check.

---

## HIGH

### H1 🔒 SSRF guard trivially bypassable
- net.rs:14-21 — `url.contains(blocked)` substring check. Bypass via decimal IP `http://2852039166/`, IPv6-mapped, DNS rebinding, redirect. `ai_http_stream` ignores `allow_private_network` (net.rs:110). **Fix**: parse URL, resolve host, reject link-local/loopback/private/metadata IPs; re-validate on redirect.

### H2 🔒 Unquoted shell paths in Source Control (injection + breakage)
- FileTree.tsx:706,747,857,870 — `git show HEAD:${relFile}`, `git add -- "${file}"` with porcelain-derived paths. Filename with space/`"`/`$`/`;` breaks or injects (`a";rm -rf .`). **Fix**: escape/quote every interpolated path or pass args array.

### H3 cap_output panics on multibyte UTF-8
- shell/mod.rs:86 — `&s[..OUTPUT_CAP]` slices at fixed byte 150_000; panics if mid-char (emoji/accents in build logs). No catch_unwind → command aborts. Reproduced. **Fix**: snap to `is_char_boundary`.

### H4 live_server Mutex poisoning kills preview for session
- lib.rs:42/53/60, server.rs:53/118/126 — all `.lock().unwrap()`. One panic holding the lock poisons it → every later start/publish/stop panics. **Fix**: `unwrap_or_else(|e| e.into_inner())`.

### H5 MCP servers leak on agent throw
- agent.ts round loop — `mcpManager.shutdownAll()` only at loop-top / no-tool-calls; if `streamErr` rethrown (agent.ts:~1581) stdio MCP child processes never killed (orphaned). **Fix**: `try { ... } finally { await shutdownAll() }`.

### H6 git rename (`R`) parsed as bogus path
- FileTree.tsx:82 — `line.slice(3).trim()` yields `old.ts -> new.ts` for renames; fed to `git add`/`show`. Stage/diff/show on renamed file all fail. **Fix**: split on ` -> `, use dest.

### H7 duplicateProjectDirectory uses copyFile on a directory — "Make a copy" broken
- fs.ts:212-221 — Tauri `copyFile` copies one file, not a tree. On real project: throws (→silent null) or makes bogus single file. **Fix**: recursive copy or Rust `copy_dir` command.

### H8 MCP import drops servers + never persists
- AgentSettings.tsx:921-949 — per-server `setCfg(prev=>...)` loop, no `saveConfig`; `betopia:config-changed` listener re-reads persisted config and wipes import. **Fix**: build full array, one `setCfg` + `saveConfig`.

### H9 Debounced message sync clobbers freshly-switched session
- App.tsx:470-482 + chatStore syncMessages — 800ms timer closes over old `messages`, writes to whatever `activeId` is at flush; switch within 800ms overwrites new session. **Fix**: capture sessionId in payload, no-op if stale.

### H10 Session-load effect stale (deps = `[activeSessionId]`)
- App.tsx:476-482 — reads `activeSession`/`messages` but omits from deps; async file-restore that populates same session never loads; early-return on transient `undefined` never retries. **Fix**: track loadedSessionIdRef, depend on `[activeSessionId, sessions]`.

### H11 Draft load races / leaks input across projects
- ChatPanel.tsx:671-694 — load uses `if (v) setInput(v)`, never clears on switch → project A's text persists into B, then auto-saved as B's draft. **Fix**: `setInput(v ?? '')`, reset history refs together.

### H12 mcp-stdio-wrapper non-functional (every call times out)
- mcp-stdio-wrapper.ts:108-133 — spawns child but never reads stdout; responseHandlers never fire → all RPCs resolve via 30s timeout. (Module may be dead/unused, but broken.) **Fix**: attach stdout reader dispatching by `id`; or delete if unused.

---

## MEDIUM

### M1 Model capability cache overwrite
- agent.ts:748 — `if (!knownCap) set(streaming?'stream':'nostream')` clobbers the more-specific `notoolstream` set at ~737 during tier fallback → every later call wastes 2 failing requests. **Fix**: guard / set once based on succeeding tier.

### M2 `<think>` tags split across SSE chunks leak into visible text
- agent.ts:883-906 — per-token stateless parse; multi-chunk think body falls to `else { yield text }`. **Fix**: carry `insideThink` across stream.

### M3 historyToOAI null-deref on tool_result content
- agent.ts:622-625 — `d.content.length` assumes string; corrupt/old session with missing content → TypeError aborts runAgent. **Fix**: `String(d.content ?? '')`.

### M4 SSE/JSON reader never released on abort
- agent.ts:800-832 — generator has no `finally` to `reader.cancel()`; Stop abandons stream, body left open. **Fix**: `try/finally { reader.cancel() }`.

### M5 MCP stdio pending RPCs hang on child death
- mcp-manager.ts:95-118 — no `close`/`error` listener; crashed server makes in-flight `tools/call` hang full timeout; listeners never removed. **Fix**: `on('close')` reject pending; clear on shutdown.

### M6 Queued-prompt effect stale (deps `[isAgentBusy]`)
- App.tsx:1318-1325 — reads `queuedPrompt`/`sendMessageCore` as stale; if queued while already idle, never fires. **Fix**: add `queuedPrompt` dep or trigger at enqueue.

### M7 Auto-fix bypasses abortRef + mutual exclusion
- App.tsx:1206-1224 — local `AbortController` never stored in `abortRef`; uncancellable; not gated by `isAgentBusy` → can run concurrently with a user send, both mutate files. **Fix**: set abortRef; gate sends on isFixing.

### M8 Diff-tracking reads non-reactive getConfig + drops diffs
- App.tsx:707-766 — autoAccept/yolo read imperatively (not a dep); `openedDiffsRef` Set + per-run `staged` replacement drops earlier reviewable diffs across runs. **Fix**: make mode reactive; merge instead of replace.

### M9 "Stop & Run" deferred send stale (ChatPanel:706-716)
- deps `[isAgentBusy]`; if busy already false when clicked, queued prompt dropped. **Fix**: add `pendingInterrupt` dep.

### M10 @mention breaks on paths with spaces
- ChatPanel.tsx:568-571 vs 899-911 — `@([^\s@]*)` grammar can't represent `@my folder/a.txt`; insert not re-detectable; caret ignores `after`. **Fix**: wrap `@file(<path>)` / quote; consistent grammar.

### M11 CodeViewer dispatches into destroyed EditorView
- CodeViewer.tsx:188-192 — `editorViewRef` never cleared on unmount; rapid file switch + active searchQuery dispatches into destroyed view. **Fix**: null ref on cleanup; guard `dom.isConnected`.

### M12 Preview console patch not idempotent / observer leak
- LivePreview.tsx:162-164,217-226 — visibility reload re-wraps `console.error` each load (multiplying logs); MutationObserver recreated per load, only disconnected on pagehide → leak + style-rewrite storm. **Fix**: guard `win.__patched`; disconnect prior observer.

### M13 Content-search leaves isSearching=true on cancel
- FileTree.tsx:1127-1162 — `isSearching` reset only inside success guard; clear-mid-flight path never resets. **Fix**: reset in cleanup/guard-fail.

### M14 CodePanel autosave writes stale file after rapid switch
- CodePanel.tsx:108-126 — 300ms debounce resolves target from `selectedFileRef` at fire time, not edit time. **Fix**: capture path at edit; flush/cancel pending on switch.

### M15 error-detector false-positives + missed locations
- error-detector.ts:107-130 (`\S+\.(ext)` misses Windows/space paths, narrow ext set) & 166-173 (`includes('ERROR')`/`\berror\b.*:` flags benign lines). Inflates error badge / wrong file. **Fix**: anchor to real error prefixes; broaden ext; strip `?query`.

### M16 Config legacy migration races initConfig file restore
- config.ts:261-277 — import-time IIFE `saveConfig` creates KEY before async `initConfig()` restores file config → richer file config lost on fresh machine. **Fix**: migrate after initConfig.

---

## LOW (summary)

| # | Loc | Issue |
|---|-----|-------|
| L1 | agent.ts:1038 | `extractServerPort` regex grabs `:port` from URLs / misses positional ports → wrong preview port |
| L2 | agent.ts:979-1006 | inference-retry can't shrink one oversized tool-arg → 3 wasted identical retries |
| L3 | agent.ts:1690 | file-write `onApprovalRequired` fire-and-forget; deny not honored, rejection unhandled |
| L4 | agent.ts:1844 | `streamInlineEdit` sets `stream:true` but `res.text()` reads whole body (no streaming) |
| L5 | providers.ts:113-123 | empty model list cached forever (offline start → never reloads) |
| L6 | intentParser.ts:154 | generic `[A-Za-z0-9_-]{32,}` mis-detects non-keys as credentials |
| L7 | App.tsx:408-416 | git-branch invoke no cancel guard → stale branch / setState after unmount |
| L8 | App.tsx:827 | logs global `window.history.length` instead of project history → always "opened with history" |
| L9 | App.tsx:1136 | `refreshTimerRef` never cleared on cleanup/unmount |
| L10 | App.tsx:1266 | inline-chat abort unreachable → file overwritten after popup closed |
| L11 | App.tsx:1437 | first-terminal-tab effect can double-create on rapid toggle |
| L12 | MessageBubble.tsx:40-62 | per-bubble global `selectionchange` listener → O(N) per selection |
| L13 | MessageBubble.tsx:82 | `showCopyBtn` is a string not bool; `extractText` called 3×/render |
| L14 | ChatPanel.tsx:869-884 | ↑/↓ recall bypasses query reset + caret set before commit; manual edit not exiting history mode discards edits |
| L15 | ChatPanel.tsx:815-931 | FileReader onload no unmount guard; paste id `paste-${Date.now()}` collides → dup React keys |
| L16 | TabBar.tsx:94-100 | onWheel preventDefault on passive listener (no-op); `idx===-1` jumps to first tab |
| L17 | TabBar.tsx:219 | getAdjacentTab computed on pre-filter array → selection jumps |
| L18 | fuzzy.ts:16-18 | multi-word query flat-scores 82 order-insensitive → QuickOpen flood |
| L19 | fuzzy.ts:50-52 | `Math.max(...[])` = -Infinity drops items with empty fields |
| L20 | path.ts:22-24 | `stripFileUri` mangles Windows `file:///C:/...` → `/C:/...` |
| L21 | ApiDocsPanel.tsx:1050+ | `execCommand` copy/cut/paste no-ops in webview |
| L22 | ApiDocsPanel.tsx:106 | `isPortInUse` treats timeout as in-use → wrong port pick |
| L23 | Terminal.tsx:138-228 | `openedRef` one-shot + deps that change → cwd/onCwd change disposes but won't re-init → dead terminal |
| L24 | LogsPanel.tsx:246 | synthetic DetectedError reuses `log.id` → key collisions |
| L25 | NewProjectModal.tsx:20-36 | no `finally setLoading(false)` → stuck "Creating…"; mixed path separators |
| L26 | ProjectPicker.tsx:23 / Header.tsx:299 | recents JSON parsed without `Array.isArray` → crash on corrupt value |
| L27 | sessionStore.ts:18 | sessions parse not validated as array → downstream `.slice`/`[0]` throws |
| L28 | codeHistory.ts:12-14 | FILE_KEY `slice(-80)` → distinct deep paths collide on one history file; LS_KEY vs FILE_KEY disagree |
| L29 | pty/session.rs:209-216 | 8 MB buffer trim via `to_vec()` → O(n²) copy on chatty sessions (comment says 64KB, stale) |
| L30 | fs/tree.rs:62, server.rs:694 | unbounded recursion / follows symlinks → stack overflow or infinite walk on symlink loop |
| L31 | shell/background.rs:120 | `shell_bg_list` hardcodes `running:true` (no `try_wait`); children/threads leak on exit |
| L32 | NotificationBell.tsx:60 | dead `now` state — `relativeTime` ignores it |

---

## PREVIOUSLY-FLAGGED (fixes uncommitted / not merged — treat as OPEN)

> These were patched in the working tree on a held `dev` branch but are **not committed/pushed**, so against the committed & remote code they are still live bugs.

### H13 `onServerStarted` not threaded → ReferenceError, preview never auto-opens
- **Type**: ReferenceError / scope · **Loc**: `agent.ts:1347` (in `executeBuiltinTool`)
- `executeBuiltinTool(projectPath, name, argsJson, onFilesChanged, onPermissionRequest?)` references `onServerStarted` — not a param, not in scope. On a server-start bash command → `ReferenceError: onServerStarted is not defined`, caught → server "start" reported as error; preview never opens.
- **Fix**: add `onServerStarted?` param + pass `callbacks.onServerStarted` at call site (~1819).

### H14 `setActiveDiff` undefined → crash on file select
- **Type**: ReferenceError · **Loc**: `App.tsx:586` (`selectFile`)
- Diff state refactored to `pendingDiffs: Map` (`setPendingDiffs`); stray `setActiveDiff(prev=>…)` left in `selectFile` → undefined name. Every file open throws (tsc TS2304; runtime ReferenceError).
- **Fix**: remove line — diffs are now keyed per-file via the Map (auto-scoped on tab switch).

### Earlier-flagged (committed in `9d348a3` / prior, but list for completeness — verify in target branch)
| Loc | Bug | Fix applied |
|-----|-----|-------------|
| session.rs:51 | `where_first` dead-code warning (compiled all platforms, used only cfg(windows)) | `#[cfg(windows)]` |
| Header.tsx | Navbar File/Edit/Windows menus reopen instead of close (`closeAll()` + functional toggle) | capture next before closeAll |
| Header.tsx | Chat sidebar no reopen affordance | header toggle button |
| ChatPanel.tsx | ⋯ composer menu clipped in narrow chat (`.chat-panel` z-index stacking trap) | portal to body |
| styles/* | Hardcoded `#da7756`/tints/grays break non-default themes | theme tokens |
| manus-shell.css | Orphan `.manus-icon-btn,` grouped selector (merge artifact) | split selector |
| tsconfig.json | `baseUrl` deprecated (TS 7) | removed (paths already relative) |
| shortcuts.ts/App.tsx | Shortcut registry non-functional (no dispatcher); defaults mismatched handlers | built `useShortcuts` dispatcher |
| shortcuts.ts | Ctrl+C / Ctrl+Shift+V claimed by app (terminal copy/paste reserved) | cancel→Esc, togglePreview→Mod+Shift+P |

> **Caveat**: if your audit target is committed `origin/dev`, H13/H14 and possibly the earlier list are STILL present — the working-tree fixes have not been merged there.

## ADDITIONAL FINDINGS — deep pass 2

### HIGH
- **H15 🔒 SSRF redirect bypass** — `net.rs:51,101` clients use default redirect policy (follows ≤10). Allowlist checked only on initial URL; endpoint 302→`http://169.254.169.254/` is followed. **Fix**: `.redirect(Policy::none())` + re-validate each hop / final IP.
- **H16 AgentSettings behavior/sandbox locals never resync** — `AgentSettings.tsx:883-897,998-1002`. `useState(cfg.behavior.X)` init-once; `config-changed` refreshes only `cfg`, not locals. Save writes stale behavior/sandbox, clobbering concurrent changes. **Fix**: effect to reset locals on `cfg.behavior`/`cfg.sandbox`, or edit `cfg` directly.
- **H17 Sandbox blind retry destroys healthy session** — `sandbox.ts:117-124`. Retry path `docker rm -f`s the container + full re-provision on ANY non-ok (400/500/timeout), not just stale-session; original error discarded. **Fix**: retry only on "session not found".
- **H18 Sandbox container leak on failed `docker rm`** — `sandbox/server.mjs:210-238`. Session deleted from Map before teardown; `runProcess` never rejects on timeout/non-zero, errors swallowed → container orphaned forever, unreachable by cleanup/shutdown. **Fix**: delete from Map only after confirmed `rm` (code 0); else keep for retry.

### MEDIUM
- **M17 SSRF blocklist incomplete** — `net.rs:8-21`. Misses IPv6 IMDS `[fd00:ec2::254]`, decimal `2852039166`, hex/octal IP; `allow_private_network` ignored (`let _ =` net.rs:110). **Fix**: resolve→IP, check CIDR ranges.
- **M18 `ai_http_request` unbounded body** — `net.rs:74` `response.text()` no size cap → OOM from malicious/large endpoint. **Fix**: streamed read with byte limit.
- **M19 sandbox writeBack after container destroyed → data loss** — `server.mjs:222-235`. `docker rm -f` (217) runs BEFORE `fs.cp` writeback; if cp throws, edits lost, still 200s. **Fix**: writeBack first (verify), then destroy.
- **M20 handleResetProject doesn't persist** — `App.tsx:1549-1554` uses raw `setPublishState` (not `setAndPersistPublishState`); localStorage keeps old published URL → resurrects on reopen. **Fix**: persist default state.
- **M21 project-scaffold mis-categorizes nested paths** — `project-scaffold.ts:42,12-14`. First-match-wins over full path: `src/app/services/api.ts`→'pages' (matches `/app/` first). **Fix**: match nearest segment / score specificity.
- **M22 DiffViewer stats over-count** — `DiffViewer.tsx:59-78`. `countLines` `Math.max(n,1)` reports `+1 −1` for an in-place single-line edit. **Fix**: count distinct touched line numbers.
- **M23 MCP auto-test duplicate fires** — `AgentSettings.tsx:1005-1011`. `[tab]`-only effect reads stale `mcpTestStates`; tab toggle re-tests in-flight servers. **Fix**: guard on `testing` in `testMCPItem`.

### LOW (deep pass 2)
| # | Loc | Issue |
|---|-----|-------|
| L33 | net.rs:31 | `lm_ping` `unwrap_or_default()` → client without 2s timeout, hangs |
| L34 | net.rs / fs/grep.rs:45 | `fs_grep`/`fs_search` sync recursive walk on command thread → IPC stall on big trees |
| L35 | fs/file.rs:14-21 | `fs_read_file(_bytes)` no size cap → OOM on huge file |
| L36 | agent.rs:81 | `path.parent().unwrap()` latent panic |
| L37 | pty/session.rs:210,235 | `.lock().unwrap()` poison (reader-thread panic bricks `pty_read_output`) |
| L38 | pty/session.rs:190-232 | reader thread + 8MB buffer not stopped on `pty_close` (leak until child EOF) |
| L39 | api.ts:262,313 | `parts` not array-validated → `.filter is not a function` silently drops backend message |
| L40 | manifest.ts:27-44 | `findEntryFile` priority per-subtree not global; can return config file as entry |
| L41 | sandbox.ts:45-107 | session-create/exec `tauriFetch` no timeout/abort → agent hangs if server wedged |
| L42 | server.mjs:357 | cleanup `setInterval` never cleared on shutdown; concurrent-sweep race |
| L43 | App.tsx:2111 + 1538 | `visibility`/`hideBuilderBadge` never sent to `publish_project` → published site ignores them |
| L44 | AgentSwitcher.tsx:35-45 | dropdown flashes at (0,0) first paint (`useEffect` not `useLayoutEffect`) |
| L45 | SnippetPicker.tsx:50 vs snippets.ts:37 | picker `#` regex allows leading `-`, expansion doesn't → preview/pick never expands |
| L46 | AgentSettings.tsx:921-941 | `importMCPServers` `as any`, defaults `type:'http'` → command server imported as broken http |

---

## ADDITIONAL FINDINGS — comb-out pass 3

### CRITICAL
- **C2 🔒 Agent file tools can escape project root** — `fs.ts:146-157`, `agent.ts:1077,1108-1109,1120,1141-1147,1253-1287`. `readProjectFile` joins `projectPath + '/' + relPath` without `normalizeRelPath`, while `delete_file` and `list_dir` build raw `${projectPath}/${path}`. `view_file ../../../../etc/passwd` reads outside the project; `list_dir ../../..` lists outside; `delete_file ../../some-file` can delete outside the project after approval / in full-access mode. This is separate from C1: it is the agent tool boundary, not the preview HTTP server. **Fix**: one shared `resolveProjectPath(projectPath, relPath)` that rejects absolute paths and `..`, canonicalizes, and verifies prefix before read/list/delete/write.

### HIGH
- **H19 🔒 Renderer has whole-disk FS + arbitrary shell capability** — `capabilities/default.json:24-64`, `tauri.conf.json:28-32`. The webview is allowed `fs` read/write/remove over `/**` plus `sh -c`, `bash -c`, `cmd /C` with `.*` args, while CSP is `null` and the asset protocol scope is `/**`. Any renderer injection or unsafe local document path becomes arbitrary file read/write and command execution. This is broader than H2's single shell interpolation bug. **Fix**: scope FS to selected project/app data, remove generic shell commands, expose narrow Rust commands for needed operations, and set a real CSP.
- **H20 MCP stdio drops split JSON-RPC messages** — `mcp-manager.ts:94-99`. The stdout handler does `lineBuf += chunk + '\n'`; if Tauri delivers one JSON response across two chunks, the first partial chunk is forced into a line, JSON.parse fails, and the partial message is discarded. The pending RPC then times out even though the server responded. **Fix**: append raw chunks only; split on existing newline; keep incomplete tail in `lineBuf`.

### MEDIUM
- **M24 Edit review diff can disagree with actual edit** — `agent.ts:1078-1094` vs `agent.ts:1653-1665`. The review preview always uses `normNew` for edits (`replaceWith = normNew`), but `executeBuiltinTool` uses raw `new_string` when `old_string` matches without normalization. Escaped multiline replacements can show a clean multiline diff while the saved file gets literal `\n` sequences. **Fix**: share one edit-planning helper for preview and execution.
- **M25 Preview console wrapper crashes on circular logged objects** — `LivePreview.tsx:168-176,187-191`. `console.error(window)` or any circular object makes `JSON.stringify(a)` throw inside the patched console method after the original log call. That prevents Betopia from recording the runtime error and can throw a new error into the preview app. **Fix**: safe stringifier with circular fallback.
- **M26 MCP manager tests no longer type-check** — `mcp-manager.test.ts:12-13,45,365,388`. `npm run build` fails after the already-listed H13/H14 errors with Vitest mock generic/type errors (`Expected 0-1 type arguments`, `parameter of type never`). Since `tsconfig.json` includes all `src`, broken tests block production build. **Fix**: type mocks with `Mock`/`vi.fn()` compatible with installed Vitest 4, or exclude tests from production `tsc`.

### Verification notes
- `npm run build` still fails: H13/H14 plus M26.
- `cargo check` passes.

---

## Recommended fix order
1. **C1, C2, H1, H2, H19** (security: traversal, SSRF, shell/renderer boundary) — before any non-localhost exposure.
2. **H3, H4, H20** (panics/protocol bugs that brick shell, preview, or MCP).
3. **H5–H18** (data loss / broken features: MCP, sessions, drafts, make-a-copy, sandbox).
4. Medium (correctness/leaks/build hygiene), then Low.

No fixes applied — report only.
