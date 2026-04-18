// Minimal Codex app-server protocol surface used by this bridge. Types are
// hand-written (not generated) and are intentionally loose: the Codex app-server
// ships a much larger schema, but we only need the shapes touched by the bridge.

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

export type RpcRequest = {
  id?: number | string;
  method: string;
  params?: JsonValue;
};

export type RpcResponse = {
  id: number | string;
  result?: JsonValue;
  error?: {
    code?: number;
    message: string;
    data?: JsonValue;
  };
};

export type RpcMessage = RpcRequest | RpcResponse;

export type CodexInitializeResponse = {
  userAgent?: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
};

export type CodexServerNotification = {
  method: string;
  params?: JsonValue;
};

/** True when `value` is a non-null, non-array JSON object. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** True when `message` has `id` and no `method` — i.e. a JSON-RPC response. */
export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}

/** Casts `value` to a `JsonObject` only if it passes the structural check. */
export function coerceJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

// ---------------------------------------------------------------------------
// User input (prompt -> turn)
// ---------------------------------------------------------------------------

export type CodexUserInput =
  | { type: "text"; text: string; text_elements?: JsonValue[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

// ---------------------------------------------------------------------------
// Threads, turns, and items
// ---------------------------------------------------------------------------

export type ThreadSummary = {
  id: string;
  cwd?: string;
  name?: string | null;
  preview?: string | null;
  updatedAt?: number;
};

export type Thread = {
  id: string;
  status?: string;
  cwd?: string;
  turns?: Turn[];
};

export type Turn = {
  id: string;
  status?: TurnStatus;
  items?: ThreadItem[];
  error?: { message?: string } | null;
};

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

// ThreadItem covers every kind emitted by Codex. Rather than a strict
// discriminated union, we expose a broad record whose `type` narrows the
// meaningful fields; the bridge uses runtime checks before touching specifics.
export type ThreadItem = {
  id: string;
  type: string;
  status?: string;
  text?: string;
  command?: string;
  cwd?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  processId?: string;
  changes?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  contentItems?: unknown;
  success?: boolean;
  query?: string;
  prompt?: unknown;
  receiverThreadIds?: unknown;
  path?: string;
  content?: Array<{ type: string; text?: string }>;
};

export type ThreadStartResponse = {
  thread: { id: string };
  cwd?: string;
  approvalPolicy?: string;
  model?: string | null;
  modelProvider?: string | null;
};

export type ThreadResumeResponse = ThreadStartResponse & {
  thread: Thread;
};

export type ThreadForkResponse = ThreadStartResponse;

export type ThreadListResponse = {
  data?: ThreadSummary[];
  nextCursor?: string | null;
};

export type ModelListResponse = {
  data?: Array<{
    id: string;
    displayName?: string;
    description?: string | null;
    isDefault?: boolean;
  }>;
};

export type TurnStartResponse = {
  turn: { id: string };
};

export type TurnInterruptResponse = {
  turn?: { id: string };
};

// ---------------------------------------------------------------------------
// Server notifications (streaming events)
// ---------------------------------------------------------------------------

type TurnScoped = { threadId?: string; turnId?: string };

export type AgentMessageDeltaNotification = TurnScoped & {
  itemId?: string;
  delta?: string;
};

export type ReasoningTextDeltaNotification = TurnScoped & {
  itemId?: string;
  contentIndex?: number;
  delta?: string;
};

export type ReasoningSummaryTextDeltaNotification = TurnScoped & {
  itemId?: string;
  contentIndex?: number;
  delta?: string;
};

export type PlanDeltaNotification = TurnScoped & {
  itemId: string;
  delta?: string;
};

export type TurnPlanUpdatedNotification = TurnScoped & {
  explanation?: string | null;
  plan: Array<{ step?: string; status?: "pending" | "inProgress" | "completed" }>;
};

export type ItemStartedNotification = TurnScoped & {
  item: ThreadItem;
};

export type ItemCompletedNotification = TurnScoped & {
  item: ThreadItem;
};

export type CommandExecutionOutputDeltaNotification = TurnScoped & {
  itemId: string;
  delta?: string;
};

export type FileChangeOutputDeltaNotification = TurnScoped & {
  itemId: string;
  delta?: string;
};

export type ThreadTokenUsageUpdatedNotification = TurnScoped & {
  tokenUsage?: {
    modelContextWindow?: number;
    total?: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    };
    last?: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    };
  };
};

export type ThreadNameUpdatedNotification = TurnScoped & {
  threadName?: string | null;
};

export type TurnCompletedNotification = TurnScoped & {
  turn?: { id: string; status?: TurnStatus; error?: { message?: string } | null };
};

export type ErrorNotification = TurnScoped & {
  error?: { message?: string };
};

// ---------------------------------------------------------------------------
// Approval / server request params
// ---------------------------------------------------------------------------

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type CommandExecutionRequestApprovalParams = {
  itemId?: string;
  threadId?: string;
  turnId?: string;
  command?: string;
  cwd?: string;
  reason?: string | null;
  availableDecisions?: ApprovalDecision[];
};

export type FileChangeRequestApprovalParams = {
  itemId?: string;
  threadId?: string;
  turnId?: string;
  changes?: unknown;
  reason?: string | null;
  availableDecisions?: ApprovalDecision[];
};

export type PermissionsRequestApprovalParams = {
  itemId?: string;
  threadId?: string;
  turnId?: string;
  reason?: string | null;
  permissions?: Record<string, unknown>;
};

export type ToolRequestUserInputParams = {
  threadId?: string;
  turnId?: string;
  questions?: Array<{
    id?: string;
    label?: string;
    description?: string;
    options?: Array<{ label?: string; description?: string }>;
  }>;
};

export type DynamicToolCallParams = {
  threadId?: string;
  turnId?: string;
  callId?: string;
  tool?: string;
  arguments?: unknown;
};

export type McpServerElicitationRequestParams = {
  threadId?: string;
  turnId?: string;
  requestId?: string;
  message?: string;
  requestedSchema?: unknown;
};

// Legacy (pre-v2) approval params kept for back-compat with older Codex servers.
export type ExecCommandApprovalParams = {
  conversationId: string;
  callId: string;
  approvalId: string | null;
  command: string[];
  cwd: string;
  reason: string | null;
  parsedCmd: unknown[];
};

export type ApplyPatchApprovalParams = {
  conversationId: string;
  callId: string;
  fileChanges: unknown;
  reason: string | null;
  grantRoot: string | null;
};
