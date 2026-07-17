import { describe, expect, it } from "vitest";
import { normalizeDiscordName } from "./discord-name";

describe("normalizeDiscordName", () => {
  it("accepts modern handles, lowercasing and stripping a leading @", () => {
    expect(normalizeDiscordName("@Dendi_Official")).toBe("dendi_official");
    expect(normalizeDiscordName("kuro.ky ")).toBe("kuro.ky");
  });

  it("accepts legacy Name#1234 tags verbatim", () => {
    expect(normalizeDiscordName("Puppey#4242")).toBe("Puppey#4242");
  });

  it("blank clears the field (empty string, not null)", () => {
    expect(normalizeDiscordName("   ")).toBe("");
  });

  it("rejects impossible handles", () => {
    expect(normalizeDiscordName("x")).toBeNull(); // too short
    expect(normalizeDiscordName("a".repeat(33))).toBeNull(); // too long
    expect(normalizeDiscordName("has spaces")).toBeNull();
    expect(normalizeDiscordName("nope#12")).toBeNull(); // bad discriminator
  });
});
