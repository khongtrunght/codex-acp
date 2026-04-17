import { expect, test } from "bun:test";
import {
  isCodexAppServerApprovalRequest,
  readCodexVersionFromUserAgent,
} from "./client.ts";

test("detects approval request methods", () => {
  expect(isCodexAppServerApprovalRequest("item/fileChange/requestApproval")).toBe(true);
  expect(isCodexAppServerApprovalRequest("applyPatchApproval")).toBe(true);
  expect(isCodexAppServerApprovalRequest("turn/start")).toBe(false);
});

test("extracts semver version from user agent", () => {
  expect(readCodexVersionFromUserAgent("codex-acp-bridge/0.1.0 (node 21)")).toBe("0.1.0");
  expect(readCodexVersionFromUserAgent("custom/1.2.3-dev")).toBe("1.2.3-dev");
});

test("returns undefined for malformed user agents", () => {
  expect(readCodexVersionFromUserAgent(undefined)).toBeUndefined();
  expect(readCodexVersionFromUserAgent("no slash here")).toBeUndefined();
});
