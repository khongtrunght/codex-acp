#!/usr/bin/env bun

import { runAcp } from "./main.ts";
import { PACKAGE_VERSION } from "./meta.ts";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stderr.write(
    [
      "Usage: codex-acp-bridge [options]",
      "",
      "Runs ACP server over stdio and bridges to codex app-server.",
      "",
      "Options:",
      "  -h, --help     Show this help",
      "  -v, --version  Show version",
      "",
      "Environment:",
      "  CODEX_BIN                       codex binary (default: codex)",
      "  CODEX_ACP_APP_SERVER_ARGS       extra args for codex app-server (shell-split)",
      "  CODEX_ACP_REQUEST_TIMEOUT_MS    per-request timeout (default: 60000)",
      "  CODEX_ACP_APPROVAL_POLICY       default approval policy",
      "  CODEX_ACP_SANDBOX               default sandbox mode",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  process.stderr.write(`${PACKAGE_VERSION}\n`);
  process.exit(0);
}

runAcp();
