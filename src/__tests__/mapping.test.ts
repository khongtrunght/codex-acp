import { expect, test } from "bun:test";
import { buildThreadConfigFromAcpMcpServers, promptToCodexInput } from "../mapping.ts";

test("maps base64 image to localImage input", async () => {
  const onePx = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7r4QkAAAAASUVORK5CYII=";
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [{ type: "image", data: onePx, mimeType: "image/png" }],
  });

  expect(out).toHaveLength(1);
  expect(out[0]?.type).toBe("localImage");
  expect(typeof out[0]?.path).toBe("string");
});

test("maps data URI image (non-standard) to localImage input", async () => {
  const onePx = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7r4QkAAAAASUVORK5CYII=";
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [{ type: "image", uri: `data:image/png;base64,${onePx}` } as any],
  } as any);

  expect(out).toHaveLength(1);
  expect(out[0]?.type).toBe("localImage");
  expect(typeof out[0]?.path).toBe("string");
});

test("maps audio input to descriptive text fallback", async () => {
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }],
  } as any);

  expect(out).toHaveLength(1);
  expect(out[0]?.type).toBe("text");
  expect(String(out[0]?.text)).toContain("Audio input received");
});

test("maps SSE MCP server into Codex mcp_servers config", () => {
  const config = buildThreadConfigFromAcpMcpServers([
    {
      type: "sse",
      name: "my sse",
      url: "https://example.com/sse",
      headers: [{ name: "Authorization", value: "Bearer x" }],
    },
  ] as any);

  expect(config).toBeTruthy();
  expect((config as any).mcp_servers.my_sse.url).toBe("https://example.com/sse");
  expect((config as any).mcp_servers.my_sse.http_headers.Authorization).toBe("Bearer x");
});
