import { expect, test } from "bun:test";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { promptToCodexInput } from "./prompt-input.ts";

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7r4QkAAAAASUVORK5CYII=";

test("maps base64 image to localImage input", async () => {
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [{ type: "image", data: ONE_PX_PNG, mimeType: "image/png" }],
  });

  expect(out).toHaveLength(1);
  const first = out[0];
  if (!first || first.type !== "localImage") {
    throw new Error("expected localImage");
  }
  expect(typeof first.path).toBe("string");
});

test("maps data URI image to localImage input", async () => {
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [
      {
        type: "image",
        uri: `data:image/png;base64,${ONE_PX_PNG}`,
      } as unknown as PromptRequest["prompt"][number],
    ],
  } as unknown as PromptRequest);

  const first = out[0];
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

  const first = out[0];
  if (!first || first.type !== "text") {
    throw new Error("expected text");
  }
  expect(first.text).toContain("Audio input received");
});

test("substitutes empty text when no usable blocks", async () => {
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [],
  } as unknown as PromptRequest);

  expect(out).toHaveLength(1);
  const first = out[0];
  if (!first || first.type !== "text") {
    throw new Error("expected text");
  }
  expect(first.text).toBe("");
});

test("maps resource link block to descriptive text", async () => {
  const out = await promptToCodexInput({
    sessionId: "s",
    prompt: [
      {
        type: "resource_link",
        uri: "file:///tmp/example.md",
      } as unknown as PromptRequest["prompt"][number],
    ],
  } as unknown as PromptRequest);

  const first = out[0];
  if (!first || first.type !== "text") {
    throw new Error("expected text");
  }
  expect(first.text).toContain("file:///tmp/example.md");
});
