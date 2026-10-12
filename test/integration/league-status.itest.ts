import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { SETTING_KEYS, getSetting, setSetting } from "@/lib/settings";
import type { LeagueStatusSnapshot } from "@/lib/league-status";
import { raceN } from "./factories";

// The league status card in #schedule: ONE message rewritten in place. The
// queue board's guarantees, held to the same standard:
//   * OFF unless an admin posted it (the Setting row IS the switch)
//   * no request at all when what the card says hasn't moved
//   * at most one edit per throttle window
//   * a deleted message turns the card off instead of re-posting itself
//   * a webhook pointed at a new channel never edits the old channel's card
//   * two admins can never both post a card
// The snapshot is mocked here: these tests are about the message, and
// league-status-snapshot.itest.ts reads real leagues.

const HOOK = "https://discord.com/api/webhooks/44444/token-status-inert";
const OTHER_HOOK = "https://discord.com/api/webhooks/55555/token-other-inert";
const MSG_ID = "1379001234567890123";
const NEW_MSG = "1379007777777777777";

vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    getLeagueStatusWebhookUrl: vi.fn(async () => HOOK),
    postWebhookMessage: vi.fn(async () => ({ id: MSG_ID })),
    patchWebhookMessage: vi.fn(async () => "ok" as const),
    deleteWebhookMessage: vi.fn(async () => true),
  };
});

function snapshot(players: number): LeagueStatusSnapshot {
  const site = "https://ggd2l.example";
  return {
    leagueName: "GGD2L",
    siteUrl: site,
    logoUrl: `${site}/brand/ggd2l-logo.png`,
    phase: draftLive ? "DRAFT" : "SIGNUPS",
    seasonName: "Season 2",
    signups: {
      players,
      standins: 0,
      captainVolunteers: 0,
      minTeams: 4,
      teamsFormable: Math.floor(players / 5),
      needed: Math.max(0, 20 - players),
      toNextTeam: 5,
      teamsNeeded: 4,
    },
    matchNight: { kind: "unset" },
    draft: draftLive
      ? {
          state: "LIVE",
          atMs: null,
          soon: false,
          captains: 4,
          pool: 16,
          sold: players,
          startedAtMs: null,
          teams: [],
          seasonStartsAtMs: null,
        }
      : null,
    week: null,
    table: null,
    highlights: null,
    playoffs: null,
    champion: null,
    lastChampion: null,
    nextSignupsAtMs: null,
    inhouseNight: null,
    urls: {
      signUp: `${site}/me`,
      howItWorks: `${site}/how-it-works`,
      draft: `${site}/draft`,
      players: `${site}/players`,
      teams: `${site}/teams`,
      schedule: `${site}/schedule`,
      hallOfFame: `${site}/hall-of-fame`,
      inhouse: `${site}/inhouse`,
    },
  };
}

let players = 10;
let draftLive = false;
vi.mock("@/lib/league-status-snapshot", () => ({
  loadLeagueStatusSnapshot: vi.fn(async () => snapshot(players)),
}));

import {
  deleteWebhookMessage,
  getLeagueStatusWebhookUrl,
  patchWebhookMessage,
  postWebhookMessage,
} from "@/lib/discord";
import {
  LEAGUE_STATUS_POST_LEASE_MS,
  createLeagueStatusCard,
  getLeagueStatusCardStatus,
  refreshLeagueStatus,
  removeLeagueStatusCard,
  syncLeagueStatus,
  syncLeagueStatusFromWorker,
} from "@/lib/league-status-service";

const mockHook = vi.mocked(getLeagueStatusWebhookUrl);
const mockPost = vi.mocked(postWebhookMessage);
const mockPatch = vi.mocked(patchWebhookMessage);
const mockDelete = vi.mocked(deleteWebhookMessage);

beforeEach(() => {
  delete process.env.VERCEL_ENV;
  players = 10;
  draftLive = false;
  mockHook.mockReset().mockResolvedValue(HOOK);
  mockPost.mockReset().mockResolvedValue({ id: MSG_ID });
  mockPatch.mockReset().mockResolvedValue("ok");
  mockDelete.mockReset().mockResolvedValue(true);
});

afterEach(() => setRaceHook(null));

const cardRow = () => getSetting(SETTING_KEYS.LEAGUE_STATUS_CARD);

/** Let the edit floor lapse without waiting for real time. */
async function expireThrottle() {
  await setSetting(
    SETTING_KEYS.LEAGUE_STATUS_AT,
    new Date(Date.now() - 600_000).toISOString(),
  );
}

