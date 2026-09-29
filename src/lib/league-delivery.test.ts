import { describe, expect, it } from "vitest";
import {
  deliveryBacklogStuck,
  deliveryErrorLabel,
  deliveryPaused,
  discordErrorCode,
  discordRefusalKind,
  isWebhookRefusalCode,
  leagueDeliveryAttention,
  refusedPostPreview,
  refusedPostsSentence,
  weekReminderExpiresAt,
  type LeagueDeliveryHealth,
} from "./league-delivery";

const NOW = new Date("2026-09-20T18:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function health(overrides: Partial<LeagueDeliveryHealth> = {}): LeagueDeliveryHealth {
  return {
    checkedAt: NOW,
    waiting: 0,
    oldestWaitingAt: null,
    newestWaitingAt: null,
    headErrorCode: null,
    headRetryAt: null,
    lastDeliveredAt: null,
    refusedRecently: 0,
    lastRefusedCode: null,
    lastRefusedPreview: null,
    expiredRecently: 0,
    ...overrides,
  };
}

describe("discordRefusalKind", () => {
  it("drops only the one post Discord refuses", () => {
    expect(discordRefusalKind(400)).toBe("post");
    expect(discordRefusalKind(413)).toBe("post");
  });

  it("pauses on a webhook that is gone or no longer authorised", () => {
    for (const status of [401, 403, 404]) {
      expect(discordRefusalKind(status)).toBe("webhook");
    }
  });

  // A forum-channel webhook refuses EVERY plain post with a 400; only the
  // body's code tells it from a bad post. Dropping each one would drain the
  // whole queue with nothing left to resend once the webhook is fixed.
  it("pauses on a 400 about the webhook's channel, not the post", () => {
    for (const code of [220001, 220002, 220003, 220004]) {
      expect(discordRefusalKind(400, code)).toBe("webhook");
    }
    // Other 400 codes (an invalid body, say) are still about the post.
    expect(discordRefusalKind(400, 50035)).toBe("post");
    expect(discordRefusalKind(400, null)).toBe("post");
    // The code only matters on a 400.
    expect(discordRefusalKind(413, 220001)).toBe("post");
  });

  it("retries rate limits, outages and anything unrecognised", () => {
    for (const status of [405, 429, 500, 502, 503, 504, 302]) {
      expect(discordRefusalKind(status)).toBe("transient");
    }
  });
});

describe("refusal codes", () => {
  it("round-trips through the stored code", () => {
    expect(discordErrorCode(404)).toBe("DISCORD_404");
    expect(isWebhookRefusalCode("DISCORD_404")).toBe(true);
    expect(isWebhookRefusalCode("DISCORD_401")).toBe(true);
    expect(isWebhookRefusalCode("DISCORD_400")).toBe(false);
    expect(isWebhookRefusalCode("TRANSPORT_REJECTED")).toBe(false);
    expect(isWebhookRefusalCode(null)).toBe(false);
    // A channel-level 400 keeps its Discord code, so it reads as paused.
    expect(discordErrorCode(400, 220001)).toBe("DISCORD_400_220001");
    expect(isWebhookRefusalCode("DISCORD_400_220001")).toBe(true);
    expect(discordErrorCode(400, 50035)).toBe("DISCORD_400");
    expect(discordErrorCode(400)).toBe("DISCORD_400");
  });

  it("labels every code in plain words, never echoing a URL", () => {
    expect(deliveryErrorLabel("DISCORD_404")).toBe("webhook not found (404)");
    expect(deliveryErrorLabel("DISCORD_401")).toBe(
      "webhook token no longer valid (401)",
    );
    expect(deliveryErrorLabel("DISCORD_400")).toBe(
      "Discord refused the post (400)",
    );
    expect(deliveryErrorLabel("DISCORD_400_220001")).toBe(
      "webhook is in a forum channel, which needs a thread for every post (400)",
    );
    expect(deliveryErrorLabel("DISCORD_503")).toBe("Discord unavailable (503)");
    expect(deliveryErrorLabel("DISCORD_429")).toBe(
      "rate limited by Discord (429)",
    );
    expect(deliveryErrorLabel("TRANSPORT_REJECTED")).toBe(
      "couldn't reach Discord",
    );
    expect(deliveryErrorLabel("EXPIRED")).toBe("out of date, dropped");
    expect(deliveryErrorLabel(null)).toBeNull();
  });
});

describe("weekReminderExpiresAt", () => {
  const kickoff = NOW.getTime();

  it("expires a reminder queued before kickoff at kickoff", () => {
    expect(
      weekReminderExpiresAt(kickoff, kickoff - 24 * 3_600_000, 3).getTime(),
    ).toBe(kickoff);
  });

  it("keeps a catch-up reminder for the service's own after-kickoff window", () => {
    expect(
      weekReminderExpiresAt(kickoff, kickoff + 30 * 60_000, 3).getTime(),
    ).toBe(kickoff + 3 * 3_600_000);
  });
});

