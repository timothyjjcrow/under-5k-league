import { afterEach, describe, it, expect, vi } from "vitest";
import { steamReturnToMatches, verifySteamCallback } from "./steam";

const CALLBACK = "https://league.example.com/api/auth/steam/callback";

describe("steamReturnToMatches", () => {
  it("accepts the exact callback URL", () => {
    expect(steamReturnToMatches(CALLBACK, CALLBACK)).toBe(true);
  });

  it("ignores a trailing slash and query string", () => {
    expect(steamReturnToMatches(`${CALLBACK}/`, CALLBACK)).toBe(true);
    expect(steamReturnToMatches(`${CALLBACK}?openid.x=1`, CALLBACK)).toBe(true);
  });

  it("requires an exact signed state when the expected return URL carries one", () => {
    const expected = `${CALLBACK}?state=browser-state`;
    expect(steamReturnToMatches(expected, expected)).toBe(true);
    expect(
      steamReturnToMatches(`${CALLBACK}?state=attacker-state`, expected),
    ).toBe(false);
    expect(steamReturnToMatches(CALLBACK, expected)).toBe(false);
    expect(
      steamReturnToMatches(`${expected}&extra=1`, expected),
    ).toBe(false);
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

const STEAM_ID = "76561198000000001";

function validAssertion(steamId = STEAM_ID) {
  const identity = `https://steamcommunity.com/openid/id/${steamId}`;
  return new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": identity,
    "openid.identity": identity,
    "openid.return_to": CALLBACK,
    "openid.response_nonce": "2026-08-03T12:00:00Znonce",
    "openid.assoc_handle": "handle",
    "openid.signed":
      "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "signed-value",
  });
}

describe("verifySteamCallback canonical assertion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the one canonical identity Steam validates", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifySteamCallback(validAssertion(), CALLBACK)).resolves.toBe(
      STEAM_ID,
    );
    const body = String(fetchMock.mock.calls[0][1]?.body);
    expect(new URLSearchParams(body).getAll("openid.claimed_id")).toEqual([
      `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    ]);
  });

  it("rejects duplicate claimed identities before contacting Steam", async () => {
    const attacker = validAssertion("76561198000000002");
    const ambiguous = new URLSearchParams();
    ambiguous.append(
      "openid.claimed_id",
      `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    );
    for (const [key, value] of attacker) ambiguous.append(key, value);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifySteamCallback(ambiguous, CALLBACK)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an oversized assertion value", (assertion: URLSearchParams) => {
      assertion.set("openid.sig", "x".repeat(4_097));
    }],
    ["too many OpenID fields", (assertion: URLSearchParams) => {
      for (let i = 0; i < 33; i += 1) {
        assertion.set(`openid.extra_${i}`, "x");
      }
    }],
  ])("rejects %s before contacting Steam", async (_label, mutate) => {
    const assertion = validAssertion();
    mutate(assertion);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifySteamCallback(assertion, CALLBACK)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["openid.identity", "https://steamcommunity.com/openid/id/76561198000000002"],
    ["openid.claimed_id", `http://steamcommunity.com/openid/id/${STEAM_ID}`],
    ["openid.op_endpoint", "https://evil.example/openid"],
    ["openid.mode", "cancel"],
    ["openid.sig", ""],
  ])("rejects a non-canonical %s before contacting Steam", async (key, value) => {
    const assertion = validAssertion();
    assertion.set(key, value);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifySteamCallback(assertion, CALLBACK)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the claimed identity to be covered by the signed field list", async () => {
    const assertion = validAssertion();
    assertion.set(
      "openid.signed",
      "op_endpoint,identity,return_to,response_nonce,assoc_handle",
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifySteamCallback(assertion, CALLBACK)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, text: vi.fn().mockResolvedValue("is_valid:true") }],
    [{ ok: true, text: vi.fn().mockResolvedValue("not_is_valid:true") }],
    [{ ok: true, text: vi.fn().mockResolvedValue("is_valid:false") }],
  ])("fails closed on an invalid verification response", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(verifySteamCallback(validAssertion(), CALLBACK)).resolves.toBeNull();
  });
});
