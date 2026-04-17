import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../meta.ts";
import {
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.ts";
import { logger } from "./logger.ts";
import {
  type CodexInitializeResponse,
  type CodexServerNotification,
  type JsonValue,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
  isRpcResponse,
} from "./protocol.ts";
import { createStdioTransport } from "./transport-stdio.ts";
import { closeCodexAppServerTransport, type CodexAppServerTransport } from "./transport.ts";

export const MIN_CODEX_APP_SERVER_VERSION = "0.118.0";

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** Error thrown when the Codex app-server responds with a JSON-RPC error. */
export class CodexAppServerRpcError extends Error {
  readonly code?: number;
  readonly data?: JsonValue;

  constructor(error: { code?: number; message: string; data?: JsonValue }, method: string) {
    super(error.message || `${method} failed`);
    this.name = "CodexAppServerRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export type CodexServerRequestHandler = (
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
) => Promise<JsonValue | undefined> | JsonValue | undefined;

export type CodexServerNotificationHandler = (
  notification: CodexServerNotification,
) => Promise<void> | void;

/**
 * JSON-RPC client for `codex app-server` over stdio.
 *
 * Spawns (or adopts) the codex subprocess, serializes JSON-RPC frames over
 * stdin, parses newline-delimited frames from stdout, and multiplexes:
 *  - outgoing `request` calls keyed by numeric ID, with optional
 *    per-call timeout and `AbortSignal` cancellation;
 *  - incoming notifications fanned out to every registered handler;
 *  - incoming server-requests tried against each registered handler in
 *    insertion order — the first handler to return a non-`undefined`
 *    result wins; if none respond, {@link defaultServerRequestResponse}
 *    is used.
 *
 * Construct with {@link CodexAppServerClient.start} and then call
 * {@link initialize} before any other request (the handshake enforces the
 * minimum codex app-server version).
 */
export class CodexAppServerClient {
  private readonly child: CodexAppServerTransport;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestHandlers = new Set<CodexServerRequestHandler>();
  private readonly notificationHandlers = new Set<CodexServerNotificationHandler>();
  private readonly closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  private nextId = 1;
  private initialized = false;
  private closed = false;

  private constructor(child: CodexAppServerTransport) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        logger.debug(`codex app-server stderr: ${text}`);
      }
    });
    child.once("error", (error) =>
      this.closeWithError(error instanceof Error ? error : new Error(String(error))),
    );
    child.once("exit", (code, signal) => {
      this.closeWithError(
        new Error(
          `codex app-server exited: code=${formatExitValue(code)} signal=${formatExitValue(signal)}`,
        ),
      );
    });
  }

  /**
   * Spawns a codex subprocess using defaults from
   * {@link resolveCodexAppServerRuntimeOptions}. Any provided fields
   * override the defaults.
   */
  static start(options?: Partial<CodexAppServerStartOptions>): CodexAppServerClient {
    const defaults = resolveCodexAppServerRuntimeOptions().start;
    const startOptions: CodexAppServerStartOptions = {
      command: options?.command ?? defaults.command,
      args: options?.args ?? defaults.args,
      headers: options?.headers ?? defaults.headers,
    };
    return new CodexAppServerClient(createStdioTransport(startOptions));
  }

  /** Test escape hatch: build a client around a pre-made transport mock. */
  static fromTransportForTests(child: CodexAppServerTransport): CodexAppServerClient {
    return new CodexAppServerClient(child);
  }

  /**
   * Performs the Codex `initialize` handshake and validates the reported
   * version meets {@link MIN_CODEX_APP_SERVER_VERSION}. Safe to call
   * multiple times (subsequent calls are no-ops).
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const response = await this.request<CodexInitializeResponse>("initialize", {
      clientInfo: {
        name: PACKAGE_NAME,
        title: "Codex ACP Bridge",
        version: PACKAGE_VERSION,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    assertSupportedCodexAppServerVersion(response);
    this.notify("initialized");
    this.initialized = true;
  }

  /**
   * Sends a JSON-RPC request and awaits its response. Supply a `timeoutMs`
   * (rounded up to 100 ms) or a precreated `AbortSignal` to cancel an
   * in-flight call. Rejects with {@link CodexAppServerRpcError} on a
   * protocol-level error and a plain `Error` on timeout, abort, or client
   * close.
   */
  request<T = JsonValue | undefined>(
    method: string,
    params?: JsonValue,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server client is closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error(`${method} aborted`));
    }
    const id = this.nextId++;
    const message: RpcRequest = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupAbort: (() => void) | undefined;
      const cleanup = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        cleanupAbort?.();
        cleanupAbort = undefined;
      };
      const rejectPending = (error: Error): void => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      if (options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        timeout = setTimeout(
          () => rejectPending(new Error(`${method} timed out`)),
          Math.max(100, options.timeoutMs),
        );
        timeout.unref?.();
      }
      if (options.signal) {
        const abortListener = (): void => rejectPending(new Error(`${method} aborted`));
        options.signal.addEventListener("abort", abortListener, { once: true });
        cleanupAbort = (): void => options.signal?.removeEventListener("abort", abortListener);
      }
      this.pending.set(id, {
        method,
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      });
      if (options.signal?.aborted) {
        rejectPending(new Error(`${method} aborted`));
        return;
      }
      try {
        this.writeMessage(message);
      } catch (error) {
        rejectPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Sends a JSON-RPC notification (no response expected). */
  notify(method: string, params?: JsonValue): void {
    this.writeMessage({ method, params });
  }

  /**
   * Registers a server-request handler. Handlers run in insertion order;
   * the first to return a non-`undefined` value produces the reply.
   * Returns a dispose fn that unregisters the handler.
   */
  addRequestHandler(handler: CodexServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  /**
   * Registers a notification handler. All handlers run for every
   * notification; callers should filter internally (e.g. by `threadId`).
   * Returns a dispose fn.
   */
  addNotificationHandler(handler: CodexServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Registers a callback invoked when the client closes (normally or due to subprocess exit). */
  addCloseHandler(handler: (client: CodexAppServerClient) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /**
   * Rejects every in-flight request, fires close handlers, and terminates
   * the transport. Idempotent.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lines.close();
    this.rejectPendingRequests(new Error("codex app-server client is closed"));
    closeCodexAppServerTransport(this.child);
  }

  private writeMessage(message: RpcRequest | RpcResponse): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      logger.warn("failed to parse codex app-server message", { error });
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const message = parsed as RpcMessage;
    if (isRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    if (!("method" in message)) {
      return;
    }
    if ("id" in message && message.id !== undefined) {
      void this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }
    this.handleNotification({
      method: message.method,
      params: message.params,
    });
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new CodexAppServerRpcError(response.error, pending.method));
      return;
    }
    pending.resolve(response.result);
  }

  private async handleServerRequest(
    request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
  ): Promise<void> {
    try {
      for (const handler of this.requestHandlers) {
        const result = await handler(request);
        if (result !== undefined) {
          this.writeMessage({ id: request.id, result });
          return;
        }
      }
      this.writeMessage({ id: request.id, result: defaultServerRequestResponse(request) });
    } catch (error) {
      this.writeMessage({
        id: request.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private handleNotification(notification: CodexServerNotification): void {
    for (const handler of this.notificationHandlers) {
      Promise.resolve(handler(notification)).catch((error: unknown) => {
        logger.warn("codex app-server notification handler failed", { error });
      });
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPendingRequests(error);
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) {
      handler(this);
    }
  }
}

/**
 * Default reply used when no registered handler answers a server-request.
 * Returns a polite decline for approvals / tool calls / elicitation, and
 * an empty object for anything else.
 */
export function defaultServerRequestResponse(
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
): JsonValue {
  if (request.method === "item/tool/call") {
    return {
      contentItems: [
        {
          type: "inputText",
          text: "codex-acp-bridge did not register a handler for this app-server tool call.",
        },
      ],
      success: false,
    };
  }
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline" };
  }
  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (isCodexAppServerApprovalRequest(request.method)) {
    return {
      decision: "decline",
      reason: "codex-acp-bridge did not handle this approval request.",
    };
  }
  if (request.method === "item/tool/requestUserInput") {
    return { answers: {} };
  }
  if (request.method === "mcpServer/elicitation/request") {
    return { action: "decline" };
  }
  return {};
}

function assertSupportedCodexAppServerVersion(response: CodexInitializeResponse): void {
  const detectedVersion = readCodexVersionFromUserAgent(response.userAgent);
  if (!detectedVersion) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but the bridge could not determine the running Codex version. Upgrade Codex CLI and retry.`,
    );
  }
  if (compareVersions(detectedVersion, MIN_CODEX_APP_SERVER_VERSION) < 0) {
    throw new Error(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected ${detectedVersion}. Upgrade Codex CLI and retry.`,
    );
  }
}

/** Extracts the semver prefix from a `name/<version> ...` user agent string. */
export function readCodexVersionFromUserAgent(userAgent: string | undefined): string | undefined {
  const match = userAgent?.match(
    /^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)/,
  );
  return match?.[1];
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

function numericVersionParts(version: string): number[] {
  return (version.split(/[+-]/, 1)[0] ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

/** True when the method name looks like a Codex approval server-request. */
export function isCodexAppServerApprovalRequest(method: string): boolean {
  return method.includes("requestApproval") || method.includes("Approval");
}

function formatExitValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "unknown";
}
