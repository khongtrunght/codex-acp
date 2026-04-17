import { expect, test } from "bun:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { EventProjector, type TurnOutcome } from "./event-projector.ts";
import type {
  AgentMessageDeltaNotification,
  CodexServerNotification,
  ErrorNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  PlanDeltaNotification,
  ReasoningTextDeltaNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
} from "./app-server/protocol.ts";

function fakeConnection(): { connection: AgentSideConnection; updates: SessionNotification[] } {
  const updates: SessionNotification[] = [];
  const connection = {
    sessionUpdate: async (params: SessionNotification) => {
      updates.push(params);
    },
  } as unknown as AgentSideConnection;
  return { connection, updates };
}

function buildNotification(method: string, params: unknown): CodexServerNotification {
  return { method, params } as unknown as CodexServerNotification;
}

test("agent message delta becomes agent_message_chunk", async () => {
  const { connection, updates } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  await projector.handle(
    buildNotification("item/agentMessage/delta", {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      delta: "hello",
    } satisfies AgentMessageDeltaNotification),
  );
  expect(updates[0]?.update.sessionUpdate).toBe("agent_message_chunk");
  const body = updates[0]?.update as { content: { text: string } };
  expect(body.content.text).toBe("hello");
});

test("reasoning text delta becomes agent_thought_chunk", async () => {
  const { connection, updates } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  await projector.handle(
    buildNotification("item/reasoning/textDelta", {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      contentIndex: 0,
      delta: "think",
    } as unknown as ReasoningTextDeltaNotification),
  );
  expect(updates[0]?.update.sessionUpdate).toBe("agent_thought_chunk");
});

test("item/started with commandExecution emits pending tool_call", async () => {
  const { connection, updates } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  await projector.handle(
    buildNotification("item/started", {
      threadId: "t",
      turnId: "u",
      item: {
        type: "commandExecution",
        id: "item-1",
        command: "ls",
        cwd: "/tmp",
        processId: "proc",
      },
    } as unknown as ItemStartedNotification),
  );
  const update = updates[0]?.update as { sessionUpdate: string; toolCallId: string };
  expect(update.sessionUpdate).toBe("tool_call");
  expect(update.toolCallId).toBe("item-1");
});

test("item/completed with fileChange emits tool_call_update", async () => {
  const { connection, updates } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  await projector.handle(
    buildNotification("item/completed", {
      threadId: "t",
      turnId: "u",
      item: {
        type: "fileChange",
        id: "item-2",
        changes: [],
        status: "completed",
      },
    } as unknown as ItemCompletedNotification),
  );
  const update = updates[0]?.update as { sessionUpdate: string };
  expect(update.sessionUpdate).toBe("tool_call_update");
});

test("plan delta accumulates per itemId", async () => {
  const { connection, updates } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  await projector.handle(
    buildNotification("item/plan/delta", {
      threadId: "t",
      turnId: "u",
      itemId: "p1",
      delta: "step-1",
    } satisfies PlanDeltaNotification),
  );
  await projector.handle(
    buildNotification("item/plan/delta", {
      threadId: "t",
      turnId: "u",
      itemId: "p1",
      delta: "\nstep-2",
    } satisfies PlanDeltaNotification),
  );
  const update = updates.at(-1)?.update as {
    sessionUpdate: string;
    entries: Array<{ content: string }>;
  };
  expect(update.sessionUpdate).toBe("plan");
  expect(update.entries[0]?.content).toBe("step-1\nstep-2");
});

test("turn/completed resolves the active turn with end_turn", async () => {
  const { connection } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  const outcome = new Promise<TurnOutcome>((resolve, reject) => {
    projector.registerTurn({ turnId: "u", resolve, reject });
  });
  await projector.handle(
    buildNotification("turn/completed", {
      threadId: "t",
      turn: { id: "u", status: "completed" },
    } as unknown as TurnCompletedNotification),
  );
  const resolved = await outcome;
  expect(resolved.stopReason).toBe("end_turn");
  expect(projector.currentTurnId).toBeNull();
});

test("turn/completed with interrupted resolves as cancelled", async () => {
  const { connection } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  const outcome = new Promise<TurnOutcome>((resolve, reject) => {
    projector.registerTurn({ turnId: "u", resolve, reject });
  });
  await projector.handle(
    buildNotification("turn/completed", {
      threadId: "t",
      turn: { id: "u", status: "interrupted" },
    } as unknown as TurnCompletedNotification),
  );
  expect((await outcome).stopReason).toBe("cancelled");
});

test("error notification emits chunk and resolves turn", async () => {
  const { connection, updates } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  const outcome = new Promise<TurnOutcome>((resolve, reject) => {
    projector.registerTurn({ turnId: "u", resolve, reject });
  });
  await projector.handle(
    buildNotification("error", {
      threadId: "t",
      turnId: "u",
      error: { message: "kaboom" },
    } as unknown as ErrorNotification),
  );
  expect((await outcome).stopReason).toBe("end_turn");
  expect(
    (updates.at(-1)?.update as { content: { text: string } }).content.text,
  ).toContain("kaboom");
});

test("thread token usage updates emit usage_update", async () => {
  const { connection, updates } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  await projector.handle(
    buildNotification("thread/tokenUsage/updated", {
      threadId: "t",
      tokenUsage: {
        modelContextWindow: 10000,
        last: { totalTokens: 500 },
      },
    } as unknown as ThreadTokenUsageUpdatedNotification),
  );
  const update = updates[0]?.update as { sessionUpdate: string; used: number; size: number };
  expect(update.sessionUpdate).toBe("usage_update");
  expect(update.used).toBe(500);
  expect(update.size).toBe(10000);
});

test("cancelActiveTurn resolves with cancelled", async () => {
  const { connection } = fakeConnection();
  const projector = new EventProjector(connection, "s");
  const outcome = new Promise<TurnOutcome>((resolve, reject) => {
    projector.registerTurn({ turnId: "u", resolve, reject });
  });
  projector.cancelActiveTurn();
  expect((await outcome).stopReason).toBe("cancelled");
});
