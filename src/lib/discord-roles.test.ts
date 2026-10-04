import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./prisma", () => ({ prisma: {} }));
vi.mock("./discord", () => ({ getInhousePingRoleId: vi.fn() }));

import {
  _clearMemberRouteGateForTests,
  fetchGuildMember,
  type GuildConfig,
} from "./discord-roles";

const cfg: GuildConfig = { token: "test-token", guildId: "test-guild" };
const MEMBER = { membership: "member", roles: [] };
const START = 1_700_000_000_000;
const fetchMock = vi.fn<typeof fetch>();

function memberResponse(resetAfter?: number): Response {
  return Response.json(
    { roles: [] },
    resetAfter === undefined
      ? undefined
      : {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset-after": String(resetAfter),
          },
        },
  );
}

function rateLimitedResponse(retryAfter: number): Response {
  return Response.json({ retry_after: retryAfter }, { status: 429 });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  _clearMemberRouteGateForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  _clearMemberRouteGateForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("member rate gate under concurrent lookups", () => {
  it.each(["rate headers", "429"] as const)(
    "rechecks a gate extended by %s while the retry is asleep",
    async (source) => {
      const concurrentResponse = deferredResponse();
      fetchMock
        .mockResolvedValueOnce(rateLimitedResponse(0.1))
        .mockReturnValueOnce(concurrentResponse.promise)
        .mockImplementation(async () =>
          Date.now() < START + 250
            ? rateLimitedResponse(0.2)
            : memberResponse(),
        );

      const retrying = fetchGuildMember("retrying", cfg);
      const concurrent = fetchGuildMember("concurrent", cfg);
      await vi.advanceTimersByTimeAsync(50);
      concurrentResponse.resolve(
        source === "429" ? rateLimitedResponse(0.2) : memberResponse(0.2),
      );
      await vi.advanceTimersByTimeAsync(70);

      // The original 100ms gate (plus 20ms slop) has expired, but another
      // response moved the refill to 250ms. Spending the sole retry now
      // would get a second 429 and incorrectly leave this member unknown.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(150);
      expect(await retrying).toEqual(MEMBER);
      expect(await concurrent).toEqual(MEMBER);
      expect(fetchMock).toHaveBeenCalledTimes(source === "429" ? 4 : 3);
    },
  );

  it("keeps one wait budget across repeated sub-cap extensions", async () => {
    const firstExtension = deferredResponse();
    const secondExtension = deferredResponse();
    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse(1))
      .mockReturnValueOnce(firstExtension.promise)
      .mockReturnValueOnce(secondExtension.promise)
      .mockImplementation(async () => memberResponse());

    const retrying = fetchGuildMember("retrying", cfg);
    const first = fetchGuildMember("first-extension", cfg);
    const second = fetchGuildMember("second-extension", cfg);
    await vi.advanceTimersByTimeAsync(500);
    firstExtension.resolve(memberResponse(1.5)); // refill at 2000ms
    await vi.advanceTimersByTimeAsync(1000);
    secondExtension.resolve(memberResponse(1.3)); // refill at 2800ms
    await vi.advanceTimersByTimeAsync(520);

    // Each advertised wait is below 2.5s; their combined deadline is not.
    expect(await retrying).toBeNull();
    expect(await first).toEqual(MEMBER);
    expect(await second).toEqual(MEMBER);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("declines a mid-wait extension beyond the cap without spending a retry", async () => {
    const extension = deferredResponse();
    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse(0.1))
      .mockReturnValueOnce(extension.promise)
      .mockImplementation(async () => memberResponse());

    const retrying = fetchGuildMember("retrying", cfg);
    const concurrent = fetchGuildMember("concurrent", cfg);
    await vi.advanceTimersByTimeAsync(50);
    extension.resolve(memberResponse(30));
    await vi.advanceTimersByTimeAsync(70);

    expect(await retrying).toBeNull();
    expect(await concurrent).toEqual(MEMBER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the inclusive 2.5s cap and timer slop", async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse(2.5))
      .mockImplementation(async () => memberResponse());
    const lookup = fetchGuildMember("member", cfg);

    await vi.advanceTimersByTimeAsync(2500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(await lookup).toEqual(MEMBER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not block another guild while this guild waits", async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimitedResponse(0.1))
      .mockImplementation(async () => memberResponse());
    const waiting = fetchGuildMember("waiting", cfg);
    await vi.advanceTimersByTimeAsync(0);

    expect(
      await fetchGuildMember("other-member", { ...cfg, guildId: "other-guild" }),
    ).toEqual(MEMBER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120);
    expect(await waiting).toEqual(MEMBER);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
