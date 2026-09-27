import { describe, expect, it } from "vitest";
import {
  normalizeTeamLogoUrl,
  TEAM_LOGO_URL_MAX_LENGTH,
} from "./team-logo";

describe("normalizeTeamLogoUrl", () => {
  it("clears a logo when the field is blank", () => {
    expect(normalizeTeamLogoUrl("  ")).toEqual({ logoUrl: null });
  });

  it("accepts HTTPS and root-relative image locations", () => {
    expect(normalizeTeamLogoUrl(" https://cdn.example/logo.png ")).toEqual({
      logoUrl: "https://cdn.example/logo.png",
    });
    expect(normalizeTeamLogoUrl("/teams/logos/radiant.png")).toEqual({
      logoUrl: "/teams/logos/radiant.png",
    });
  });

  it.each([
    "http://cdn.example/logo.png",
    "//cdn.example/logo.png",
    "/\\cdn.example/logo.png",
    "data:image/png;base64,abc",
    "javascript:alert(1)",
    "not a URL",
    "https://user:secret@cdn.example/logo.png",
    "https://cdn.example/lo\ngo.png",
  ])("rejects unsafe or unusable locations: %s", (value) => {
    expect(normalizeTeamLogoUrl(value)).toHaveProperty("error");
  });

  it.each([
    "https://cdn.discordapp.com/attachments/1/2/logo.png?ex=66f00000&is=66ee0000&hm=abc&",
    "https://media.discordapp.net/attachments/1/2/logo.png?ex=66f00000&is=66ee0000&hm=abc&=&format=webp",
    "https://CDN.DISCORDAPP.COM/attachments/1/2/logo.png",
    "https://cdn.discordapp.com/ephemeral-attachments/1/2/logo.png",
  ])("refuses expiring Discord attachment links with a way forward: %s", (value) => {
    const result = normalizeTeamLogoUrl(value);
    expect(result).toHaveProperty("error");
    expect("error" in result && result.error).toMatch(
      /stop working after about a day.*permanent/,
    );
  });

  it("keeps permanent Discord images such as emoji and server icons", () => {
    for (const value of [
      "https://cdn.discordapp.com/emojis/123456789.png",
      "https://cdn.discordapp.com/icons/1/abc.png",
    ]) {
      expect(normalizeTeamLogoUrl(value)).toEqual({ logoUrl: value });
    }
  });

  it("bounds stored URLs", () => {
    expect(
      normalizeTeamLogoUrl(
        `https://cdn.example/${"x".repeat(TEAM_LOGO_URL_MAX_LENGTH)}`,
      ),
    ).toHaveProperty("error");
    // URL canonicalization percent-encodes Unicode, so enforce the bound on
    // the stored form as well as the raw form.
    expect(
      normalizeTeamLogoUrl(`https://cdn.example/${"é".repeat(400)}`),
    ).toHaveProperty("error");
  });
});
