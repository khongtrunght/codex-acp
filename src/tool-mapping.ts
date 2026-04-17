import type { ThreadItem } from "./app-server/protocol.ts";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export type ToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type MappedToolCall = {
  toolCallId: string;
  title: string;
  status?: ToolCallStatus;
  kind?: ToolCallKind;
  rawInput?: unknown;
  rawOutput?: unknown;
};

export function toolStatusFromItem(item: ThreadItem): "completed" | "failed" {
  if (item.type === "commandExecution") {
    return item.status === "failed" ? "failed" : "completed";
  }
  if (item.type === "fileChange") {
    return item.status === "failed" ? "failed" : "completed";
  }
  if (item.type === "mcpToolCall") {
    return item.status === "failed" ? "failed" : "completed";
  }
  if (item.type === "dynamicToolCall") {
    return item.status === "failed" || item.success === false ? "failed" : "completed";
  }
  return "completed";
}

export function mapItemToToolCall(item: ThreadItem, status: ToolCallStatus): MappedToolCall | null {
  switch (item.type) {
    case "commandExecution":
      return {
        toolCallId: item.id,
        title: item.command ?? "Execute command",
        status,
        kind: "execute",
        rawInput: {
          command: item.command,
          cwd: item.cwd,
        },
        rawOutput: item.aggregatedOutput,
      };
    case "fileChange":
      return {
        toolCallId: item.id,
        title: "Apply file changes",
        status,
        kind: "edit",
        rawOutput: item.changes,
      };
    case "mcpToolCall":
      return {
        toolCallId: item.id,
        title: `${item.server}:${item.tool}`,
        status,
        kind: "other",
        rawInput: item.arguments,
        rawOutput: item.result ?? item.error,
      };
    case "dynamicToolCall":
      return {
        toolCallId: item.id,
        title: item.tool ?? "Tool",
        status,
        kind: "other",
        rawInput: item.arguments,
        rawOutput: item.contentItems,
      };
    case "webSearch":
      return {
        toolCallId: item.id,
        title: `Web search: ${item.query}`,
        status,
        kind: "fetch",
      };
    case "collabAgentToolCall":
      return {
        toolCallId: item.id,
        title: `Agent tool: ${item.tool}`,
        status,
        kind: "other",
        rawInput: {
          prompt: item.prompt,
          receiverThreadIds: item.receiverThreadIds,
        },
      };
    case "imageView":
      return {
        toolCallId: item.id,
        title: `View image: ${item.path}`,
        status,
        kind: "read",
      };
    case "imageGeneration":
      return {
        toolCallId: item.id,
        title: "Generate image",
        status,
        kind: "other",
        rawOutput: item.result,
      };
    default:
      return null;
  }
}

export function toSessionTitle(preview: string | null | undefined): string | null {
  if (!preview) {
    return null;
  }
  const compact = preview.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}
