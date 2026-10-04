# Sandbox Hardening Roadmap

## Phase 1 (Implemented in this repo)

- Dedicated local sandbox service (`desktop/sandbox/server.mjs`)
- Per-session isolated workspace copy
- Docker-based command execution
- CPU/memory/pids/network controls
- Session TTL cleanup
- App integration for inline agent `bash` tool
- Agent Settings toggle + endpoint/resource controls

## Phase 2 (Recommended next)

- Add signed image allowlist (only approved images)
- Per-command audit logs (JSONL + session correlation IDs)
- Sensitive pattern scanning for stdout/stderr before UI display
- Explicit `writeback` confirmation UX for changed files

## Phase 3 (Enterprise level)

- Rootless containers or microVM runtime (Firecracker/Kata)
- Egress proxy with domain allowlist and full DNS/IP logging
- OCI image vulnerability scanning before session start
- Secrets broker (short-lived tokens, never persisted in project files)

## Phase 4 (Claude/Manus parity targets)

- Deterministic snapshot + replay for agent debugging
- Time-travel logs and tool-call event stream viewer
- Session artifacts API (diffs, test reports, build metadata)
- Team policies (RBAC, approval matrix, compliance export)
