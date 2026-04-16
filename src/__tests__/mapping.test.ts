import { expect, test } from "bun:test";
import { buildThreadConfigFromAcpMcpServers, promptToCodexInput } from "../mapping.ts";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import type { McpServer } from "@agentclientprotocol/sdk";

test("maps base64 image to localImage input", async () => {
  const onePx = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7r4QkAAAAASUVORK5CYII=";
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [{ type: "image", data: onePx, mimeType: "image/png" }],
  });

  expect(out).toHaveLength(1);
  const first = out[0];
  expect(first?.type).toBe("localImage");
  if (!first || first.type !== "localImage") {
    throw new Error("expected localImage");
  }
  expect(typeof first.path).toBe("string");
});

test("maps data URI image (non-standard) to localImage input", async () => {
  const onePx = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7r4QkAAAAASUVORK5CYII=";
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [{ type: "image", uri: `data:image/png;base64,${onePx}` } as unknown as PromptRequest["prompt"][number]],
  } as unknown as PromptRequest);

  expect(out).toHaveLength(1);
  const first = out[0];
  expect(first?.type).toBe("localImage");
  if (!first || first.type !== "localImage") {
    throw new Error("expected localImage");
  }
  expect(typeof first.path).toBe("string");
});

test("maps audio input to descriptive text fallback", async () => {
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }],
  } as unknown as PromptRequest);

  expect(out).toHaveLength(1);
  const first = out[0];
  expect(first?.type).toBe("text");
  if (!first || first.type !== "text") {
    throw new Error("expected text");
  }
  expect(first.text).toContain("Audio input received");
});

test("maps SSE MCP server into Codex mcp_servers config", () => {
  const config = buildThreadConfigFromAcpMcpServers([
    {
      type: "sse",
      name: "my sse",
      url: "https://example.com/sse",
      headers: [{ name: "Authorization", value: "Bearer x" }],
    },
  ] as McpServer[]);

  expect(config).toBeTruthy();
  const mcpServers = (config as { mcp_servers: Record<string, { url: string; http_headers?: Record<string, string> }> })
    .mcp_servers;
  const server = mcpServers.my_sse;
  if (!server) {
    throw new Error("expected my_sse config");
  }
  expect(server.url).toBe("https://example.com/sse");
  expect(server.http_headers?.Authorization).toBe("Bearer x");
});
