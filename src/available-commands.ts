import type { AgentSideConnection, AvailableCommand } from "@agentclientprotocol/sdk";
import {
  CODEX_EXTENSION_METHODS,
  ExtensionClient,
  isAvailableCommandsResponse,
} from "./extension.ts";

export const STATIC_AVAILABLE_COMMANDS: AvailableCommand[] = [
  { name: "review", description: "Run code review in current thread." },
  { name: "review-branch", description: "Review current git branch." },
  { name: "review-commit", description: "Review a specific commit." },
  { name: "init", description: "Initialize project scaffold/instructions." },
  { name: "compact", description: "Compact conversation context." },
  { name: "logout", description: "Logout current account/session." },
];

export async function resolveAvailableCommands(
  extensions: ExtensionClient,
): Promise<AvailableCommand[]> {
  const response = await extensions.call(CODEX_EXTENSION_METHODS.availableCommands, {});
  if (response && isAvailableCommandsResponse(response)) {
    return response.availableCommands;
  }
  return STATIC_AVAILABLE_COMMANDS;
}

export async function sendAvailableCommandsUpdate(
  connection: AgentSideConnection,
  sessionId: string,
  extensions: ExtensionClient,
): Promise<void> {
  const availableCommands = await resolveAvailableCommands(extensions);
  await connection.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands,
    },
  });
}
