import { describe, expect, it } from "vitest";
import {
  STREAM_HOST_ERROR,
  STREAM_URL_MAX_LENGTH,
  WATCH_OPENS_BEFORE_KICKOFF_MS,
  matchWatchWindow,
  normalizeStreamUrl,
  parseStoredStream,
  watchState,
} from "./broadcast";
import { seriesEstimateMinutes } from "./series-lengths";

const MIN = 60_000;

describe("normalizeStreamUrl", () => {
  it.each([
    ["https://www.twitch.tv/ggd2l", "https://www.twitch.tv/ggd2l", "Twitch"],
    ["https://twitch.tv/ggd2l", "https://twitch.tv/ggd2l", "Twitch"],
    ["https://m.twitch.tv/ggd2l", "https://m.twitch.tv/ggd2l", "Twitch"],
    ["  https://www.twitch.tv/ggd2l  ", "https://www.twitch.tv/ggd2l", "Twitch"],
    ["HTTPS://WWW.TWITCH.TV/GGD2L", "https://www.twitch.tv/GGD2L", "Twitch"],
    ["https://www.twitch.tv:443/ggd2l", "https://www.twitch.tv/ggd2l", "Twitch"],
    [
      "https://www.youtube.com/@ggd2l/live",
      "https://www.youtube.com/@ggd2l/live",
      "YouTube",
    ],
    [
      "https://youtube.com/watch?v=abc123",
      "https://youtube.com/watch?v=abc123",
      "YouTube",
    ],
    ["https://m.youtube.com/@ggd2l", "https://m.youtube.com/@ggd2l", "YouTube"],
    ["https://youtu.be/abc123", "https://youtu.be/abc123", "YouTube"],
    ["https://kick.com/ggd2l", "https://kick.com/ggd2l", "Kick"],
    ["https://www.kick.com/ggd2l", "https://www.kick.com/ggd2l", "Kick"],
  ])("keeps %s as %s", (raw, url, platform) => {
    expect(normalizeStreamUrl(raw)).toEqual({ stream: { url, platform } });
  });

  it("treats a blank value as clearing the link", () => {
    expect(normalizeStreamUrl("")).toEqual({ stream: null });
    expect(normalizeStreamUrl("   ")).toEqual({ stream: null });
  });

  it.each([
    // Look-alikes: only the exact host names count.
    "https://twitch.tv.evil.example/ggd2l",
    "https://evil.example/twitch.tv",
    "https://eviltwitch.tv/ggd2l",
    "https://clips.twitch.tv.evil.example/x",
    "https://www.twitch.tv./ggd2l",
    "https://xn--twtch-7ua.tv/ggd2l",
    "https://youtube.com.evil.example/live",
    "https://example.com/?u=https://www.twitch.tv/ggd2l",
    // Other streaming sites aren't on the list.
    "https://www.facebook.com/gaming/ggd2l",
  ])("refuses the look-alike or unlisted host %s", (raw) => {
    expect(normalizeStreamUrl(raw)).toEqual({ error: STREAM_HOST_ERROR });
  });

  it("refuses a port", () => {
    expect(normalizeStreamUrl("https://www.twitch.tv:8443/ggd2l")).toEqual({
      error: STREAM_HOST_ERROR,
    });
  });

  it.each([
    "http://www.twitch.tv/ggd2l",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://twitch.tv/ggd2l",
  ])("refuses the non-https link %s", (raw) => {
    expect(normalizeStreamUrl(raw)).toEqual({
      error: "Stream links must start with https://.",
    });
  });

  it("refuses credentials", () => {
    expect(normalizeStreamUrl("https://user:pass@www.twitch.tv/x")).toEqual({
      error: "Stream links can't include a username or password.",
    });
    expect(normalizeStreamUrl("https://user@www.twitch.tv/x")).toEqual({
      error: "Stream links can't include a username or password.",
    });
  });

  it.each([
    "www.twitch.tv/ggd2l",
    "twitch",
    "https://www.twitch.tv/gg d2l",
    "https://www.twitch.tv/gg\nd2l",
    "https://www.twitch.tv/\u0000",
    "https://www.twitch.tv\\@evil.example/",
    "https://www.twitch.tv/ ggd2l",
  ])("refuses the malformed value %j", (raw) => {
    const result = normalizeStreamUrl(raw);
    expect("error" in result).toBe(true);
  });

  it("caps the length, before and after the canonical form", () => {
    const long = `https://www.twitch.tv/${"a".repeat(STREAM_URL_MAX_LENGTH)}`;
    expect(normalizeStreamUrl(long)).toEqual({
      error: "Stream links must be 2,048 characters or fewer.",
    });
    // Short enough as typed, too long once the parser percent-encodes it.
    const unicode = `https://www.twitch.tv/${"é".repeat(800)}`;
    expect(unicode.length).toBeLessThanOrEqual(STREAM_URL_MAX_LENGTH);
    expect(normalizeStreamUrl(unicode)).toEqual({
      error: "Stream links must be 2,048 characters or fewer.",
    });
  });
});

