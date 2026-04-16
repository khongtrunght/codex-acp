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

test("requestUserInput uses extension result when available", async () => {
  const controller = new AbortController();
  const fakeClient: any = {
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async () => {},
    signal: controller.signal,
    extMethod: async (method: string) => {
      if (method === "codex/request_user_input") {
        return { answers: { q1: { answers: ["from-ext"] } } };
      }
      throw new Error("unsupported");
    },
  };
  const agent = new CodexAcpAgent(fakeClient as any) as any;
  agent.enableExtensionMethods = true;
  const res = await agent.handleToolRequestUserInput(
    { sessionId: "s" },
    { questions: [{ id: "q1", options: [{ label: "opt1", description: "" }] }] },
  );
  expect(res.answers.q1.answers[0]).toBe("from-ext");
});

test("available commands use extension result when available", async () => {
  const controller = new AbortController();
  const fakeClient: any = {
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async () => {},
    signal: controller.signal,
    extMethod: async (method: string) => {
      if (method === "codex/available_commands") {
        return {
          availableCommands: [
            {
              name: "custom-cmd",
              description: "from extension",
            },
          ],
        };
      }
      throw new Error("unsupported");
    },
  };
  const agent = new CodexAcpAgent(fakeClient as any) as any;
  agent.enableExtensionMethods = true;
  const commands = await agent.resolveAvailableCommands();
  expect(commands).toHaveLength(1);
  expect(commands[0].name).toBe("custom-cmd");
});
