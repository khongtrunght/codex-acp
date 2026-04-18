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
  PermissionsRequestApprovalParams,
} from "./app-server/protocol.ts";

type PermissionOption = RequestPermissionRequest["options"][number];

type ApprovalKind = "command" | "file";
type ApprovalParams = CommandExecutionRequestApprovalParams | FileChangeRequestApprovalParams;

type LegacyDecision = "approved" | "approved_for_session" | "denied" | "abort";

const COMMAND_DEFAULT_DECISIONS: string[] = ["accept", "acceptForSession", "decline"];

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