describe("parseStoredStream", () => {
  it("reads a stored link back with its platform", () => {
    expect(parseStoredStream("https://www.twitch.tv/ggd2l")).toEqual({
      url: "https://www.twitch.tv/ggd2l",
      platform: "Twitch",
    });
  });

  it("renders nothing for no value, or one that no longer passes", () => {
    expect(parseStoredStream(null)).toBeNull();
    expect(parseStoredStream("")).toBeNull();
    expect(parseStoredStream("https://evil.example/stream")).toBeNull();
    expect(parseStoredStream("http://www.twitch.tv/ggd2l")).toBeNull();
  });
});

describe("matchWatchWindow", () => {
  const kickoff = new Date("2026-10-03T22:00:00Z");
  const final = {
    phase: "FINAL",
    status: "SCHEDULED",
    forfeit: false,
    scheduledAt: kickoff,
    bestOf: 3,
  };

  it("opens 15 minutes before kickoff and closes when the series should be over", () => {
    expect(matchWatchWindow(final, true)).toEqual({
      opensAtMs: kickoff.getTime() - 15 * MIN,
      closesAtMs: kickoff.getTime() + 210 * MIN,
    });
    expect(WATCH_OPENS_BEFORE_KICKOFF_MS).toBe(15 * MIN);
  });

  it.each([1, 2, 3, 5])("uses the calendar's estimate for a Bo%i", (bestOf) => {
    const window = matchWatchWindow({ ...final, bestOf }, true);
    expect(window?.closesAtMs).toBe(
      kickoff.getTime() + seriesEstimateMinutes(bestOf) * MIN,
    );
  });

  it("covers playoff matches and the final, under way or not", () => {
    expect(matchWatchWindow({ ...final, phase: "PLAYOFF" }, true)).not.toBeNull();
    expect(matchWatchWindow({ ...final, status: "LIVE" }, true)).not.toBeNull();
  });

  it("never links the regular season or a tiebreaker", () => {
    expect(matchWatchWindow({ ...final, phase: "REGULAR" }, true)).toBeNull();
    expect(matchWatchWindow({ ...final, phase: "TIEBREAKER" }, true)).toBeNull();
  });

  it("never links a decided match, a forfeit, an unset kickoff or an archived season", () => {
    expect(matchWatchWindow({ ...final, status: "COMPLETED" }, true)).toBeNull();
    expect(matchWatchWindow({ ...final, forfeit: true }, true)).toBeNull();
    expect(matchWatchWindow({ ...final, scheduledAt: null }, true)).toBeNull();
    expect(matchWatchWindow(final, false)).toBeNull();
  });
});

describe("watchState", () => {
  const window = { opensAtMs: 1_000_000, closesAtMs: 2_000_000 };

  it("says where it will be streamed before the window", () => {
    expect(watchState(window, 0)).toBe("soon");
    expect(watchState(window, window.opensAtMs - 1)).toBe("soon");
  });

  it("is live from the window's first millisecond to its last", () => {
    expect(watchState(window, window.opensAtMs)).toBe("live");
    expect(watchState(window, window.closesAtMs - 1)).toBe("live");
  });

  it("is gone once the window closes", () => {
    expect(watchState(window, window.closesAtMs)).toBeNull();
    expect(watchState(window, window.closesAtMs + 60 * MIN)).toBeNull();
  });
});
