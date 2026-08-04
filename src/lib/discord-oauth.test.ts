import { describe, it, expect } from "vitest";
import {
  DISCORD_OAUTH_COOKIE_PATH,
  buildDiscordAuthUrl,
  codeChallengeS256,
  discordProfileFromMe,
  oauthLandingPath,
  packOauthCookie,
  randomOauthValue,
  safeEqual,
  unpackOauthCookie,
} from "./discord-oauth";

const OAUTH_STATE = "s".repeat(43);
const OAUTH_VERIFIER = "v".repeat(43);

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

  // The scope is the consent screen, so it stays pinned in both directions.
  // `guilds.join` is the ONE addition ever made here and it is conditional:
  // anything else appearing, or the join scope appearing by default, is a
  // privacy regression.
  it("asks ONLY for identify by default", () => {
    expect(parsed.searchParams.get("scope")).toBe("identify");
  });

  it("adds guilds.join — and nothing else — when the league can actually join them", () => {
    const withJoin = new URL(
      buildDiscordAuthUrl({
        clientId: "1234567890",
        redirectUri: "https://ld2l.example/api/auth/discord/callback",
        state: "st4te-value",
        codeChallenge: "chall3nge",
        withGuildJoin: true,
      }),
    );
    expect(withJoin.searchParams.get("scope")).toBe("identify guilds.join");
  });

  it("never asks to READ anything beyond identify", () => {
    for (const withGuildJoin of [false, true]) {
      const scope = new URL(
        buildDiscordAuthUrl({
          clientId: "1234567890",
          redirectUri: "https://ld2l.example/api/auth/discord/callback",
          state: "st4te-value",
          codeChallenge: "chall3nge",
          withGuildJoin,
        }),
      ).searchParams.get("scope");
      const scopes = (scope ?? "").split(" ").filter(Boolean);
      // guilds.join is write-only; `guilds`, `email`, `messages.read` etc. are
      // reads we have never needed and must not acquire by accident.
      expect(scopes.every((s) => s === "identify" || s === "guilds.join")).toBe(
        true,
      );
    }
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
  it("uses the root path required by production __Host- cookies", () => {
    expect(DISCORD_OAUTH_COOKIE_PATH).toBe("/");
  });

  it("round-trips state + verifier + initiating site user", () => {
    const packed = packOauthCookie(
      OAUTH_STATE,
      OAUTH_VERIFIER,
      "site-user-1",
    );
    expect(unpackOauthCookie(packed)).toEqual({
      state: OAUTH_STATE,
      verifier: OAUTH_VERIFIER,
      userId: "site-user-1",
      next: null,
    });
  });

  it("round-trips real random values (base64url never contains the separator)", () => {
    const state = randomOauthValue();
    const verifier = randomOauthValue();
    expect(
      unpackOauthCookie(packOauthCookie(state, verifier, "site-user-2")),
    ).toEqual({
      state,
      verifier,
      userId: "site-user-2",
      next: null,
    });
  });

  it.each([
    "",
    "no-separator",
    ".leading",
    "trailing.",
    "a.b.c.d",
    "abc.def", // pre-user-binding cookie; restart the flow safely
    null,
    undefined,
  ])("rejects malformed or legacy cookie %j", (v) => {
    expect(unpackOauthCookie(v as string | null | undefined)).toBeNull();
  });

  it("round-trips a validated return path as an opaque final part", () => {
    const packed = packOauthCookie(
      OAUTH_STATE,
      OAUTH_VERIFIER,
      "site-user-3",
      "/players?pos=1",
    );
    expect(unpackOauthCookie(packed)).toEqual({
      state: OAUTH_STATE,
      verifier: OAUTH_VERIFIER,
      userId: "site-user-3",
      next: "/players?pos=1",
    });
  });

  it("refuses to pack an unsafe return path at all", () => {
    // Validation happens at pack time too — an attacker-supplied ?next= must
    // not even ride the cookie.
    for (const evil of [
      "https://evil.test",
      "//evil.test",
      "/ok\nSet-Cookie: x",
      "\\evil",
    ]) {
      expect(
        packOauthCookie(
          OAUTH_STATE,
          OAUTH_VERIFIER,
          "site-user-4",
          evil,
        ),
      ).toBe(
        `v2.${OAUTH_STATE}.${OAUTH_VERIFIER}.${Buffer.from("site-user-4").toString("base64url")}`,
      );
    }
  });

  it("a tampered return-path part degrades to no return path", () => {
    // The cookie is client-held bytes. "https://evil.test" base64url'd is a
    // structurally valid final part — safeReturnPath at unpack is what stops
    // it becoming an open redirect.
    const evil = Buffer.from("https://evil.test").toString("base64url");
    const user = Buffer.from("site-user-5").toString("base64url");
    expect(
      unpackOauthCookie(`v2.${OAUTH_STATE}.${OAUTH_VERIFIER}.${user}.${evil}`),
    ).toEqual({
      state: OAUTH_STATE,
      verifier: OAUTH_VERIFIER,
      userId: "site-user-5",
      next: null,
    });
    expect(
      unpackOauthCookie(`v2.${OAUTH_STATE}.${OAUTH_VERIFIER}.${user}.!!!`),
    ).toMatchObject({
      state: OAUTH_STATE,
      verifier: OAUTH_VERIFIER,
      userId: "site-user-5",
      next: null,
    });
  });

  it("rejects a malformed initiating user instead of weakening the binding", () => {
    expect(
      unpackOauthCookie(`v2.${OAUTH_STATE}.${OAUTH_VERIFIER}.!!!`),
    ).toBeNull();
  });

  it("rejects oversized cookies and non-canonical state/verifier values", () => {
    expect(unpackOauthCookie("x".repeat(1_025))).toBeNull();
    const user = Buffer.from("site-user").toString("base64url");
    expect(unpackOauthCookie(`v2.short.${OAUTH_VERIFIER}.${user}`)).toBeNull();
    expect(unpackOauthCookie(`v2.${OAUTH_STATE}.short.${user}`)).toBeNull();
  });
});

describe("oauthLandingPath", () => {
  it("honors the return path only on FULL success", () => {
    expect(oauthLandingPath("joined", "/")).toBe("/");
    expect(oauthLandingPath("linked", "/players")).toBe("/players");
  });

  it("routes every note-carrying outcome to /me, where the copy lives", () => {
    for (const code of [
      "join_failed",
      "joined_pending",
      "taken",
      "error",
      "denied",
    ]) {
      expect(oauthLandingPath(code, "/")).toBe(`/me?discord=${code}`);
    }
  });

  it("keeps the confirmation code when /me was the destination anyway", () => {
    expect(oauthLandingPath("joined", "/me")).toBe("/me?discord=joined");
    expect(oauthLandingPath("joined", null)).toBe("/me?discord=joined");
  });
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
    ).toEqual({
      discordId: "80351110224678912",
      discordName: "dendi_official",
    });
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
