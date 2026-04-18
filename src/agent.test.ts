import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { CodexAcpAgent } from "./agent.ts";
import { CodexAppServerClient, MIN_CODEX_APP_SERVER_VERSION } from "./app-server/client.ts";
import type { CodexAppServerTransport } from "./app-server/transport.ts";
import { resetSharedCodexAppServerClientForTests } from "./app-server/shared-client.ts";

type AutoHarness = {
  client: CodexAppServerClient;
  writes: string[];
  process: EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof mock>;
  };
  responses: Map<string, unknown>;
  requestsByMethod: Map<string, unknown[]>;
};

// Builds a real CodexAppServerClient backed by a fake transport, and installs
// a stdin interceptor that auto-replies to every outgoing JSON-RPC request
// whose method has an entry in `responses`. This keeps agent.ts running the
// production code path (no mock.module) while letting each test script the
// transport replies.
function createAutoHarness(): AutoHarness {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  const responses = new Map<string, unknown>();
  const requestsByMethod = new Map<string, unknown[]>();

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      writes.push(text);
      try {
        const frame = JSON.parse(text) as {
          id?: number | string;
          method?: string;
          params?: unknown;
        };
        if (frame.method) {
          const existing = requestsByMethod.get(frame.method) ?? [];
          existing.push(frame.params);
          requestsByMethod.set(frame.method, existing);
          if (frame.id !== undefined && responses.has(frame.method)) {
            setImmediate(() => {
              stdout.write(
                `${JSON.stringify({ id: frame.id, result: responses.get(frame.method!) })}\n`,
              );
            });
          }
        }
      } catch {
        // non-JSON frames are ignored in the tests.
      }
      callback();
    },
  });

  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: mock(() => {
      child.killed = true;
      return true;
    }),
  });
  const client = CodexAppServerClient.fromTransportForTests(
    child as unknown as CodexAppServerTransport,
  );

  return { client, writes, process: child, responses, requestsByMethod };
}

const MODEL_LIST_RESPONSE = {
  data: [
    {
      id: "gpt-5",
      displayName: "GPT-5",
      description: "Default",
      isDefault: true,
    },
    {
      id: "gpt-5-codex",
      displayName: "GPT-5 Codex",
      description: null,
      isDefault: false,
    },
  ],
};

