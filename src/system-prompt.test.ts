import { expect, test } from "bun:test";
import { resolveSystemPromptFields } from "./system-prompt.ts";

test("returns empty when no meta", () => {
  expect(resolveSystemPromptFields(undefined)).toEqual({});
  expect(resolveSystemPromptFields(null)).toEqual({});
  expect(resolveSystemPromptFields({})).toEqual({});
});

test("string systemPrompt maps to baseInstructions", () => {
  expect(resolveSystemPromptFields({ systemPrompt: "You are a tester." })).toEqual({
    baseInstructions: "You are a tester.",
  });
});

test("{append} maps to developerInstructions", () => {
  expect(resolveSystemPromptFields({ systemPrompt: { append: "Always be concise." } })).toEqual({
    developerInstructions: "Always be concise.",
  });
});

test("{base} maps to baseInstructions", () => {
  expect(resolveSystemPromptFields({ systemPrompt: { base: "Override." } })).toEqual({
    baseInstructions: "Override.",
  });
});

test("{base, append} supplies both fields", () => {
  expect(
    resolveSystemPromptFields({
      systemPrompt: { base: "A.", append: "B." },
    }),
  ).toEqual({
    baseInstructions: "A.",
    developerInstructions: "B.",
  });
});

test("non-string values in object are ignored", () => {
  expect(
    resolveSystemPromptFields({
      systemPrompt: { base: 42, append: null },
    }),
  ).toEqual({});
});

test("array systemPrompt is ignored", () => {
  expect(resolveSystemPromptFields({ systemPrompt: ["a", "b"] })).toEqual({});
});

test("missing systemPrompt returns empty even with other meta", () => {
  expect(resolveSystemPromptFields({ foo: "bar" })).toEqual({});
});