describe("status card — off by default", () => {
  it("does nothing until an admin posts it", async () => {
    await expect(syncLeagueStatus()).resolves.toBe("off");
    expect(mockPatch).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
    await expect(getLeagueStatusCardStatus()).resolves.toMatchObject({
      configured: true,
      posted: false,
    });
  });

  it("never edits from a Vercel preview", async () => {
    await createLeagueStatusCard();
    players = 11;
    process.env.VERCEL_ENV = "preview";
    try {
      await expect(syncLeagueStatus()).resolves.toBe("off");
      await expect(createLeagueStatusCard()).resolves.toMatchObject({ ok: false });
    } finally {
      delete process.env.VERCEL_ENV;
    }
    expect(mockPatch).not.toHaveBeenCalled();
  });
});

describe("status card — posting", () => {
  it("posts a Components V2 card once and remembers it", async () => {
    await expect(createLeagueStatusCard()).resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, payload] = mockPost.mock.calls[0];
    expect(url).toBe(HOOK);
    expect(payload).toMatchObject({ flags: 1 << 15 });
    expect(payload).not.toHaveProperty("content");
    expect(Array.isArray(payload.components)).toBe(true);
    expect(JSON.parse((await cardRow())!)).toMatchObject({
      webhookId: "44444",
      messageId: MSG_ID,
    });
    await expect(getLeagueStatusCardStatus()).resolves.toMatchObject({
      posted: true,
      inSync: true,
      liveState: "Signups: 10 players",
      masked: "discord.com/api/webhooks/44444/••••••••",
    });
  });

  it("refuses without a webhook and refuses a second card in the same channel", async () => {
    mockHook.mockResolvedValueOnce(null);
    await expect(createLeagueStatusCard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/webhook first/i),
    });
    await createLeagueStatusCard();
    await expect(createLeagueStatusCard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/already posted/i),
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("posts exactly one card when several admins press Post at once", async () => {
    await raceN(4, () => createLeagueStatusCard());
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("keeps a visible recovery state when Discord doesn't confirm an id", async () => {
    mockPost.mockResolvedValue(null);
    await expect(createLeagueStatusCard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/didn't confirm/i),
    });
    expect(JSON.parse((await cardRow())!)).toMatchObject({
      messageId: "",
      reservedAt: null,
    });
    await expect(createLeagueStatusCard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/interrupted/i),
    });
    await expect(removeLeagueStatusCard()).resolves.toEqual({
      ok: true,
      orphaned: true,
    });
    mockPost.mockResolvedValue({ id: MSG_ID });
    await expect(createLeagueStatusCard()).resolves.toEqual({ ok: true });
  });

  it("does not overwrite a newer row when an ambiguous post answers late", async () => {
    const replacement = JSON.stringify({
      webhookId: "44444",
      messageId: NEW_MSG,
      digest: "posted-by-another-admin",
    });
    mockPost.mockImplementation(async () => {
      await setSetting(SETTING_KEYS.LEAGUE_STATUS_CARD, replacement);
      return null;
    });
    await expect(createLeagueStatusCard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/state changed/i),
    });
    expect(await cardRow()).toBe(replacement);
  });

  it("deletes a card that finishes posting after its reservation was cleared", async () => {
    // An admin moving the webhook mid-post force-clears the reservation.
    mockPost.mockImplementation(async () => {
      await removeLeagueStatusCard({ force: true });
      return { id: MSG_ID };
    });
    await expect(createLeagueStatusCard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/cancelled/i),
    });
    expect(mockDelete).toHaveBeenCalledWith(HOOK, MSG_ID);
    expect(await cardRow()).toBeNull();
  });

  it("keeps a fresh reservation locked, then lets an admin clear a stale one", async () => {
    const fresh = JSON.stringify({
      webhookId: "44444",
      messageId: "",
      digest: "posting:44444",
      reservedAt: new Date().toISOString(),
    });
    await setSetting(SETTING_KEYS.LEAGUE_STATUS_CARD, fresh);
    await expect(createLeagueStatusCard()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/being posted/i),
    });
    await expect(removeLeagueStatusCard()).resolves.toMatchObject({ ok: false });
    const stale = JSON.stringify({
      ...JSON.parse(fresh),
      reservedAt: new Date(Date.now() - LEAGUE_STATUS_POST_LEASE_MS - 1).toISOString(),
    });
    await setSetting(SETTING_KEYS.LEAGUE_STATUS_CARD, stale);
    await expect(getLeagueStatusCardStatus()).resolves.toMatchObject({
      postingStuck: true,
    });
    await expect(removeLeagueStatusCard()).resolves.toEqual({
      ok: true,
      orphaned: true,
    });
    expect(await cardRow()).toBeNull();
  });
});

