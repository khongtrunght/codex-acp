import { RequestError } from "@agentclientprotocol/sdk";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionInfo,
  SessionModelState,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import { ApprovalBridge } from "./approval-bridge.ts";
import type { CodexAppServerClient } from "./app-server/client.ts";
import type { JsonObject } from "./app-server/protocol.ts";
import {
  clearSharedCodexAppServerClient,
  getSharedCodexAppServerClient,
} from "./app-server/shared-client.ts";
import { sendAvailableCommandsUpdate } from "./available-commands.ts";
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_PERSIST_EXTENDED_HISTORY,
  DEFAULT_SANDBOX,
} from "./constants.ts";
import { CLIENT_EXTENSION_CAPABILITY_KEY, ExtensionClient } from "./extension.ts";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./meta.ts";
import { loadModelState } from "./modes.ts";
import { CodexSession } from "./session-manager.ts";
import { buildThreadConfigFromAcpMcpServers } from "./thread-config.ts";
import { replayThreadHistory } from "./thread-replay.ts";
import { toSessionTitle } from "./tool-mapping.ts";
import type {
  ThreadForkResponse,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
} from "./app-server/protocol.ts";

export class CodexAcpAgent implements Agent {
  private readonly sessions = new Map<string, CodexSession>();
  private readonly connection: AgentSideConnection;
  private closed = false;
  private lifecycleHooksInstalled = false;
  private extensions: ExtensionClient;
  private readonly approvals: ApprovalBridge;
  private modelsPromise: Promise<SessionModelState> | null = null;

