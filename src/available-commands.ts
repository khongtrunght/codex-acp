import type { AgentSideConnection, AvailableCommand } from "@agentclientprotocol/sdk";
import {
  CODEX_EXTENSION_METHODS,
  ExtensionClient,
  isAvailableCommandsResponse,
} from "./extension.ts";

/**
 * Default slash-command list advertised to ACP clients when the client does
 * not provide a `codex/available_commands` extension handler.
 */
export const STATIC_AVAILABLE_COMMANDS: AvailableCommand[] = [
  { name: "review", description: "Run code review in current thread." },
  { name: "review-branch", description: "Review current git branch." },
  { name: "review-commit", description: "Review a specific commit." },
  { name: "init", description: "Initialize project scaffold/instructions." },
  { name: "compact", description: "Compact conversation context." },
  { name: "logout", description: "Logout current account/session." },
];

/**
 * Asks the client (via extension method) for its command list, falling
 * back to {@link STATIC_AVAILABLE_COMMANDS} when the client has no
 * handler, returned a malformed payload, or has extensions disabled.
 */
export async function resolveAvailableCommands(
  extensions: ExtensionClient,
): Promise<AvailableCommand[]> {
  const response = await extensions.call(CODEX_EXTENSION_METHODS.availableCommands, {});
  if (response && isAvailableCommandsResponse(response)) {
    return response.availableCommands;
  }
  return STATIC_AVAILABLE_COMMANDS;
}

/**
 * Resolves the command list and sends it to the ACP client as an
 * `available_commands_update` session notification.
 */
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
