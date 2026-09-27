import { describe, expect, it } from "vitest";
import { initials, formatNetWorth, teamInitials } from "./utils";

describe("initials", () => {
  it("takes up to two uppercase initials", () => {
    expect(initials("Radiant Wolves")).toBe("RW");
    expect(initials("sumail")).toBe("S");
    expect(initials("a b c d")).toBe("AB");
    expect(initials("")).toBe("");
  });
});

describe("teamInitials", () => {
  it("takes the first letters of the first two words", () => {
    expect(teamInitials("Radiant Raccoons")).toBe("RR");
    expect(teamInitials("Team Liquid")).toBe("TL");
    expect(teamInitials("Fire Team")).toBe("FT");
    expect(teamInitials("4 Kings")).toBe("4K");
  });

  it("skips small words", () => {
    expect(teamInitials("Sisters of the Veil")).toBe("SV");
    expect(teamInitials("The Pudge Patrol")).toBe("PP");
    expect(teamInitials("Mid or Feed")).toBe("MF");
    expect(teamInitials("Rock n Roll")).toBe("RR");
  });

  it("uses the captain's name for a default \"<captain>'s Team\"", () => {
    expect(teamInitials("Zai's Team")).toBe("ZA");
    expect(teamInitials("Zed's Team")).toBe("ZE");
    expect(teamInitials("w4tkins's Team")).toBe("W4");
    expect(teamInitials("Big Bob’s Team")).toBe("BB");
    expect(teamInitials("Roshan's Revenge")).toBe("RR");
  });

  it("gives a one-word name two letters", () => {
    expect(teamInitials("Navi")).toBe("NA");
    expect(teamInitials("x")).toBe("X");
  });

  it("ignores punctuation and emoji, and falls back when nothing is left", () => {
    expect(teamInitials("🔥 Fire Ants")).toBe("FA");
    expect(teamInitials("The The")).toBe("TT");
    expect(teamInitials("")).toBe("");
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
