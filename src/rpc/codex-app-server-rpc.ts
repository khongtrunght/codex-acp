import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { CODEX_BIN } from "../constants.ts";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../meta.ts";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  NotificationHandler,
  ServerRequestHandler,
} from "../types.ts";

export class CodexAppServerRpc {
  private child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private notificationHandler: NotificationHandler | null = null;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private readBuffer = "";

  setNotificationHandler(handler: NotificationHandler) {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler: ServerRequestHandler) {
    this.serverRequestHandler = handler;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    this.child = spawn(CODEX_BIN, ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child.on("exit", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("codex app-server exited"));
      }
      this.pending.clear();
    });

    const child = this.child;
    if (!child) {
      throw new Error("Failed to start codex app-server");
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdoutData(chunk));

    await this.request("initialize", {
      clientInfo: {
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    this.child = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        resolve();
      }, 1500);
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    this.send(payload);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(payload: unknown): void {
    if (!this.child) {
      throw new Error("codex app-server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdoutData(chunk: string): void {
    this.readBuffer += chunk;

    while (true) {
      const newLineIndex = this.readBuffer.indexOf("\n");
      if (newLineIndex < 0) {
        break;
      }

      const line = this.readBuffer.slice(0, newLineIndex).trim();
      this.readBuffer = this.readBuffer.slice(newLineIndex + 1);
      if (!line) {
        continue;
      }

      this.handleLine(line).catch((error) => {
        console.error("[codex-acp] failed to handle app-server line", error);
      });
    }
  }

  private async handleLine(line: string): Promise<void> {
    const parsed = JSON.parse(line) as JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

    if (typeof parsed === "object" && parsed !== null && "id" in parsed && ("result" in parsed || "error" in parsed)) {
      const id = parsed.id;
      if (typeof id !== "number") {
        return;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);

      if (parsed.error) {
        pending.reject(new Error(parsed.error.message));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if (typeof parsed === "object" && parsed !== null && "method" in parsed && "id" in parsed) {
      const request = parsed as JsonRpcRequest;
      if (!this.serverRequestHandler) {
        this.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: `No handler for server request method ${request.method}`,
          },
        });
        return;
      }

      try {
        const result = await this.serverRequestHandler(request);
        this.send({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        this.send({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (typeof parsed === "object" && parsed !== null && "method" in parsed) {
      if (this.notificationHandler) {
        await this.notificationHandler(parsed as JsonRpcNotification);
      }
    }
  }
}
