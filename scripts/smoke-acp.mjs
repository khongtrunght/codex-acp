#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { ndJsonStream, ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

class SmokeClient {
  async requestPermission(params) {
    const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options[0];
    if (!allow) {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }

  async sessionUpdate(_params) {
    // Keep smoke quiet by default.
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  // Allow smoke-testing a compiled binary: BRIDGE_BIN=dist/codex-acp-bridge.
  const bridgeBin = process.env.BRIDGE_BIN;
  const [cmd, args] = bridgeBin ? [bridgeBin, []] : ["bun", ["run", "src/index.ts"]];
  const bridge = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });

  try {
    const stream = ndJsonStream(Writable.toWeb(bridge.stdin), Readable.toWeb(bridge.stdout));
    const conn = new ClientSideConnection(() => new SmokeClient(), stream);

    const init = await withTimeout(
      conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      15000,
      "initialize",
    );

    if (!init?.agentInfo?.name) {
      throw new Error("Missing agentInfo in initialize response");
    }

    const session = await withTimeout(
      conn.newSession({ cwd: process.cwd(), mcpServers: [] }),
      20000,
      "newSession",
    );

    await withTimeout(
      conn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: smoke-ok" }],
      }),
      45000,
      "prompt",
    );

    await withTimeout(
      conn.unstable_resumeSession({
        sessionId: session.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      }),
      20000,
      "unstable_resumeSession",
    );

    const forked = await withTimeout(
      conn.unstable_forkSession({
        sessionId: session.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      }),
      20000,
      "unstable_forkSession",
    );

    await withTimeout(
      conn.unstable_closeSession({ sessionId: session.sessionId }),
      10000,
      "close original session",
    );
    await withTimeout(
      conn.unstable_closeSession({ sessionId: forked.sessionId }),
      10000,
      "close fork session",
    );

    console.log("smoke-acp: ok");
  } finally {
    bridge.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error("smoke-acp: failed", error);
  process.exitCode = 1;
});
