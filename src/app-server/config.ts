export type CodexAppServerApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";
export type CodexAppServerSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexAppServerStartOptions = {
  command: string;
  args: string[];
  headers: Record<string, string>;
};

export type CodexAppServerRuntimeOptions = {
  start: CodexAppServerStartOptions;
  requestTimeoutMs: number;
  approvalPolicy: CodexAppServerApprovalPolicy;
  sandbox: CodexAppServerSandboxMode;
};

/**
 * Builds runtime options (binary, args, timeouts, defaults) from
 * environment variables:
 *
 *  - `CODEX_BIN` — codex executable path (default `"codex"`)
 *  - `CODEX_ACP_APP_SERVER_ARGS` — extra args (shell-word split)
 *  - `CODEX_ACP_REQUEST_TIMEOUT_MS` — per-request timeout
 *  - `CODEX_ACP_APPROVAL_POLICY` — default approval policy
 *  - `CODEX_ACP_SANDBOX` — default sandbox mode
 */
export function resolveCodexAppServerRuntimeOptions(
  env: NodeJS.ProcessEnv = process.env,
): CodexAppServerRuntimeOptions {
  const command = readNonEmptyString(env.CODEX_BIN) ?? "codex";
  const args = splitShellWords(env.CODEX_ACP_APP_SERVER_ARGS ?? "");
  return {
    start: {
      command,
      args: args.length > 0 ? args : ["app-server"],
      headers: {},
    },
    requestTimeoutMs: readPositiveInt(env.CODEX_ACP_REQUEST_TIMEOUT_MS, 60_000),
    approvalPolicy: resolveApprovalPolicy(env.CODEX_ACP_APPROVAL_POLICY) ?? "on-request",
    sandbox: resolveSandbox(env.CODEX_ACP_SANDBOX) ?? "workspace-write",
  };
}

/**
 * Deterministic string key for a set of start options. Two options with
 * the same command, args, and headers (regardless of header insertion
 * order) produce the same key, so the shared-client cache can compare them.
 */
export function codexAppServerStartOptionsKey(options: CodexAppServerStartOptions): string {
  return JSON.stringify({
    command: options.command,
    args: options.args,
    headers: Object.entries(options.headers).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  });
}

function resolveApprovalPolicy(value: unknown): CodexAppServerApprovalPolicy | undefined {
  return value === "never" ||
    value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted"
    ? value
    : undefined;
}

function resolveSandbox(value: unknown): CodexAppServerSandboxMode | undefined {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
  return fallback;
}

function splitShellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of value) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    words.push(current);
  }
  return words;
}
