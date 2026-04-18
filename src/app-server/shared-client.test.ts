import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CodexAppServerClient, MIN_CODEX_APP_SERVER_VERSION } from "./client.ts";
import {
  clearSharedCodexAppServerClient,
  createIsolatedCodexAppServerClient,
  getSharedCodexAppServerClient,
  resetSharedCodexAppServerClientForTests,
} from "./shared-client.ts";
import type { CodexAppServerTransport } from "./transport.ts";

type SpawnHarness = {
  client: CodexAppServerClient;
  writes: string[];
  process: EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof mock>;
  };
  send: (message: unknown) => void;
};

function createSpawnHarness(): SpawnHarness {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: mock(() => {
      child.killed = true;
      return true;
    }),
  });
  const client = CodexAppServerClient.fromTransportForTests(
    child as unknown as CodexAppServerTransport,
  );
  return {
    client,
    writes,
    process: child,
    send: (message) => {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readInitializeId(writes: string[]): number | string | undefined {
  const frame = JSON.parse(writes[0] ?? "{}") as { id?: number | string };
  return frame.id;
}

describe("shared codex app-server client", () => {
  afterEach(() => {
    // Drop in-memory state without closing any client — individual tests own teardown.
    resetSharedCodexAppServerClientForTests();
  });

  test("memoizes concurrent callers to a single spawn", async () => {
    const harness = createSpawnHarness();
    const startSpy = spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    try {
      const first = getSharedCodexAppServerClient();
      const second = getSharedCodexAppServerClient();

      await waitFor(() => harness.writes.length === 1);
      harness.send({
        id: readInitializeId(harness.writes),
        result: { userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });

      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      expect(startSpy).toHaveBeenCalledTimes(1);
    } finally {
      startSpy.mockRestore();
      clearSharedCodexAppServerClient();
    }
  });

  test("closes and clears the shared client when the version gate fails", async () => {
    const harness = createSpawnHarness();
    const startSpy = spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    try {
      const pending = getSharedCodexAppServerClient();
      await waitFor(() => harness.writes.length === 1);
      harness.send({
        id: readInitializeId(harness.writes),
        result: { userAgent: "codex_cli_rs/0.117.9 (macOS; test)" },
      });

      await expect(pending).rejects.toThrow(
        `Codex app-server ${MIN_CODEX_APP_SERVER_VERSION} or newer is required`,
      );
      // Shared cache must be emptied so the next caller respawns.
      const secondHarness = createSpawnHarness();
      startSpy.mockReturnValueOnce(secondHarness.client);

      const second = getSharedCodexAppServerClient();
      await waitFor(() => secondHarness.writes.length === 1);
      secondHarness.send({
        id: readInitializeId(secondHarness.writes),
        result: { userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      await expect(second).resolves.toBe(secondHarness.client);
      expect(startSpy).toHaveBeenCalledTimes(2);
    } finally {
      startSpy.mockRestore();
      clearSharedCodexAppServerClient();
    }
  });

  test("clears the shared cache when initialize times out", async () => {
    const first = createSpawnHarness();
    const second = createSpawnHarness();
    const startSpy = spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    try {
      // first call never receives a response; timeout must drop the cache.
      await expect(getSharedCodexAppServerClient({ timeoutMs: 10 })).rejects.toThrow(
        "codex app-server initialize timed out",
      );

      // Second call spawns fresh — if the cache wasn't cleared the promise would
      // still be the (now-rejected) first one.
      const pending = getSharedCodexAppServerClient();
      await waitFor(() => second.writes.length === 1);
      second.send({
        id: readInitializeId(second.writes),
        result: { userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      await expect(pending).resolves.toBe(second.client);
      expect(startSpy).toHaveBeenCalledTimes(2);
    } finally {
      startSpy.mockRestore();
      clearSharedCodexAppServerClient();
    }
  });

  test("respawns when startup options change the cache key", async () => {
    const first = createSpawnHarness();
    const second = createSpawnHarness();
    const startSpy = spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    try {
      const firstCall = getSharedCodexAppServerClient({
        startOptions: { command: "codex", args: ["app-server"], headers: {} },
      });
      await waitFor(() => first.writes.length === 1);
      first.send({
        id: readInitializeId(first.writes),
        result: { userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      const firstClient = await firstCall;

      // Different command => different key => old client closed, new one spawned.
      const secondCall = getSharedCodexAppServerClient({
        startOptions: { command: "/opt/codex", args: ["app-server"], headers: {} },
      });
      expect(first.process.kill).toHaveBeenCalled();
      await waitFor(() => second.writes.length === 1);
      second.send({
        id: readInitializeId(second.writes),
        result: { userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      const secondClient = await secondCall;

      expect(secondClient).not.toBe(firstClient);
      expect(startSpy).toHaveBeenCalledTimes(2);
    } finally {
      startSpy.mockRestore();
      clearSharedCodexAppServerClient();
    }
  });

  test("clears the cache when the shared subprocess exits", async () => {
    const first = createSpawnHarness();
    const second = createSpawnHarness();
    const startSpy = spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);

    try {
      const firstCall = getSharedCodexAppServerClient();
      await waitFor(() => first.writes.length === 1);
      first.send({
        id: readInitializeId(first.writes),
        result: { userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      await firstCall;

      // Simulate the subprocess dying unexpectedly.
      first.process.emit("exit", 1, null);

      const secondCall = getSharedCodexAppServerClient();
      await waitFor(() => second.writes.length === 1);
      second.send({
        id: readInitializeId(second.writes),
        result: { userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      await expect(secondCall).resolves.toBe(second.client);
      expect(startSpy).toHaveBeenCalledTimes(2);
    } finally {
      startSpy.mockRestore();
      clearSharedCodexAppServerClient();
    }
  });

  test("isolated clients do not populate the shared cache", async () => {
    const isolated = createSpawnHarness();
    const shared = createSpawnHarness();
    const startSpy = spyOn(CodexAppServerClient, "start")
      .mockReturnValueOnce(isolated.client)
      .mockReturnValueOnce(shared.client);

    try {
      const isolatedPromise = createIsolatedCodexAppServerClient();
      await waitFor(() => isolated.writes.length === 1);
      isolated.send({
        id: readInitializeId(isolated.writes),
        result: { userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      const isolatedClient = await isolatedPromise;

      const sharedPromise = getSharedCodexAppServerClient();
      await waitFor(() => shared.writes.length === 1);
      shared.send({
        id: readInitializeId(shared.writes),
        result: { userAgent: `codex_cli_rs/${MIN_CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      const sharedClient = await sharedPromise;

      expect(sharedClient).not.toBe(isolatedClient);
      expect(startSpy).toHaveBeenCalledTimes(2);
      isolatedClient.close();
    } finally {
      startSpy.mockRestore();
      clearSharedCodexAppServerClient();
    }
  });

  test("isolated client initialization timeout closes the subprocess", async () => {
    const harness = createSpawnHarness();
    const startSpy = spyOn(CodexAppServerClient, "start").mockReturnValue(harness.client);

    try {
      await expect(createIsolatedCodexAppServerClient({ timeoutMs: 10 })).rejects.toThrow(
        "codex app-server initialize timed out",
      );
      expect(harness.process.kill).toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
    }
  });
});
