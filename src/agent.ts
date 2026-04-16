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
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
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
import type { JsonRpcNotification, JsonRpcRequest } from "./types.ts";

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

  constructor(client: AgentSideConnection) {
    this.client = client;
  }

  async initialize(_request: InitializeRequest): Promise<InitializeResponse> {
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

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    return;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = randomUUID();
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
    })) as any;

    const currentModeId = mapApprovalPolicyToModeId(startResponse.approvalPolicy);
    const modes = buildModeState(currentModeId);
    const configOptions = buildConfigOptions(modes, modelState);

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
    })) as any;

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

    await replayThreadHistory(this.client, session.sessionId, resumeResponse.thread);

    return {
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
      })) as any;

      const sessions: SessionInfo[] = (response.data ?? []).map((thread: any) => ({
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

    const input = promptToCodexInput(params);

    const response = (await session.rpc.request("turn/start", {
      threadId: session.threadId,
      input,
      model: session.currentModelId,
      approvalPolicy: mapModeIdToApprovalPolicy(session.currentModeId),
    })) as any;

    const turnId: string = response.turn.id;

    const stopReason = await new Promise<StopReason>((resolve, reject) => {
      session.promptWaiter = { turnId, resolve, reject };
    }).finally(() => {
      session.promptWaiter = null;
    });

    return {
      stopReason,
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
    const response = (await rpc.request("model/list", {})) as any;
    const models = (response.data ?? []) as any[];
    if (models.length === 0) {
      throw new Error("No models returned from codex app-server");
    }

    const defaultModel = models.find((model) => model.isDefault) ?? models[0];

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
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.resourceNotFound(sessionId);
    }
    return session;
  }

  private async handleNotification(session: SessionState, notification: JsonRpcNotification): Promise<void> {
    const { method, params } = notification;
    const p = (params ?? {}) as any;

    switch (method) {
      case "item/agentMessage/delta":
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: p.delta ?? "" },
          },
        });
        return;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: p.delta ?? "" },
          },
        });
        return;
      case "item/started":
        await this.handleItemStarted(session, p.item);
        return;
      case "item/plan/delta": {
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
      case "item/fileChange/outputDelta":
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
      case "item/completed":
        await this.handleItemCompleted(session, p.item);
        return;
      case "thread/tokenUsage/updated": {
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
        await this.client.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: p.name ?? null,
          },
        });
        return;
      case "turn/plan/updated":
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
      case "turn/completed":
        if (session.promptWaiter && session.promptWaiter.turnId === p.turn?.id) {
          const status = p.turn?.status;
          const reason: StopReason =
            status === "interrupted" ? "cancelled" : status === "failed" ? "end_turn" : "end_turn";
          session.promptWaiter.resolve(reason);
        }
        return;
      case "error":
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

  private async handleServerRequest(session: SessionState, request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case "item/commandExecution/requestApproval":
        return this.handleApprovalRequest(session, request.params as any, "command");
      case "item/fileChange/requestApproval":
        return this.handleApprovalRequest(session, request.params as any, "file");
      case "item/permissions/requestApproval":
        return this.handlePermissionsApprovalRequest(session, request.params as any);
      case "item/tool/requestUserInput":
        return this.handleToolRequestUserInput(session, request.params as any);
      case "item/tool/call":
        return {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "Dynamic tool call is not supported by this ACP bridge yet.",
            },
          ],
        };
      case "mcpServer/elicitation/request":
        return {
          action: "decline",
          content: null,
          _meta: null,
        };
      case "account/chatgptAuthTokens/refresh":
        return {};
      default:
        throw new Error(`Unsupported server request from codex app-server: ${request.method}`);
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
    params: any,
  ): Promise<unknown> {
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
}