describe("status card — the digest gate and the throttle", () => {
  it("makes no request while the league hasn't moved", async () => {
    await createLeagueStatusCard();
    await expireThrottle();
    await expect(syncLeagueStatus()).resolves.toBe("unchanged");
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("edits once when the league moves, then records what it says", async () => {
    await createLeagueStatusCard();
    await expireThrottle();
    players = 11;
    await expect(syncLeagueStatus()).resolves.toBe("edited");
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch.mock.calls[0][1]).toBe(MSG_ID);
    expect(mockPatch.mock.calls[0][2]).toMatchObject({ flags: 1 << 15 });
    const row = JSON.parse((await cardRow())!);
    expect(row.lastOkAt).toEqual(expect.any(String));
    expect(row.failures).toBe(0);
    await expect(syncLeagueStatus()).resolves.toBe("unchanged");
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into one edit and catches up once the floor lapses", async () => {
    await createLeagueStatusCard();
    await expireThrottle();
    players = 11;
    await syncLeagueStatus();
    players = 12;
    await expect(syncLeagueStatus()).resolves.toBe("throttled");
    expect(mockPatch).toHaveBeenCalledTimes(1);
    await expireThrottle();
    await expect(syncLeagueStatus()).resolves.toBe("edited");
    expect(mockPatch).toHaveBeenCalledTimes(2);
  });

  it("refreshLeagueStatus outside a request runs the repaint inline", async () => {
    await createLeagueStatusCard();
    await expireThrottle();
    players = 13;
    await refreshLeagueStatus();
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });
});

describe("status card — the worker's looks", () => {
  /** The worker's last idle look, `agoMs` before now. */
  async function lookedAt(agoMs: number) {
    await setSetting(
      SETTING_KEYS.LEAGUE_STATUS_CHECK_AT,
      new Date(Date.now() - agoMs).toISOString(),
    );
  }

  it("costs one read and no look while the card is off", async () => {
    await expect(syncLeagueStatusFromWorker(true)).resolves.toBe("off");
    expect(await getSetting(SETTING_KEYS.LEAGUE_STATUS_CHECK_AT)).toBeNull();
  });

  it("looks after a pass that changed something, else every ten minutes", async () => {
    await createLeagueStatusCard();
    await expireThrottle();
    players = 11;
    await lookedAt(60_000);
    // A quiet pass a minute after the last look reads nothing.
    await expect(syncLeagueStatusFromWorker(false)).resolves.toBe("idle");
    expect(mockPatch).not.toHaveBeenCalled();
    // A pass that imported a game (or sold a lot, built a round) looks now.
    await expect(syncLeagueStatusFromWorker(true)).resolves.toBe("edited");
    players = 12;
    await expireThrottle();
    await lookedAt(11 * 60_000);
    await expect(syncLeagueStatusFromWorker(false)).resolves.toBe("edited");
    expect(mockPatch).toHaveBeenCalledTimes(2);
  });

  it("looks every pass while the card shows a live draft", async () => {
    draftLive = true;
    await createLeagueStatusCard();
    expect(JSON.parse((await cardRow())!).hot).toBe(true);
    await expireThrottle();
    players = 11;
    await lookedAt(55_000);
    await expect(syncLeagueStatusFromWorker(false)).resolves.toBe("edited");
    // Once the draft is over, the card cools back to the ten-minute look.
    draftLive = false;
    await expireThrottle();
    await lookedAt(55_000);
    await expect(syncLeagueStatusFromWorker(false)).resolves.toBe("edited");
    expect(JSON.parse((await cardRow())!).hot).toBe(false);
    players = 12;
    await expireThrottle();
    await lookedAt(55_000);
    await expect(syncLeagueStatusFromWorker(false)).resolves.toBe("idle");
  });
});

describe("status card — failures", () => {
  it("counts a failed edit, keeps the old digest and retries", async () => {
    await createLeagueStatusCard();
    const before = JSON.parse((await cardRow())!).digest;
    await expireThrottle();
    players = 11;
    mockPatch.mockResolvedValueOnce("failed");
    await expect(syncLeagueStatus()).resolves.toBe("failed");
    const row = JSON.parse((await cardRow())!);
    expect(row.digest).toBe(before);
    expect(row.failures).toBe(1);
    await expireThrottle();
    await expect(syncLeagueStatus()).resolves.toBe("edited");
    expect(JSON.parse((await cardRow())!).failures).toBe(0);
  });

  it("turns itself off when the message is gone, and never re-posts", async () => {
    await createLeagueStatusCard();
    await expireThrottle();
    players = 11;
    mockPatch.mockResolvedValueOnce("gone");
    await expect(syncLeagueStatus()).resolves.toBe("gone");
    expect(await cardRow()).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("forgets a card stranded by a webhook in another channel", async () => {
    await createLeagueStatusCard();
    mockHook.mockResolvedValue(OTHER_HOOK);
    await expect(getLeagueStatusCardStatus()).resolves.toMatchObject({
      posted: true,
      stranded: true,
    });
    players = 11;
    await expect(syncLeagueStatus()).resolves.toBe("stranded");
    expect(mockPatch).not.toHaveBeenCalled();
    expect(await cardRow()).toBeNull();
  });

  it("keeps the card while the webhook is temporarily unset", async () => {
    await createLeagueStatusCard();
    mockHook.mockResolvedValue(null);
    await expect(syncLeagueStatus()).resolves.toBe("off");
    expect(await cardRow()).not.toBeNull();
  });

  it("survives a corrupt row", async () => {
    await setSetting(SETTING_KEYS.LEAGUE_STATUS_CARD, "{not json");
    await expect(syncLeagueStatus()).resolves.toBe("off");
  });
});

describe("status card — removal", () => {
  it("deletes the message and forgets it", async () => {
    await createLeagueStatusCard();
    await expect(removeLeagueStatusCard()).resolves.toEqual({
      ok: true,
      orphaned: false,
    });
    expect(mockDelete).toHaveBeenCalledWith(HOOK, MSG_ID);
    expect(await cardRow()).toBeNull();
  });

  it("keeps the row when Discord doesn't confirm, unless forced", async () => {
    await createLeagueStatusCard();
    mockDelete.mockResolvedValue(false);
    await expect(removeLeagueStatusCard()).resolves.toMatchObject({ ok: false });
    expect(await cardRow()).not.toBeNull();
    await expect(removeLeagueStatusCard({ force: true })).resolves.toEqual({
      ok: true,
      orphaned: true,
    });
    expect(await cardRow()).toBeNull();
  });
});

describe("status card — guarded writes", () => {
  it("never writes an old card's state over a card posted during its edit", async () => {
    // The row is read before the PATCH round trip and written after it. An
    // admin who removes the card and posts a new one in that gap leaves a row
    // for the NEW message; writing the old state back would point the row at
    // a deleted message and leave the new card untracked.
    await createLeagueStatusCard();
    await expireThrottle();
    players = 11;
    mockPatch.mockImplementation(async () => {
      await removeLeagueStatusCard();
      mockPost.mockResolvedValueOnce({ id: NEW_MSG });
      await createLeagueStatusCard();
      return "ok";
    });
    await syncLeagueStatus();
    expect(JSON.parse((await cardRow())!).messageId).toBe(NEW_MSG);
  });

  it("stands down when a rival posts first during a takeover", async () => {
    // A settled card in the OLD channel; the webhook now points elsewhere, so
    // taking that row over is the one case the read-time checks allow.
    mockHook.mockResolvedValue(OTHER_HOOK);
    await createLeagueStatusCard();
    mockHook.mockResolvedValue(HOOK);
    mockPost.mockClear();
    let fired = false;
    setRaceHook(
      onceAt("leagueStatus.claimCardRow.beforeTakeover", async () => {
        fired = true;
        mockPost.mockResolvedValueOnce({ id: NEW_MSG });
        await createLeagueStatusCard();
      }),
    );
    const res = await createLeagueStatusCard();
    expect(fired).toBe(true);
    expect(res.ok).toBe(false);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await cardRow())!).messageId).toBe(NEW_MSG);
  });

  it("never forgets a card posted while the old one's edit came back gone", async () => {
    // "Gone" clears the row by value (clearStateIf, a deleteMany the
    // mutation ratchet can't see): a blind delete would forget the card an
    // admin posted during the round trip, leaving it frozen in the channel.
    await createLeagueStatusCard();
    await expireThrottle();
    players = 11;
    mockPatch.mockImplementation(async () => {
      await removeLeagueStatusCard();
      mockPost.mockResolvedValueOnce({ id: NEW_MSG });
      await createLeagueStatusCard();
      return "gone";
    });
    await expect(syncLeagueStatus()).resolves.toBe("gone");
    expect(JSON.parse((await cardRow())!).messageId).toBe(NEW_MSG);
  });

  it("leaves a row an admin replaced alone when its own edit fails", async () => {
    await createLeagueStatusCard();
    await expireThrottle();
    players = 11;
    const replacement = JSON.stringify({
      webhookId: "44444",
      messageId: NEW_MSG,
      digest: "replacement",
    });
    mockPatch.mockImplementation(async () => {
      await prisma.setting.update({
        where: { key: SETTING_KEYS.LEAGUE_STATUS_CARD },
        data: { value: replacement },
      });
      return "failed";
    });
    await syncLeagueStatus();
    expect(await cardRow()).toBe(replacement);
  });
});
