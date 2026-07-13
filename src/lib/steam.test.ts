import { describe, it, expect } from "vitest";
import { steamReturnToMatches } from "./steam";

const CALLBACK = "https://league.example.com/api/auth/steam/callback";

describe("steamReturnToMatches", () => {
  it("accepts the exact callback URL", () => {
    expect(steamReturnToMatches(CALLBACK, CALLBACK)).toBe(true);
  });

  it("ignores a trailing slash and query string", () => {
    expect(steamReturnToMatches(`${CALLBACK}/`, CALLBACK)).toBe(true);
    expect(steamReturnToMatches(`${CALLBACK}?openid.x=1`, CALLBACK)).toBe(true);
  });

  it("rejects a different origin (cross-realm replay)", () => {
    expect(
      steamReturnToMatches(
        "https://evil.example.com/api/auth/steam/callback",
        CALLBACK,
      ),
    ).toBe(false);
  });

  it("rejects a different path on the same origin", () => {
    expect(
      steamReturnToMatches("https://league.example.com/api/steal", CALLBACK),
    ).toBe(false);
  });

  it("rejects null / missing / malformed return_to", () => {
    expect(steamReturnToMatches(null, CALLBACK)).toBe(false);
    expect(steamReturnToMatches("", CALLBACK)).toBe(false);
    expect(steamReturnToMatches("not-a-url", CALLBACK)).toBe(false);
  });
});
