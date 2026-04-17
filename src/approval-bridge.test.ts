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
