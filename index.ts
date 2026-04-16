#!/usr/bin/env bun

import {
  AgentSideConnection,
  ndJsonStream,
  RequestError,
} from "@agentclientprotocol/sdk";
import type {
  Agent,
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
  McpServer,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import packageJson from "./package.json" with { type: "json" };

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const DEFAULT_APPROVAL_POLICY = "on-request";
const DEFAULT_SANDBOX = "workspace-write";
const DEFAULT_PERSIST_EXTENDED_HISTORY = true;

function nodeToWebWritable(nodeStream: NodeJS.WritableStream): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  });
}

function nodeToWebReadable(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer | string) => {
        const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(data));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type ServerRequestHandler = (request: JsonRpcRequest) => Promise<unknown>;
type NotificationHandler = (notification: JsonRpcNotification) => Promise<void>;

class CodexAppServerRpc {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private readBuffer = "";

  setNotificationHandler(handler: NotificationHandler) {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler: ServerRequestHandler) {
    this.serverRequestHandler = handler;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    this.child = spawn(CODEX_BIN, ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child.on("exit", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("codex app-server exited"));
      }
      this.pending.clear();
    });

    const child = this.child;
    if (!child) {
      throw new Error("Failed to start codex app-server");
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdoutData(chunk));

    await this.request("initialize", {
      clientInfo: {
        name: packageJson.name,
        version: packageJson.version,
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    this.child = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        resolve();
      }, 1500);
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    this.send(payload);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(payload: unknown): void {
    if (!this.child) {
      throw new Error("codex app-server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdoutData(chunk: string): void {
    this.readBuffer += chunk;

    while (true) {
      const newLineIndex = this.readBuffer.indexOf("\n");
      if (newLineIndex < 0) {
        break;
      }

      const line = this.readBuffer.slice(0, newLineIndex).trim();
      this.readBuffer = this.readBuffer.slice(newLineIndex + 1);
      if (!line) {
        continue;
      }

      this.handleLine(line).catch((error) => {
        console.error("[codex-acp] failed to handle app-server line", error);
      });
    }
  }

  private async handleLine(line: string): Promise<void> {
    const parsed = JSON.parse(line) as JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

    if (typeof parsed === "object" && parsed !== null && "id" in parsed && ("result" in parsed || "error" in parsed)) {
      const id = parsed.id;
      if (typeof id !== "number") {
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);

      if (parsed.error) {
        pending.reject(new Error(parsed.error.message));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if (typeof parsed === "object" && parsed !== null && "method" in parsed && "id" in parsed) {
      const request = parsed as JsonRpcRequest;
      if (!this.serverRequestHandler) {
        this.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: `No handler for server request method ${request.method}`,
          },
        });
        return;
      }

      try {
        const result = await this.serverRequestHandler(request);
        this.send({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        this.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (typeof parsed === "object" && parsed !== null && "method" in parsed) {
      if (this.notificationHandler) {
        await this.notificationHandler(parsed as JsonRpcNotification);
      }
    }
  }
}

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
};

class CodexAcpAgent implements Agent {
  private readonly sessions = new Map<string, SessionState>();
  private readonly client: AgentSideConnection;

  constructor(client: AgentSideConnection) {
    this.client = client;
  }

  async initialize(_request: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentInfo: {
        name: packageJson.name,
        title: "Codex ACP Bridge",
        version: packageJson.version,
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

    const toolCall = mapItemToToolCall(item, "pending");
    if (!toolCall) {
      return;
    }

    await this.client.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call",
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
        ...toolCall,
      },
    });
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
        return { answers: {} };
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
}

function buildPermissionOptions(
  kind: "command" | "file",
  params: any,
  decisionMap: Map<string, unknown>,
): RequestPermissionRequest["options"] {
  const options: RequestPermissionRequest["options"] = [];

  if (kind === "command") {
    const decisions = (params.availableDecisions ?? ["accept", "acceptForSession", "decline"]) as unknown[];
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
  } else {
    options.push({ optionId: "allow_once", name: "Allow once", kind: "allow_once" });
    decisionMap.set("allow_once", "accept");
    options.push({ optionId: "allow_always", name: "Always allow", kind: "allow_always" });
    decisionMap.set("allow_always", "acceptForSession");
    options.push({ optionId: "reject_once", name: "Reject", kind: "reject_once" });
    decisionMap.set("reject_once", "decline");
  }

  if (options.length === 0) {
    options.push({ optionId: "reject_once", name: "Reject", kind: "reject_once" });
    decisionMap.set("reject_once", "decline");
  }

  return options;
}

function promptToCodexInput(prompt: PromptRequest): any[] {
  const input: any[] = [];

  for (const block of prompt.prompt) {
    if (block.type === "text") {
      input.push({ type: "text", text: block.text, text_elements: [] });
      continue;
    }

    if (block.type === "resource_link") {
      input.push({
        type: "text",
        text: `Referenced resource: ${block.uri}`,
        text_elements: [],
      });
      continue;
    }

    if (block.type === "resource" && "text" in block.resource) {
      input.push({
        type: "text",
        text: `Resource ${block.resource.uri}\n\n${block.resource.text}`,
        text_elements: [],
      });
      continue;
    }

    if (block.type === "image") {
      if (block.uri && /^https?:\/\//.test(block.uri)) {
        input.push({ type: "image", url: block.uri });
      }
      continue;
    }
  }

  if (input.length === 0) {
    input.push({ type: "text", text: "", text_elements: [] });
  }

  return input;
}

function toolStatusFromItem(item: any): "completed" | "failed" {
  if (item.type === "commandExecution") {
    return item.status === "failed" ? "failed" : "completed";
  }
  if (item.type === "fileChange") {
    return item.status === "failed" ? "failed" : "completed";
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return item.status === "error" || item.success === false ? "failed" : "completed";
  }
  return "completed";
}

function mapItemToToolCall(item: any, status: "pending" | "completed" | "failed"):
  | {
      toolCallId: string;
      title: string;
      status?: "pending" | "completed" | "failed";
      kind?:
        | "read"
        | "edit"
        | "delete"
        | "move"
        | "search"
        | "execute"
        | "think"
        | "fetch"
        | "switch_mode"
        | "other";
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | null {
  switch (item.type) {
    case "commandExecution":
      return {
        toolCallId: item.id,
        title: item.command ?? "Execute command",
        status,
        kind: "execute",
        rawInput: {
          command: item.command,
          cwd: item.cwd,
        },
        rawOutput: item.aggregatedOutput,
      };
    case "fileChange":
      return {
        toolCallId: item.id,
        title: "Apply file changes",
        status,
        kind: "edit",
        rawOutput: item.changes,
      };
    case "mcpToolCall":
      return {
        toolCallId: item.id,
        title: `${item.server}:${item.tool}`,
        status,
        kind: "other",
        rawInput: item.arguments,
        rawOutput: item.result ?? item.error,
      };
    case "dynamicToolCall":
      return {
        toolCallId: item.id,
        title: item.tool,
        status,
        kind: "other",
        rawInput: item.arguments,
        rawOutput: item.contentItems,
      };
    case "webSearch":
      return {
        toolCallId: item.id,
        title: `Web search: ${item.query}`,
        status,
        kind: "fetch",
      };
    case "collabAgentToolCall":
      return {
        toolCallId: item.id,
        title: `Agent tool: ${item.tool}`,
        status,
        kind: "other",
        rawInput: {
          prompt: item.prompt,
          receiverThreadIds: item.receiverThreadIds,
        },
      };
    case "imageView":
      return {
        toolCallId: item.id,
        title: `View image: ${item.path}`,
        status,
        kind: "read",
      };
    case "imageGeneration":
      return {
        toolCallId: item.id,
        title: "Generate image",
        status,
        kind: "other",
        rawOutput: item.result,
      };
    default:
      return null;
  }
}

function toSessionTitle(preview: string | null | undefined): string | null {
  if (!preview) {
    return null;
  }
  const compact = preview.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}

function mapApprovalPolicyToModeId(approvalPolicy: unknown): string {
  if (approvalPolicy === "never") return "never";
  if (approvalPolicy === "untrusted") return "untrusted";
  if (approvalPolicy === "on-failure") return "on-failure";
  return "on-request";
}

function mapModeIdToApprovalPolicy(modeId: string): string {
  if (modeId === "never") return "never";
  if (modeId === "untrusted") return "untrusted";
  if (modeId === "on-failure") return "on-failure";
  return "on-request";
}

function buildModeState(currentModeId: string): SessionModeState {
  return {
    currentModeId,
    availableModes: [
      {
        id: "on-request",
        name: "On Request",
        description: "Prompt for sensitive operations.",
      },
      {
        id: "on-failure",
        name: "On Failure",
        description: "Prompt only when a sandboxed action fails.",
      },
      {
        id: "untrusted",
        name: "Untrusted",
        description: "Strict mode for untrusted repositories.",
      },
      {
        id: "never",
        name: "Never",
        description: "Never ask for approval.",
      },
    ],
  };
}

function modelConfigOption(models: SessionModelState): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    description: "Model used for this session.",
    category: "model",
    type: "select",
    currentValue: models.currentModelId,
    options: models.availableModels.map((model) => ({
      value: model.modelId,
      name: model.name,
      description: model.description,
    })),
  };
}

function modeConfigOption(modes: SessionModeState): SessionConfigOption {
  return {
    id: "mode",
    name: "Approval Mode",
    description: "Approval behavior for tool execution.",
    category: "mode",
    type: "select",
    currentValue: modes.currentModeId,
    options: modes.availableModes.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description,
    })),
  };
}

