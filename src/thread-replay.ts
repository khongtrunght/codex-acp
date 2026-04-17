import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { mapItemToToolCall } from "./tool-mapping.ts";
import type { Thread } from "./app-server/protocol.ts";

export async function replayThreadHistory(
  client: AgentSideConnection,
  sessionId: string,
  thread: Thread,
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
                content: { type: "text", text: part.text ?? "" },
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
            content: { type: "text", text: item.text ?? "" },
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
