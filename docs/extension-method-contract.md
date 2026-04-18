# Extension Method Contract (Client-side)

Bridge gọi các extension method sau qua ACP `extMethod` (nếu client hỗ trợ).

Nếu client không hỗ trợ hoặc throw error, bridge sẽ fallback an toàn.

## Extension Opt-in

Bridge chỉ gọi extension methods khi client bật:

```json
{
  "clientCapabilities": {
    "_meta": {
      "codex-extension-methods": true
    }
  }
}
```

## 1) `codex/request_user_input`

- Purpose: trả lời cho Codex server request `item/tool/requestUserInput`.
- Request params: pass-through từ `ToolRequestUserInputParams`.
- Expected response:

```json
{
  "answers": {
    "<questionId>": {
      "answers": ["..."]
    }
  }
}
```

- Fallback nếu không có extension: auto chọn option đầu tiên cho mỗi câu hỏi.

## 2) `codex/dynamic_tool_call`

- Purpose: xử lý Codex server request `item/tool/call`.
- Request params: pass-through từ `DynamicToolCallParams`.
- Expected response:

```json
{
  "success": true,
  "contentItems": [{ "type": "inputText", "text": "..." }]
}
```

`contentItems` cũng có thể dùng:

```json
{ "type": "inputImage", "imageUrl": "https://..." }
```

- Fallback nếu không có extension:

```json
{
  "success": false,
  "contentItems": [
    { "type": "inputText", "text": "Dynamic tool call is not supported by this ACP bridge yet." }
  ]
}
```

## 3) `codex/mcp_eliicitation_request`

- Purpose: xử lý Codex server request `mcpServer/elicitation/request`.
- Request params: pass-through từ `McpServerElicitationRequestParams`.
- Expected response:

```json
{
  "action": "accept",
  "content": {},
  "_meta": null
}
```

`action` hợp lệ: `accept | decline | cancel`.

- Fallback nếu không có extension:

```json
{
  "action": "decline",
  "content": null,
  "_meta": null
}
```

## Compatibility notes

- Extension payload được validate kiểu tối thiểu trước khi bridge trả về Codex.
- Nếu response extension không đúng shape, bridge bỏ qua và dùng fallback.
