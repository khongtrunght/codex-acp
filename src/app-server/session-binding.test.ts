import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  resolveCodexAppServerBindingPath,
  writeCodexAppServerBinding,
} from "./session-binding.ts";

let tempDir: string;

describe("codex app-server session binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-acp-binding-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("resolves the sidecar path next to the session file", () => {
    const sessionFile = path.join(tempDir, "session.json");
    expect(resolveCodexAppServerBindingPath(sessionFile)).toBe(
      `${sessionFile}.codex-app-server.json`,
    );
  });

  test("round-trips the thread binding beside the ACP session file", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-123",
      cwd: tempDir,
      model: "gpt-5.4-codex",
    });

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding).toMatchObject({
      schemaVersion: 1,
      threadId: "thread-123",
      sessionFile,
      cwd: tempDir,
      model: "gpt-5.4-codex",
    });
    expect(binding?.createdAt).toBeTypeOf("string");
    expect(binding?.updatedAt).toBeTypeOf("string");

    await expect(fs.stat(resolveCodexAppServerBindingPath(sessionFile))).resolves.toBeTruthy();
  });

  test("preserves createdAt and refreshes updatedAt on rewrite", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });
    const first = await readCodexAppServerBinding(sessionFile);

    // Ensure the clock advances at least one millisecond so updatedAt changes.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      createdAt: first?.createdAt,
    });
    const second = await readCodexAppServerBinding(sessionFile);

    expect(second?.createdAt).toBe(first?.createdAt);
    expect(second?.updatedAt).not.toBe(first?.updatedAt);
  });

  test("returns undefined when the binding file is missing", async () => {
    const sessionFile = path.join(tempDir, "missing.json");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  test("returns undefined for mismatched schema versions", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await fs.writeFile(
      resolveCodexAppServerBindingPath(sessionFile),
      JSON.stringify({ schemaVersion: 2, threadId: "thread-1", cwd: tempDir }),
    );
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  test("returns undefined when threadId is missing", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await fs.writeFile(
      resolveCodexAppServerBindingPath(sessionFile),
      JSON.stringify({ schemaVersion: 1, cwd: tempDir }),
    );
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  test("returns undefined for malformed JSON", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await fs.writeFile(resolveCodexAppServerBindingPath(sessionFile), "not json at all");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  test("clear removes the binding file", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-x",
      cwd: tempDir,
    });
    await clearCodexAppServerBinding(sessionFile);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
    await expect(fs.stat(resolveCodexAppServerBindingPath(sessionFile))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("clear on a missing binding is a no-op", async () => {
    const sessionFile = path.join(tempDir, "missing.json");
    await expect(clearCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  test("write pretty-prints with a trailing newline", async () => {
    const sessionFile = path.join(tempDir, "session.json");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-y",
      cwd: tempDir,
    });
    const raw = await fs.readFile(resolveCodexAppServerBindingPath(sessionFile), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('"schemaVersion": 1');
  });
});
