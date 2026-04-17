import { spawn } from "node:child_process";
import type { CodexAppServerStartOptions } from "./config.ts";
import type { CodexAppServerTransport } from "./transport.ts";

export function createStdioTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  return spawn(options.command, options.args, {
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
