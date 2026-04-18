import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

const shouldRun = process.env.RUN_INTEGRATION_TESTS === "true";

function codexAvailable(): boolean {
  const result = spawnSync("command", ["-v", "codex"], { shell: true });
  return result.status === 0;
}

class RecordingClient implements Client {
  readonly updates: SessionNotification[] = [];

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const allow =
      params.options.find((option) => option.kind === "allow_once") ?? params.options[0];
    if (!allow) {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params);
  }

  async writeTextFile(): Promise<{ _meta?: Record<string, unknown> }> {
    return {};
  }

  async readTextFile(): Promise<{ content: string; _meta?: Record<string, unknown> }> {
    return { content: "" };
  }
}

type Bridge = {
  connection: ClientSideConnection;
  child: ChildProcess;
  client: RecordingClient;
};

function spawnBridge(): Bridge {
  const child = spawn("bun", ["run", "src/index.ts"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
  if (!child.stdin || !child.stdout) {
    throw new Error("bridge subprocess missing stdio pipes");
  }
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const client = new RecordingClient();
  const connection = new ClientSideConnection(() => client, stream);
  return { child, connection, client };
}

function killBridge(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 500);
  });
}

describe.skipIf(!shouldRun)("codex-acp-bridge subprocess (integration)", () => {
  let canRunCodexTests = true;

  beforeAll(() => {
    if (!codexAvailable()) {
      canRunCodexTests = false;
    }
  });

  let bridges: Bridge[] = [];

  afterEach(async () => {
    await Promise.all(bridges.map((bridge) => killBridge(bridge.child)));
    bridges = [];
  });

  test("initialize handshake returns agent info and capabilities", async () => {
    const bridge = spawnBridge();
    bridges.push(bridge);

    const response = await bridge.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    expect(response.agentInfo?.name).toBeTruthy();
    expect(response.agentInfo?.title).toBe("Codex ACP Bridge");
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentCapabilities?.sessionCapabilities).toEqual({
      list: {},
      close: {},
      resume: {},
      fork: {},
    });
    expect(response.authMethods?.some((method) => method.id === "codex-cli-auth")).toBe(true);
  });

  test("newSession creates a real codex thread and returns a session id", async () => {
    if (!canRunCodexTests) return;
    const bridge = spawnBridge();
    bridges.push(bridge);

    await bridge.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const session = await bridge.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    expect(session.sessionId).toBeTypeOf("string");
    expect(session.sessionId.length).toBeGreaterThan(0);

    await bridge.connection.unstable_closeSession({ sessionId: session.sessionId });
  }, 30_000);

  test("listSessions returns the newly created session", async () => {
    if (!canRunCodexTests) return;
    const bridge = spawnBridge();
    bridges.push(bridge);

    await bridge.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await bridge.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    const list = await bridge.connection.listSessions({});
    expect(Array.isArray(list.sessions)).toBe(true);

    await bridge.connection.unstable_closeSession({ sessionId: session.sessionId });
  }, 30_000);

  test("cancel on an idle session resolves without error", async () => {
    if (!canRunCodexTests) return;
    const bridge = spawnBridge();
    bridges.push(bridge);

    await bridge.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await bridge.connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    await expect(
      bridge.connection.cancel({ sessionId: session.sessionId }),
    ).resolves.toBeUndefined();

    await bridge.connection.unstable_closeSession({ sessionId: session.sessionId });
  }, 30_000);
});
