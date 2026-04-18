import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AgentSideConnection,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  CodexAppServerClient,
  CodexServerNotificationHandler,
  CodexServerRequestHandler,
} from "./app-server/client.ts";

type RecordedRequest = { method: string; params?: unknown };

type FakeClientControl = {
  client: CodexAppServerClient;
  requests: RecordedRequest[];
  notificationHandlers: CodexServerNotificationHandler[];
  requestHandlers: CodexServerRequestHandler[];
  responsesByMethod: Map<string, unknown>;
};

const state: { current: FakeClientControl | null } = { current: null };

function buildFakeClient(): FakeClientControl {
  const requests: RecordedRequest[] = [];
  const notificationHandlers: CodexServerNotificationHandler[] = [];
  const requestHandlers: CodexServerRequestHandler[] = [];
  const closeHandlers: Array<(client: CodexAppServerClient) => void> = [];
  const responsesByMethod = new Map<string, unknown>();

  const client = {
    async request(method: string, params?: unknown) {
      requests.push({ method, params });
      if (!responsesByMethod.has(method)) {
        return {};
      }
      return responsesByMethod.get(method);
    },
    notify() {},
    addRequestHandler(handler: CodexServerRequestHandler) {
      requestHandlers.push(handler);
      return () => {
        const index = requestHandlers.indexOf(handler);
        if (index !== -1) requestHandlers.splice(index, 1);
      };
    },
    addNotificationHandler(handler: CodexServerNotificationHandler) {
      notificationHandlers.push(handler);
      return () => {
        const index = notificationHandlers.indexOf(handler);
        if (index !== -1) notificationHandlers.splice(index, 1);
      };
    },
    addCloseHandler(handler: (client: CodexAppServerClient) => void) {
      closeHandlers.push(handler);
      return () => {
        const index = closeHandlers.indexOf(handler);
        if (index !== -1) closeHandlers.splice(index, 1);
      };
    },
    close() {},
  } as unknown as CodexAppServerClient;

  return { client, requests, notificationHandlers, requestHandlers, responsesByMethod };
}

mock.module("./app-server/shared-client.ts", () => ({
  getSharedCodexAppServerClient: async () => {
    if (!state.current) {
      state.current = buildFakeClient();
    }
    return state.current.client;
  },
  clearSharedCodexAppServerClient: () => {
    state.current = null;
  },
  resetSharedCodexAppServerClientForTests: () => {
    state.current = null;
  },
  createIsolatedCodexAppServerClient: async () => {
    const isolated = buildFakeClient();
    return isolated.client;
  },
}));

const { CodexAcpAgent } = await import("./agent.ts");

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

function seedThreadStart(responses: Map<string, unknown>, threadId = "thread-abc"): void {
  responses.set("model/list", MODEL_LIST_RESPONSE);
  responses.set("thread/start", {
    thread: { id: threadId },
    cwd: "/repo",
    approvalPolicy: "on-request",
    model: "gpt-5",
    modelProvider: "openai",
  });
}

beforeEach(() => {
  state.current = buildFakeClient();
});

describe("CodexAcpAgent.initialize", () => {
  test("advertises session capabilities, auth methods, and protocol version", async () => {
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
    const connection = buildFakeConnection();
    // Return a command list only if extensions are on; the agent calls extMethod
    // during newSession when extensions are enabled.
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
    seedThreadStart(state.current!.responsesByMethod);
    await agent.newSession({ cwd: "/repo", mcpServers: [] });

    expect(extensionsCalled).toBe(1);
    const update = connection.sessionUpdates.find(
      (notification) => notification.update.sessionUpdate === "available_commands_update",
    );
    expect(update).toBeDefined();
  });

  test("falls back to static available commands without the extension capability", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);

    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod);
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
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod);

    const response = await agent.newSession({ cwd: "/repo", mcpServers: [] });

    expect(response.sessionId).toBe("thread-abc");
    const startRequest = state.current!.requests.find((r) => r.method === "thread/start");
    expect(startRequest).toBeDefined();
    expect(startRequest?.params).toMatchObject({
      cwd: "/repo",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5",
    });
  });

  test("honors _meta.systemPrompt string as baseInstructions", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod);

    await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
      _meta: { systemPrompt: "Be concise." },
    });

    const startRequest = state.current!.requests.find((r) => r.method === "thread/start");
    expect(startRequest?.params).toMatchObject({ baseInstructions: "Be concise." });
  });

  test("honors _meta.systemPrompt.append as developerInstructions", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod);

    await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
      _meta: { systemPrompt: { append: "Add these rules." } },
    });

    const startRequest = state.current!.requests.find((r) => r.method === "thread/start");
    expect(startRequest?.params).toMatchObject({
      developerInstructions: "Add these rules.",
    });
  });

  test("projects ACP mcpServers into thread config", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod);

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

    const startRequest = state.current!.requests.find((r) => r.method === "thread/start");
    const params = startRequest?.params as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(params?.config?.mcp_servers?.docs).toBeDefined();
  });

  test("returns configOptions with mode and model", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod);

    const response = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const optionIds = response.configOptions?.map((option) => option.id);
    expect(optionIds).toContain("mode");
    expect(optionIds).toContain("model");
  });
});

