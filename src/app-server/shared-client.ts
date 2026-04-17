import { CodexAppServerClient } from "./client.ts";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.ts";
import { withTimeout } from "./timeout.ts";

type SharedClientState = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
  key?: string;
};

const STATE_SYMBOL = Symbol.for("codex-acp-bridge.sharedAppServerClient");

function getState(): SharedClientState {
  const globalState = globalThis as typeof globalThis & { [STATE_SYMBOL]?: SharedClientState };
  globalState[STATE_SYMBOL] ??= {};
  return globalState[STATE_SYMBOL];
}

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
}): Promise<CodexAppServerClient> {
  const state = getState();
  const startOptions = options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const key = codexAppServerStartOptionsKey(startOptions);
  if (state.key && state.key !== key) {
    clearSharedCodexAppServerClient();
  }
  state.key = key;
  state.promise ??= (async () => {
    const client = CodexAppServerClient.start(startOptions);
    state.client = client;
    client.addCloseHandler(clearIfCurrent);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  })();
  try {
    return await withTimeout(
      state.promise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
  } catch (error) {
    clearSharedCodexAppServerClient();
    throw error;
  }
}

export async function createIsolatedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
}): Promise<CodexAppServerClient> {
  const startOptions = options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const client = CodexAppServerClient.start(startOptions);
  const initialize = client.initialize();
  try {
    await withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
    return client;
  } catch (error) {
    client.close();
    await initialize.catch(() => undefined);
    throw error;
  }
}

export function clearSharedCodexAppServerClient(): void {
  const state = getState();
  const client = state.client;
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
  client?.close();
}

export function resetSharedCodexAppServerClientForTests(): void {
  const state = getState();
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
}

function clearIfCurrent(client: CodexAppServerClient): void {
  const state = getState();
  if (state.client !== client) {
    return;
  }
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
}
