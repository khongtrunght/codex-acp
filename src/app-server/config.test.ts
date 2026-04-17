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
