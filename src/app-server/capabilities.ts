import { CodexAppServerRpcError } from "./client.ts";

export const CODEX_CONTROL_METHODS = {
  compact: "thread/compact/start",
  listThreads: "thread/list",
  listModels: "model/list",
  startThread: "thread/start",
  resumeThread: "thread/resume",
  forkThread: "thread/fork",
  startTurn: "turn/start",
  interruptTurn: "turn/interrupt",
  steerTurn: "turn/steer",
} as const;

export type CodexControlName = keyof typeof CODEX_CONTROL_METHODS;
export type CodexControlMethod = (typeof CODEX_CONTROL_METHODS)[CodexControlName];

export function describeControlFailure(error: unknown): string {
  if (isUnsupportedControlError(error)) {
    return "unsupported by this Codex app-server";
  }
  return error instanceof Error ? error.message : String(error);
}

export function isUnsupportedControlError(error: unknown): error is CodexAppServerRpcError {
  return error instanceof CodexAppServerRpcError && error.code === -32601;
}
