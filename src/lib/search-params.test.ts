import { describe, expect, it } from "vitest";
import { singleSearchParam } from "./search-params";

describe("singleSearchParam", () => {
  it("keeps one non-empty value", () => {
    expect(singleSearchParam(" season-1 ")).toBe("season-1");
  });

  it("treats missing and blank values as omitted", () => {
    expect(singleSearchParam(undefined)).toBeUndefined();
    expect(singleSearchParam("   ")).toBeUndefined();
  });

  it("rejects repeated keys instead of passing an array to a data query", () => {
    expect(singleSearchParam(["season-1", "season-2"])).toBeNull();
    expect(singleSearchParam([])).toBeNull();
  });
});
