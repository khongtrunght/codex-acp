export type CodexAppServerTransport = {
  stdin: {
    write: (data: string) => unknown;
    end?: () => unknown;
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  stdout: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  stderr: NodeJS.ReadableStream & {
    destroy?: () => unknown;
    unref?: () => unknown;
  };
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  killed?: boolean;
  kill?: (signal?: NodeJS.Signals) => unknown;
  unref?: () => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

/**
 * Gracefully shuts a Codex subprocess down: tears down stdio streams,
 * sends SIGTERM (to the process group on non-Windows so child processes
 * also receive it), and schedules a SIGKILL fallback after the given
 * delay in case the process doesn't exit on its own.
 */
export function closeCodexAppServerTransport(
  child: CodexAppServerTransport,
  options: { forceKillDelayMs?: number } = {},
): void {
  child.stdout.destroy?.();
  child.stderr.destroy?.();
  child.stdin.end?.();
  child.stdin.destroy?.();
  signalTransport(child, "SIGTERM");
  const forceKillDelayMs = options.forceKillDelayMs ?? 1_000;
  const forceKill = setTimeout(
    () => {
      if (hasExited(child)) {
        return;
      }
      signalTransport(child, "SIGKILL");
    },
    Math.max(1, forceKillDelayMs),
  );
  forceKill.unref?.();
  child.once("exit", () => clearTimeout(forceKill));
  child.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();
  child.stdin.unref?.();
}

function hasExited(child: CodexAppServerTransport): boolean {
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return true;
  }
  return child.signalCode !== null && child.signalCode !== undefined;
}

function signalTransport(child: CodexAppServerTransport, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to direct handle
    }
  }
  child.kill?.(signal);
}
