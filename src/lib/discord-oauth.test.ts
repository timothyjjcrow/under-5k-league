import { describe, it, expect } from "vitest";
import {
  buildDiscordAuthUrl,
  codeChallengeS256,
  discordProfileFromMe,
  packOauthCookie,
  randomOauthValue,
  safeEqual,
  unpackOauthCookie,
} from "./discord-oauth";

describe("buildDiscordAuthUrl", () => {
  const url = buildDiscordAuthUrl({
    clientId: "1234567890",
    redirectUri: "https://ld2l.example/api/auth/discord/callback",
    state: "st4te-value",
    codeChallenge: "chall3nge",
  });
  const parsed = new URL(url);

  it("targets Discord's authorize endpoint", () => {
    expect(parsed.origin).toBe("https://discord.com");
    expect(parsed.pathname).toBe("/oauth2/authorize");
  });

  it("carries the code flow + PKCE params", () => {
    expect(parsed.searchParams.get("client_id")).toBe("1234567890");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://ld2l.example/api/auth/discord/callback",
    );
    expect(parsed.searchParams.get("state")).toBe("st4te-value");
    expect(parsed.searchParams.get("code_challenge")).toBe("chall3nge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("asks ONLY for identify — scope creep here is a privacy regression", () => {
    expect(parsed.searchParams.get("scope")).toBe("identify");
  });
});

describe("codeChallengeS256", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(
      codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("randomOauthValue", () => {
  it("is URL-safe and long enough to be unguessable", () => {
    const v = randomOauthValue();
    expect(v).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(randomOauthValue()).not.toBe(v);
  });
});

describe("oauth cookie pack/unpack", () => {
  it("round-trips state + verifier", () => {
    const packed = packOauthCookie("abc", "def");
    expect(unpackOauthCookie(packed)).toEqual({ state: "abc", verifier: "def" });
  });

  it("round-trips real random values (base64url never contains the separator)", () => {
    const state = randomOauthValue();
    const verifier = randomOauthValue();
    expect(unpackOauthCookie(packOauthCookie(state, verifier))).toEqual({
      state,
      verifier,
    });
  });

  it.each(["", "no-separator", ".leading", "trailing.", "a.b.c", null, undefined])(
    "rejects malformed cookie %j",
    (v) => {
      expect(unpackOauthCookie(v as string | null | undefined)).toBeNull();
    },
  );
});

describe("safeEqual", () => {
  it("matches equal strings and rejects different ones", () => {
    expect(safeEqual("same-state", "same-state")).toBe(true);
    expect(safeEqual("same-state", "other-state")).toBe(false);
    expect(safeEqual("short", "longer-value")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("discordProfileFromMe", () => {
  it("accepts a modern account (discriminator 0) and stores the handle", () => {
    expect(
      discordProfileFromMe({
        id: "80351110224678912",
        username: "dendi_official",
        discriminator: "0",
        global_name: "Dendi",
      }),
    ).toEqual({ discordId: "80351110224678912", discordName: "dendi_official" });
  });

  it("keeps the legacy name#1234 form for old accounts", () => {
    expect(
      discordProfileFromMe({
        id: "80351110224678912",
        username: "Dendi",
        discriminator: "1337",
      }),
    ).toEqual({ discordId: "80351110224678912", discordName: "Dendi#1337" });
  });

  it("treats a missing discriminator as modern", () => {
    expect(
      discordProfileFromMe({ id: "80351110224678912", username: "arteezy" }),
    ).toEqual({ discordId: "80351110224678912", discordName: "arteezy" });
  });

  it("trims username whitespace", () => {
    expect(
      discordProfileFromMe({ id: "80351110224678912", username: " neat " }),
    ).toEqual({ discordId: "80351110224678912", discordName: "neat" });
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["missing id", { username: "x" }],
    ["non-numeric id", { id: "abc123", username: "x" }],
    ["id too short", { id: "1234", username: "x" }],
    ["id too long", { id: "1".repeat(26), username: "x" }],
    ["missing username", { id: "80351110224678912" }],
    ["blank username", { id: "80351110224678912", username: "   " }],
    [
      "username over 40 chars",
      { id: "80351110224678912", username: "x".repeat(41) },
    ],
    ["numeric id (not string)", { id: 80351110224678912, username: "x" }],
  ])("rejects %s — never persist an unclear assertion", (_label, json) => {
    expect(discordProfileFromMe(json)).toBeNull();
  });
});