function buildConfigOptions(modes: SessionModeState, models: SessionModelState): SessionConfigOption[] {
  return [modeConfigOption(modes), modelConfigOption(models)];
}

function buildThreadConfigFromAcpMcpServers(mcpServers: McpServer[]): Record<string, unknown> | undefined {
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) {
    return undefined;
  }

  const codexMcpServers: Record<string, unknown> = {};

  for (const server of mcpServers) {
    const name = sanitizeMcpServerName(server.name);

    if ("command" in server) {
      const envMap =
        server.env.length > 0
          ? Object.fromEntries(server.env.map((entry: { name: string; value: string }) => [entry.name, entry.value]))
          : undefined;

      codexMcpServers[name] = {
        command: server.command,
        args: server.args,
        ...(envMap ? { env: envMap } : {}),
      };
      continue;
    }

    if ("type" in server && server.type === "http") {
      const headerMap =
        server.headers.length > 0
          ? Object.fromEntries(
              server.headers.map((header: { name: string; value: string }) => [header.name, header.value]),
            )
          : undefined;

      codexMcpServers[name] = {
        url: server.url,
        ...(headerMap ? { http_headers: headerMap } : {}),
      };
      continue;
    }

    // codex currently doesn't accept SSE transport config.
    console.error(`[codex-acp] ignoring unsupported MCP SSE server: ${server.name}`);
  }

  if (Object.keys(codexMcpServers).length === 0) {
    return undefined;
  }

  return {
    mcp_servers: codexMcpServers,
  };
}

function sanitizeMcpServerName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, "_");
  return trimmed.length > 0 ? trimmed : "mcp_server";
}

async function replayThreadHistory(
  client: AgentSideConnection,
  sessionId: string,
  thread: any,
): Promise<void> {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      if (item.type === "userMessage") {
        for (const part of item.content ?? []) {
          if (part.type === "text") {
            await client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                content: {
                  type: "text",
                  text: part.text ?? "",
                },
              },
            });
          }
        }
        continue;
      }

      if (item.type === "agentMessage") {
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: item.text ?? "",
            },
          },
        });
        continue;
      }

      const toolCall = mapItemToToolCall(item, "completed");
      if (!toolCall) {
        continue;
      }

      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          ...toolCall,
        },
      });
    }
  }
}

function runAcp(): void {
  // stdout is ACP transport; route app logs to stderr
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);

  new AgentSideConnection((client) => new CodexAcpAgent(client), stream);
}

runAcp();
