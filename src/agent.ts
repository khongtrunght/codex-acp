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
import { resolveSystemPromptFields } from "./system-prompt.ts";
import { buildThreadConfigFromAcpMcpServers } from "./thread-config.ts";
import { replayThreadHistory } from "./thread-replay.ts";
import { toSessionTitle } from "./tool-mapping.ts";
import type {
  ThreadForkResponse,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
} from "./app-server/protocol.ts";

/**
 * ACP agent that bridges an ACP client to the `codex app-server` JSON-RPC
 * protocol.
 *
 * Owns:
 *  - A single shared {@link CodexAppServerClient} (one subprocess for the
 *    whole bridge, shared across sessions).
 *  - A map of ACP session IDs to {@link CodexSession} instances, each of
 *    which wraps one Codex thread.
 *  - The model list, cached per ACP connection.
 *  - Extension-method capability flag and the shared {@link ApprovalBridge}.
 *
 * Lifecycle: constructed once per ACP connection. `initialize` records
 * client capabilities; `connection.signal` abort triggers `shutdown()`,
 * which closes every session and terminates the shared codex subprocess.
 */
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

  /**
   * ACP `initialize`. Records whether the client opted into the bridge's
   * extension methods (via `clientCapabilities._meta["codex-extension-methods"]`)
   * and advertises the bridge's session capabilities (list/close/resume/fork).
   */
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

  /**
   * ACP `session/new`. Issues `thread/start` on the shared codex client and
   * registers a new {@link CodexSession}. Honors `_meta.systemPrompt`
   * (string → `baseInstructions`; `{ append }` → `developerInstructions`)
   * and projects ACP MCP servers into `config.mcp_servers` on the thread.
   */
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const { client, models } = await this.acquireClientAndModels();
    const startResponse = await client.request<ThreadStartResponse>("thread/start", {
      cwd: params.cwd,
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      sandbox: DEFAULT_SANDBOX,
      experimentalRawEvents: false,
      persistExtendedHistory: DEFAULT_PERSIST_EXTENDED_HISTORY,
      model: models.currentModelId,
      ...resolveSystemPromptFields(params._meta),
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

  /**
   * ACP `session/load`. Dedupes: if the session is already tracked in this
   * connection, returns its current state without re-issuing `thread/resume`.
   * Otherwise resumes the thread, attaches a {@link CodexSession}, and
   * replays the thread history as ACP session updates.
   *
   * Note: Codex freezes instructions at thread creation, so `_meta.systemPrompt`
   * is ignored here (the thread keeps whatever prompt it was created with).
   */
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

  /**
   * ACP `session/resume` (unstable). Like `loadSession` but without history
   * replay — intended for clients that already rendered prior content.
   */
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

  /**
   * ACP `session/fork` (unstable). Issues `thread/fork` against an existing
   * Codex thread; the new thread gets a fresh ID but inherits the parent's
   * history up to the fork point. Honors `_meta.systemPrompt` since fork
   * creates a new thread.
   */
  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const { client, models } = await this.acquireClientAndModels();
    const forkResponse = await client.request<ThreadForkResponse>("thread/fork", {
      threadId: params.sessionId,
      cwd: params.cwd,
      persistExtendedHistory: true,
      model: models.currentModelId,
      ...resolveSystemPromptFields(params._meta),
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

  /**
   * ACP `session/list`. Reads every thread Codex knows about (optionally
   * filtered by `cwd`). Uses the shared client, so it does not spawn an
   * extra codex subprocess.
   */
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

  /**
   * ACP `session/prompt`. Delegates to the session's `prompt` method, which
   * sends `turn/start` and awaits `turn/completed` (or interruption).
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.requireSession(params.sessionId).prompt(params);
  }

  /**
   * ACP `session/cancel`. Sends `turn/interrupt` to Codex if a turn is
   * active. Safe to call when no turn is running.
   */
  async cancel(params: CancelNotification): Promise<void> {
    await this.requireSession(params.sessionId).cancel();
  }

  /**
   * ACP `session/close` (unstable). Unregisters the session's handlers on
   * the shared client and cancels any active turn. Does NOT close the shared
   * client — other sessions may still be using it.
   */
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

  /**
   * Tears down every active session and clears the shared client so the
   * codex subprocess exits. Invoked when the ACP connection aborts.
   */
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

  /**
   * Returns the shared codex client and the cached model list. The model
   * list is fetched lazily on first call and reused across every session in
   * this connection; a failed fetch is not cached, so the next call retries.
   */
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