function seedHandshakeAndModels(harness: AutoHarness): void {
  harness.responses.set("initialize", {
    userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)`,
  });
  harness.responses.set("model/list", MODEL_LIST_RESPONSE);
}

function seedThreadStart(harness: AutoHarness, threadId = "thread-abc"): void {
  seedHandshakeAndModels(harness);
  harness.responses.set("thread/start", {
    thread: { id: threadId },
    cwd: "/repo",
    approvalPolicy: "on-request",
    model: "gpt-5",
  });
}

type FakeConnection = AgentSideConnection & {
  sessionUpdates: SessionNotification[];
  abortController: AbortController;
};

function buildFakeConnection(): FakeConnection {
  const abortController = new AbortController();
  const sessionUpdates: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (params: SessionNotification) => {
      sessionUpdates.push(params);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    extMethod: async () => null,
    writeTextFile: async () => ({}),
    readTextFile: async () => ({ content: "" }),
    signal: abortController.signal,
    sessionUpdates,
    abortController,
  } as unknown as FakeConnection;
  return connection;
}

function installHarness(): AutoHarness {
  const harness = createAutoHarness();
  spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);
  return harness;
}

afterEach(() => {
  resetSharedCodexAppServerClientForTests();
  mock.restore();
});

describe("CodexAcpAgent.initialize", () => {
  test("advertises session capabilities, auth methods, and protocol version", async () => {
    installHarness();
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);

    const response = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });

    expect(response.protocolVersion).toBe(1);
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentCapabilities?.sessionCapabilities).toEqual({
      list: {},
      close: {},
      resume: {},
      fork: {},
    });
    expect(response.agentCapabilities?.promptCapabilities).toEqual({
      image: true,
      embeddedContext: true,
    });
    expect(response.authMethods?.map((method) => method.id)).toEqual(["codex-cli-auth"]);
    expect(response.agentInfo?.title).toBe("Codex ACP Bridge");
  });

  test("enables extension methods when the client advertises the capability", async () => {
    const harness = installHarness();
    seedThreadStart(harness);
    const connection = buildFakeConnection();
    let extensionsCalled = 0;
    (connection as { extMethod: unknown }).extMethod = async (method: string) => {
      if (method === "codex/available_commands") {
        extensionsCalled += 1;
        return { availableCommands: [{ name: "custom" }] };
      }
      return null;
    };
    const agent = new CodexAcpAgent(connection);

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { _meta: { "codex-extension-methods": true } },
    });
    await agent.newSession({ cwd: "/repo", mcpServers: [] });

    expect(extensionsCalled).toBe(1);
    const update = connection.sessionUpdates.find(
      (notification) => notification.update.sessionUpdate === "available_commands_update",
    );
    expect(update).toBeDefined();
  });

  test("falls back to static available commands without the extension capability", async () => {
    const harness = installHarness();
    seedThreadStart(harness);
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);

    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await agent.newSession({ cwd: "/repo", mcpServers: [] });

    const update = connection.sessionUpdates.find(
      (notification) => notification.update.sessionUpdate === "available_commands_update",
    );
    expect(update).toBeDefined();
    if (update?.update.sessionUpdate === "available_commands_update") {
      expect(update.update.availableCommands.some((cmd) => cmd.name === "review")).toBe(true);
    }
  });
});

describe("CodexAcpAgent.newSession", () => {
  test("issues thread/start with model, cwd, and default approval/sandbox", async () => {
    const harness = installHarness();
    seedThreadStart(harness);
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const response = await agent.newSession({ cwd: "/repo", mcpServers: [] });

    expect(response.sessionId).toBe("thread-abc");
    const startParams = harness.requestsByMethod.get("thread/start")?.[0] as Record<
      string,
      unknown
    >;
    expect(startParams).toMatchObject({
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5",
    });
  });

  test("honors _meta.systemPrompt string as baseInstructions", async () => {
    const harness = installHarness();
    seedThreadStart(harness);
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
      _meta: { systemPrompt: "Be concise." },
    });

    const startParams = harness.requestsByMethod.get("thread/start")?.[0] as Record<
      string,
      unknown
    >;
    expect(startParams).toMatchObject({ baseInstructions: "Be concise." });
  });

  test("honors _meta.systemPrompt.append as developerInstructions", async () => {
    const harness = installHarness();
    seedThreadStart(harness);
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
      _meta: { systemPrompt: { append: "Add these rules." } },
    });

    const startParams = harness.requestsByMethod.get("thread/start")?.[0] as Record<
      string,
      unknown
    >;
    expect(startParams).toMatchObject({ developerInstructions: "Add these rules." });
  });

  test("projects ACP mcpServers into thread config", async () => {
    const harness = installHarness();
    seedThreadStart(harness);
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await agent.newSession({
      cwd: "/repo",
      mcpServers: [
        {
          name: "docs",
          command: "/bin/docs",
          args: ["--stdio"],
          env: [{ name: "FOO", value: "bar" }],
        },
      ],
    });

    const startParams = harness.requestsByMethod.get("thread/start")?.[0] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(startParams.config?.mcp_servers?.docs).toBeDefined();
  });

  test("returns configOptions with mode and model", async () => {
    const harness = installHarness();
    seedThreadStart(harness);
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const response = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const optionIds = response.configOptions?.map((option) => option.id);
    expect(optionIds).toContain("mode");
    expect(optionIds).toContain("model");
  });
});

describe("CodexAcpAgent.loadSession", () => {
  test("returns cached state for already-tracked sessions without reissuing resume", async () => {
    const harness = installHarness();
    seedThreadStart(harness, "thread-42");
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const created = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const resumeCallsBefore = harness.requestsByMethod.get("thread/resume")?.length ?? 0;

    const loaded = await agent.loadSession({
      sessionId: created.sessionId,
      cwd: "/repo",
      mcpServers: [],
    });
    const resumeCallsAfter = harness.requestsByMethod.get("thread/resume")?.length ?? 0;

    expect(resumeCallsAfter).toBe(resumeCallsBefore);
    expect(loaded.models?.currentModelId).toBe("gpt-5");
  });

  test("issues thread/resume and replays thread history for new sessions", async () => {
    const harness = installHarness();
    seedHandshakeAndModels(harness);
    harness.responses.set("thread/resume", {
      thread: {
        id: "existing-thread",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                id: "item-1",
                type: "userMessage",
                content: [{ type: "text", text: "hi" }],
              },
              { id: "item-2", type: "agentMessage", text: "hello back" },
            ],
          },
        ],
      },
      cwd: "/repo",
      approvalPolicy: "on-request",
      model: "gpt-5",
    });
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await agent.loadSession({ sessionId: "existing-thread", cwd: "/repo", mcpServers: [] });

    const resumeParams = harness.requestsByMethod.get("thread/resume")?.[0] as Record<
      string,
      unknown
    >;
    expect(resumeParams).toMatchObject({ threadId: "existing-thread", cwd: "/repo" });

    const userEcho = connection.sessionUpdates.find(
      (notification) => notification.update.sessionUpdate === "user_message_chunk",
    );
    const agentEcho = connection.sessionUpdates.find(
      (notification) => notification.update.sessionUpdate === "agent_message_chunk",
    );
    expect(userEcho).toBeDefined();
    expect(agentEcho).toBeDefined();
  });
});

describe("CodexAcpAgent.unstable_resumeSession", () => {
  test("resumes without history replay", async () => {
    const harness = installHarness();
    seedHandshakeAndModels(harness);
    harness.responses.set("thread/resume", {
      thread: {
        id: "existing-thread",
        turns: [
          {
            id: "turn-1",
            items: [
              {
                id: "item-1",
                type: "userMessage",
                content: [{ type: "text", text: "skip me" }],
              },
            ],
          },
        ],
      },
      cwd: "/repo",
      approvalPolicy: "on-request",
      model: "gpt-5",
    });
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await agent.unstable_resumeSession({
      sessionId: "existing-thread",
      cwd: "/repo",
      mcpServers: [],
    });

    const userEcho = connection.sessionUpdates.find(
      (notification) => notification.update.sessionUpdate === "user_message_chunk",
    );
    expect(userEcho).toBeUndefined();
  });
});

describe("CodexAcpAgent.unstable_forkSession", () => {
  test("issues thread/fork and tracks a new session", async () => {
    const harness = installHarness();
    seedHandshakeAndModels(harness);
    harness.responses.set("thread/fork", {
      thread: { id: "forked-thread" },
      cwd: "/repo",
      approvalPolicy: "on-request",
      model: "gpt-5",
    });
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const response = await agent.unstable_forkSession({
      sessionId: "original-thread",
      cwd: "/repo",
      mcpServers: [],
    });

    expect(response.sessionId).toBe("forked-thread");
    const forkParams = harness.requestsByMethod.get("thread/fork")?.[0] as Record<string, unknown>;
    expect(forkParams).toMatchObject({ threadId: "original-thread", cwd: "/repo" });
  });

  test("honors _meta.systemPrompt on fork", async () => {
    const harness = installHarness();
    seedHandshakeAndModels(harness);
    harness.responses.set("thread/fork", {
      thread: { id: "forked-thread" },
      cwd: "/repo",
      approvalPolicy: "on-request",
      model: "gpt-5",
    });
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await agent.unstable_forkSession({
      sessionId: "original-thread",
      cwd: "/repo",
      mcpServers: [],
      _meta: { systemPrompt: "Fresh prompt." },
    });

    const forkParams = harness.requestsByMethod.get("thread/fork")?.[0] as Record<string, unknown>;
    expect(forkParams).toMatchObject({ baseInstructions: "Fresh prompt." });
  });
});

describe("CodexAcpAgent.listSessions", () => {
  test("maps thread/list results into ACP session summaries", async () => {
    const harness = installHarness();
    seedHandshakeAndModels(harness);
    harness.responses.set("thread/list", {
      data: [
        { id: "t1", cwd: "/repo", name: "First thread", updatedAt: 1_700_000_000 },
        {
          id: "t2",
          cwd: "/repo",
          name: null,
          preview: "Second thread preview",
          updatedAt: 1_700_000_100,
        },
      ],
      nextCursor: "cursor-1",
    });
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const response = await agent.listSessions({ cwd: "/repo" });

    expect(response.nextCursor).toBe("cursor-1");
    expect(response.sessions).toHaveLength(2);
    expect(response.sessions[0]).toMatchObject({ sessionId: "t1", title: "First thread" });
    expect(response.sessions[1]?.title).toBeTruthy();
    expect(response.sessions[0]?.updatedAt).toMatch(/^20\d{2}-/);
  });

  test("uses the shared client without spawning a per-request subprocess", async () => {
    const harness = installHarness();
    seedHandshakeAndModels(harness);
    harness.responses.set("thread/list", { data: [], nextCursor: null });
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await agent.listSessions({});
    await agent.listSessions({});

    // Both calls hit the same shared client, so the transport sees two
    // thread/list frames but only one initialize handshake.
    expect(harness.requestsByMethod.get("thread/list")).toHaveLength(2);
    expect(harness.requestsByMethod.get("initialize")).toHaveLength(1);
  });
});

describe("CodexAcpAgent session routing", () => {
  test("prompt throws resourceNotFound for unknown sessions", async () => {
    installHarness();
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(
      agent.prompt({ sessionId: "unknown", prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({ code: -32002 });
  });

  test("cancel throws resourceNotFound for unknown sessions", async () => {
    installHarness();
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(agent.cancel({ sessionId: "unknown" })).rejects.toMatchObject({ code: -32002 });
  });

  test("setSessionMode throws for unknown sessions", async () => {
    installHarness();
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(
      agent.setSessionMode({ sessionId: "unknown", modeId: "never" }),
    ).rejects.toMatchObject({ code: -32002 });
  });

  test("unstable_closeSession is a no-op for unknown sessions", async () => {
    installHarness();
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(agent.unstable_closeSession({ sessionId: "unknown" })).resolves.toEqual({});
  });

  test("unstable_closeSession untracks the session", async () => {
    const harness = installHarness();
    seedThreadStart(harness, "thread-close");
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    const created = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    await agent.unstable_closeSession({ sessionId: created.sessionId });

    await expect(
      agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({ code: -32002 });
  });
});

describe("CodexAcpAgent.setSessionConfigOption", () => {
  test("rejects non-string values", async () => {
    const harness = installHarness();
    seedThreadStart(harness, "thread-cfg");
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.newSession({ cwd: "/repo", mcpServers: [] });

    await expect(
      agent.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: "mode",
        value: 123 as unknown as string,
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test("rejects unsupported configIds", async () => {
    const harness = installHarness();
    seedThreadStart(harness, "thread-cfg");
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.newSession({ cwd: "/repo", mcpServers: [] });

    await expect(
      agent.setSessionConfigOption({
        sessionId: created.sessionId,
        configId: "something-else",
        value: "x",
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe("CodexAcpAgent.authenticate", () => {
  test("authenticate is a no-op that resolves successfully", async () => {
    installHarness();
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(agent.authenticate({ methodId: "codex-cli-auth" })).resolves.toBeUndefined();
  });
});
