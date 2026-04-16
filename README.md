# codex-acp-bridge

TypeScript ACP adapter that bridges ACP clients to `codex app-server` over JSON-RPC stdio.

## What it does

- Runs an ACP server over stdio
- Spawns `codex app-server` per ACP session
- Maps ACP session lifecycle to Codex threads:
  - `session/new` -> `thread/start`
  - `session/load` -> `thread/resume`
  - `session/list` -> `thread/list`
  - `session/prompt` -> `turn/start`
  - `session/cancel` -> `turn/interrupt`
- Streams Codex events into ACP `session/update` notifications:
  - `agent_message_chunk`
  - `agent_thought_chunk`
  - `tool_call` / `tool_call_update`
  - `plan`
  - `usage_update`
- Bridges Codex approval server-requests to ACP `requestPermission`
- Exposes model and mode config through ACP session config options

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
# command name: codex-acp-bridge
```

Optional environment variable:

- `CODEX_BIN`: path to `codex` executable (default: `codex`)

## Current limitations

- ACP `mcpServers` are projected to Codex thread config as `config.mcp_servers` for `stdio` and `http` transports
- ACP `sse` MCP transport is currently ignored (Codex app-server config does not accept SSE MCP transport shape)
- `item/tool/requestUserInput` uses extension first, then fallback (auto-select first option per question)
- `session/set_mode` and `session/set_model` update session defaults and apply on subsequent turns

Optional extension hooks for richer behavior (if ACP client implements them):

- `codex/request_user_input`
- `codex/dynamic_tool_call`
- `codex/mcp_eliicitation_request`

## Quick sanity test

```bash
bun run typecheck
bun run test
```

Implementation is modularized under `src/` (`agent`, `rpc`, `mapping`, `main`), with `src/index.ts` as the executable entrypoint (same style as `mission-agent-acp`).

## Codex Protocol Types

Bridge này vendor schema types từ `openai/codex` vào:

- `src/vendor/codex-app-server-protocol/`
- metadata nguồn: `src/vendor/codex-schema-source.md`

Sync types từ upstream:

```bash
scripts/sync-codex-schema-types.sh
```
