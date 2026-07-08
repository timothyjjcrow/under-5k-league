import { describe, expect, it } from "vitest";
import { initials, formatNetWorth } from "./utils";

describe("initials", () => {
  it("takes up to two uppercase initials", () => {
    expect(initials("Radiant Wolves")).toBe("RW");
    expect(initials("sumail")).toBe("S");
    expect(initials("a b c d")).toBe("AB");
    expect(initials("")).toBe("");
  });
});

describe("formatNetWorth", () => {
  it("abbreviates thousands to one decimal", () => {
    expect(formatNetWorth(12500)).toBe("12.5k");
    expect(formatNetWorth(1000)).toBe("1.0k");
    expect(formatNetWorth(22000)).toBe("22.0k");
  });
  it("leaves sub-1000 values plain and handles null", () => {
    expect(formatNetWorth(999)).toBe("999");
    expect(formatNetWorth(0)).toBe("0");
    expect(formatNetWorth(null)).toBe("—");
    expect(formatNetWorth(undefined)).toBe("—");
  });
});
