// Maps ACP `_meta.systemPrompt` into the Codex app-server `thread/start` fields.
// Mirrors the claude-agent-acp API:
//   { systemPrompt: "text" }                -> baseInstructions (replaces preset)
//   { systemPrompt: { append: "..." } }     -> developerInstructions (extra)
// Both can also be combined: { systemPrompt: { base, append } }.

export type SystemPromptFields = {
  baseInstructions?: string;
  developerInstructions?: string;
};

export function resolveSystemPromptFields(
  meta: Record<string, unknown> | null | undefined,
): SystemPromptFields {
  if (!meta) {
    return {};
  }
  const raw = meta.systemPrompt;
  if (typeof raw === "string") {
    return { baseInstructions: raw };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const result: SystemPromptFields = {};
    if (typeof obj.base === "string") {
      result.baseInstructions = obj.base;
    }
    if (typeof obj.append === "string") {
      result.developerInstructions = obj.append;
    }
    return result;
  }
  return {};
}
