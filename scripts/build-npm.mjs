#!/usr/bin/env node
// Builds the npm package in dist/: JS bundles via bun build, .d.ts via tsc.
// Rewrites the cli shebang from bun to node so `npx codex-acp` works
// without requiring bun on end-user machines. Bun is still the dev runtime.

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: repoRoot });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("bun", [
  "build",
  "src/index.ts",
  "--outdir",
  "dist",
  "--target",
  "node",
  "--format",
  "esm",
  "--external",
  "@agentclientprotocol/sdk",
]);

run("bun", [
  "build",
  "src/lib.ts",
  "--outdir",
  "dist",
  "--target",
  "node",
  "--format",
  "esm",
  "--external",
  "@agentclientprotocol/sdk",
]);

run("bunx", ["tsc", "-p", "tsconfig.build.json"]);

// Rewrite shebang on the CLI bundle so it runs under node, not bun.
const cliPath = resolve(repoRoot, "dist/index.js");
const cli = await readFile(cliPath, "utf8");
const rewritten = cli.replace(/^#!.*\n/, "#!/usr/bin/env node\n");
await writeFile(cliPath, rewritten, "utf8");
