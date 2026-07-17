import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-path";

describe("safeReturnPath", () => {
  it("passes same-origin relative paths (with query/hash)", () => {
    expect(safeReturnPath("/inhouse")).toBe("/inhouse");
    expect(safeReturnPath("/matches/abc?tab=preview#stakes")).toBe(
      "/matches/abc?tab=preview#stakes",
    );
    expect(safeReturnPath("/")).toBe("/");
  });

  it("rejects open-redirect shapes", () => {
    expect(safeReturnPath("//evil.example")).toBeNull();
    expect(safeReturnPath("https://evil.example/x")).toBeNull();
    expect(safeReturnPath("/\\evil.example")).toBeNull();
    expect(safeReturnPath("javascript:alert(1)")).toBeNull();
    expect(safeReturnPath("me")).toBeNull(); // not rooted
  });

  it("rejects junk: empty, control chars, absurd length", () => {
    expect(safeReturnPath("")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath("/a\r\nSet-Cookie: x")).toBeNull();
    expect(safeReturnPath("/" + "a".repeat(600))).toBeNull();
  });
});
