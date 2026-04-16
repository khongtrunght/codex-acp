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

export type ServerRequestHandler = (request: JsonRpcRequest) => Promise<unknown>;
export type NotificationHandler = (notification: JsonRpcNotification) => Promise<void>;
