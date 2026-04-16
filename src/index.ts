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
    ].join("\n"),
  );
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  process.stderr.write(`${PACKAGE_VERSION}\n`);
  process.exit(0);
}

runAcp();