describe("leagueDeliveryAttention", () => {
  it("is quiet while posts are flowing", () => {
    expect(leagueDeliveryAttention(health())).toEqual([]);
    // A post queued a minute ago is not stuck yet.
    const fresh = health({ waiting: 1, oldestWaitingAt: minutesAgo(1) });
    expect(deliveryBacklogStuck(fresh)).toBe(false);
    expect(leagueDeliveryAttention(fresh)).toEqual([]);
  });

  it("flags a post waiting more than 15 minutes, with the last error", () => {
    const stuck = health({
      waiting: 1,
      oldestWaitingAt: minutesAgo(16),
      headErrorCode: "DISCORD_503",
    });
    expect(deliveryBacklogStuck(stuck)).toBe(true);
    expect(leagueDeliveryAttention(stuck)).toEqual([
      "1 league Discord post has been waiting 16 minutes — last error: Discord unavailable (503).",
    ]);
  });

  it("says posting is paused when the webhook itself was refused", () => {
    const paused = health({
      waiting: 4,
      oldestWaitingAt: minutesAgo(180),
      headErrorCode: "DISCORD_404",
      headRetryAt: minutesAgo(-10),
    });
    expect(deliveryPaused(paused)).toBe(true);
    expect(leagueDeliveryAttention(paused)).toEqual([
      "4 league Discord posts are waiting, the oldest for 3 hours. Discord says: webhook not found (404). Posting is paused until you save a working webhook.",
    ]);
  });

  it("stops calling it paused once a new webhook makes the posts due", () => {
    // resumeLeagueAnnouncements set the retry to now; the old refusal is
    // still the last error until the next attempt.
    const resumed = health({
      waiting: 4,
      oldestWaitingAt: minutesAgo(180),
      headErrorCode: "DISCORD_404",
      headRetryAt: NOW,
    });
    expect(deliveryPaused(resumed)).toBe(false);
    expect(leagueDeliveryAttention(resumed)).toEqual([
      "4 league Discord posts are waiting, the oldest for 3 hours — last error: webhook not found (404).",
    ]);
    // A transient error never reads as paused.
    expect(
      deliveryPaused(
        health({
          waiting: 1,
          headErrorCode: "DISCORD_503",
          headRetryAt: minutesAgo(-1),
        }),
      ),
    ).toBe(false);
  });

  it("leaves a refused post off the list: it was dropped, nothing to act on", () => {
    // One refused post used to hold the card at "needs attention" for a day.
    const refused = health({ refusedRecently: 1, lastRefusedCode: "DISCORD_400" });
    expect(leagueDeliveryAttention(refused)).toEqual([]);
    // A stuck backlog is still listed beside it, and only the backlog.
    const both = health({
      waiting: 1,
      oldestWaitingAt: minutesAgo(16),
      refusedRecently: 3,
      lastRefusedCode: "DISCORD_413",
    });
    expect(leagueDeliveryAttention(both)).toEqual([
      "1 league Discord post has been waiting 16 minutes.",
    ]);
  });
});

describe("refusedPostsSentence", () => {
  it("counts the refused posts", () => {
    const refused = health({ refusedRecently: 2, lastRefusedCode: "DISCORD_400" });
    expect(refusedPostsSentence(refused)).toBe(
      "Discord refused 2 league posts in the last day (error 400), so they were skipped.",
    );
  });

  it("says which post it was, so an admin can post it by hand", () => {
    expect(
      refusedPostsSentence(
        health({
          refusedRecently: 1,
          lastRefusedCode: "DISCORD_413",
          lastRefusedPreview: "📋 **Week 3** results are in",
        }),
      ),
    ).toBe(
      "Discord refused 1 league post in the last day (error 413), so it was skipped. It started: “📋 **Week 3** results are in”",
    );
    expect(
      refusedPostsSentence(
        health({
          refusedRecently: 2,
          lastRefusedCode: "DISCORD_400",
          lastRefusedPreview: "🧭 Captain news",
        }),
      ),
    ).toBe(
      "Discord refused 2 league posts in the last day (error 400), so they were skipped. The latest one started: “🧭 Captain news”",
    );
  });
});

describe("refusedPostPreview", () => {
  it("is the first line that has text", () => {
    expect(refusedPostPreview("\n  \n  🏆 **Champions** \nsecond line")).toBe(
      "🏆 **Champions**",
    );
    expect(refusedPostPreview("one\r\ntwo")).toBe("one");
  });

  it("is null for a missing or blank post", () => {
    expect(refusedPostPreview(null)).toBeNull();
    expect(refusedPostPreview(undefined)).toBeNull();
    expect(refusedPostPreview(" \n\t\n")).toBeNull();
  });

  it("cuts a long line to 140 characters without splitting an emoji", () => {
    const long = `🔥${"a".repeat(300)}`;
    const preview = refusedPostPreview(long)!;
    expect(Array.from(preview)).toHaveLength(140);
    expect(preview.startsWith("🔥a")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    const exact = "b".repeat(140);
    expect(refusedPostPreview(exact)).toBe(exact);
    // A cut landing inside an emoji keeps the whole emoji.
    const emojis = "😀".repeat(200);
    expect(refusedPostPreview(emojis)).toBe(`${"😀".repeat(139)}…`);
  });
});
