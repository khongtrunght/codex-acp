import { spawn } from "node:child_process";
import type { CodexAppServerStartOptions } from "./config.ts";
import type { CodexAppServerTransport } from "./transport.ts";

/**
 * Spawns the codex binary with pipes on stdin/stdout/stderr. On
 * non-Windows platforms the child is detached so it lives in its own
 * process group, which lets {@link closeCodexAppServerTransport} signal
 * the whole subtree.
 */
export function createStdioTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  return spawn(options.command, options.args, {
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
