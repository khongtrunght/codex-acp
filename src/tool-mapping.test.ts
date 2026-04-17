import { expect, test } from "bun:test";
import { mapItemToToolCall, toSessionTitle, toolStatusFromItem } from "./tool-mapping.ts";
import type { ThreadItem } from "./app-server/protocol.ts";

test("maps commandExecution item with command title", () => {
  const mapped = mapItemToToolCall(
    {
      type: "commandExecution",
      id: "c1",
      command: "ls -la",
      cwd: "/tmp",
      aggregatedOutput: "out",
      status: "completed",
    } as unknown as ThreadItem,
    "completed",
  );
  expect(mapped?.title).toBe("ls -la");
  expect(mapped?.kind).toBe("execute");
});

test("returns null for unrelated item types", () => {
  expect(
    mapItemToToolCall({ type: "userMessage", id: "u" } as unknown as ThreadItem, "completed"),
  ).toBeNull();
});

test("toolStatusFromItem flags failed commandExecution", () => {
  const failed: ThreadItem = {
    type: "commandExecution",
    id: "c",
    status: "failed",
  } as unknown as ThreadItem;
  expect(toolStatusFromItem(failed)).toBe("failed");
});

test("toSessionTitle truncates long previews", () => {
  const title = toSessionTitle("a".repeat(200));
  expect(title?.length).toBeLessThanOrEqual(120);
  expect(title?.endsWith("…")).toBe(true);
});

test("toSessionTitle returns null for blank previews", () => {
  expect(toSessionTitle("   \n\t  ")).toBeNull();
  expect(toSessionTitle(null)).toBeNull();
});
