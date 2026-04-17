import type { PromptRequest } from "@agentclientprotocol/sdk";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CodexUserInput } from "./app-server/protocol.ts";

/**
 * Converts an ACP `session/prompt` body into Codex `UserInput` entries for
 * `turn/start`.
 *
 * - `text` passes through verbatim.
 * - `resource_link` and embedded `resource` contents fold into text
 *   with the URI prefixed so Codex has the reference point.
 * - `image` accepts http(s) URLs, `data:image/...` URIs, and raw base64
 *   payloads; base64 inputs are written to a temp file and sent as
 *   `localImage` because Codex expects a path.
 * - `audio` has no Codex equivalent yet, so it is rendered as a text
 *   placeholder noting the mime type and payload size.
 *
 * Guarantees at least one input block (an empty text block) so `turn/start`
 * always has content.
 */
export async function promptToCodexInput(prompt: PromptRequest): Promise<CodexUserInput[]> {
  const input: CodexUserInput[] = [];

  for (const block of prompt.prompt) {
    if (block.type === "text") {
      input.push({ type: "text", text: block.text, text_elements: [] });
      continue;
    }

    if (block.type === "resource_link") {
      input.push({
        type: "text",
        text: `Referenced resource: ${block.uri}`,
        text_elements: [],
      });
      continue;
    }

    if (block.type === "resource" && "text" in block.resource) {
      input.push({
        type: "text",
        text: `Resource ${block.resource.uri}\n\n${block.resource.text}`,
        text_elements: [],
      });
      continue;
    }

    if (block.type === "image") {
      const resolved = await resolveImageBlock(block);
      if (resolved) {
        input.push(resolved);
      }
      continue;
    }

    if (block.type === "audio") {
      // ACP audio is not yet supported by codex app-server; stand it in as text
      // so the turn still includes the signal that audio was received.
      input.push({
        type: "text",
        text:
          block.mimeType && block.data
            ? `[Audio input received: ${block.mimeType}, ${block.data.length} base64 chars]`
            : "[Audio input received]",
        text_elements: [],
      });
      continue;
    }
  }

  if (input.length === 0) {
    input.push({ type: "text", text: "", text_elements: [] });
  }

  return input;
}

type ImageBlock = Extract<PromptRequest["prompt"][number], { type: "image" }>;

async function resolveImageBlock(block: ImageBlock): Promise<CodexUserInput | undefined> {
  if (block.uri && /^https?:\/\//.test(block.uri)) {
    return { type: "image", url: block.uri };
  }
  if (block.uri && /^data:image\//i.test(block.uri)) {
    const parsed = parseDataImageUri(block.uri);
    if (!parsed) {
      return undefined;
    }
    const localPath = await writePromptImageToTempFile(parsed.base64Data, parsed.mimeType);
    return { type: "localImage", path: localPath };
  }
  if (block.data && block.mimeType) {
    const localPath = await writePromptImageToTempFile(block.data, block.mimeType);
    return { type: "localImage", path: localPath };
  }
  return undefined;
}

async function writePromptImageToTempFile(base64Data: string, mimeType: string): Promise<string> {
  const extension = mimeTypeToExtension(mimeType);
  const dir = path.join(os.tmpdir(), "codex-acp-bridge-images");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(
    dir,
    `prompt-image-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`,
  );
  await fs.writeFile(filePath, Buffer.from(base64Data, "base64"));
  return filePath;
}

function mimeTypeToExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  return "bin";
}

function parseDataImageUri(uri: string): { mimeType: string; base64Data: string } | null {
  const match = uri.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  const mimeType = match?.[1];
  const base64Data = match?.[2];
  if (!mimeType || !base64Data) {
    return null;
  }
  return { mimeType, base64Data };
}
