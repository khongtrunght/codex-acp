# codex-acp

TypeScript ACP adapter that bridges ACP clients to `codex app-server` over JSON-RPC stdio.

## What it does

- Runs an ACP server over stdio
- Spawns `codex app-server` per ACP session
- Maps ACP session lifecycle to Codex threads:
  - `session/new` -> `thread/start`
  - `session/load` -> `thread/resume`
  - `session/resume` -> `thread/resume`
  - `session/fork` -> `thread/fork`
  - `session/list` -> `thread/list`
  - `session/prompt` -> `turn/start`
  - `session/cancel` -> `turn/interrupt`
- Streams Codex events into ACP `session/update` notifications:
  - `agent_message_chunk`
  - `agent_thought_chunk`
  - `tool_call` / `tool_call_update`
  - `plan`
  - `usage_update`
  - `available_commands_update` (static command set at session bootstrap)
- Bridges Codex approval server-requests to ACP `requestPermission`
- Exposes model and mode config through ACP session config options
- Converts unsupported ACP media inputs (for example audio) to safe text fallbacks

## Install

```bash
bun install
```

## Run

```bash
bun run src/index.ts
```

Or as a bin:

```bash
bun run start
# command name: codex-acp
```

Optional environment variable:

- `CODEX_BIN`: path to `codex` executable (default: `codex`)

## Current limitations

- ACP `mcpServers` are projected to Codex thread config as `config.mcp_servers` for `stdio`, `http`, and `sse` (best-effort)
- `item/tool/requestUserInput` uses extension first, then fallback (auto-select first option per question)
- `session/set_mode` and `session/set_model` update session defaults and apply on subsequent turns

Optional extension hooks for richer behavior (if ACP client implements them):

- `codex/request_user_input`
- `codex/dynamic_tool_call`
- `codex/mcp_eliicitation_request`
- `codex/available_commands`

Extension payload contract: [`docs/extension-method-contract.md`](./docs/extension-method-contract.md)

To enable extension calls, client should advertise capability:

- `initialize.clientCapabilities._meta["codex-extension-methods"] = true`

### Custom system prompt

`session/new` and `session/fork` accept a system prompt through `_meta.systemPrompt` (mirrors the claude-agent-acp API):

- `_meta.systemPrompt: "..."` — replaces the preset (mapped to Codex `baseInstructions`)
- `_meta.systemPrompt: { append: "..." }` — extra instructions on top of the preset (mapped to Codex `developerInstructions`)
- `_meta.systemPrompt: { base: "...", append: "..." }` — both fields at once

Codex locks instructions at thread creation time, so this has no effect on `session/load` or `session/resume` (the existing thread keeps whatever prompt it was created with).

## Quick sanity test

```bash
bun run typecheck
bun run test
bun run smoke
```

`bun run smoke` requires local `codex` CLI access/auth because it performs an end-to-end prompt turn.

## Build standalone binary

`bun build --compile` bundles the bridge into a single native executable (Bun runtime included, no `node`/`bun` required at runtime):

```bash
# host platform → dist/codex-acp
bun run build:binary

# cross-compile targets
bun run build:binary:darwin-arm64
bun run build:binary:darwin-x64
bun run build:binary:linux-x64
bun run build:binary:linux-arm64
bun run build:binary:windows-x64

# everything in one go (release builds)
bun run build:binary:all
```

Smoke-test a compiled binary with `BRIDGE_BIN=./dist/codex-acp bun run smoke`.

Implementation is modularized under `src/` (`agent`, `rpc`, `mapping`, `main`), with `src/index.ts` as the executable entrypoint (same style as `mission-agent-acp`).

## Codex Protocol Types

Bridge này vendor schema types từ `openai/codex` vào:

- `src/vendor/codex-app-server-protocol/`
- metadata nguồn: `src/vendor/codex-schema-source.md`

Sync types từ upstream:

```bash
scripts/sync-codex-schema-types.sh
```

## CI

- GitHub Actions workflow: `.github/workflows/ci.yml`
- Runs on push/PR:
  - `bun install --frozen-lockfile`
  - `bun run typecheck`
  - `bun run test`
