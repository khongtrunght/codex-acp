import type { SessionConfigOption, SessionModeState, SessionModelState } from "@agentclientprotocol/sdk";
import type { CodexAppServerClient } from "./app-server/client.ts";
import type { JsonObject, ModelListResponse } from "./app-server/protocol.ts";

export const APPROVAL_MODES: SessionModeState["availableModes"] = [
  { id: "on-request", name: "On Request", description: "Prompt for sensitive operations." },
  { id: "on-failure", name: "On Failure", description: "Prompt only when a sandboxed action fails." },
  { id: "untrusted", name: "Untrusted", description: "Strict mode for untrusted repositories." },
  { id: "never", name: "Never", description: "Never ask for approval." },
];

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
    availableModes: APPROVAL_MODES,
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

export function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
): SessionConfigOption[] {
  return [modeConfigOption(modes), modelConfigOption(models)];
}

export async function loadModelState(client: CodexAppServerClient): Promise<SessionModelState> {
  const response = await client.request<ModelListResponse>(
    "model/list",
    {} as unknown as JsonObject,
  );
  const models = response.data ?? [];
  if (models.length === 0) {
    throw new Error("No models returned from codex app-server");
  }
  const defaultModel = models.find((model) => model.isDefault) ?? models[0]!;
  return {
    currentModelId: defaultModel.id,
    availableModels: models.map((model) => ({
      modelId: model.id,
      name: model.displayName ?? model.id,
      description: model.description ?? null,
    })),
  };
}
