import type {
  CodexClientRequest,
  CodexServerNotification,
  CodexServerRequest,
} from "./vendor/codex-types.ts";

export type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type CodexClientRequestMessage = CodexClientRequest & { jsonrpc?: "2.0" };
export type CodexServerRequestMessage = CodexServerRequest & { jsonrpc?: "2.0" };
export type CodexServerNotificationMessage = CodexServerNotification & { jsonrpc?: "2.0" };

export type ServerRequestHandler = (request: CodexServerRequestMessage) => Promise<unknown>;
export type NotificationHandler = (notification: CodexServerNotificationMessage) => Promise<void>;
