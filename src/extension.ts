import type { AgentSideConnection, AvailableCommand } from "@agentclientprotocol/sdk";

export const CLIENT_EXTENSION_CAPABILITY_KEY = "codex-extension-methods";

export const CODEX_EXTENSION_METHODS = {
  availableCommands: "codex/available_commands",
  dynamicToolCall: "codex/dynamic_tool_call",
  requestUserInput: "codex/request_user_input",
  mcpElicitation: "codex/mcp_eliicitation_request",
} as const;

export type CodexExtensionMethod =
  (typeof CODEX_EXTENSION_METHODS)[keyof typeof CODEX_EXTENSION_METHODS];

/**
 * Safe wrapper around `AgentSideConnection.extMethod` for the bridge's
 * optional hooks. Only issues calls when the client opted in (by setting
 * `clientCapabilities._meta["codex-extension-methods"] = true` during ACP
 * `initialize`); otherwise, and on any RPC error, returns `null` so callers
 * can fall back to their default behavior.
 */
export class ExtensionClient {
  private readonly connection: AgentSideConnection;
  private readonly enabled: boolean;

  constructor(connection: AgentSideConnection, enabled: boolean) {
    this.connection = connection;
    this.enabled = enabled;
  }

  /** True when the client advertised the `codex-extension-methods` capability. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Invokes an extension method. Returns `null` when the feature is
   * disabled or the remote call throws; callers should treat `null` as
   * "no extension response, use the built-in fallback".
   */
  async call(
    method: CodexExtensionMethod,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (!this.enabled) {
      return null;
    }
    try {
      return await this.connection.extMethod(method, params);
    } catch {
      return null;
    }
  }
}

/** Shape guard for a `codex/available_commands` extension response. */
export function isAvailableCommandsResponse(
  value: Record<string, unknown>,
): value is { availableCommands: AvailableCommand[] } {
  if (!Array.isArray(value.availableCommands)) {
    return false;
  }
  return value.availableCommands.every(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { name?: unknown }).name === "string" &&
      typeof (item as { description?: unknown }).description === "string",
  );
}

/** Shape guard for a `codex/request_user_input` extension response. */
export function isToolRequestUserInputResponse(
  value: Record<string, unknown>,
): value is { answers: Record<string, { answers: string[] }> } {
  return typeof value.answers === "object" && value.answers !== null;
}

/** Shape guard for a `codex/dynamic_tool_call` extension response. */
export function isDynamicToolCallResponse(value: Record<string, unknown>): value is {
  success: boolean;
  contentItems: Array<{ type: string; text?: string; imageUrl?: string }>;
} {
  return typeof value.success === "boolean" && Array.isArray(value.contentItems);
}

/** Shape guard for a `codex/mcp_eliicitation_request` extension response. */
export function isMcpElicitationResponse(value: Record<string, unknown>): value is {
  action: "accept" | "decline" | "cancel";
  content: unknown;
  _meta: unknown;
} {
  return (
    (value.action === "accept" || value.action === "decline" || value.action === "cancel") &&
    "content" in value &&
    "_meta" in value
  );
}
