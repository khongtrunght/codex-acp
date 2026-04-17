import { CodexAppServerRpcError } from "./client.ts";

/** Canonical list of Codex app-server control methods used by the bridge. */
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

/**
 * Renders a user-facing reason for why a control method failed. Returns
 * a generic "unsupported" message for JSON-RPC "method not found" errors
 * so callers can detect old Codex servers; other errors pass through.
 */
export function describeControlFailure(error: unknown): string {
  if (isUnsupportedControlError(error)) {
    return "unsupported by this Codex app-server";
  }
  return error instanceof Error ? error.message : String(error);
}

/** True when the error is a JSON-RPC `-32601` "method not found". */
export function isUnsupportedControlError(error: unknown): error is CodexAppServerRpcError {
  return error instanceof CodexAppServerRpcError && error.code === -32601;
}
