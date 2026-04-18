import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  CodexAppServerClient,
  CodexAppServerRpcError,
  isCodexAppServerApprovalRequest,
  MIN_CODEX_APP_SERVER_VERSION,
  readCodexVersionFromUserAgent,
} from "./client.ts";
import { closeCodexAppServerTransport, type CodexAppServerTransport } from "./transport.ts";

type ClientHarness = {
  client: CodexAppServerClient;
  process: EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof mock>;
  };
  writes: string[];
  send: (message: unknown) => void;
};

function createClientHarness(): ClientHarness {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: mock(() => {
      process.killed = true;
      return true;
    }),
  });
  const client = CodexAppServerClient.fromTransportForTests(
    process as unknown as CodexAppServerTransport,
  );
  return {
    client,
    process,
    writes,
    send: (message) => {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type OutboundFrame = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

function takeOutbound(writes: string[], index = 0): OutboundFrame {
  return JSON.parse(writes[index] ?? "{}") as OutboundFrame;
}

const activeClients: CodexAppServerClient[] = [];

afterEach(() => {
  for (const client of activeClients) {
    client.close();
  }
  activeClients.length = 0;
});

describe("CodexAppServerClient", () => {
  test("routes request responses by id", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const pending = harness.client.request("model/list", {});
    await waitFor(() => harness.writes.length === 1);
    const outbound = takeOutbound(harness.writes);
    harness.send({ id: outbound.id, result: { models: [] } });

    await expect(pending).resolves.toEqual({ models: [] });
    expect(outbound.method).toBe("model/list");
  });

  test("preserves JSON-RPC error codes and data", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const pending = harness.client.request("future/method", {});
    await waitFor(() => harness.writes.length === 1);
    const outbound = takeOutbound(harness.writes);
    harness.send({
      id: outbound.id,
      error: { code: -32601, message: "Method not found", data: { detail: "x" } },
    });

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodexAppServerRpcError);
    const rpcError = caught as CodexAppServerRpcError;
    expect(rpcError.code).toBe(-32601);
    expect(rpcError.message).toBe("Method not found");
    expect(rpcError.data).toEqual({ detail: "x" });
  });

  test("rejects timed-out requests and ignores late responses", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const pending = harness.client.request("model/list", {}, { timeoutMs: 50 });
    await waitFor(() => harness.writes.length === 1);
    const outbound = takeOutbound(harness.writes);

    await expect(pending).rejects.toThrow("model/list timed out");

    harness.send({ id: outbound.id, result: { data: [] } });
    // Give the response loop a tick; late reply must not produce a new write.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.writes).toHaveLength(1);
  });

  test("rejects aborted requests and ignores late responses", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);
    const controller = new AbortController();

    const pending = harness.client.request("model/list", {}, { signal: controller.signal });
    await waitFor(() => harness.writes.length === 1);
    const outbound = takeOutbound(harness.writes);
    controller.abort();

    await expect(pending).rejects.toThrow("model/list aborted");

    harness.send({ id: outbound.id, result: { data: [] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.writes).toHaveLength(1);
  });

  test("rejects pre-aborted requests without writing to the transport", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);
    const controller = new AbortController();
    controller.abort();

    await expect(
      harness.client.request("model/list", {}, { signal: controller.signal }),
    ).rejects.toThrow("model/list aborted");
    expect(harness.writes).toHaveLength(0);
  });

  test("initializes with the required client version and sends initialized notification", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const initializing = harness.client.initialize();
    await waitFor(() => harness.writes.length === 1);
    const outbound = takeOutbound(harness.writes) as {
      id?: number;
      method?: string;
      params?: { clientInfo?: { name?: string; title?: string; version?: string } };
    };
    harness.send({
      id: outbound.id,
      result: { userAgent: "codex_cli_rs/0.118.0 (macOS; test)" },
    });

    await expect(initializing).resolves.toBeUndefined();
    expect(outbound.method).toBe("initialize");
    expect(outbound.params?.clientInfo?.name).toBeTruthy();
    expect(outbound.params?.clientInfo?.title).toBe("Codex ACP Bridge");
    expect(outbound.params?.clientInfo?.version).toBeTruthy();

    await waitFor(() => harness.writes.length === 2);
    expect(takeOutbound(harness.writes, 1)).toEqual({ method: "initialized" });
  });

  test("initialize is a no-op on subsequent calls", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const first = harness.client.initialize();
    await waitFor(() => harness.writes.length === 1);
    const outbound = takeOutbound(harness.writes);
    harness.send({
      id: outbound.id,
      result: { userAgent: "codex_cli_rs/0.118.0 (macOS; test)" },
    });
    await first;
    await waitFor(() => harness.writes.length === 2);

    await harness.client.initialize();
    // No extra handshake writes.
    expect(harness.writes).toHaveLength(2);
  });

  test("blocks unsupported app-server versions during initialize", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const initializing = harness.client.initialize();
    await waitFor(() => harness.writes.length === 1);
    const outbound = takeOutbound(harness.writes);
    harness.send({
      id: outbound.id,
      result: { userAgent: "codex_cli_rs/0.117.9 (macOS; test)" },
    });

    await expect(initializing).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required, but detected 0.117.9`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  test("blocks initialize responses without a detectable version", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const initializing = harness.client.initialize();
    await waitFor(() => harness.writes.length === 1);
    const outbound = takeOutbound(harness.writes);
    harness.send({ id: outbound.id, result: {} });

    await expect(initializing).rejects.toThrow(
      `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required`,
    );
    expect(harness.writes).toHaveLength(1);
  });

  test("answers server-initiated requests with the first non-undefined handler result", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    harness.client.addRequestHandler(() => undefined);
    harness.client.addRequestHandler((request) => {
      if (request.method === "item/tool/call") {
        return { contentItems: [{ type: "inputText", text: "ok" }], success: true };
      }
      return undefined;
    });

    harness.send({ id: "srv-1", method: "item/tool/call", params: { tool: "message" } });
    await waitFor(() => harness.writes.length === 1);

    expect(takeOutbound(harness.writes)).toEqual({
      id: "srv-1",
      result: { contentItems: [{ type: "inputText", text: "ok" }], success: true },
    });
  });

  test("fails closed for unhandled native app-server approval requests", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    harness.send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t", turnId: "u", itemId: "c", command: "bun test" },
    });
    await waitFor(() => harness.writes.length === 1);

    expect(takeOutbound(harness.writes)).toEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
  });

  test("returns polite decline for unregistered tool calls", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    harness.send({ id: "srv-2", method: "item/tool/call", params: {} });
    await waitFor(() => harness.writes.length === 1);

    const reply = takeOutbound(harness.writes) as {
      id?: string;
      result?: { success?: boolean; contentItems?: Array<{ type?: string; text?: string }> };
    };
    expect(reply.id).toBe("srv-2");
    expect(reply.result?.success).toBe(false);
    expect(reply.result?.contentItems?.[0]?.type).toBe("inputText");
  });

  test("propagates server request handler errors back as RPC errors", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);
    harness.client.addRequestHandler(() => {
      throw new Error("handler failed");
    });

    harness.send({ id: "srv-err", method: "item/tool/call", params: {} });
    await waitFor(() => harness.writes.length === 1);

    expect(takeOutbound(harness.writes)).toEqual({
      id: "srv-err",
      error: { message: "handler failed" },
    });
  });

  test("dispatches notifications to every registered handler", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const received: string[] = [];
    harness.client.addNotificationHandler((note) => {
      received.push(`a:${note.method}`);
    });
    harness.client.addNotificationHandler((note) => {
      received.push(`b:${note.method}`);
    });

    harness.send({ method: "thread/status", params: { status: "idle" } });
    await waitFor(() => received.length === 2);
    expect(received).toEqual(["a:thread/status", "b:thread/status"]);
  });

  test("rejects all pending requests when closed", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const pending = harness.client.request("model/list", {});
    await waitFor(() => harness.writes.length === 1);

    harness.client.close();
    await expect(pending).rejects.toThrow("codex app-server client is closed");
    // Subsequent requests also reject immediately.
    await expect(harness.client.request("any", {})).rejects.toThrow(
      "codex app-server client is closed",
    );
  });

  test("rejects pending requests when the subprocess exits", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);

    const pending = harness.client.request("model/list", {});
    await waitFor(() => harness.writes.length === 1);

    harness.process.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("codex app-server exited");
  });

  test("fires close handlers exactly once", async () => {
    const harness = createClientHarness();
    activeClients.push(harness.client);
    let callCount = 0;
    harness.client.addCloseHandler(() => {
      callCount += 1;
    });

    harness.client.close();
    harness.client.close();
    expect(callCount).toBe(1);
  });
});

describe("closeCodexAppServerTransport", () => {
  test("sends SIGTERM and escalates to SIGKILL after the force-kill delay", async () => {
    const stdin = {
      write: mock(() => undefined),
      end: mock(() => undefined),
      destroy: mock(() => undefined),
      unref: mock(() => undefined),
    };
    const stdout = Object.assign(new PassThrough(), { unref: mock(() => undefined) });
    const stderr = Object.assign(new PassThrough(), { unref: mock(() => undefined) });
    const kill = mock(() => true);
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill,
      unref: mock(() => undefined),
    }) as unknown as CodexAppServerTransport & { kill: typeof kill };

    closeCodexAppServerTransport(child, { forceKillDelayMs: 10 });

    expect(kill).toHaveBeenCalledWith("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const signals = (kill.mock.calls as unknown as NodeJS.Signals[][]).map((call) => call[0]);
    expect(signals).toContain("SIGKILL" as NodeJS.Signals);
  });

  test("skips SIGKILL when the process already exited", async () => {
    const stdin = {
      write: mock(() => undefined),
      end: mock(() => undefined),
      destroy: mock(() => undefined),
      unref: mock(() => undefined),
    };
    const stdout = Object.assign(new PassThrough(), { unref: mock(() => undefined) });
    const stderr = Object.assign(new PassThrough(), { unref: mock(() => undefined) });
    const kill = mock(() => true);
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      exitCode: 0,
      signalCode: null,
      kill,
      unref: mock(() => undefined),
    }) as unknown as CodexAppServerTransport & { kill: typeof kill };

    closeCodexAppServerTransport(child, { forceKillDelayMs: 10 });

    expect(kill).toHaveBeenCalledWith("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const signals = (kill.mock.calls as unknown as NodeJS.Signals[][]).map((call) => call[0]);
    expect(signals).not.toContain("SIGKILL" as NodeJS.Signals);
  });
});

describe("helper predicates", () => {
  test("detects approval request methods", () => {
    expect(isCodexAppServerApprovalRequest("item/fileChange/requestApproval")).toBe(true);
    expect(isCodexAppServerApprovalRequest("applyPatchApproval")).toBe(true);
    expect(isCodexAppServerApprovalRequest("turn/start")).toBe(false);
  });

  test("extracts semver version from user agent", () => {
    expect(readCodexVersionFromUserAgent("codex-acp-bridge/0.1.0 (node 21)")).toBe("0.1.0");
    expect(readCodexVersionFromUserAgent("codex_cli_rs/0.118.1-dev (linux; test)")).toBe(
      "0.118.1-dev",
    );
    expect(readCodexVersionFromUserAgent("custom/1.2.3+build.7")).toBe("1.2.3+build.7");
  });

  test("returns undefined for malformed user agents", () => {
    expect(readCodexVersionFromUserAgent(undefined)).toBeUndefined();
    expect(readCodexVersionFromUserAgent("no slash here")).toBeUndefined();
    expect(readCodexVersionFromUserAgent("codex_cli_rs/0.118")).toBeUndefined();
    expect(readCodexVersionFromUserAgent("codex_cli_rs/not-a-version")).toBeUndefined();
    expect(readCodexVersionFromUserAgent("codex_cli_rs/0.118.0abc")).toBeUndefined();
  });
});
