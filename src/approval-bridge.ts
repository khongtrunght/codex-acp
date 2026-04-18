import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import type {
  ApplyPatchApprovalParams,
  CommandExecutionRequestApprovalParams,
  ExecCommandApprovalParams,
  FileChangeRequestApprovalParams,
  JsonObject,
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
} from "./app-server/protocol.ts";

type PermissionOption = RequestPermissionRequest["options"][number];

type ApprovalKind = "command" | "file";
type ApprovalParams = CommandExecutionRequestApprovalParams | FileChangeRequestApprovalParams;

type LegacyDecision = "approved" | "approved_for_session" | "denied" | "abort";

const COMMAND_DEFAULT_DECISIONS: string[] = ["accept", "acceptForSession", "decline"];

// Metadata keys Codex attaches to elicitations that represent MCP tool call
// approvals. Wire-compatible with zed-industries/codex-acp so the same client
// UI works for both bridges. See
// https://github.com/zed-industries/codex-acp/blob/main/src/thread.rs
const MCP_TOOL_APPROVAL_KIND_KEY = "codex_approval_kind";
const MCP_TOOL_APPROVAL_KIND_MCP_TOOL_CALL = "mcp_tool_call";
const MCP_TOOL_APPROVAL_PERSIST_KEY = "persist";
const MCP_TOOL_APPROVAL_PERSIST_SESSION = "session";
const MCP_TOOL_APPROVAL_PERSIST_ALWAYS = "always";
const MCP_TOOL_APPROVAL_TOOL_TITLE_KEY = "tool_title";
const MCP_TOOL_APPROVAL_REQUEST_ID_PREFIX = "mcp_tool_call_approval_";

const MCP_TOOL_APPROVAL_ALLOW_OPTION_ID = "approved";
const MCP_TOOL_APPROVAL_ALLOW_SESSION_OPTION_ID = "approved-for-session";
const MCP_TOOL_APPROVAL_ALLOW_ALWAYS_OPTION_ID = "approved-always";
const MCP_TOOL_APPROVAL_CANCEL_OPTION_ID = "cancel";

/**
 * Translates Codex approval server-requests into ACP `requestPermission`
 * calls. The user's ACP client decides whether to allow once, always, or
 * reject; this class maps the returned `optionId` back to the Codex
 * decision strings Codex expects.
 */
export class ApprovalBridge {
  private readonly connection: AgentSideConnection;

  constructor(connection: AgentSideConnection) {
    this.connection = connection;
  }

  /**
   * Handles the v2 `item/commandExecution/requestApproval` and
   * `item/fileChange/requestApproval` server-requests. Returns Codex's
   * decision string — `"accept"`, `"acceptForSession"`, `"decline"`, or
   * `"cancel"` — based on the user's pick.
   */
  async commandOrFileApproval(
    sessionId: string,
    params: ApprovalParams,
    kind: ApprovalKind,
  ): Promise<{ decision: string }> {
    const decisionMap = new Map<string, string>();
    const options = buildV2ApprovalOptions(kind, params, decisionMap);

    const response = await this.connection.requestPermission({
      sessionId,
      options,
      toolCall: {
        toolCallId: params.itemId ?? randomUUID(),
        title: renderApprovalTitle(kind, params),
      },
    });

    return { decision: resolveV2Decision(response, decisionMap) };
  }

  /**
   * Handles `item/permissions/requestApproval`. Prompts the user for an
   * allow/reject decision; on allow, echoes back the requested permissions;
   * on reject, returns an empty permissions object. Scope is always
   * `"turn"` (single-turn grant).
   */
  async permissionsApproval(
    sessionId: string,
    params: PermissionsRequestApprovalParams,
  ): Promise<{ permissions: Record<string, unknown>; scope: "turn" }> {
    const response = await this.connection.requestPermission({
      sessionId,
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
      toolCall: {
        toolCallId: params.itemId ?? randomUUID(),
        title: params.reason ?? "Grant additional permissions",
      },
    });

    const allowed =
      response.outcome.outcome === "selected" && response.outcome.optionId === "allow_once";
    return {
      permissions: allowed ? (params.permissions ?? {}) : {},
      scope: "turn",
    };
  }

