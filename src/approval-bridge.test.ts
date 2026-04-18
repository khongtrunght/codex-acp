import { expect, test } from "bun:test";
import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { ApprovalBridge } from "./approval-bridge.ts";

type RecordedRequest = {
  params: RequestPermissionRequest;
};

function fakeConnection(response: RequestPermissionResponse): {
  connection: AgentSideConnection;
  recorded: RecordedRequest[];
} {
  const recorded: RecordedRequest[] = [];
  const connection = {
    requestPermission: async (params: RequestPermissionRequest) => {
      recorded.push({ params });
      return response;
    },
  } as unknown as AgentSideConnection;
  return { connection, recorded };
}

test("legacy execCommandApproval maps allow_once to approved", async () => {
  const { connection } = fakeConnection({
    outcome: { outcome: "selected", optionId: "allow_once" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.legacyExecCommandApproval("s", {
    conversationId: "t",
    callId: "c1",
    approvalId: null,
    command: ["ls"],
    cwd: "/tmp",
    reason: null,
    parsedCmd: [],
  });
  expect(result.decision).toBe("approved");
});

test("legacy applyPatchApproval maps allow_always to approved_for_session", async () => {
  const { connection } = fakeConnection({
    outcome: { outcome: "selected", optionId: "allow_always" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.legacyApplyPatchApproval("s", {
    conversationId: "t",
    callId: "c2",
    fileChanges: {},
    reason: null,
    grantRoot: null,
  });
  expect(result.decision).toBe("approved_for_session");
});

test("legacy approvals map cancelled to abort", async () => {
  const { connection } = fakeConnection({ outcome: { outcome: "cancelled" } });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.legacyExecCommandApproval("s", {
    conversationId: "t",
    callId: "c3",
    approvalId: null,
    command: ["ls"],
    cwd: "/tmp",
    reason: null,
    parsedCmd: [],
  });
  expect(result.decision).toBe("abort");
});

test("v2 command approval maps selected option to server decision", async () => {
  const { connection, recorded } = fakeConnection({
    outcome: { outcome: "selected", optionId: "allow_once" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      command: "rm -rf /",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "command",
  );
  expect(result.decision).toBe("accept");
  expect(recorded[0]?.params.toolCall.title).toBe("rm -rf /");
});

test("v2 permissions approval respects allow_once", async () => {
  const { connection } = fakeConnection({
    outcome: { outcome: "selected", optionId: "allow_once" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.permissionsApproval("s", {
    itemId: "i",
    reason: "needs network",
    permissions: { network: true },
  } as unknown as Parameters<ApprovalBridge["permissionsApproval"]>[1]);
  expect(result.permissions).toEqual({ network: true });
  expect(result.scope).toBe("turn");
});

test("v2 permissions approval denies when rejected", async () => {
  const { connection } = fakeConnection({
    outcome: { outcome: "selected", optionId: "reject_once" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.permissionsApproval("s", {
    itemId: "i",
    reason: null,
    permissions: { network: true },
  } as unknown as Parameters<ApprovalBridge["permissionsApproval"]>[1]);
  expect(result.permissions).toEqual({});
});

test("v2 command approval maps acceptForSession", async () => {
  const { connection } = fakeConnection({
    outcome: { outcome: "selected", optionId: "allow_always" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      command: "pnpm test",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "command",
  );
  expect(result.decision).toBe("acceptForSession");
});

test("v2 command approval maps decline", async () => {
  const { connection } = fakeConnection({
    outcome: { outcome: "selected", optionId: "reject_once" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      command: "ls",
      availableDecisions: ["accept", "decline"],
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "command",
  );
  expect(result.decision).toBe("decline");
});

test("v2 command approval maps cancelled outcome to cancel", async () => {
  const { connection } = fakeConnection({ outcome: { outcome: "cancelled" } });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      command: "ls",
      availableDecisions: ["accept", "decline"],
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "command",
  );
  expect(result.decision).toBe("cancel");
});

test("v2 command approval surfaces the cancel option when available", async () => {
  const { connection, recorded } = fakeConnection({
    outcome: { outcome: "selected", optionId: "cancel" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      command: "ls",
      availableDecisions: ["accept", "cancel"],
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "command",
  );
  expect(result.decision).toBe("cancel");
  const optionIds = recorded[0]?.params.options.map((option) => option.optionId);
  expect(optionIds).toEqual(["allow_once", "cancel"]);
});

test("v2 command approval falls back to reject-only when decisions list is empty", async () => {
  const { connection, recorded } = fakeConnection({
    outcome: { outcome: "selected", optionId: "reject_once" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      command: "ls",
      availableDecisions: [],
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "command",
  );
  expect(result.decision).toBe("decline");
  expect(recorded[0]?.params.options.map((option) => option.optionId)).toEqual(["reject_once"]);
});

test("v2 command approval defaults to accept/session/decline when decisions are absent", async () => {
  const { connection, recorded } = fakeConnection({
    outcome: { outcome: "selected", optionId: "allow_always" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      command: "ls",
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "command",
  );
  expect(result.decision).toBe("acceptForSession");
  expect(recorded[0]?.params.options.map((option) => option.optionId)).toEqual([
    "allow_once",
    "allow_always",
    "reject_once",
  ]);
});

test("v2 command approval defaults unknown optionIds to decline", async () => {
  const { connection } = fakeConnection({
    outcome: { outcome: "selected", optionId: "never-mapped" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      command: "ls",
      availableDecisions: ["accept", "decline"],
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "command",
  );
  expect(result.decision).toBe("decline");
});

test("v2 file approval renders a generic title", async () => {
  const { connection, recorded } = fakeConnection({
    outcome: { outcome: "selected", optionId: "allow_once" },
  });
  const bridge = new ApprovalBridge(connection);
  await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      changes: [{ path: "/tmp/x" }],
      availableDecisions: ["accept", "decline"],
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "file",
  );
  expect(recorded[0]?.params.toolCall.title).toBe("Apply file changes");
});

test("v2 command approval generates a toolCallId when itemId is missing", async () => {
  const { connection, recorded } = fakeConnection({
    outcome: { outcome: "selected", optionId: "allow_once" },
  });
  const bridge = new ApprovalBridge(connection);
  await bridge.commandOrFileApproval(
    "s",
    {
      threadId: "t",
      turnId: "u",
      command: "ls",
      availableDecisions: ["accept", "decline"],
    } as unknown as Parameters<ApprovalBridge["commandOrFileApproval"]>[1],
    "command",
  );
  const toolCallId = recorded[0]?.params.toolCall.toolCallId;
  expect(toolCallId).toBeTypeOf("string");
  expect(toolCallId?.length ?? 0).toBeGreaterThan(0);
});

test("legacy applyPatchApproval maps allow_once to approved", async () => {
  const { connection } = fakeConnection({
    outcome: { outcome: "selected", optionId: "allow_once" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.legacyApplyPatchApproval("s", {
    conversationId: "t",
    callId: "c",
    fileChanges: {},
    reason: null,
    grantRoot: null,
  });
  expect(result.decision).toBe("approved");
});

test("legacy execCommandApproval maps reject_once to denied", async () => {
  const { connection } = fakeConnection({
    outcome: { outcome: "selected", optionId: "reject_once" },
  });
  const bridge = new ApprovalBridge(connection);
  const result = await bridge.legacyExecCommandApproval("s", {
    conversationId: "t",
    callId: "c",
    approvalId: null,
    command: ["rm"],
    cwd: "/",
    reason: null,
    parsedCmd: [],
  });
  expect(result.decision).toBe("denied");
});
