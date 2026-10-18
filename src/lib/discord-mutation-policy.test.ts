import { describe, expect, it } from "vitest";
import { discordMutationsAllowed } from "./discord-mutation-policy";

describe("discordMutationsAllowed", () => {
  it("fails closed for every Vercel preview", () => {
    expect(discordMutationsAllowed({ VERCEL_ENV: "preview" })).toBe(false);
  });

  it("preserves production and local behavior", () => {
    expect(discordMutationsAllowed({ VERCEL_ENV: "production" })).toBe(true);
    expect(discordMutationsAllowed({ VERCEL_ENV: "development" })).toBe(true);
    expect(discordMutationsAllowed({ VERCEL_ENV: undefined })).toBe(true);
  });

  it("allows a self-hosted deployment only when it declares production", () => {
    expect(discordMutationsAllowed({ LEAGUE_DEPLOY_ENV: "production" })).toBe(true);
  });

  it.each(["staging", "", "prod", "Production", "invalid"])(
    "fails closed for the declared deploy marker %j",
    (value) => {
      expect(discordMutationsAllowed({ LEAGUE_DEPLOY_ENV: value })).toBe(false);
      // A declared marker wins over Vercel's own production flag.
      expect(
        discordMutationsAllowed({ VERCEL_ENV: "production", LEAGUE_DEPLOY_ENV: value }),
      ).toBe(false);
    },
  );

  it("keeps a preview closed even when it declares production", () => {
    expect(
      discordMutationsAllowed({ VERCEL_ENV: "preview", LEAGUE_DEPLOY_ENV: "production" }),
    ).toBe(false);
  });
});
