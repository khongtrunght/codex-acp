import { expect, test } from "bun:test";
import type { McpServer } from "@agentclientprotocol/sdk";
import { buildThreadConfigFromAcpMcpServers, sanitizeMcpServerName } from "./thread-config.ts";

test("returns undefined when no servers", () => {
  expect(buildThreadConfigFromAcpMcpServers([])).toBeUndefined();
  expect(buildThreadConfigFromAcpMcpServers(undefined)).toBeUndefined();
});

test("maps SSE MCP server into mcp_servers config", () => {
  const config = buildThreadConfigFromAcpMcpServers([
    {
      type: "sse",
      name: "my sse",
      url: "https://example.com/sse",
      headers: [{ name: "Authorization", value: "Bearer x" }],
    },
  ] as McpServer[]);

  const servers = (
    config as {
      mcp_servers: Record<string, { url: string; http_headers?: Record<string, string> }>;
    }
  ).mcp_servers;
  const server = servers.my_sse;
  if (!server) {
    throw new Error("expected my_sse config");
  }
  expect(server.url).toBe("https://example.com/sse");
  expect(server.http_headers?.Authorization).toBe("Bearer x");
});

test("maps stdio MCP server with env map", () => {
  const config = buildThreadConfigFromAcpMcpServers([
    {
      name: "local",
      command: "codex-helper",
      args: ["--flag"],
      env: [{ name: "DEBUG", value: "1" }],
    },
  ] as McpServer[]);

  const servers = (
    config as {
      mcp_servers: Record<
        string,
        { command: string; args: string[]; env?: Record<string, string> }
      >;
    }
  ).mcp_servers;
  const server = servers.local;
  if (!server) {
    throw new Error("expected local config");
  }
  expect(server.command).toBe("codex-helper");
  expect(server.env?.DEBUG).toBe("1");
});

test("sanitizeMcpServerName replaces spaces and falls back to default", () => {
  expect(sanitizeMcpServerName("my name")).toBe("my_name");
  expect(sanitizeMcpServerName("  ")).toBe("mcp_server");
});
