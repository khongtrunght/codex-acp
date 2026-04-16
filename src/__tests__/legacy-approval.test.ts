import { expect, test } from "bun:test";
import { CodexAcpAgent } from "../agent.ts";

function buildAgent(optionId: string | null) {
  const controller = new AbortController();
  const fakeClient: any = {
    requestPermission: async () => {
      if (!optionId) {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId } };
    },
    sessionUpdate: async () => {},
    signal: controller.signal,
  };
  return new CodexAcpAgent(fakeClient as any) as any;
}

test("legacy execCommandApproval maps allow_once to approved", async () => {
  const agent = buildAgent("allow_once");
  const session = { sessionId: "s" };
  const res = await agent.handleLegacyExecCommandApproval(session, {
    conversationId: "t1",
    callId: "c1",
    approvalId: null,
    command: ["ls"],
    cwd: "/tmp",
    reason: null,
    parsedCmd: [],
  });
  expect(res.decision).toBe("approved");
});

test("legacy applyPatchApproval maps allow_always to approved_for_session", async () => {
  const agent = buildAgent("allow_always");
  const session = { sessionId: "s" };
  const res = await agent.handleLegacyApplyPatchApproval(session, {
    conversationId: "t1",
    callId: "c2",
    fileChanges: {},
    reason: null,
    grantRoot: null,
  });
  expect(res.decision).toBe("approved_for_session");
});

test("legacy approvals map cancelled to abort", async () => {
  const agent = buildAgent(null);
  const session = { sessionId: "s" };
  const res = await agent.handleLegacyExecCommandApproval(session, {
    conversationId: "t1",
    callId: "c3",
    approvalId: null,
    command: ["ls"],
    cwd: "/tmp",
    reason: null,
    parsedCmd: [],
  });
  expect(res.decision).toBe("abort");
});
