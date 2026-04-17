import fs from "node:fs/promises";
import { logger } from "./logger.ts";

export type CodexAppServerThreadBinding = {
  schemaVersion: 1;
  threadId: string;
  sessionFile: string;
  cwd: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
};

/** Path to the sidecar binding file that pairs an ACP session file with a Codex thread. */
export function resolveCodexAppServerBindingPath(sessionFile: string): string {
  return `${sessionFile}.codex-app-server.json`;
}

/**
 * Reads the sidecar binding written by {@link writeCodexAppServerBinding}.
 * Returns `undefined` when the file is missing, unreadable, or its
 * schemaVersion doesn't match.
 */
export async function readCodexAppServerBinding(
  sessionFile: string,
): Promise<CodexAppServerThreadBinding | undefined> {
  const path = resolveCodexAppServerBindingPath(sessionFile);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    logger.warn("failed to read codex app-server binding", { path, error });
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CodexAppServerThreadBinding>;
    if (parsed.schemaVersion !== 1 || typeof parsed.threadId !== "string") {
      return undefined;
    }
    return {
      schemaVersion: 1,
      threadId: parsed.threadId,
      sessionFile,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (error) {
    logger.warn("failed to parse codex app-server binding", { path, error });
    return undefined;
  }
}

/**
 * Persists (or refreshes) the binding for a session file. `createdAt`
 * falls back to the current time when not supplied; `updatedAt` is always
 * rewritten to now.
 */
export async function writeCodexAppServerBinding(
  sessionFile: string,
  binding: Omit<
    CodexAppServerThreadBinding,
    "schemaVersion" | "sessionFile" | "createdAt" | "updatedAt"
  > & { createdAt?: string },
): Promise<void> {
  const now = new Date().toISOString();
  const payload: CodexAppServerThreadBinding = {
    schemaVersion: 1,
    sessionFile,
    threadId: binding.threadId,
    cwd: binding.cwd,
    model: binding.model,
    createdAt: binding.createdAt ?? now,
    updatedAt: now,
  };
  await fs.writeFile(
    resolveCodexAppServerBindingPath(sessionFile),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

/** Removes the binding file. A missing file is not an error. */
export async function clearCodexAppServerBinding(sessionFile: string): Promise<void> {
  try {
    await fs.unlink(resolveCodexAppServerBindingPath(sessionFile));
  } catch (error) {
    if (!isNotFound(error)) {
      logger.warn("failed to clear codex app-server binding", { sessionFile, error });
    }
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
