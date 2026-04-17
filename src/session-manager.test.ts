import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { ApprovalBridge } from "./approval-bridge.ts";
import type { CodexAppServerClient, CodexServerNotificationHandler, CodexServerRequestHandler } from "./app-server/client.ts";
import { ExtensionClient } from "./extension.ts";
import { CodexSession } from "./session-manager.ts";

type FakeHarness = {
  client: CodexAppServerClient;
  connection: AgentSideConnection;
  updates: SessionNotification[];
  notificationHandlers: CodexServerNotificationHandler[];
  requestHandlers: CodexServerRequestHandler[];
  clientRequests: Array<{ method: string; params?: unknown }>;
  clientResponses: Map<string, unknown>;
};

function buildHarness(): FakeHarness {
  const notificationHandlers: CodexServerNotificationHandler[] = [];
  const requestHandlers: CodexServerRequestHandler[] = [];
  const clientRequests: Array<{ method: string; params?: unknown }> = [];
  const clientResponses = new Map<string, unknown>();

  const client = {
    addNotificationHandler(handler: CodexServerNotificationHandler) {
      notificationHandlers.push(handler);
      return () => {
        const index = notificationHandlers.indexOf(handler);
        if (index !== -1) notificationHandlers.splice(index, 1);
      };
    },
    addRequestHandler(handler: CodexServerRequestHandler) {
      requestHandlers.push(handler);
      return () => {
        const index = requestHandlers.indexOf(handler);
        if (index !== -1) requestHandlers.splice(index, 1);
      };
    },
    async request(method: string, params?: unknown) {
      clientRequests.push({ method, params });
      return clientResponses.get(method) ?? {};
    },
    close() {},
  } as unknown as CodexAppServerClient;

  const updates: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (params: SessionNotification) => {
      updates.push(params);
    },
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  } as unknown as AgentSideConnection;

  return {
    client,
    connection,
    updates,
    notificationHandlers,
    requestHandlers,
    clientRequests,
    clientResponses,
  };
}

function buildSession(
  harness: FakeHarness,
  opts: { sessionId: string; threadId: string },
): CodexSession {
  return new CodexSession({
    sessionId: opts.sessionId,
    cwd: "/tmp",
    threadId: opts.threadId,
    approvalPolicy: "on-request",
    client: harness.client,
    connection: harness.connection,
    models: {
      currentModelId: "gpt",
      availableModels: [{ modelId: "gpt", name: "GPT", description: null }],
    },
    extensions: new ExtensionClient(harness.connection, false),
    approvals: new ApprovalBridge(harness.connection),
  });
}

let harness: FakeHarness;

beforeEach(() => {
  harness = buildHarness();
});

afterEach(async () => {
  harness.notificationHandlers.length = 0;
  harness.requestHandlers.length = 0;
});

test("notification for another thread is ignored", async () => {
  const session = buildSession(harness, { sessionId: "s", threadId: "t1" });
  try {
    await harness.notificationHandlers[0]?.({
      method: "item/agentMessage/delta",
      params: { threadId: "t2", turnId: "u", delta: "hi" },
    });
    expect(harness.updates).toHaveLength(0);
  } finally {
    await session.close();
  }
});

test("notification for this thread is projected", async () => {
  const session = buildSession(harness, { sessionId: "s", threadId: "t1" });
  try {
    await harness.notificationHandlers[0]?.({
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "u", delta: "hi" },
    });
    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]?.update.sessionUpdate).toBe("agent_message_chunk");
  } finally {
    await session.close();
  }
});

test("server request with mismatching threadId falls through", async () => {
  buildSession(harness, { sessionId: "s1", threadId: "t1" });
  buildSession(harness, { sessionId: "s2", threadId: "t2" });

  const results = await Promise.all(
    harness.requestHandlers.map((handler) =>
      handler({
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "t3", command: "ls" },
      }),
    ),
  );
  expect(results.every((result) => result === undefined)).toBe(true);
});

test("close unregisters handlers without closing the client", async () => {
  const session = buildSession(harness, { sessionId: "s", threadId: "t1" });
  expect(harness.notificationHandlers).toHaveLength(1);
  expect(harness.requestHandlers).toHaveLength(1);

  await session.close();

  expect(harness.notificationHandlers).toHaveLength(0);
  expect(harness.requestHandlers).toHaveLength(0);
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("prompt sends turn/start and resolves when turn completes", async () => {
  const session = buildSession(harness, { sessionId: "s", threadId: "t1" });
  harness.clientResponses.set("turn/start", { turn: { id: "u1" } });

  const pending = session.prompt({
    sessionId: "s",
    prompt: [{ type: "text", text: "hi" }],
  });

  await waitUntil(() => harness.clientRequests.some((r) => r.method === "turn/start"));

  await harness.notificationHandlers[0]?.({
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "u1", status: "completed" } },
  });

  const response = await pending;
  expect(response.stopReason).toBe("end_turn");
});

test("cancel sends turn/interrupt for the active turn", async () => {
  const session = buildSession(harness, { sessionId: "s", threadId: "t1" });
  harness.clientResponses.set("turn/start", { turn: { id: "u1" } });
  harness.clientResponses.set("turn/interrupt", {});

  const pending = session.prompt({
    sessionId: "s",
    prompt: [{ type: "text", text: "hi" }],
  });
  await waitUntil(() => harness.clientRequests.some((r) => r.method === "turn/start"));

  await session.cancel();
  await harness.notificationHandlers[0]?.({
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "u1", status: "interrupted" } },
  });

  const response = await pending;
  expect(response.stopReason).toBe("cancelled");
  expect(
    harness.clientRequests.some(
      (r) => r.method === "turn/interrupt" && (r.params as { turnId?: string }).turnId === "u1",
    ),
  ).toBe(true);
});