  /**
   * Handles pre-v2 `execCommandApproval`. Options are allow-once,
   * allow-for-session, or reject; the outcome is mapped to Codex's legacy
   * decision strings (`approved`, `approved_for_session`, `denied`, or
   * `abort` when the prompt was cancelled).
   */
  async legacyExecCommandApproval(
    sessionId: string,
    params: ExecCommandApprovalParams,
  ): Promise<{ decision: LegacyDecision }> {
    const response = await this.connection.requestPermission({
      sessionId,
      options: legacyApprovalOptions(),
      toolCall: {
        toolCallId: params.callId,
        title: params.command.join(" "),
        rawInput: { cwd: params.cwd, reason: params.reason },
      },
    });
    return { decision: resolveLegacyDecision(response) };
  }

  /**
   * Handles pre-v2 `applyPatchApproval`. Same decision mapping as
   * {@link legacyExecCommandApproval}, rendered as "Apply patch" in the UI.
   */
  async legacyApplyPatchApproval(
    sessionId: string,
    params: ApplyPatchApprovalParams,
  ): Promise<{ decision: LegacyDecision }> {
    const response = await this.connection.requestPermission({
      sessionId,
      options: legacyApprovalOptions(),
      toolCall: {
        toolCallId: params.callId,
        title: "Apply patch",
        rawInput: {
          reason: params.reason,
          grantRoot: params.grantRoot,
          fileChanges: params.fileChanges,
        },
      },
    });
    return { decision: resolveLegacyDecision(response) };
  }

  /**
   * Routes an MCP-tool-call approval elicitation through ACP
   * `requestPermission`. Only applies when the elicitation carries a `_meta`
   * object marking it as a tool-call approval (matching Codex/Zed
   * convention); other elicitations (generic form fill, URL launch) must be
   * handled by the caller.
   *
   * Returns a ready-to-send response on success, or `undefined` if the
   * elicitation is not a tool-call approval — the caller should then use a
   * safe fallback such as `{ action: "decline" }`.
   */
  async mcpToolApproval(
    sessionId: string,
    params: McpServerElicitationRequestParams,
  ): Promise<McpServerElicitationRequestResponse | undefined> {
    const meta = params._meta ?? undefined;
    if (!meta) {
      return undefined;
    }
    if (meta[MCP_TOOL_APPROVAL_KIND_KEY] !== MCP_TOOL_APPROVAL_KIND_MCP_TOOL_CALL) {
      return undefined;
    }

    const decisionMap = new Map<string, McpServerElicitationRequestResponse>();
    const options = buildMcpElicitationOptions(meta, decisionMap);

    const response = await this.connection.requestPermission({
      sessionId,
      options,
      toolCall: {
        toolCallId: mcpToolApprovalCallId(params),
        title: renderMcpToolApprovalTitle(meta, params),
        rawInput: meta,
      },
    });

    if (response.outcome.outcome === "cancelled") {
      return { action: "cancel", content: null, _meta: null };
    }
    return (
      decisionMap.get(response.outcome.optionId) ?? {
        action: "decline",
        content: null,
        _meta: null,
      }
    );
  }
}

function buildMcpElicitationOptions(
  meta: JsonObject,
  decisionMap: Map<string, McpServerElicitationRequestResponse>,
): PermissionOption[] {
  const options: PermissionOption[] = [
    { optionId: MCP_TOOL_APPROVAL_ALLOW_OPTION_ID, name: "Allow", kind: "allow_once" },
  ];
  decisionMap.set(MCP_TOOL_APPROVAL_ALLOW_OPTION_ID, {
    action: "accept",
    content: null,
    _meta: null,
  });

  const { session, always } = readMcpToolApprovalPersistModes(meta);
  if (session) {
    options.push({
      optionId: MCP_TOOL_APPROVAL_ALLOW_SESSION_OPTION_ID,
      name: "Allow for this session",
      kind: "allow_always",
    });
    decisionMap.set(MCP_TOOL_APPROVAL_ALLOW_SESSION_OPTION_ID, {
      action: "accept",
      content: null,
      _meta: { [MCP_TOOL_APPROVAL_PERSIST_KEY]: MCP_TOOL_APPROVAL_PERSIST_SESSION },
    });
  }
  if (always) {
    options.push({
      optionId: MCP_TOOL_APPROVAL_ALLOW_ALWAYS_OPTION_ID,
      name: "Allow and don't ask again",
      kind: "allow_always",
    });
    decisionMap.set(MCP_TOOL_APPROVAL_ALLOW_ALWAYS_OPTION_ID, {
      action: "accept",
      content: null,
      _meta: { [MCP_TOOL_APPROVAL_PERSIST_KEY]: MCP_TOOL_APPROVAL_PERSIST_ALWAYS },
    });
  }

  options.push({
    optionId: MCP_TOOL_APPROVAL_CANCEL_OPTION_ID,
    name: "Cancel",
    kind: "reject_once",
  });
  decisionMap.set(MCP_TOOL_APPROVAL_CANCEL_OPTION_ID, {
    action: "cancel",
    content: null,
    _meta: null,
  });

  return options;
}

