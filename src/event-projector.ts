import type { AgentSideConnection, StopReason } from "@agentclientprotocol/sdk";
import type {
  AgentMessageDeltaNotification,
  CodexServerNotification,
  CommandExecutionOutputDeltaNotification,
  ErrorNotification,
  FileChangeOutputDeltaNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  PlanDeltaNotification,
  ReasoningSummaryTextDeltaNotification,
  ReasoningTextDeltaNotification,
  ThreadItem,
  ThreadNameUpdatedNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
} from "./app-server/protocol.ts";
import { mapItemToToolCall, toolStatusFromItem } from "./tool-mapping.ts";

/** Resolution value for a completed (or interrupted) turn. */
export type TurnOutcome = {
  stopReason: StopReason;
  turnId: string;
};

/** Pending turn state tracked by the projector between prompt and turn/completed. */
export type ActiveTurn = {
  turnId: string;
  resolve: (outcome: TurnOutcome) => void;
  reject: (error: unknown) => void;
};

/**
 * Translates Codex app-server notifications into ACP `session/update`
 * messages.
 *
 * Holds per-turn state (plan deltas, terminal processes, active turn
 * waiter). Instances are created per {@link CodexSession} and filter
 * incoming notifications so they never leak across threads.
 */
export class EventProjector {
  private readonly connection: AgentSideConnection;
  private readonly sessionId: string;
  private readonly threadId: string | undefined;
  private readonly planDeltaByItemId = new Map<string, string>();
  private readonly terminalProcessByItemId = new Map<string, string>();
  private activeTurn: ActiveTurn | null = null;

