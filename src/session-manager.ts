import type {
  AgentSideConnection,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
  SessionModelState,
  StopReason,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { ApprovalBridge } from "./approval-bridge.ts";
import type { CodexAppServerClient } from "./app-server/client.ts";
import { logger } from "./app-server/logger.ts";
import type {
  ApplyPatchApprovalParams,
  CodexServerNotification,
  CommandExecutionRequestApprovalParams,
  DynamicToolCallParams,
  ExecCommandApprovalParams,
  FileChangeRequestApprovalParams,
  JsonValue,
  McpServerElicitationRequestParams,
  PermissionsRequestApprovalParams,
  RpcRequest,
  ToolRequestUserInputParams,
  TurnStartResponse,
} from "./app-server/protocol.ts";
import { isJsonObject } from "./app-server/protocol.ts";
import { EventProjector, type TurnOutcome } from "./event-projector.ts";
import {
  CODEX_EXTENSION_METHODS,
  ExtensionClient,
  isDynamicToolCallResponse,
  isMcpElicitationResponse,
  isToolRequestUserInputResponse,
} from "./extension.ts";
import { buildConfigOptions, buildModeState, mapApprovalPolicyToModeId, mapModeIdToApprovalPolicy } from "./modes.ts";
import { promptToCodexInput } from "./prompt-input.ts";

type CodexServerRequest = Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue };

export type CodexSessionOptions = {
  sessionId: string;
  cwd: string;
  threadId: string;
  approvalPolicy?: unknown;
  client: CodexAppServerClient;
  connection: AgentSideConnection;
  models: SessionModelState;
  extensions: ExtensionClient;
  approvals: ApprovalBridge;
};

/**
 * Per-ACP-session wrapper around one Codex thread. Lives on top of the
 * shared {@link CodexAppServerClient}: registers notification and server-
 * request handlers that filter by `threadId` so fan-out from the shared
 * client stays scoped to this session.
 *
 * Responsibilities:
 *  - Drive `turn/start`, `turn/interrupt` against its thread.
 *  - Track active-turn state via {@link EventProjector} and resolve the
 *    prompt promise on `turn/completed`.
 *  - Bridge Codex approval/tool server-requests to ACP `requestPermission`
 *    and the client's extension methods.
 *  - Track `modes` and `models` state plus push `current_mode_update`
 *    session notifications when the user changes them.
 *
 * `close()` unregisters handlers and cancels the active turn but does NOT
 * close the shared client.
 */
