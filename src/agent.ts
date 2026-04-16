import {
  RequestError,
} from "@agentclientprotocol/sdk";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  AvailableCommand,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionModelState,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_PERSIST_EXTENDED_HISTORY,
  DEFAULT_SANDBOX,
} from "./constants.ts";
import {
  buildConfigOptions,
  buildModeState,
  buildPermissionOptions,
  buildThreadConfigFromAcpMcpServers,
  mapApprovalPolicyToModeId,
  mapItemToToolCall,
  mapModeIdToApprovalPolicy,
  modelConfigOption,
  promptToCodexInput,
  replayThreadHistory,
  toolStatusFromItem,
  toSessionTitle,
} from "./mapping.ts";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.ts";
import { CodexAppServerRpc } from "./rpc/codex-app-server-rpc.ts";
import type {
  CodexServerNotificationMessage,
  CodexServerRequestMessage,
} from "./types.ts";
import type {
  AgentMessageDeltaNotification,
  ApplyPatchApprovalParams,
  CommandExecutionOutputDeltaNotification,
  CommandExecutionRequestApprovalParams,
  DynamicToolCallParams,
  ErrorNotification,
  ExecCommandApprovalParams,
  FileChangeOutputDeltaNotification,
  FileChangeRequestApprovalParams,
  ItemCompletedNotification,
  ItemStartedNotification,
  McpServerElicitationRequestParams,
  ModelListResponse,
  PermissionsRequestApprovalParams,
  PlanDeltaNotification,
  ReasoningSummaryTextDeltaNotification,
  ReasoningTextDeltaNotification,
  ThreadListResponse,
  ThreadForkResponse,
  ThreadNameUpdatedNotification,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
} from "./vendor/codex-types.ts";

type PromptWaiter = {
  turnId: string;
  resolve: (reason: StopReason) => void;
  reject: (error: unknown) => void;
};

type SessionState = {
  sessionId: string;
  rpc: CodexAppServerRpc;
  threadId: string;
  cwd: string;
  modes: SessionModeState;
  models: SessionModelState;
  configOptions: SessionConfigOption[];
  currentModeId: string;
  currentModelId: string;
  promptWaiter: PromptWaiter | null;
  planDeltaByItemId: Map<string, string>;
  terminalProcessByItemId: Map<string, string>;
};

export class CodexAcpAgent implements Agent {
  private readonly sessions = new Map<string, SessionState>();
  private readonly client: AgentSideConnection;
  private closed = false;
  private lifecycleHooksInstalled = false;
  private static readonly STATIC_AVAILABLE_COMMANDS: AvailableCommand[] = [
    { name: "review", description: "Run code review in current thread." },
    { name: "review-branch", description: "Review current git branch." },
    { name: "review-commit", description: "Review a specific commit." },
    { name: "init", description: "Initialize project scaffold/instructions." },
    { name: "compact", description: "Compact conversation context." },
    { name: "logout", description: "Logout current account/session." },
  ];

  constructor(client: AgentSideConnection) {
    this.client = client;
  }

