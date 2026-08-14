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
