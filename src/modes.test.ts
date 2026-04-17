import { expect, test } from "bun:test";
import {
  buildConfigOptions,
  buildModeState,
  mapApprovalPolicyToModeId,
  mapModeIdToApprovalPolicy,
  modeConfigOption,
  modelConfigOption,
} from "./modes.ts";

test("mapApprovalPolicyToModeId normalizes unknown values to on-request", () => {
  expect(mapApprovalPolicyToModeId("never")).toBe("never");
  expect(mapApprovalPolicyToModeId("on-failure")).toBe("on-failure");
  expect(mapApprovalPolicyToModeId("untrusted")).toBe("untrusted");
  expect(mapApprovalPolicyToModeId("unknown")).toBe("on-request");
  expect(mapApprovalPolicyToModeId(undefined)).toBe("on-request");
});

test("mapModeIdToApprovalPolicy is the inverse", () => {
  for (const modeId of ["never", "on-failure", "untrusted", "on-request"]) {
    expect(mapModeIdToApprovalPolicy(modeId)).toBe(modeId);
  }
  expect(mapModeIdToApprovalPolicy("bogus")).toBe("on-request");
});

test("buildModeState includes canonical modes", () => {
  const state = buildModeState("on-request");
  expect(state.currentModeId).toBe("on-request");
  expect(state.availableModes.map((m) => m.id).sort()).toEqual(
    ["never", "on-failure", "on-request", "untrusted"].sort(),
  );
});

test("buildConfigOptions returns mode then model", () => {
  const modes = buildModeState("on-request");
  const models = {
    currentModelId: "gpt",
    availableModels: [{ modelId: "gpt", name: "GPT", description: null }],
  };
  const options = buildConfigOptions(modes, models);
  expect(options[0]).toEqual(modeConfigOption(modes));
  expect(options[1]).toEqual(modelConfigOption(models));
});
