import { expect, test } from "bun:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import {
  CODEX_EXTENSION_METHODS,
  ExtensionClient,
  isAvailableCommandsResponse,
  isDynamicToolCallResponse,
  isMcpElicitationResponse,
  isToolRequestUserInputResponse,
} from "./extension.ts";

test("ExtensionClient returns null when disabled", async () => {
  const connection = {} as AgentSideConnection;
  const client = new ExtensionClient(connection, false);
  expect(await client.call(CODEX_EXTENSION_METHODS.availableCommands, {})).toBeNull();
});

test("ExtensionClient swallows extMethod errors", async () => {
  const connection = {
    extMethod: async () => {
      throw new Error("boom");
    },
  } as unknown as AgentSideConnection;
  const client = new ExtensionClient(connection, true);
  expect(await client.call(CODEX_EXTENSION_METHODS.availableCommands, {})).toBeNull();
});

test("ExtensionClient forwards parameters", async () => {
  let called: { method: string; params: unknown } | undefined;
  const connection = {
    extMethod: async (method: string, params: Record<string, unknown>) => {
      called = { method, params };
      return { ok: true };
    },
  } as unknown as AgentSideConnection;
  const client = new ExtensionClient(connection, true);
  const response = await client.call(CODEX_EXTENSION_METHODS.dynamicToolCall, { callId: "x" });
  expect(response?.ok).toBe(true);
  expect(called?.method).toBe("codex/dynamic_tool_call");
  expect((called?.params as { callId: string }).callId).toBe("x");
});

test("isAvailableCommandsResponse validates schema", () => {
  expect(
    isAvailableCommandsResponse({ availableCommands: [{ name: "a", description: "b" }] }),
  ).toBe(true);
  expect(isAvailableCommandsResponse({ availableCommands: [{ name: "a" }] })).toBe(false);
  expect(isAvailableCommandsResponse({} as Record<string, unknown>)).toBe(false);
});

test("isDynamicToolCallResponse validates schema", () => {
  expect(
    isDynamicToolCallResponse({ success: true, contentItems: [{ type: "inputText", text: "" }] }),
  ).toBe(true);
  expect(isDynamicToolCallResponse({ success: true } as Record<string, unknown>)).toBe(false);
});

test("isMcpElicitationResponse requires action and metadata fields", () => {
  expect(isMcpElicitationResponse({ action: "accept", content: null, _meta: null })).toBe(true);
  expect(isMcpElicitationResponse({ action: "invalid", content: null, _meta: null })).toBe(false);
});

test("isToolRequestUserInputResponse accepts answer records", () => {
  expect(isToolRequestUserInputResponse({ answers: { q: { answers: ["x"] } } })).toBe(true);
  expect(isToolRequestUserInputResponse({ answers: null as unknown as Record<string, never> })).toBe(false);
});
