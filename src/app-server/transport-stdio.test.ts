import { describe, expect, test } from "bun:test";
import { createStdioTransport } from "./transport-stdio.ts";

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function waitForExit(child: ReturnType<typeof createStdioTransport>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    child.once("exit", (...args: unknown[]) => {
      resolve({
        code: (args[0] as number | null) ?? null,
        signal: (args[1] as NodeJS.Signals | null) ?? null,
      });
    });
  });
}

describe("createStdioTransport", () => {
  test("spawns the configured command and exposes stdin/stdout/stderr pipes", async () => {
    const child = createStdioTransport({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ready'); process.exit(0);"],
      headers: {},
    });

    const stdout = await readAll(child.stdout);
    const exit = await waitForExit(child);

    expect(stdout).toBe("ready");
    expect(exit.code).toBe(0);
    expect(typeof child.pid).toBe("number");
  });

  test("forwards stdin writes to the child process", async () => {
    const child = createStdioTransport({
      command: process.execPath,
      args: [
        "-e",
        "let buf=''; process.stdin.on('data', (c) => buf += c); process.stdin.on('end', () => process.stdout.write(buf));",
      ],
      headers: {},
    });

    child.stdin.write("hello\n");
    child.stdin.end?.();

    const stdout = await readAll(child.stdout);
    await waitForExit(child);
    expect(stdout).toBe("hello\n");
  });

  test("forwards stderr separately from stdout", async () => {
    const child = createStdioTransport({
      command: process.execPath,
      args: ["-e", "process.stderr.write('boom'); process.stdout.write('ok'); process.exit(0);"],
      headers: {},
    });

    const [stdout, stderr] = await Promise.all([readAll(child.stdout), readAll(child.stderr)]);
    await waitForExit(child);
    expect(stdout).toBe("ok");
    expect(stderr).toBe("boom");
  });

  test("can terminate the child with kill()", async () => {
    const child = createStdioTransport({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      headers: {},
    });

    const exitPromise = waitForExit(child);
    expect(typeof child.kill).toBe("function");
    child.kill?.("SIGTERM");
    const exit = await exitPromise;
    // Windows signals work differently; only assert the child actually exited.
    expect(exit.code !== null || exit.signal !== null).toBe(true);
  });

  test("detaches the child into its own process group on non-Windows platforms", () => {
    if (process.platform === "win32") {
      return;
    }
    const child = createStdioTransport({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 50);"],
      headers: {},
    });
    // A detached child's pid equals its process group id.
    const pid = child.pid;
    expect(typeof pid).toBe("number");
    try {
      const getpgid = (
        process as NodeJS.Process & {
          getpgid?: (pid: number) => number;
        }
      ).getpgid;
      if (pid !== undefined && getpgid) {
        expect(getpgid(pid)).toBe(pid);
      }
    } finally {
      child.kill?.("SIGTERM");
    }
  });
});
