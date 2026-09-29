import { describe, expect, it } from "vitest";
import {
  isCaptainLogoHost,
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

  it("keeps plain paths to image files deployed with the site", () => {
    for (const value of [
      "/brand/ggd2l-logo.png",
      "/merch/jerseys/vegan-squadron-front.PNG",
      "/teams/logos/radiant_v2.webp",
      "/logo.svg",
    ]) {
      expect(normalizeTeamLogoUrl(value)).toEqual({ logoUrl: value });
    }
  });

  // A logo is an <img> on every team surface, and an image request to the
  // site carries the viewer's cookies: a captain must not be able to make
  // every visitor start a Discord link or every admin export a season.
  it.each([
    "/api/auth/discord",
    "/api/admin/season-export?seasonId=abc",
    "/api/auth/discord.png",
    "/API/auth/discord.png",
    "/brand/logo.png?seasonId=abc",
    "/brand/logo.png#x",
    "/brand/../api/auth/discord.png",
    "/brand/./logo.png",
    "/%61pi/auth/discord.png",
    "/inhouse",
    "/teams/abc",
    "/brand/logo.html",
  ])("refuses a site path that isn't an image file: %s", (value) => {
    expect(normalizeTeamLogoUrl(value)).toEqual({
      error: expect.stringMatching(/path to an image file/),
    });
  });

  it.each([
    "https://ggd2l.example/api/auth/discord",
    "https://ggd2l.example/API/admin/season-export?seasonId=abc",
    "https://ggd2l.example/%61pi/auth/discord",
    "https://ggd2l.example/api",
  ])("refuses the site's endpoints typed as a full address: %s", (value) => {
    expect(normalizeTeamLogoUrl(value)).toEqual({
      error: expect.stringMatching(/direct link to the image file/),
    });
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

describe("isCaptainLogoHost", () => {
  it("allows Imgur image links and the site's own artwork", () => {
    expect(isCaptainLogoHost("https://i.imgur.com/abc.png")).toBe(true);
    expect(isCaptainLogoHost("/brand/logo.png")).toBe(true);
  });

  it("refuses any other host, including look-alikes of Imgur", () => {
    for (const url of [
      "https://tracker.example/x.png",
      "https://imgur.com/abc",
      "https://i.imgur.com.tracker.example/x.png",
      "https://tracker.example/i.imgur.com/x.png",
      "http://i.imgur.com/abc.png",
      "//i.imgur.com/abc.png",
      "not a url",
    ]) {
      expect(isCaptainLogoHost(url), url).toBe(false);
    }
  });

  it("agrees with the normalizer on what a site path is", () => {
    // It is only ever handed normalized logos; a path the normalizer would
    // refuse must not count as site artwork either.
    expect(isCaptainLogoHost("/api/admin/season-export")).toBe(false);
    expect(isCaptainLogoHost("/brand/../api/x.png")).toBe(false);
  });
});