function readMcpToolApprovalPersistModes(meta: JsonObject): {
  session: boolean;
  always: boolean;
} {
  const persist = meta[MCP_TOOL_APPROVAL_PERSIST_KEY];
  if (typeof persist === "string") {
    return {
      session: persist === MCP_TOOL_APPROVAL_PERSIST_SESSION,
      always: persist === MCP_TOOL_APPROVAL_PERSIST_ALWAYS,
    };
  }
  if (Array.isArray(persist)) {
    const values = persist.filter((entry): entry is string => typeof entry === "string");
    return {
      session: values.includes(MCP_TOOL_APPROVAL_PERSIST_SESSION),
      always: values.includes(MCP_TOOL_APPROVAL_PERSIST_ALWAYS),
    };
  }
  return { session: false, always: false };
}

function mcpToolApprovalCallId(params: McpServerElicitationRequestParams): string {
  const elicitationId = params.elicitationId;
  if (typeof elicitationId === "string" && elicitationId.length > 0) {
    const stripped = elicitationId.startsWith(MCP_TOOL_APPROVAL_REQUEST_ID_PREFIX)
      ? elicitationId.slice(MCP_TOOL_APPROVAL_REQUEST_ID_PREFIX.length)
      : elicitationId;
    return stripped || elicitationId;
  }
  return `mcp-tool-approval-${randomUUID()}`;
}

function renderMcpToolApprovalTitle(
  meta: JsonObject,
  params: McpServerElicitationRequestParams,
): string {
  const title = meta[MCP_TOOL_APPROVAL_TOOL_TITLE_KEY];
  if (typeof title === "string" && title.trim()) {
    return `Approve ${title.trim()}`;
  }
  if (params.serverName) {
    return `Approve MCP tool call from ${params.serverName}`;
  }
  return "Approve MCP tool call";
}

function buildV2ApprovalOptions(
  kind: ApprovalKind,
  params: ApprovalParams,
  decisionMap: Map<string, string>,
): PermissionOption[] {
  const options: PermissionOption[] = [];
  const raw = "availableDecisions" in params ? params.availableDecisions : undefined;
  const decisions = Array.isArray(raw)
    ? raw
    : kind === "command"
      ? COMMAND_DEFAULT_DECISIONS
      : ["accept", "acceptForSession", "decline"];

  for (const decision of decisions) {
    if (decision === "accept") {
      options.push({ optionId: "allow_once", name: "Allow once", kind: "allow_once" });
      decisionMap.set("allow_once", "accept");
    } else if (decision === "acceptForSession") {
      options.push({ optionId: "allow_always", name: "Always allow", kind: "allow_always" });
      decisionMap.set("allow_always", "acceptForSession");
    } else if (decision === "decline") {
      options.push({ optionId: "reject_once", name: "Reject", kind: "reject_once" });
      decisionMap.set("reject_once", "decline");
    } else if (decision === "cancel") {
      options.push({ optionId: "cancel", name: "Cancel", kind: "reject_once" });
      decisionMap.set("cancel", "cancel");
    }
  }

  if (options.length === 0) {
    options.push({ optionId: "reject_once", name: "Reject", kind: "reject_once" });
    decisionMap.set("reject_once", "decline");
  }
  return options;
}

function resolveV2Decision(
  response: RequestPermissionResponse,
  decisionMap: Map<string, string>,
): string {
  if (response.outcome.outcome === "cancelled") {
    return "cancel";
  }
  return decisionMap.get(response.outcome.optionId) ?? "decline";
}

function legacyApprovalOptions(): PermissionOption[] {
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow for session", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  ];
}

function resolveLegacyDecision(response: RequestPermissionResponse): LegacyDecision {
  if (response.outcome.outcome !== "selected") {
    return "abort";
  }
  if (response.outcome.optionId === "allow_once") {
    return "approved";
  }
  if (response.outcome.optionId === "allow_always") {
    return "approved_for_session";
  }
  return "denied";
}

function renderApprovalTitle(kind: ApprovalKind, params: ApprovalParams): string {
  if (kind === "command" && "command" in params) {
    return params.command ?? "Execute command";
  }
  return "Apply file changes";
}