  async initialize(_request: InitializeRequest): Promise<InitializeResponse> {
    this.installLifecycleHooks();

    return {
      protocolVersion: 1,
      agentInfo: {
        name: PACKAGE_NAME,
        title: "Codex ACP Bridge",
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: {},
          close: {},
          resume: {},
          fork: {},
        },
      },
      authMethods: [
        {
          id: "codex-cli-auth",
          name: "Codex CLI Auth",
          description: "Authenticate using existing Codex CLI login or API key environment variables.",
        },
      ],
    };
  }

  private installLifecycleHooks(): void {
    if (this.lifecycleHooksInstalled) {
      return;
    }
    this.lifecycleHooksInstalled = true;
    this.client.signal.addEventListener("abort", () => {
      void this.closeAllSessions();
    });
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    return;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const rpc = new CodexAppServerRpc();
    await rpc.start();

    const modelState = await this.loadModelState(rpc);
    const threadConfig = buildThreadConfigFromAcpMcpServers(params.mcpServers);
    const startResponse = (await rpc.request("thread/start", {
      cwd: params.cwd,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      sandbox: DEFAULT_SANDBOX,
      experimentalRawEvents: false,
      persistExtendedHistory: DEFAULT_PERSIST_EXTENDED_HISTORY,
      model: modelState.currentModelId,
      ...(threadConfig ? { config: threadConfig } : {}),
    })) as ThreadStartResponse;

    const currentModeId = mapApprovalPolicyToModeId(startResponse.approvalPolicy);
    const modes = buildModeState(currentModeId);
    const configOptions = buildConfigOptions(modes, modelState);
    const sessionId = startResponse.thread.id;

    const session: SessionState = {
      sessionId,
      rpc,
      threadId: startResponse.thread.id,
      cwd: startResponse.cwd ?? params.cwd,
      modes,
      models: modelState,
      configOptions,
      currentModeId,
      currentModelId: modelState.currentModelId,
      promptWaiter: null,
      planDeltaByItemId: new Map(),
      terminalProcessByItemId: new Map(),
    };

    rpc.setNotificationHandler((notification) => this.handleNotification(session, notification));
    rpc.setServerRequestHandler((request) => this.handleServerRequest(session, request));

    this.sessions.set(sessionId, session);
    await this.sendAvailableCommandsUpdate(sessionId);

    return {
      sessionId,
      modes: session.modes,
      models: session.models,
      configOptions: session.configOptions,
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const rpc = new CodexAppServerRpc();
    await rpc.start();

    const modelState = await this.loadModelState(rpc);
    const threadConfig = buildThreadConfigFromAcpMcpServers(params.mcpServers);
    const resumeResponse = (await rpc.request("thread/resume", {
      threadId: params.sessionId,
      cwd: params.cwd,
      persistExtendedHistory: true,
      model: modelState.currentModelId,
      ...(threadConfig ? { config: threadConfig } : {}),
    })) as ThreadResumeResponse;

    const currentModeId = mapApprovalPolicyToModeId(resumeResponse.approvalPolicy);
    const modes = buildModeState(currentModeId);
    const configOptions = buildConfigOptions(modes, modelState);

    const session: SessionState = {
      sessionId: params.sessionId,
      rpc,
      threadId: resumeResponse.thread.id,
      cwd: resumeResponse.cwd ?? params.cwd,
      modes,
      models: modelState,
      configOptions,
      currentModeId,
      currentModelId: modelState.currentModelId,
      promptWaiter: null,
      planDeltaByItemId: new Map(),
      terminalProcessByItemId: new Map(),
    };

    rpc.setNotificationHandler((notification) => this.handleNotification(session, notification));
    rpc.setServerRequestHandler((request) => this.handleServerRequest(session, request));

    this.sessions.set(params.sessionId, session);
    await this.sendAvailableCommandsUpdate(params.sessionId);

    await replayThreadHistory(this.client, session.sessionId, resumeResponse.thread);

    return {
      modes,
      models: modelState,
      configOptions,
    };
  }

  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const rpc = new CodexAppServerRpc();
    await rpc.start();

    const modelState = await this.loadModelState(rpc);
    const threadConfig = buildThreadConfigFromAcpMcpServers(params.mcpServers ?? []);
    const resumeResponse = (await rpc.request("thread/resume", {
      threadId: params.sessionId,
      cwd: params.cwd,
      persistExtendedHistory: true,
      model: modelState.currentModelId,
      ...(threadConfig ? { config: threadConfig } : {}),
    })) as ThreadResumeResponse;

    const currentModeId = mapApprovalPolicyToModeId(resumeResponse.approvalPolicy);
    const modes = buildModeState(currentModeId);
    const configOptions = buildConfigOptions(modes, modelState);

    const session: SessionState = {
      sessionId: params.sessionId,
      rpc,
      threadId: resumeResponse.thread.id,
      cwd: resumeResponse.cwd ?? params.cwd,
      modes,
      models: modelState,
      configOptions,
      currentModeId,
      currentModelId: modelState.currentModelId,
      promptWaiter: null,
      planDeltaByItemId: new Map(),
      terminalProcessByItemId: new Map(),
    };

    rpc.setNotificationHandler((notification) => this.handleNotification(session, notification));
    rpc.setServerRequestHandler((request) => this.handleServerRequest(session, request));

    this.sessions.set(params.sessionId, session);
    await this.sendAvailableCommandsUpdate(params.sessionId);

    return {
      modes,
      models: modelState,
      configOptions,
    };
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const rpc = new CodexAppServerRpc();
    await rpc.start();

    const modelState = await this.loadModelState(rpc);
    const threadConfig = buildThreadConfigFromAcpMcpServers(params.mcpServers ?? []);
    const forkResponse = (await rpc.request("thread/fork", {
      threadId: params.sessionId,
      cwd: params.cwd,
      persistExtendedHistory: true,
      model: modelState.currentModelId,
      ...(threadConfig ? { config: threadConfig } : {}),
    })) as ThreadForkResponse;

    const currentModeId = mapApprovalPolicyToModeId(forkResponse.approvalPolicy);
    const modes = buildModeState(currentModeId);
    const configOptions = buildConfigOptions(modes, modelState);
    const forkedSessionId = forkResponse.thread.id;

    const session: SessionState = {
      sessionId: forkedSessionId,
      rpc,
      threadId: forkResponse.thread.id,
      cwd: forkResponse.cwd ?? params.cwd,
      modes,
      models: modelState,
      configOptions,
      currentModeId,
      currentModelId: modelState.currentModelId,
      promptWaiter: null,
      planDeltaByItemId: new Map(),
      terminalProcessByItemId: new Map(),
    };

    rpc.setNotificationHandler((notification) => this.handleNotification(session, notification));
    rpc.setServerRequestHandler((request) => this.handleServerRequest(session, request));

    this.sessions.set(forkedSessionId, session);
    await this.sendAvailableCommandsUpdate(forkedSessionId);

    return {
      sessionId: forkedSessionId,
      modes,
      models: modelState,
      configOptions,
    };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const rpc = new CodexAppServerRpc();
    await rpc.start();

    try {
      const response = (await rpc.request("thread/list", {
        cursor: params.cursor ?? null,
        cwd: params.cwd ?? null,
      })) as ThreadListResponse;

      const sessions: SessionInfo[] = (response.data ?? []).map((thread) => ({
        sessionId: thread.id,
        cwd: thread.cwd,
        title: thread.name ?? toSessionTitle(thread.preview),
        updatedAt:
          typeof thread.updatedAt === "number" ? new Date(thread.updatedAt * 1000).toISOString() : undefined,
      }));

      return {
        sessions,
        nextCursor: response.nextCursor ?? null,
      };
    } finally {
      await rpc.stop();
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    if (session.promptWaiter) {
      throw RequestError.invalidParams(undefined, "A turn is already running for this session.");
    }

    const input = await promptToCodexInput(params);

    const response = (await session.rpc.request("turn/start", {
      threadId: session.threadId,
      input,
      model: session.currentModelId,
      approvalPolicy: mapModeIdToApprovalPolicy(session.currentModeId),
    })) as { turn: { id: string } };

    const turnId: string = response.turn.id;

    const stopReason = await new Promise<StopReason>((resolve, reject) => {
      session.promptWaiter = { turnId, resolve, reject };
    }).finally(() => {
      session.promptWaiter = null;
    });

    return {
      stopReason,
      ...(params.messageId ? { userMessageId: params.messageId } : {}),
    };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.requireSession(params.sessionId);
    if (!session.promptWaiter) {
      return;
    }

    await session.rpc.request("turn/interrupt", {
      threadId: session.threadId,
      turnId: session.promptWaiter.turnId,
    });
  }

  async unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return {};
    }

    this.sessions.delete(params.sessionId);
    if (session.promptWaiter) {
      session.promptWaiter.resolve("cancelled");
      session.promptWaiter = null;
    }
    await session.rpc.stop();
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    const found = session.modes.availableModes.find((mode) => mode.id === params.modeId);
    if (!found) {
      throw RequestError.invalidParams(undefined, `Unsupported mode: ${params.modeId}`);
    }

    session.currentModeId = params.modeId;
    session.modes.currentModeId = params.modeId;
    session.configOptions = buildConfigOptions(session.modes, session.models);

    await this.client.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: session.currentModeId,
      },
    });

    return {};
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    const session = this.requireSession(params.sessionId);
    const found = session.models.availableModels.find((model) => model.modelId === params.modelId);
    if (!found) {
      throw RequestError.invalidParams(undefined, `Unsupported model: ${params.modelId}`);
    }

    session.currentModelId = params.modelId;
    session.models.currentModelId = params.modelId;
    session.configOptions = buildConfigOptions(session.modes, session.models);

    await this.client.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });

    return {};
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    const value = "value" in params ? params.value : undefined;

    if (params.configId === "mode" && typeof value === "string") {
      await this.setSessionMode({ sessionId: params.sessionId, modeId: value });
    } else if (params.configId === "model" && typeof value === "string") {
      await this.unstable_setSessionModel({ sessionId: params.sessionId, modelId: value });
    } else {
      throw RequestError.invalidParams(undefined, `Unsupported config option: ${params.configId}`);
    }

    return {
      configOptions: session.configOptions,
    };
  }

  private async loadModelState(rpc: CodexAppServerRpc): Promise<SessionModelState> {
    const response = (await rpc.request("model/list", {})) as ModelListResponse;
    const models = response.data ?? [];
    if (models.length === 0) {
      throw new Error("No models returned from codex app-server");
    }

    const defaultModel = models.find((model) => model.isDefault) ?? models[0]!;

    return {
      currentModelId: defaultModel.id,
      availableModels: models.map((model) => ({
        modelId: model.id,
        name: model.displayName ?? model.id,
        description: model.description ?? null,
      })),
    };
  }

  private requireSession(sessionId: string): SessionState {
    if (this.closed) {
      throw RequestError.internalError(undefined, "ACP connection already closed.");
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.resourceNotFound(sessionId);
    }
    return session;
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: CodexAcpAgent.STATIC_AVAILABLE_COMMANDS,
      },
    });
  }

  private async closeAllSessions(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();

    await Promise.all(
      sessions.map(async (session) => {
        if (session.promptWaiter) {
          session.promptWaiter.resolve("cancelled");
          session.promptWaiter = null;
        }
        await session.rpc.stop();
      }),
    );
  }

  private async handleNotification(session: SessionState, notification: CodexServerNotificationMessage): Promise<void> {
    switch (notification.method) {
      case "item/agentMessage/delta":
        {
          const p = notification.params as AgentMessageDeltaNotification;
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: p.delta ?? "" },
          },
        });
        return;
        }
      case "item/reasoning/textDelta":
        {
          const p = notification.params as ReasoningTextDeltaNotification;
          await this.client.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: p.delta ?? "" },
            },
          });
          return;
        }
      case "item/reasoning/summaryTextDelta":
        {
          const p = notification.params as ReasoningSummaryTextDeltaNotification;
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: p.delta ?? "" },
          },
        });
        return;
        }
      case "item/started":
        {
          const p = notification.params as ItemStartedNotification;
          await this.handleItemStarted(session, p.item);
        return;
        }
      case "item/plan/delta": {
        const p = notification.params as PlanDeltaNotification;
        const previous = session.planDeltaByItemId.get(p.itemId) ?? "";
        const next = previous + (p.delta ?? "");
        session.planDeltaByItemId.set(p.itemId, next);
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "plan",
            entries: [{ content: next, priority: "medium", status: "in_progress" }],
          },
        });
        return;
      }
      case "item/commandExecution/outputDelta":
        {
          const p = notification.params as CommandExecutionOutputDeltaNotification;
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: p.itemId,
            status: "in_progress",
            kind: "execute",
            rawOutput: p.delta ?? "",
            _meta: {
              terminal_output: {
                terminal_id: session.terminalProcessByItemId.get(p.itemId) ?? p.itemId,
                data: p.delta ?? "",
              },
            },
          },
        });
        return;
        }
      case "item/fileChange/outputDelta":
        {
          const p = notification.params as FileChangeOutputDeltaNotification;
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: p.itemId,
            status: "in_progress",
            kind: "edit",
            rawOutput: p.delta ?? "",
          },
        });
        return;
        }
      case "item/completed":
        {
          const p = notification.params as ItemCompletedNotification;
          await this.handleItemCompleted(session, p.item);
        return;
        }
      case "thread/tokenUsage/updated": {
        const p = notification.params as ThreadTokenUsageUpdatedNotification;
        const usage = p.tokenUsage?.last ?? p.tokenUsage?.total;
        if (!usage) {
          return;
        }
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "usage_update",
            size: p.tokenUsage?.modelContextWindow ?? 0,
            used: usage.totalTokens ?? 0,
          },
        });
        return;
      }
      case "thread/name/updated":
        {
        const p = notification.params as ThreadNameUpdatedNotification;
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: p.threadName ?? null,
          },
        });
        return;
        }
      case "turn/plan/updated":
        {
        const p = notification.params as TurnPlanUpdatedNotification;
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "plan",
            entries: (Array.isArray(p.plan) ? p.plan : []).map((entry: any) => ({
              content: entry.step ?? "",
              priority: "medium",
              status: entry.status === "inProgress" ? "in_progress" : entry.status ?? "pending",
            })),
          },
        });
        return;
        }
      case "turn/completed":
        {
        const p = notification.params as TurnCompletedNotification;
        if (session.promptWaiter && session.promptWaiter.turnId === p.turn?.id) {
          const status = p.turn?.status;
          const reason: StopReason =
            status === "interrupted" ? "cancelled" : status === "failed" ? "end_turn" : "end_turn";
          session.promptWaiter.resolve(reason);
        }
        return;
        }
      case "error":
        {
        const p = notification.params as ErrorNotification;
        if (session.promptWaiter && session.promptWaiter.turnId === p.turnId) {
          session.promptWaiter.resolve("end_turn");
        }
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `\n[Codex error] ${p.error?.message ?? "Unknown error"}\n`,
            },
          },
        });
        return;
        }
      default:
        return;
    }
  }

  private async handleItemStarted(session: SessionState, item: any): Promise<void> {
    if (!item || typeof item !== "object") {
      return;
    }

    if (item.type === "plan") {
      await this.client.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: item.text ?? "", priority: "medium", status: "in_progress" }],
        },
      });
      return;
    }

    if (item.type === "commandExecution" && item.processId) {
      session.terminalProcessByItemId.set(item.id, item.processId);
    }

    const toolCall = mapItemToToolCall(item, "pending");
    if (!toolCall) {
      return;
    }

    await this.client.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call",
        ...(item.type === "commandExecution" && item.processId
          ? { _meta: { terminal_info: { terminal_id: item.processId } } }
          : {}),
        ...toolCall,
      },
    });
  }

  private async handleItemCompleted(session: SessionState, item: any): Promise<void> {
    if (!item || typeof item !== "object") {
      return;
    }

    if (item.type === "agentMessage") {
      return;
    }

    if (item.type === "plan") {
      session.planDeltaByItemId.delete(item.id);
      await this.client.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: item.text ?? "", priority: "medium", status: "completed" }],
        },
      });
      return;
    }

    const toolCall = mapItemToToolCall(item, toolStatusFromItem(item));
    if (!toolCall) {
      return;
    }

    await this.client.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        ...(item.type === "commandExecution"
          ? {
              _meta: {
                terminal_exit: {
                  terminal_id: session.terminalProcessByItemId.get(item.id) ?? item.id,
                  exit_code: item.exitCode ?? 0,
                  signal: null,
                },
              },
            }
          : {}),
        ...toolCall,
      },
    });

    if (item.type === "commandExecution") {
      session.terminalProcessByItemId.delete(item.id);
    }
  }

  private async handleServerRequest(session: SessionState, request: CodexServerRequestMessage): Promise<unknown> {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return this.handleApprovalRequest(
          session,
          request.params as CommandExecutionRequestApprovalParams,
          "command",
        );
      case "item/fileChange/requestApproval":
        return this.handleApprovalRequest(
          session,
          request.params as FileChangeRequestApprovalParams,
          "file",
        );
      case "item/permissions/requestApproval":
        return this.handlePermissionsApprovalRequest(
          session,
          request.params as PermissionsRequestApprovalParams,
        );
      case "item/tool/requestUserInput":
        return this.handleToolRequestUserInput(
          session,
          request.params as ToolRequestUserInputParams,
        );
      case "item/tool/call":
        {
          const params = request.params as DynamicToolCallParams;
          const extResponse = await this.tryExtMethod("codex/dynamic_tool_call", params as Record<string, unknown>);
          if (extResponse && this.isDynamicToolCallResponse(extResponse)) {
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
      case "mcpServer/elicitation/request":
        {
          const params = request.params as McpServerElicitationRequestParams;
          const extResponse = await this.tryExtMethod(
            "codex/mcp_eliicitation_request",
            params as Record<string, unknown>,
          );
          if (extResponse && this.isMcpElicitationResponse(extResponse)) {
            return extResponse;
          }
          return {
            action: "decline",
            content: null,
            _meta: null,
          };
        }
      case "execCommandApproval":
        return this.handleLegacyExecCommandApproval(
          session,
          request.params as ExecCommandApprovalParams,
        );
      case "applyPatchApproval":
        return this.handleLegacyApplyPatchApproval(
          session,
          request.params as ApplyPatchApprovalParams,
        );
      case "account/chatgptAuthTokens/refresh":
        return {};
      default:
        throw new Error("Unsupported server request from codex app-server");
    }
  }

  private async handleApprovalRequest(
    session: SessionState,
    params: any,
    kind: "command" | "file",
  ): Promise<unknown> {
    const decisionMap = new Map<string, unknown>();

    const options = buildPermissionOptions(kind, params, decisionMap);

    const permissionRequest: RequestPermissionRequest = {
      sessionId: session.sessionId,
      options,
      toolCall: {
        toolCallId: params.itemId ?? randomUUID(),
        title: kind === "command" ? (params.command ?? "Execute command") : "Apply file changes",
      },
    };

    const permissionResponse: RequestPermissionResponse = await this.client.requestPermission(permissionRequest);
    const outcome = permissionResponse.outcome;

    if (outcome.outcome === "cancelled") {
      return kind === "command" ? { decision: "cancel" } : { decision: "cancel" };
    }

    const mapped = decisionMap.get(outcome.optionId);
    if (!mapped) {
      return kind === "command" ? { decision: "decline" } : { decision: "decline" };
    }

    return kind === "command" ? { decision: mapped } : { decision: mapped };
  }

  private async handlePermissionsApprovalRequest(
    session: SessionState,
    params: any,
  ): Promise<unknown> {
    const options = [
      {
        optionId: "allow_once",
        name: "Allow once",
        kind: "allow_once" as const,
      },
      {
        optionId: "reject_once",
        name: "Reject",
        kind: "reject_once" as const,
      },
    ];

    const permissionResponse = await this.client.requestPermission({
      sessionId: session.sessionId,
      options,
      toolCall: {
        toolCallId: params.itemId ?? randomUUID(),
        title: params.reason ?? "Grant additional permissions",
      },
    });

    if (permissionResponse.outcome.outcome === "selected" && permissionResponse.outcome.optionId === "allow_once") {
      return {
        permissions: params.permissions ?? {},
        scope: "turn",
      };
    }

    return {
      permissions: {},
      scope: "turn",
    };
  }

  private async handleToolRequestUserInput(
    _session: SessionState,
    params: ToolRequestUserInputParams,
  ): Promise<unknown> {
    const extResponse = await this.tryExtMethod(
      "codex/request_user_input",
      params as unknown as Record<string, unknown>,
    );
    if (extResponse && this.isToolRequestUserInputResponse(extResponse)) {
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
      if (options.length > 0) {
        // Best-effort fallback until ACP SDK exposes native request-user-input plumbing.
        answers[id] = { answers: [String(options[0]?.label ?? "")] };
      } else {
        answers[id] = { answers: [] };
      }
    }

    return { answers };
  }

  private async tryExtMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.client.extMethod(method, params);
    } catch {
      return null;
    }
  }

  private isToolRequestUserInputResponse(
    value: Record<string, unknown>,
  ): value is { answers: Record<string, { answers: string[] }> } {
    return typeof value.answers === "object" && value.answers !== null;
  }

  private isDynamicToolCallResponse(
    value: Record<string, unknown>,
  ): value is { success: boolean; contentItems: Array<{ type: string; text?: string; imageUrl?: string }> } {
    return typeof value.success === "boolean" && Array.isArray(value.contentItems);
  }

  private isMcpElicitationResponse(
    value: Record<string, unknown>,
  ): value is { action: "accept" | "decline" | "cancel"; content: unknown; _meta: unknown } {
    return (
      (value.action === "accept" || value.action === "decline" || value.action === "cancel") &&
      "content" in value &&
      "_meta" in value
    );
  }

  private async handleLegacyExecCommandApproval(
    session: SessionState,
    params: ExecCommandApprovalParams,
  ): Promise<unknown> {
    const options: RequestPermissionRequest["options"] = [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow for session", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ];
    const response = await this.client.requestPermission({
      sessionId: session.sessionId,
      options,
      toolCall: {
        toolCallId: params.callId,
        title: params.command.join(" "),
        rawInput: {
          cwd: params.cwd,
          reason: params.reason,
        },
      },
    });

    if (response.outcome.outcome !== "selected") {
      return { decision: "abort" };
    }

    if (response.outcome.optionId === "allow_once") {
      return { decision: "approved" };
    }
    if (response.outcome.optionId === "allow_always") {
      return { decision: "approved_for_session" };
    }
    return { decision: "denied" };
  }

  private async handleLegacyApplyPatchApproval(
    session: SessionState,
    params: ApplyPatchApprovalParams,
  ): Promise<unknown> {
    const options: RequestPermissionRequest["options"] = [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow for session", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ];
    const response = await this.client.requestPermission({
      sessionId: session.sessionId,
      options,
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

    if (response.outcome.outcome !== "selected") {
      return { decision: "abort" };
    }

    if (response.outcome.optionId === "allow_once") {
      return { decision: "approved" };
    }
    if (response.outcome.optionId === "allow_always") {
      return { decision: "approved_for_session" };
    }
    return { decision: "denied" };
  }
}