describe("CodexAcpAgent.loadSession", () => {
  test("returns cached state for already-tracked sessions without reissuing resume", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod, "thread-42");

    const created = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const resumeCallsBefore = state.current!.requests.filter(
      (r) => r.method === "thread/resume",
    ).length;

    const loaded = await agent.loadSession({ sessionId: created.sessionId, cwd: "/repo", mcpServers: [] });
    const resumeCallsAfter = state.current!.requests.filter(
      (r) => r.method === "thread/resume",
    ).length;

    expect(resumeCallsAfter).toBe(resumeCallsBefore);
    expect(loaded.models?.currentModelId).toBe("gpt-5");
  });

  test("issues thread/resume and replays thread history for new sessions", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    state.current!.responsesByMethod.set("model/list", MODEL_LIST_RESPONSE);
    state.current!.responsesByMethod.set("thread/resume", {
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
              {
                id: "item-2",
                type: "agentMessage",
                text: "hello back",
              },
            ],
          },
        ],
      },
      cwd: "/repo",
      approvalPolicy: "on-request",
      model: "gpt-5",
    });

    await agent.loadSession({ sessionId: "existing-thread", cwd: "/repo", mcpServers: [] });

    const resumeRequest = state.current!.requests.find((r) => r.method === "thread/resume");
    expect(resumeRequest?.params).toMatchObject({ threadId: "existing-thread", cwd: "/repo" });

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
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    state.current!.responsesByMethod.set("model/list", MODEL_LIST_RESPONSE);
    state.current!.responsesByMethod.set("thread/resume", {
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
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    state.current!.responsesByMethod.set("model/list", MODEL_LIST_RESPONSE);
    state.current!.responsesByMethod.set("thread/fork", {
      thread: { id: "forked-thread" },
      cwd: "/repo",
      approvalPolicy: "on-request",
      model: "gpt-5",
    });

    const response = await agent.unstable_forkSession({
      sessionId: "original-thread",
      cwd: "/repo",
      mcpServers: [],
    });

    expect(response.sessionId).toBe("forked-thread");
    const forkRequest = state.current!.requests.find((r) => r.method === "thread/fork");
    expect(forkRequest?.params).toMatchObject({ threadId: "original-thread", cwd: "/repo" });
  });

  test("honors _meta.systemPrompt on fork", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    state.current!.responsesByMethod.set("model/list", MODEL_LIST_RESPONSE);
    state.current!.responsesByMethod.set("thread/fork", {
      thread: { id: "forked-thread" },
      cwd: "/repo",
      approvalPolicy: "on-request",
      model: "gpt-5",
    });

    await agent.unstable_forkSession({
      sessionId: "original-thread",
      cwd: "/repo",
      mcpServers: [],
      _meta: { systemPrompt: "Fresh prompt." },
    });

    const forkRequest = state.current!.requests.find((r) => r.method === "thread/fork");
    expect(forkRequest?.params).toMatchObject({ baseInstructions: "Fresh prompt." });
  });
});

describe("CodexAcpAgent.listSessions", () => {
  test("maps thread/list results into ACP session summaries", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    state.current!.responsesByMethod.set("thread/list", {
      data: [
        {
          id: "t1",
          cwd: "/repo",
          name: "First thread",
          updatedAt: 1_700_000_000,
        },
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

    const response = await agent.listSessions({ cwd: "/repo" });

    expect(response.nextCursor).toBe("cursor-1");
    expect(response.sessions).toHaveLength(2);
    expect(response.sessions[0]).toMatchObject({ sessionId: "t1", title: "First thread" });
    expect(response.sessions[1]?.title).toBeTruthy();
    expect(response.sessions[0]?.updatedAt).toMatch(/^20\d{2}-/);
  });

  test("uses the shared client without spawning a per-request subprocess", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    state.current!.responsesByMethod.set("thread/list", { data: [], nextCursor: null });

    await agent.listSessions({});
    await agent.listSessions({});

    // Both calls hit the same fake client (state.current is the shared handle).
    const listCalls = state.current!.requests.filter((r) => r.method === "thread/list");
    expect(listCalls).toHaveLength(2);
  });
});

describe("CodexAcpAgent session routing", () => {
  test("prompt throws resourceNotFound for unknown sessions", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(
      agent.prompt({ sessionId: "unknown", prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({ code: -32002 });
  });

  test("cancel throws resourceNotFound for unknown sessions", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(agent.cancel({ sessionId: "unknown" })).rejects.toMatchObject({ code: -32002 });
  });

  test("setSessionMode throws for unknown sessions", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(
      agent.setSessionMode({ sessionId: "unknown", modeId: "never" }),
    ).rejects.toMatchObject({ code: -32002 });
  });

  test("unstable_closeSession is a no-op for unknown sessions", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(agent.unstable_closeSession({ sessionId: "unknown" })).resolves.toEqual({});
  });

  test("unstable_closeSession untracks the session", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod, "thread-close");

    const created = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    await agent.unstable_closeSession({ sessionId: created.sessionId });

    // After close, prompt should throw resourceNotFound.
    await expect(
      agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toMatchObject({ code: -32002 });
  });
});

describe("CodexAcpAgent.setSessionConfigOption", () => {
  test("rejects non-string values", async () => {
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod, "thread-cfg");
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
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    seedThreadStart(state.current!.responsesByMethod, "thread-cfg");
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
    const connection = buildFakeConnection();
    const agent = new CodexAcpAgent(connection);
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await expect(agent.authenticate({ methodId: "codex-cli-auth" })).resolves.toBeUndefined();
  });
});