  constructor(connection: AgentSideConnection, sessionId: string, threadId?: string) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.threadId = threadId;
  }

  /** Records the turn waiter. Throws if a turn is already active. */
  registerTurn(turn: ActiveTurn): void {
    if (this.activeTurn) {
      throw new Error("Another turn is already active for this session.");
    }
    this.activeTurn = turn;
  }

  /** Drops the turn waiter without resolving it. Rarely needed. */
  clearTurn(): void {
    this.activeTurn = null;
  }

  /** Active turn ID or `null` when no turn is in flight. */
  get currentTurnId(): string | null {
    return this.activeTurn?.turnId ?? null;
  }

  /**
   * Resolves the active turn with the given reason (default `"cancelled"`)
   * and clears it. No-op if no turn is active.
   */
  cancelActiveTurn(reason: StopReason = "cancelled"): void {
    if (!this.activeTurn) {
      return;
    }
    const turn = this.activeTurn;
    this.activeTurn = null;
    turn.resolve({ stopReason: reason, turnId: turn.turnId });
  }

  /**
   * Dispatches a Codex notification to the matching handler. Unknown
   * notification methods are ignored. Callers should gate by thread ID
   * before calling this (see {@link CodexSession}).
   */
  async handle(notification: CodexServerNotification): Promise<void> {
    switch (notification.method) {
      case "item/agentMessage/delta":
        await this.emitTextChunk(
          "agent_message_chunk",
          (notification.params as AgentMessageDeltaNotification)?.delta,
        );
        return;
      case "item/reasoning/textDelta":
        await this.emitTextChunk(
          "agent_thought_chunk",
          (notification.params as ReasoningTextDeltaNotification)?.delta,
        );
        return;
      case "item/reasoning/summaryTextDelta":
        await this.emitTextChunk(
          "agent_thought_chunk",
          (notification.params as ReasoningSummaryTextDeltaNotification)?.delta,
        );
        return;
      case "item/plan/delta":
        await this.handlePlanDelta(notification.params as PlanDeltaNotification);
        return;
      case "turn/plan/updated":
        await this.handleTurnPlanUpdated(notification.params as TurnPlanUpdatedNotification);
        return;
      case "item/started":
        await this.handleItemStarted((notification.params as ItemStartedNotification).item);
        return;
      case "item/completed":
        await this.handleItemCompleted((notification.params as ItemCompletedNotification).item);
        return;
      case "item/commandExecution/outputDelta":
        await this.handleCommandExecutionOutputDelta(
          notification.params as CommandExecutionOutputDeltaNotification,
        );
        return;
      case "item/fileChange/outputDelta":
        await this.handleFileChangeOutputDelta(
          notification.params as FileChangeOutputDeltaNotification,
        );
        return;
      case "thread/tokenUsage/updated":
        await this.handleTokenUsage(notification.params as ThreadTokenUsageUpdatedNotification);
        return;
      case "thread/name/updated":
        await this.handleThreadNameUpdated(notification.params as ThreadNameUpdatedNotification);
        return;
      case "turn/completed":
        await this.handleTurnCompleted(notification.params as TurnCompletedNotification);
        return;
      case "error":
        await this.handleErrorNotification(notification.params as ErrorNotification);
        return;
      default:
        return;
    }
  }

  private async emitTextChunk(
    kind: "agent_message_chunk" | "agent_thought_chunk",
    delta: string | undefined,
  ): Promise<void> {
    if (!delta) {
      return;
    }
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: kind,
        content: { type: "text", text: delta },
      },
    });
  }

  private async handlePlanDelta(params: PlanDeltaNotification): Promise<void> {
    const previous = this.planDeltaByItemId.get(params.itemId) ?? "";
    const next = previous + (params.delta ?? "");
    this.planDeltaByItemId.set(params.itemId, next);
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [{ content: next, priority: "medium", status: "in_progress" }],
      },
    });
  }

  private async handleTurnPlanUpdated(params: TurnPlanUpdatedNotification): Promise<void> {
    const plan = Array.isArray(params.plan) ? params.plan : [];
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "plan",
        entries: plan.map((entry) => ({
          content: entry.step ?? "",
          priority: "medium",
          status: normalizePlanStatus(entry.status),
        })),
      },
    });
  }

  private async handleItemStarted(item: ThreadItem): Promise<void> {
    if (item.type === "plan") {
      await this.connection.sessionUpdate({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: item.text ?? "", priority: "medium", status: "in_progress" }],
        },
      });
      return;
    }

    if (item.type === "commandExecution" && item.processId) {
      this.terminalProcessByItemId.set(item.id, item.processId);
    }

    const toolCall = mapItemToToolCall(item, "pending");
    if (!toolCall) {
      return;
    }

    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        ...(item.type === "commandExecution" && item.processId
          ? { _meta: { terminal_info: { terminal_id: item.processId } } }
          : {}),
        ...toolCall,
      },
    });
  }

  private async handleItemCompleted(item: ThreadItem): Promise<void> {
    if (item.type === "agentMessage") {
      return;
    }

    if (item.type === "plan") {
      this.planDeltaByItemId.delete(item.id);
      await this.connection.sessionUpdate({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: item.text ?? "", priority: "medium", status: "completed" }],
        },
      });
      return;
    }

    const toolCall = mapItemToToolCall(item, toolStatusFromItem(item));
    if (!toolCall) {
      return;
    }

    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        ...(item.type === "commandExecution"
          ? {
              _meta: {
                terminal_exit: {
                  terminal_id: this.terminalProcessByItemId.get(item.id) ?? item.id,
                  exit_code: item.exitCode ?? 0,
                  signal: null,
                },
              },
            }
          : {}),
        ...toolCall,
      },
    });

    if (item.type === "commandExecution") {
      this.terminalProcessByItemId.delete(item.id);
    }
  }

  private async handleCommandExecutionOutputDelta(
    params: CommandExecutionOutputDeltaNotification,
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: params.itemId,
        status: "in_progress",
        kind: "execute",
        rawOutput: params.delta ?? "",
        _meta: {
          terminal_output: {
            terminal_id: this.terminalProcessByItemId.get(params.itemId) ?? params.itemId,
            data: params.delta ?? "",
          },
        },
      },
    });
  }

  private async handleFileChangeOutputDelta(
    params: FileChangeOutputDeltaNotification,
  ): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: params.itemId,
        status: "in_progress",
        kind: "edit",
        rawOutput: params.delta ?? "",
      },
    });
  }

  private async handleTokenUsage(params: ThreadTokenUsageUpdatedNotification): Promise<void> {
    const usage = params.tokenUsage?.last ?? params.tokenUsage?.total;
    if (!usage) {
      return;
    }
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "usage_update",
        size: params.tokenUsage?.modelContextWindow ?? 0,
        used: usage.totalTokens ?? 0,
      },
    });
  }

  private async handleThreadNameUpdated(params: ThreadNameUpdatedNotification): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title: params.threadName ?? null,
      },
    });
  }

  private async handleTurnCompleted(params: TurnCompletedNotification): Promise<void> {
    if (!this.activeTurn || this.activeTurn.turnId !== params.turn?.id) {
      return;
    }
    const turn = this.activeTurn;
    this.activeTurn = null;
    const stopReason: StopReason = params.turn?.status === "interrupted" ? "cancelled" : "end_turn";
    turn.resolve({ stopReason, turnId: turn.turnId });
  }

  private async handleErrorNotification(params: ErrorNotification): Promise<void> {
    if (this.activeTurn && params.turnId === this.activeTurn.turnId) {
      const turn = this.activeTurn;
      this.activeTurn = null;
      turn.resolve({ stopReason: "end_turn", turnId: turn.turnId });
    }
    await this.connection.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `\n[Codex error] ${params.error?.message ?? "Unknown error"}\n`,
        },
      },
    });
  }
}

function normalizePlanStatus(
  status: TurnPlanUpdatedNotification["plan"][number]["status"] | undefined,
): "pending" | "in_progress" | "completed" {
  if (status === "completed") return "completed";
  if (status === "inProgress") return "in_progress";
  return "pending";
}
