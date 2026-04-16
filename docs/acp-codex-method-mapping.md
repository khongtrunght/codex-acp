# ACP <-> Codex App Server Method Mapping

Tài liệu này mô tả mapping giữa ACP methods và Codex App Server JSON-RPC methods trong bridge hiện tại.

## Legend

- `[x]` implemented
- `[ ]` chưa implement / chưa đầy đủ
- `n/a` không có method tương ứng trực tiếp

## ACP Agent Methods

| ACP method | Codex App Server mapping | Status | Ghi chú |
|---|---|---|---|
| `initialize` | `initialize` + `initialized` | [x] | Handshake app-server khi tạo process cho session |
| `authenticate` | n/a | [x] | Hiện no-op, trả success |
| `session/new` (`newSession`) | `thread/start` | [x] | Tạo thread mới; có map `mcpServers` -> `config.mcp_servers` |
| `session/load` (`loadSession`) | `thread/resume` | [x] | Resume theo `sessionId` (thread id) |
| `session/resume` (`unstable_resumeSession`) | `thread/resume` | [x] | Resume không replay history |
| `session/fork` (`unstable_forkSession`) | `thread/fork` | [x] | Tạo session mới từ thread hiện có |
| `session/list` (`listSessions`) | `thread/list` | [x] | Có map `cursor`, `cwd` |
| `session/prompt` (`prompt`) | `turn/start` | [x] | Chờ `turn/completed` để trả `stopReason` |
| `session/cancel` (`cancel`) | `turn/interrupt` | [x] | Cần `threadId` + `turnId` đang chạy |
| `session/set_mode` (`setSessionMode`) | n/a (apply qua tham số turn) | [x] | Lưu local mode, gửi vào `turn/start.approvalPolicy` |
| `session/set_model` (`unstable_setSessionModel`) | n/a (apply qua tham số turn) | [x] | Lưu local model, gửi vào `turn/start.model` |
| `session/set_config_option` (`setSessionConfigOption`) | n/a | [x] | Hỗ trợ `mode`, `model` |
| `session/close` (`unstable_closeSession`) | n/a | [x] | Stop process `codex app-server` của session |

## ACP Client-facing Updates (`session/update`)

| Nguồn Codex notification | ACP update | Status | Ghi chú |
|---|---|---|---|
| `item/agentMessage/delta` | `agent_message_chunk` | [x] | Stream text assistant |
| `item/reasoning/textDelta` | `agent_thought_chunk` | [x] | |
| `item/reasoning/summaryTextDelta` | `agent_thought_chunk` | [x] | |
| `item/started` (tool-like items) | `tool_call` | [x] | Map `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, ... |
| `item/completed` (tool-like items) | `tool_call_update` | [x] | status completed/failed |
| `item/commandExecution/outputDelta` | `tool_call_update` | [x] | status `in_progress`, `kind=execute` |
| `item/fileChange/outputDelta` | `tool_call_update` | [x] | status `in_progress`, `kind=edit` |
| `thread/tokenUsage/updated` | `usage_update` | [x] | map `used` + `size` |
| `thread/name/updated` | `session_info_update` | [x] | update title |
| `turn/completed` | `PromptResponse.stopReason` | [x] | resolve waiter prompt |
| `error` | `agent_message_chunk` + resolve prompt | [x] | hiện fallback message |
| `item/plan/delta` | `plan` | [x] | stream plan text dạng incremental |
| `turn/plan/updated` | `plan` | [x] | map full plan state (`pending/inProgress/completed`) |
| session bootstrap | `available_commands_update` | [x] | publish static command set khi `newSession`/`loadSession` |
| `item/commandExecution` lifecycle | `tool_call(_update)` + `_meta.terminal_*` | [x] | `terminal_info`, `terminal_output`, `terminal_exit` |

## Codex Server Requests handled by ACP bridge

| Codex server request | ACP side behavior | Status | Ghi chú |
|---|---|---|---|
| `item/commandExecution/requestApproval` | gọi ACP `requestPermission` -> trả `decision` | [x] | Map allow/reject/cancel |
| `item/fileChange/requestApproval` | gọi ACP `requestPermission` -> trả `decision` | [x] | |
| `item/permissions/requestApproval` | gọi ACP `requestPermission` -> trả `permissions/scope` | [x] | hiện basic mapping |
| `item/tool/requestUserInput` | ext-method -> fallback answers | [x] | thử `codex/request_user_input`, fallback chọn option đầu tiên |
| `account/chatgptAuthTokens/refresh` | trả `{}` | [x] | no-op compatibility |
| `applyPatchApproval` | gọi ACP `requestPermission` -> trả `decision` | [x] | hỗ trợ legacy approval flow |
| `execCommandApproval` | gọi ACP `requestPermission` -> trả `decision` | [x] | hỗ trợ legacy approval flow |
| `item/tool/call` (dynamic tools) | ext-method -> graceful fallback | [x] | thử `codex/dynamic_tool_call`, nếu không có thì `success:false` |
| `mcpServer/elicitation/request` | ext-method -> graceful fallback | [x] | thử `codex/mcp_eliicitation_request`, nếu không có thì `decline` |

## ACP Content -> Codex Input mapping

| ACP content block | Codex `turn/start.input` | Status | Ghi chú |
|---|---|---|---|
| `text` | `{ type: "text", text, text_elements: [] }` | [x] | |
| `resource_link` | text fallback | [x] | Serialize thành text |
| `resource` (text) | text fallback | [x] | Embed uri + text |
| `image` (http/https uri) | `{ type: "image", url }` | [x] | |
| `image` (base64 data) | `{ type: "localImage", path }` | [x] | ghi file tạm rồi gửi local image |
| `audio` | text fallback | [x] | convert thành descriptive text note |

## MCP Servers mapping (ACP -> Codex config)

| ACP MCP transport | Codex config output | Status | Ghi chú |
|---|---|---|---|
| `stdio` | `config.mcp_servers.<name> = { command, args, env }` | [x] | |
| `http` | `config.mcp_servers.<name> = { url, http_headers }` | [x] | |
| `sse` | `config.mcp_servers.<name> = { url, http_headers }` | [x] | mapped best-effort sang streamable-http shape |

## Gaps ưu tiên tiếp theo

1. Thay static command set bằng nguồn dynamic khi Codex App Server expose command list chính thức.
2. Nâng audio từ text fallback sang native mapping nếu Codex mở input audio cho `turn/start`.
