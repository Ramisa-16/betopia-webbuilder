# Betopia Isolated Sandbox Runner

This service adds a **Claude/ChatGPT/Manus-style isolated execution layer** for agent `bash` commands.

## What It Does

- Starts a per-project sandbox session in Docker.
- Copies your workspace into an isolated runtime directory.
- Executes commands inside container (`docker exec`), not on host.
- Enforces resource limits (CPU, memory, pids).
- Disables outbound network by default (`--network none`).
- Auto-cleans idle sessions.

## API

- `GET /health`
- `POST /v1/sessions`
- `GET /v1/sessions`
- `POST /v1/sessions/:id/exec`
- `POST /v1/sessions/:id/writeback` (optional write-back + close)
- `DELETE /v1/sessions/:id?writeBack=1`

## Run

1. Install Docker Desktop and ensure `docker version` works.
2. Start from `desktop` folder:
   - `npm run sandbox:start`
3. Confirm:
   - `http://127.0.0.1:7879/health`

## Environment Variables

- `SANDBOX_HOST` (default: `127.0.0.1`)
- `SANDBOX_PORT` (default: `7879`)
- `SANDBOX_API_KEY` (optional bearer auth)
- `SANDBOX_IMAGE` (default: `node:20-alpine`)
- `SANDBOX_DEFAULT_CPU` (default: `1`)
- `SANDBOX_DEFAULT_MEMORY_MB` (default: `1024`)
- `SANDBOX_DEFAULT_TIMEOUT_SEC` (default: `120`)
- `SANDBOX_SESSION_TTL_SEC` (default: `3600`)
- `SANDBOX_RUNTIME_ROOT` (default: `desktop/.sandbox-runtime`)
- `SANDBOX_ALLOWED_ROOTS` (semicolon-separated absolute paths)

## App Integration

This repository already wires it into inline agent execution:

- Open `Agent Settings` -> `Behavior` -> `Isolated Sandbox`
- Enable `Run bash in container sandbox`
- Set endpoint (default `http://127.0.0.1:7879`)
- Save settings

After that, agent `bash` tool calls run in sandbox.

## Notes

- Timeout kills `docker exec` process; long-running child processes inside container may require session reset.
- This is a practical local sandbox baseline. For enterprise hardening, add VM isolation, signed images, vulnerability scanning, egress proxy controls, and audit pipeline.