  constructor(connection: AgentSideConnection) {
    this.connection = connection;
    this.extensions = new ExtensionClient(connection, false);
    this.approvals = new ApprovalBridge(connection);
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.installLifecycleHooks();
    const extensionsEnabled =
      request.clientCapabilities?._meta?.[CLIENT_EXTENSION_CAPABILITY_KEY] === true;
    this.extensions = new ExtensionClient(this.connection, extensionsEnabled);

    return {
      protocolVersion: 1,
      agentInfo: {
        name: PACKAGE_NAME,
        title: "Codex ACP Bridge",
        version: PACKAGE_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
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
          description:
            "Authenticate using existing Codex CLI login or API key environment variables.",
        },
      ],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    return;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const { client, models } = await this.acquireClientAndModels();
    const startResponse = await client.request<ThreadStartResponse>("thread/start", {
      cwd: params.cwd,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      sandbox: DEFAULT_SANDBOX,
      experimentalRawEvents: false,
      persistExtendedHistory: DEFAULT_PERSIST_EXTENDED_HISTORY,
      model: models.currentModelId,
      ...(this.threadConfigOrUndefined(params.mcpServers) ?? {}),
    });

    const sessionId = startResponse.thread.id;
    const session = this.trackSession(
      new CodexSession({
        sessionId,
        cwd: startResponse.cwd ?? params.cwd,
        threadId: startResponse.thread.id,
        approvalPolicy: startResponse.approvalPolicy,
        client,
        connection: this.connection,
        models,
        extensions: this.extensions,
        approvals: this.approvals,
      }),
    );

    await sendAvailableCommandsUpdate(this.connection, sessionId, this.extensions);

    return {
      sessionId,
      modes: session.modes,
      models: session.models,
      configOptions: session.configOptions,
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      return {
        modes: existing.modes,
        models: existing.models,
        configOptions: existing.configOptions,
      };
    }

    const { client, models } = await this.acquireClientAndModels();
    const resumeResponse = await client.request<ThreadResumeResponse>("thread/resume", {
      threadId: params.sessionId,
      cwd: params.cwd,
      persistExtendedHistory: true,
      model: models.currentModelId,
      ...(this.threadConfigOrUndefined(params.mcpServers) ?? {}),
    });

    const session = this.trackSession(
      new CodexSession({
        sessionId: params.sessionId,
        cwd: resumeResponse.cwd ?? params.cwd,
        threadId: resumeResponse.thread.id,
        approvalPolicy: resumeResponse.approvalPolicy,
        client,
        connection: this.connection,
        models,
        extensions: this.extensions,
        approvals: this.approvals,
      }),
    );

    await sendAvailableCommandsUpdate(this.connection, params.sessionId, this.extensions);
    await replayThreadHistory(this.connection, session.sessionId, resumeResponse.thread);

    return {
      modes: session.modes,
      models: session.models,
      configOptions: session.configOptions,
    };
  }

  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      return {
        modes: existing.modes,
        models: existing.models,
        configOptions: existing.configOptions,
      };
    }

    const { client, models } = await this.acquireClientAndModels();
    const resumeResponse = await client.request<ThreadResumeResponse>("thread/resume", {
      threadId: params.sessionId,
      cwd: params.cwd,
      persistExtendedHistory: true,
      model: models.currentModelId,
      ...(this.threadConfigOrUndefined(params.mcpServers) ?? {}),
    });

    const session = this.trackSession(
      new CodexSession({
        sessionId: params.sessionId,
        cwd: resumeResponse.cwd ?? params.cwd,
        threadId: resumeResponse.thread.id,
        approvalPolicy: resumeResponse.approvalPolicy,
        client,
        connection: this.connection,
        models,
        extensions: this.extensions,
        approvals: this.approvals,
      }),
    );

    await sendAvailableCommandsUpdate(this.connection, params.sessionId, this.extensions);

    return {
      modes: session.modes,
      models: session.models,
      configOptions: session.configOptions,
    };
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const { client, models } = await this.acquireClientAndModels();
    const forkResponse = await client.request<ThreadForkResponse>("thread/fork", {
      threadId: params.sessionId,
      cwd: params.cwd,
      persistExtendedHistory: true,
      model: models.currentModelId,
      ...(this.threadConfigOrUndefined(params.mcpServers) ?? {}),
    });

    const forkedSessionId = forkResponse.thread.id;
    const session = this.trackSession(
      new CodexSession({
        sessionId: forkedSessionId,
        cwd: forkResponse.cwd ?? params.cwd,
        threadId: forkResponse.thread.id,
        approvalPolicy: forkResponse.approvalPolicy,
        client,
        connection: this.connection,
        models,
        extensions: this.extensions,
        approvals: this.approvals,
      }),
    );

    await sendAvailableCommandsUpdate(this.connection, forkedSessionId, this.extensions);

    return {
      sessionId: forkedSessionId,
      modes: session.modes,
      models: session.models,
      configOptions: session.configOptions,
    };
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const client = await getSharedCodexAppServerClient();
    const response = await client.request<ThreadListResponse>("thread/list", {
      cursor: params.cursor ?? null,
      cwd: params.cwd ?? null,
    });

    const sessions: SessionInfo[] = (response.data ?? []).map((thread) => ({
      sessionId: thread.id,
      cwd: thread.cwd ?? "",
      title: thread.name ?? toSessionTitle(thread.preview),
      updatedAt:
        typeof thread.updatedAt === "number"
          ? new Date(thread.updatedAt * 1000).toISOString()
          : undefined,
    }));

    return {
      sessions,
      nextCursor: response.nextCursor ?? null,
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.requireSession(params.sessionId).prompt(params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.requireSession(params.sessionId).cancel();
  }

  async unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return {};
    }
    this.sessions.delete(params.sessionId);
    await session.close();
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    await this.requireSession(params.sessionId).setMode(params.modeId);
    return {};
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse> {
    await this.requireSession(params.sessionId).setModel(params.modelId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    const value = "value" in params ? params.value : undefined;
    if (params.configId === "mode" && typeof value === "string") {
      await session.setMode(value);
    } else if (params.configId === "model" && typeof value === "string") {
      await session.setModel(value);
    } else {
      throw RequestError.invalidParams(
        undefined,
        `Unsupported config option: ${params.configId}`,
      );
    }
    return { configOptions: session.configOptions };
  }

  private trackSession(session: CodexSession): CodexSession {
    this.sessions.set(session.sessionId, session);
    return session;
  }

  private requireSession(sessionId: string): CodexSession {
    if (this.closed) {
      throw RequestError.internalError(undefined, "ACP connection already closed.");
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.resourceNotFound(sessionId);
    }
    return session;
  }

  private installLifecycleHooks(): void {
    if (this.lifecycleHooksInstalled) {
      return;
    }
    this.lifecycleHooksInstalled = true;
    this.connection.signal.addEventListener("abort", () => {
      void this.shutdown();
    });
  }

  private async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
    this.modelsPromise = null;
    clearSharedCodexAppServerClient();
  }

  private async acquireClientAndModels(): Promise<{
    client: CodexAppServerClient;
    models: SessionModelState;
  }> {
    const client = await getSharedCodexAppServerClient();
    this.modelsPromise ??= loadModelState(client).catch((error) => {
      // Don't cache a failed lookup; the next call retries.
      this.modelsPromise = null;
      throw error;
    });
    const models = await this.modelsPromise;
    return { client, models };
  }

  private threadConfigOrUndefined(
    mcpServers: McpServer[] | undefined,
  ): { config: JsonObject } | undefined {
    const config = buildThreadConfigFromAcpMcpServers(mcpServers);
    return config ? { config } : undefined;
  }
}
