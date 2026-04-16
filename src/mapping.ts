import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type {
  McpServer,
  PromptRequest,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionModeState,
  SessionModelState,
} from "@agentclientprotocol/sdk";

export function buildPermissionOptions(
  kind: "command" | "file",
  params: any,
  decisionMap: Map<string, unknown>,
): RequestPermissionRequest["options"] {
  const options: RequestPermissionRequest["options"] = [];

  if (kind === "command") {
    const decisions = (params.availableDecisions ?? ["accept", "acceptForSession", "decline"]) as unknown[];
    for (const decision of decisions) {
      if (decision === "accept") {
        options.push({ optionId: "allow_once", name: "Allow once", kind: "allow_once" });
        decisionMap.set("allow_once", "accept");
      } else if (decision === "acceptForSession") {
        options.push({ optionId: "allow_always", name: "Always allow", kind: "allow_always" });
        decisionMap.set("allow_always", "acceptForSession");
      } else if (decision === "decline") {
        options.push({ optionId: "reject_once", name: "Reject", kind: "reject_once" });
        decisionMap.set("reject_once", "decline");
      } else if (decision === "cancel") {
        options.push({ optionId: "cancel", name: "Cancel", kind: "reject_once" });
        decisionMap.set("cancel", "cancel");
      }
    }
  } else {
    options.push({ optionId: "allow_once", name: "Allow once", kind: "allow_once" });
    decisionMap.set("allow_once", "accept");
    options.push({ optionId: "allow_always", name: "Always allow", kind: "allow_always" });
    decisionMap.set("allow_always", "acceptForSession");
    options.push({ optionId: "reject_once", name: "Reject", kind: "reject_once" });
    decisionMap.set("reject_once", "decline");
  }

  if (options.length === 0) {
    options.push({ optionId: "reject_once", name: "Reject", kind: "reject_once" });
    decisionMap.set("reject_once", "decline");
  }

  return options;
}

export function promptToCodexInput(prompt: PromptRequest): any[] {
  const input: any[] = [];

  for (const block of prompt.prompt) {
    if (block.type === "text") {
      input.push({ type: "text", text: block.text, text_elements: [] });
      continue;
    }

    if (block.type === "resource_link") {
      input.push({
        type: "text",
        text: `Referenced resource: ${block.uri}`,
        text_elements: [],
      });
      continue;
    }

    if (block.type === "resource" && "text" in block.resource) {
      input.push({
        type: "text",
        text: `Resource ${block.resource.uri}\n\n${block.resource.text}`,
        text_elements: [],
      });
      continue;
    }

    if (block.type === "image") {
      if (block.uri && /^https?:\/\//.test(block.uri)) {
        input.push({ type: "image", url: block.uri });
      }
      continue;
    }
  }

  if (input.length === 0) {
    input.push({ type: "text", text: "", text_elements: [] });
  }

  return input;
}

export function toolStatusFromItem(item: any): "completed" | "failed" {
  if (item.type === "commandExecution") {
    return item.status === "failed" ? "failed" : "completed";
  }
  if (item.type === "fileChange") {
    return item.status === "failed" ? "failed" : "completed";
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return item.status === "error" || item.success === false ? "failed" : "completed";
  }
  return "completed";
}

export function mapItemToToolCall(item: any, status: "pending" | "completed" | "failed"):
  | {
      toolCallId: string;
      title: string;
      status?: "pending" | "completed" | "failed";
      kind?:
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
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | null {
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
        title: item.tool,
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

export function mapApprovalPolicyToModeId(approvalPolicy: unknown): string {
  if (approvalPolicy === "never") return "never";
  if (approvalPolicy === "untrusted") return "untrusted";
  if (approvalPolicy === "on-failure") return "on-failure";
  return "on-request";
}

export function mapModeIdToApprovalPolicy(modeId: string): string {
  if (modeId === "never") return "never";
  if (modeId === "untrusted") return "untrusted";
  if (modeId === "on-failure") return "on-failure";
  return "on-request";
}

export function buildModeState(currentModeId: string): SessionModeState {
  return {
    currentModeId,
    availableModes: [
      {
        id: "on-request",
        name: "On Request",
        description: "Prompt for sensitive operations.",
      },
      {
        id: "on-failure",
        name: "On Failure",
        description: "Prompt only when a sandboxed action fails.",
      },
      {
        id: "untrusted",
        name: "Untrusted",
        description: "Strict mode for untrusted repositories.",
      },
      {
        id: "never",
        name: "Never",
        description: "Never ask for approval.",
      },
    ],
  };
}

export function modelConfigOption(models: SessionModelState): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    description: "Model used for this session.",
    category: "model",
    type: "select",
    currentValue: models.currentModelId,
    options: models.availableModels.map((model) => ({
      value: model.modelId,
      name: model.name,
      description: model.description,
    })),
  };
}

export function modeConfigOption(modes: SessionModeState): SessionConfigOption {
  return {
    id: "mode",
    name: "Approval Mode",
    description: "Approval behavior for tool execution.",
    category: "mode",
    type: "select",
    currentValue: modes.currentModeId,
    options: modes.availableModes.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description,
    })),
  };
}

export function buildConfigOptions(modes: SessionModeState, models: SessionModelState): SessionConfigOption[] {
  return [modeConfigOption(modes), modelConfigOption(models)];
}

export function buildThreadConfigFromAcpMcpServers(mcpServers: McpServer[]): Record<string, unknown> | undefined {
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) {
    return undefined;
  }

  const codexMcpServers: Record<string, unknown> = {};

  for (const server of mcpServers) {
    const name = sanitizeMcpServerName(server.name);

    if ("command" in server) {
      const envMap =
        server.env.length > 0
          ? Object.fromEntries(server.env.map((entry: { name: string; value: string }) => [entry.name, entry.value]))
          : undefined;

      codexMcpServers[name] = {
        command: server.command,
        args: server.args,
        ...(envMap ? { env: envMap } : {}),
      };
      continue;
    }

    if ("type" in server && server.type === "http") {
      const headerMap =
        server.headers.length > 0
          ? Object.fromEntries(
              server.headers.map((header: { name: string; value: string }) => [header.name, header.value]),
            )
          : undefined;

      codexMcpServers[name] = {
        url: server.url,
        ...(headerMap ? { http_headers: headerMap } : {}),
      };
      continue;
    }

    // codex currently doesn't accept SSE transport config.
    console.error(`[codex-acp] ignoring unsupported MCP SSE server: ${server.name}`);
  }

  if (Object.keys(codexMcpServers).length === 0) {
    return undefined;
  }

  return {
    mcp_servers: codexMcpServers,
  };
}

export function sanitizeMcpServerName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, "_");
  return trimmed.length > 0 ? trimmed : "mcp_server";
}

export async function replayThreadHistory(
  client: AgentSideConnection,
  sessionId: string,
  thread: any,
): Promise<void> {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      if (item.type === "userMessage") {
        for (const part of item.content ?? []) {
          if (part.type === "text") {
            await client.sessionUpdate({
              sessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                content: {
                  type: "text",
                  text: part.text ?? "",
                },
              },
            });
          }
        }
        continue;
      }

      if (item.type === "agentMessage") {
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: item.text ?? "",
            },
          },
        });
        continue;
      }

      const toolCall = mapItemToToolCall(item, "completed");
      if (!toolCall) {
        continue;
      }

      await client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          ...toolCall,
        },
      });
    }
  }
}
