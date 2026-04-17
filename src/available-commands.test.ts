import { expect, test } from "bun:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { resolveAvailableCommands, STATIC_AVAILABLE_COMMANDS } from "./available-commands.ts";
import { ExtensionClient } from "./extension.ts";

test("returns static commands when extensions disabled", async () => {
  const connection = {} as AgentSideConnection;
  const client = new ExtensionClient(connection, false);
  const commands = await resolveAvailableCommands(client);
  expect(commands).toBe(STATIC_AVAILABLE_COMMANDS);
});

test("uses extension response when available", async () => {
  const connection = {
    extMethod: async (method: string) => {
      if (method === "codex/available_commands") {
        return { availableCommands: [{ name: "custom-cmd", description: "x" }] };
      }
      throw new Error("unsupported");
    },
  } as unknown as AgentSideConnection;
  const client = new ExtensionClient(connection, true);
  const commands = await resolveAvailableCommands(client);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.name).toBe("custom-cmd");
});

test("falls back to static commands on invalid extension payload", async () => {
  const connection = {
    extMethod: async () => ({ availableCommands: [{ name: 1 }] }),
  } as unknown as AgentSideConnection;
  const client = new ExtensionClient(connection, true);
  const commands = await resolveAvailableCommands(client);
  expect(commands).toBe(STATIC_AVAILABLE_COMMANDS);
});
