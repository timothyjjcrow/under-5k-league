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
});
