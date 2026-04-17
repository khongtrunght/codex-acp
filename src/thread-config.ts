import type { McpServer } from "@agentclientprotocol/sdk";
import type { JsonObject } from "./app-server/protocol.ts";

/**
 * Maps ACP `mcpServers` into a Codex thread-config fragment of the form
 * `{ mcp_servers: {...} }`. Stdio servers become `{ command, args, env }`;
 * http/sse servers become `{ url, http_headers }`. Returns `undefined`
 * when there are no servers, so callers can spread the result only when
 * present.
 */
export function buildThreadConfigFromAcpMcpServers(
  mcpServers: McpServer[] | undefined,
): JsonObject | undefined {
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) {
    return undefined;
  }

  const codexMcpServers: JsonObject = {};

  for (const server of mcpServers) {
    const name = sanitizeMcpServerName(server.name);

    if ("command" in server) {
      const envMap =
        server.env.length > 0
          ? Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]))
          : undefined;
      codexMcpServers[name] = {
        command: server.command,
        args: server.args,
        ...(envMap ? { env: envMap } : {}),
      };
      continue;
    }

    if ("type" in server && (server.type === "http" || server.type === "sse")) {
      const headerMap =
        server.headers.length > 0
          ? Object.fromEntries(server.headers.map((header) => [header.name, header.value]))
          : undefined;
      codexMcpServers[name] = {
        url: server.url,
        ...(headerMap ? { http_headers: headerMap } : {}),
      };
      continue;
    }
  }

  if (Object.keys(codexMcpServers).length === 0) {
    return undefined;
  }

  return { mcp_servers: codexMcpServers };
}

/**
 * Collapses whitespace to underscores and returns a non-empty name. Used
 * because Codex keys MCP server entries by name, so spaces need cleanup.
 */
export function sanitizeMcpServerName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, "_");
  return trimmed.length > 0 ? trimmed : "mcp_server";
}
