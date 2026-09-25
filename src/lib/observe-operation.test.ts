import { describe, expect, it } from "vitest";
import { observeOperation } from "./observe-operation";

describe("optional performance observation", () => {
  it("preserves a committed operation when its observer throws", async () => {
    const committed = { id: "saved" };
    await expect(observeOperation(async () => committed, async () => {
      throw new Error("log transport unavailable");
    })).resolves.toBe(committed);
  });
  it("preserves the original rejection even when reporting also fails", async () => {
    const original = { code: "P2024", message: "private connection details" };
    await expect(observeOperation(async () => { throw original; }, async (observation) => {
      expect(observation.failed).toBe(true);
      expect(observation.error).toBe(original);
      throw new Error("metrics unavailable");
    })).rejects.toBe(original);
  });
});
