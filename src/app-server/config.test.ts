import { expect, test } from "bun:test";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
} from "./config.ts";

test("uses default codex binary when env is absent", () => {
  const opts = resolveCodexAppServerRuntimeOptions({});
  expect(opts.start.command).toBe("codex");
  expect(opts.start.args).toEqual(["app-server"]);
  expect(opts.approvalPolicy).toBe("on-request");
  expect(opts.sandbox).toBe("workspace-write");
});

test("respects CODEX_BIN and extra args", () => {
  const opts = resolveCodexAppServerRuntimeOptions({
    CODEX_BIN: "/opt/codex",
    CODEX_ACP_APP_SERVER_ARGS: '--listen "stdio://" --debug',
  });
  expect(opts.start.command).toBe("/opt/codex");
  expect(opts.start.args).toEqual(["--listen", "stdio://", "--debug"]);
});

test("parses override approval policy and sandbox", () => {
  const opts = resolveCodexAppServerRuntimeOptions({
    CODEX_ACP_APPROVAL_POLICY: "never",
    CODEX_ACP_SANDBOX: "read-only",
  });
  expect(opts.approvalPolicy).toBe("never");
  expect(opts.sandbox).toBe("read-only");
});

test("ignores invalid approval policy", () => {
  const opts = resolveCodexAppServerRuntimeOptions({
    CODEX_ACP_APPROVAL_POLICY: "nonsense",
  });
  expect(opts.approvalPolicy).toBe("on-request");
});

test("codexAppServerStartOptionsKey is stable", () => {
  const left = codexAppServerStartOptionsKey({
    command: "codex",
    args: ["app-server"],
    headers: { a: "1", b: "2" },
  });
  const right = codexAppServerStartOptionsKey({
    command: "codex",
    args: ["app-server"],
    headers: { b: "2", a: "1" },
  });
  expect(left).toBe(right);
});

test("codexAppServerStartOptionsKey distinguishes different commands", () => {
  const a = codexAppServerStartOptionsKey({
    command: "codex",
    args: ["app-server"],
    headers: {},
  });
  const b = codexAppServerStartOptionsKey({
    command: "/opt/codex",
    args: ["app-server"],
    headers: {},
  });
  expect(a).not.toBe(b);
});

test("codexAppServerStartOptionsKey distinguishes different args", () => {
  const a = codexAppServerStartOptionsKey({
    command: "codex",
    args: ["app-server"],
    headers: {},
  });
  const b = codexAppServerStartOptionsKey({
    command: "codex",
    args: ["app-server", "--debug"],
    headers: {},
  });
  expect(a).not.toBe(b);
});

test("ignores invalid sandbox mode", () => {
  const opts = resolveCodexAppServerRuntimeOptions({
    CODEX_ACP_SANDBOX: "invalid-mode",
  });
  expect(opts.sandbox).toBe("workspace-write");
});

test("accepts every valid approval policy", () => {
  for (const value of ["never", "on-request", "on-failure", "untrusted"] as const) {
    const opts = resolveCodexAppServerRuntimeOptions({ CODEX_ACP_APPROVAL_POLICY: value });
    expect(opts.approvalPolicy).toBe(value);
  }
});

test("accepts every valid sandbox mode", () => {
  for (const value of ["read-only", "workspace-write", "danger-full-access"] as const) {
    const opts = resolveCodexAppServerRuntimeOptions({ CODEX_ACP_SANDBOX: value });
    expect(opts.sandbox).toBe(value);
  }
});

test("honors CODEX_ACP_REQUEST_TIMEOUT_MS when positive", () => {
  const opts = resolveCodexAppServerRuntimeOptions({ CODEX_ACP_REQUEST_TIMEOUT_MS: "5000" });
  expect(opts.requestTimeoutMs).toBe(5_000);
});

test("falls back for non-positive or non-numeric request timeouts", () => {
  for (const value of ["0", "-1", "not-a-number", ""]) {
    const opts = resolveCodexAppServerRuntimeOptions({ CODEX_ACP_REQUEST_TIMEOUT_MS: value });
    expect(opts.requestTimeoutMs).toBe(60_000);
  }
});

test("falls back to default when CODEX_BIN is empty or whitespace", () => {
  for (const value of ["", "   "]) {
    const opts = resolveCodexAppServerRuntimeOptions({ CODEX_BIN: value });
    expect(opts.start.command).toBe("codex");
  }
});

test("falls back to default args when CODEX_ACP_APP_SERVER_ARGS is whitespace-only", () => {
  const opts = resolveCodexAppServerRuntimeOptions({ CODEX_ACP_APP_SERVER_ARGS: "   " });
  expect(opts.start.args).toEqual(["app-server"]);
});

test("splits double- and single-quoted args as a single word each", () => {
  const opts = resolveCodexAppServerRuntimeOptions({
    CODEX_ACP_APP_SERVER_ARGS: `--config "a b" --name 'c d' --flag`,
  });
  expect(opts.start.args).toEqual(["--config", "a b", "--name", "c d", "--flag"]);
});

test("treats mixed quotes and bare tokens correctly", () => {
  const opts = resolveCodexAppServerRuntimeOptions({
    CODEX_ACP_APP_SERVER_ARGS: `first "second third" fourth`,
  });
  expect(opts.start.args).toEqual(["first", "second third", "fourth"]);
});