export class CodexSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly threadId: string;

  private readonly client: CodexAppServerClient;
  private readonly connection: AgentSideConnection;
  private readonly projector: EventProjector;
  private readonly extensions: ExtensionClient;
  private readonly approvals: ApprovalBridge;
  private readonly disposeNotificationHandler: () => void;
  private readonly disposeRequestHandler: () => void;
  private closed = false;

  private modelsState: SessionModelState;
  private modesState: SessionModeState;
  private configOptionsState: SessionConfigOption[];

  constructor(options: CodexSessionOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.threadId = options.threadId;
    this.client = options.client;
    this.connection = options.connection;
    this.extensions = options.extensions;
    this.approvals = options.approvals;

    const currentModeId = mapApprovalPolicyToModeId(options.approvalPolicy);
    this.modesState = buildModeState(currentModeId);
    this.modelsState = options.models;
    this.configOptionsState = buildConfigOptions(this.modesState, this.modelsState);
    this.projector = new EventProjector(this.connection, this.sessionId, this.threadId);

    this.disposeNotificationHandler = this.client.addNotificationHandler((notification) =>
      this.routeNotification(notification),
    );
    this.disposeRequestHandler = this.client.addRequestHandler(async (request) => {
      if (!this.isForThisThread(request.params)) {
        return undefined;
      }
      const result = await this.handleServerRequest(request);
      return result as JsonValue | undefined;
    });
  }

  get modes(): SessionModeState {
    return this.modesState;
  }

  get models(): SessionModelState {
    return this.modelsState;
  }

  get configOptions(): SessionConfigOption[] {
    return this.configOptionsState;
  }

  get currentModeId(): string {
    return this.modesState.currentModeId;
  }

  get currentModelId(): string {
    return this.modelsState.currentModelId;
  }

  /**
   * Updates the session's approval mode and emits an ACP
   * `current_mode_update`. The new mode applies to subsequent `turn/start`
   * calls as the Codex `approvalPolicy`.
   */
  async setMode(modeId: string): Promise<void> {
    const found = this.modesState.availableModes.find((mode) => mode.id === modeId);
    if (!found) {
      throw RequestError.invalidParams(undefined, `Unsupported mode: ${modeId}`);
    }
    this.modesState = { ...this.modesState, currentModeId: modeId };
    this.configOptionsState = buildConfigOptions(this.modesState, this.modelsState);
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: modeId },
    });
  }

  /**
   * Updates the session's default model and emits an ACP
   * `config_option_update`. The new model applies to subsequent `turn/start`
   * calls.
   */
  async setModel(modelId: string): Promise<void> {
    const found = this.modelsState.availableModels.find((model) => model.modelId === modelId);
    if (!found) {
      throw RequestError.invalidParams(undefined, `Unsupported model: ${modelId}`);
    }
    this.modelsState = { ...this.modelsState, currentModelId: modelId };
    this.configOptionsState = buildConfigOptions(this.modesState, this.modelsState);
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: this.configOptionsState },
    });
  }

  /**
   * Starts a Codex turn for this thread and waits for it to complete.
   * Throws if a turn is already in flight. The returned `stopReason` is
   * `"end_turn"` on normal completion and `"cancelled"` if the turn was
   * interrupted (by `cancel()` or by the client).
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (this.projector.currentTurnId) {
      throw RequestError.invalidParams(undefined, "A turn is already running for this session.");
    }

    const input = await promptToCodexInput(params);
    const response = await this.client.request<TurnStartResponse>("turn/start", {
      threadId: this.threadId,
      input,
      model: this.currentModelId,
      approvalPolicy: mapModeIdToApprovalPolicy(this.currentModeId),
    });

    const turnId = response.turn.id;
    const outcome: TurnOutcome = await new Promise<TurnOutcome>((resolve, reject) => {
      this.projector.registerTurn({ turnId, resolve, reject });
    });

    const stopReason: StopReason = outcome.stopReason;
    return {
      stopReason,
      ...(params.messageId ? { userMessageId: params.messageId } : {}),
    };
  }

  /**
   * Interrupts the active turn, if any. If the RPC fails the active-turn
   * promise is still resolved with `"cancelled"` so the ACP client is not
   * left hanging.
   */
  async cancel(): Promise<void> {
    const turnId = this.projector.currentTurnId;
    if (!turnId) {
      return;
    }
    try {
      await this.client.request("turn/interrupt", { threadId: this.threadId, turnId });
    } catch (error) {
      logger.warn("turn/interrupt failed", { error, turnId });
      this.projector.cancelActiveTurn("cancelled");
    }
  }

  /**
   * Idempotent. Unregisters this session's notification/request handlers on
   * the shared client and resolves any pending prompt promise with
   * `"cancelled"`. Does NOT close the shared client; the agent does that
   * on connection shutdown.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.disposeNotificationHandler();
    this.disposeRequestHandler();
    this.projector.cancelActiveTurn("cancelled");
  }

  private routeNotification(notification: CodexServerNotification): Promise<void> | void {
    if (!this.isForThisThread(notification.params)) {
      return;
    }
    return this.projector.handle(notification);
  }

  private isForThisThread(params: JsonValue | undefined): boolean {
    if (!isJsonObject(params)) {
      // Some top-level notifications carry no threadId (e.g. account updates).
      // Let every session see them; handlers that only care about a specific
      // thread already short-circuit internally.
      return true;
    }
    const threadId = params.threadId;
    if (typeof threadId !== "string") {
      return true;
    }
    return threadId === this.threadId;
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<unknown> {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return this.approvals.commandOrFileApproval(
          this.sessionId,
          request.params as CommandExecutionRequestApprovalParams,
          "command",
        );
      case "item/fileChange/requestApproval":
        return this.approvals.commandOrFileApproval(
          this.sessionId,
          request.params as FileChangeRequestApprovalParams,
          "file",
        );
      case "item/permissions/requestApproval":
        return this.approvals.permissionsApproval(
          this.sessionId,
          request.params as PermissionsRequestApprovalParams,
        );
      case "item/tool/requestUserInput":
        return this.handleToolRequestUserInput(request.params as ToolRequestUserInputParams);
      case "item/tool/call":
        return this.handleDynamicToolCall(request.params as DynamicToolCallParams);
      case "mcpServer/elicitation/request":
        return this.handleMcpElicitation(request.params as McpServerElicitationRequestParams);
      case "execCommandApproval":
        return this.approvals.legacyExecCommandApproval(
          this.sessionId,
          request.params as ExecCommandApprovalParams,
        );
      case "applyPatchApproval":
        return this.approvals.legacyApplyPatchApproval(
          this.sessionId,
          request.params as ApplyPatchApprovalParams,
        );
      case "account/chatgptAuthTokens/refresh":
        return {};
      default:
        return undefined;
    }
  }

  private async handleToolRequestUserInput(
    params: ToolRequestUserInputParams,
  ): Promise<unknown> {
    const extResponse = await this.extensions.call(
      CODEX_EXTENSION_METHODS.requestUserInput,
      params as unknown as Record<string, unknown>,
    );
    if (extResponse && isToolRequestUserInputResponse(extResponse)) {
      return extResponse;
    }

    const answers: Record<string, { answers: string[] }> = {};
    const questions = Array.isArray(params?.questions) ? params.questions : [];
    for (const question of questions) {
      const id = typeof question?.id === "string" ? question.id : undefined;
      if (!id) {
        continue;
      }
      const options = Array.isArray(question?.options) ? question.options : [];
      answers[id] = {
        answers: options.length > 0 ? [String(options[0]?.label ?? "")] : [],
      };
    }
    return { answers };
  }

  private async handleDynamicToolCall(params: DynamicToolCallParams): Promise<unknown> {
    const extResponse = await this.extensions.call(
      CODEX_EXTENSION_METHODS.dynamicToolCall,
      params as unknown as Record<string, unknown>,
    );
    if (extResponse && isDynamicToolCallResponse(extResponse)) {
      return extResponse;
    }
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Dynamic tool call is not supported by this ACP bridge yet.",
        },
      ],
    };
  }

  private async handleMcpElicitation(
    params: McpServerElicitationRequestParams,
  ): Promise<unknown> {
    const extResponse = await this.extensions.call(
      CODEX_EXTENSION_METHODS.mcpElicitation,
      params as unknown as Record<string, unknown>,
    );
    if (extResponse && isMcpElicitationResponse(extResponse)) {
      return extResponse;
    }
    return { action: "decline", content: null, _meta: null };
  }
}
