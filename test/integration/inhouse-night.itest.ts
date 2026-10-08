import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
// Keep the formatters real; stub the inhouse channel and the role lookup.
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    getInhouseAlertWebhookUrl: vi.fn(async () => "https://discord.test/inhouse"),
    getInhousePingRoleId: vi.fn(async () => "555555555555555555"),
    sendInhouseDiscordMessage: vi.fn(async () => true),
  };
});
// The bot's REST calls are stubbed; the guild is known.
vi.mock("@/lib/discord-roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord-roles")>();
  return {
    ...actual,
    getGuildConfig: vi.fn(() => ({ token: "t", guildId: "111111111111111111" })),
    createGuildEvent: vi.fn(),
    updateGuildEvent: vi.fn(),
    deleteGuildEvent: vi.fn(async () => "ok"),
  };
});

import { cancelInhouseNight, setInhouseNight } from "@/app/actions/admin-inhouse-night";
import { setInhouseNightRsvpAction } from "@/app/actions/inhouse-night-rsvp";
import { requireAdmin, requireUser } from "@/lib/auth";
import {
  getInhouseAlertWebhookUrl,
  sendInhouseDiscordMessage,
} from "@/lib/discord";
import {
  createGuildEvent,
  deleteGuildEvent,
  updateGuildEvent,
} from "@/lib/discord-roles";
import {
  INHOUSE_NIGHT_START_POST_WINDOW_MS,
  parseInhouseNight,
  serializeInhouseNight,
  type InhouseNight,
} from "@/lib/inhouse-night";
import {
  readInhouseNightRsvps,
  setInhouseNightRsvp,
} from "@/lib/inhouse-night-rsvp-service";
import {
  announceInhouseNightStart,
  attachInhouseNightEvent,
  clearInhouseNight,
  publishInhouseNight,
  readInhouseNight,
  saveInhouseNight,
  withdrawInhouseNight,
} from "@/lib/inhouse-night-service";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { runResultSync } from "@/lib/result-sync-service";
import { SETTING_KEYS, inhouseNightStartKey } from "@/lib/settings";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import { makeUser, raceN, sessionFor } from "./factories";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GUILD = "111111111111111111";
const EVENT = "222222222222222222";
const ROLE = "555555555555555555";
const STALE = /changed while this page was open/;

const mockSend = vi.mocked(sendInhouseDiscordMessage);
const mockWebhook = vi.mocked(getInhouseAlertWebhookUrl);
const mockCreate = vi.mocked(createGuildEvent);
const mockUpdate = vi.mocked(updateGuildEvent);
const mockDelete = vi.mocked(deleteGuildEvent);

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
  mockWebhook.mockReset();
  mockWebhook.mockResolvedValue("https://discord.test/inhouse");
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ ok: true, eventId: EVENT });
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue({ ok: true, eventId: EVENT });
  mockDelete.mockReset();
  mockDelete.mockResolvedValue("ok");
});
afterEach(() => setRaceHook(null));

const stored = async () => (await readInhouseNight()).night;

/** Store a night directly (a past start can't be saved through the form). */
async function storeNight(overrides: Partial<InhouseNight> = {}): Promise<InhouseNight> {
  const night: InhouseNight = {
    id: "night-1",
    startsAtMs: Date.now() - 60_000,
    note: "",
    createdAtMs: Date.now() - DAY,
    revision: 0,
    discordEventId: null,
    ...overrides,
  };
  await prisma.setting.upsert({
    where: { key: SETTING_KEYS.INHOUSE_NIGHT },
    create: { key: SETTING_KEYS.INHOUSE_NIGHT, value: serializeInhouseNight(night) },
    update: { value: serializeInhouseNight(night) },
  });
  return night;
}

describe("saving the inhouse night", () => {
  it("stores a new night, then moves it keeping its id and Discord event", async () => {
    const first = await saveInhouseNight({
      startsAtMs: Date.now() + 2 * DAY,
      note: "  First one:   bring a friend ",
      expected: null,
    });
    expect(first.change).toBe("new");
    expect(await stored()).toEqual(first.night);
    expect(first.night).toMatchObject({ note: "First one: bring a friend", revision: 0 });

    expect(await attachInhouseNightEvent(first, EVENT)).toBe(true);
    const withEvent = (await stored())!;
    const moved = await saveInhouseNight({
      startsAtMs: Date.now() + 3 * DAY,
      note: withEvent.note,
      expected: { id: withEvent.id, revision: withEvent.revision },
    });
    expect(moved.change).toBe("moved");
    expect(await stored()).toEqual({
      ...withEvent,
      startsAtMs: moved.night.startsAtMs,
      revision: 1,
    });
  });

  it("refuses a past or far-off start and an over-long note, storing nothing", async () => {
    await expect(
      saveInhouseNight({ startsAtMs: Date.now() - 1, note: "", expected: null }),
    ).rejects.toThrow(/future/);
    await expect(
      saveInhouseNight({ startsAtMs: Date.now() + 61 * DAY, note: "", expected: null }),
    ).rejects.toThrow(/60 days/);
    await expect(
      saveInhouseNight({ startsAtMs: Date.now() + DAY, note: "x".repeat(201), expected: null }),
    ).rejects.toThrow(/200 characters/);
    expect(await stored()).toBeNull();
  });

  it("refuses a save from a page that showed a different night", async () => {
    const night = await storeNight({ startsAtMs: Date.now() + DAY, revision: 3 });
    await expect(
      saveInhouseNight({ startsAtMs: Date.now() + 2 * DAY, note: "", expected: null }),
    ).rejects.toThrow(STALE);
    await expect(
      saveInhouseNight({
        startsAtMs: Date.now() + 2 * DAY,
        note: "",
        expected: { id: night.id, revision: 2 },
      }),
    ).rejects.toThrow(STALE);
    expect(await stored()).toEqual(night);
  });

  it("loses to a save that lands between its read and its write", async () => {
    const rivalAt = Date.now() + 4 * DAY;
    let fired = false;
    setRaceHook(
      onceAt("inhouseNight.save.beforeSwap", async () => {
        fired = true;
        await saveInhouseNight({ startsAtMs: rivalAt, note: "rival", expected: null });
      }),
    );
    await expect(
      saveInhouseNight({ startsAtMs: Date.now() + DAY, note: "mine", expected: null }),
    ).rejects.toThrow(STALE);
    expect(fired).toBe(true);
    expect(await stored()).toMatchObject({ startsAtMs: rivalAt, note: "rival" });
  });

  it("loses a move to a move that lands between its read and its write", async () => {
    const night = await storeNight({ startsAtMs: Date.now() + DAY });
    const expected = { id: night.id, revision: night.revision };
    const rivalAt = Date.now() + 5 * DAY;
    let fired = false;
    setRaceHook(
      onceAt("inhouseNight.save.beforeSwap", async () => {
        fired = true;
        await saveInhouseNight({ startsAtMs: rivalAt, note: "", expected });
      }),
    );
    await expect(
      saveInhouseNight({ startsAtMs: Date.now() + 2 * DAY, note: "", expected }),
    ).rejects.toThrow(STALE);
    expect(fired).toBe(true);
    expect(await stored()).toMatchObject({ id: night.id, startsAtMs: rivalAt, revision: 1 });
  });

  it("keeps one night when two admins save from the same empty page at once", async () => {
    const results = await raceN(2, () =>
      saveInhouseNight({ startsAtMs: Date.now() + DAY, note: "", expected: null }).then(
        (save) => save.night.id,
        (error: Error) => error.message,
      ),
    );
    const saved = results.filter((result) => !STALE.test(result));
    expect(saved).toHaveLength(1);
    expect((await stored())?.id).toBe(saved[0]);
  });
});

describe("cancelling the inhouse night", () => {
  it("removes the night the page showed, and refuses one it didn't", async () => {
    const night = await storeNight({ startsAtMs: Date.now() + DAY, revision: 1 });
    await expect(
      clearInhouseNight({ expected: { id: night.id, revision: 0 } }),
    ).rejects.toThrow(STALE);
    expect(await clearInhouseNight({ expected: { id: night.id, revision: 1 } })).toEqual(night);
    expect(await stored()).toBeNull();
    expect(await clearInhouseNight({ expected: null })).toBeNull();
  });

  it("loses to a save that lands between its read and its delete", async () => {
    const night = await storeNight({ startsAtMs: Date.now() + DAY });
    const expected = { id: night.id, revision: night.revision };
    let fired = false;
    setRaceHook(
      onceAt("inhouseNight.clear.beforeSwap", async () => {
        fired = true;
        await saveInhouseNight({ startsAtMs: Date.now() + 2 * DAY, note: "", expected });
      }),
    );
    await expect(clearInhouseNight({ expected })).rejects.toThrow(STALE);
    expect(fired).toBe(true);
    expect(await stored()).toMatchObject({ id: night.id, revision: 1 });
  });
});

describe("the night on Discord", () => {
  it("creates the server event, stores its id and pings the role with its link", async () => {
    const save = await saveInhouseNight({
      startsAtMs: Date.now() + DAY,
      note: "First one",
      expected: null,
    });
    expect(await publishInhouseNight(save)).toEqual({ posted: true, event: "created" });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const fields = mockCreate.mock.calls[0][0];
    expect(fields.name).toMatch(/inhouse night$/);
    expect(fields.location).toMatch(/\/inhouse$/);
    expect(fields.startsAt.getTime()).toBe(save.night.startsAtMs);
    expect((await stored())?.discordEventId).toBe(EVENT);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [content, mentions] = mockSend.mock.calls[0];
    expect(content).toContain(`<@&${ROLE}>`);
    expect(content).toContain("First one");
    expect(content).toContain(`https://discord.com/events/${GUILD}/${EVENT}`);
    expect(mentions).toEqual({ roles: [ROLE] });
  });

  it("moves the event with the night and posts the move without a ping", async () => {
    const night = await storeNight({ startsAtMs: Date.now() + DAY, discordEventId: EVENT });
    const save = await saveInhouseNight({
      startsAtMs: Date.now() + 2 * DAY,
      note: "",
      expected: { id: night.id, revision: night.revision },
    });
    expect(await publishInhouseNight(save)).toEqual({ posted: true, event: "updated" });
    expect(mockUpdate).toHaveBeenCalledWith(EVENT, expect.objectContaining({
      startsAt: new Date(save.night.startsAtMs),
    }));
    expect(mockCreate).not.toHaveBeenCalled();
    const [content, mentions] = mockSend.mock.calls[0];
    expect(content).toMatch(/^🕑 \*\*Inhouse night moved\*\*/);
    expect(mentions).toBeUndefined();
  });

  it("only rewords the event for a new note, posting nothing", async () => {
    const night = await storeNight({ startsAtMs: Date.now() + DAY, discordEventId: EVENT });
    const save = await saveInhouseNight({
      startsAtMs: night.startsAtMs,
      note: "Now with a note",
      expected: { id: night.id, revision: night.revision },
    });
    expect(save.change).toBe("note");
    expect(await publishInhouseNight(save)).toEqual({ posted: null, event: "updated" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("makes the event again when someone deleted it in Discord", async () => {
    const night = await storeNight({ startsAtMs: Date.now() + DAY, discordEventId: "333333333333333333" });
    mockUpdate.mockResolvedValue({ ok: false, reason: "gone" });
    const save = await saveInhouseNight({
      startsAtMs: Date.now() + 2 * DAY,
      note: "",
      expected: { id: night.id, revision: night.revision },
    });
    expect((await publishInhouseNight(save)).event).toBe("created");
    expect((await stored())?.discordEventId).toBe(EVENT);
  });

  it("never links an event deleted in Discord, even when it can't be made again", async () => {
    const night = await storeNight({ startsAtMs: Date.now() + DAY, discordEventId: "333333333333333333" });
    mockUpdate.mockResolvedValue({ ok: false, reason: "gone" });
    mockCreate.mockResolvedValue({ ok: false, reason: "forbidden" });
    const save = await saveInhouseNight({
      startsAtMs: Date.now() + 2 * DAY,
      note: "",
      expected: { id: night.id, revision: night.revision },
    });
    expect(await publishInhouseNight(save)).toEqual({ posted: true, event: "forbidden" });
    expect(mockSend.mock.calls[0][0]).not.toContain("discord.com/events");
  });

  it("deletes an event made for a night that changed before its id was stored", async () => {
    const first = await saveInhouseNight({ startsAtMs: Date.now() + DAY, note: "", expected: null });
    await saveInhouseNight({
      startsAtMs: Date.now() + 2 * DAY,
      note: "",
      expected: { id: first.night.id, revision: first.night.revision },
    });
    expect((await publishInhouseNight(first)).event).toBe("failed");
    expect(mockDelete).toHaveBeenCalledWith(EVENT);
    expect((await stored())?.discordEventId).toBeNull();
  });

  it("still posts the night when the bot may not create events", async () => {
    mockCreate.mockResolvedValue({ ok: false, reason: "forbidden" });
    const save = await saveInhouseNight({ startsAtMs: Date.now() + DAY, note: "", expected: null });
    expect(await publishInhouseNight(save)).toEqual({ posted: true, event: "forbidden" });
    expect(mockSend.mock.calls[0][0]).not.toContain("discord.com/events");
  });

  it("deletes an upcoming night's event and says it's off; a started night is left alone", async () => {
    const upcoming = await storeNight({ startsAtMs: Date.now() + DAY, discordEventId: EVENT });
    expect(await withdrawInhouseNight(upcoming)).toEqual({ posted: true, event: "deleted" });
    expect(mockDelete).toHaveBeenCalledWith(EVENT);
    expect(mockSend.mock.calls[0][0]).toMatch(/is off/);

    mockSend.mockClear();
    mockDelete.mockClear();
    const started = await storeNight({ startsAtMs: Date.now() - HOUR, discordEventId: EVENT });
    expect(await withdrawInhouseNight(started)).toEqual({ posted: null, event: "kept" });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("the admin actions", () => {
  async function signInAdmin() {
    const admin = await makeUser("League Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
  }
  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  it("sets a night, says what happened on Discord, and cancels it", async () => {
    await signInAdmin();
    const startsAt = Date.now() + DAY;
    const set = await setInhouseNight(null, form({
      startsAt: "2030-01-01T20:00",
      startsAtTs: String(startsAt),
      note: "",
      expectedNightId: "",
      expectedNightRevision: "",
    }));
    expect(set?.message).toMatch(/^Inhouse night set for .+ Posted in the inhouse channel\. Added to the server's Discord events\.$/);
    const night = (await stored())!;
    expect(night.startsAtMs).toBe(startsAt);
    expect(await prisma.adminAction.count({ where: { action: "setInhouseNight" } })).toBe(1);

    const stale = await cancelInhouseNight(null, form({
      expectedNightId: night.id,
      expectedNightRevision: String(night.revision + 1),
    }));
    expect(stale?.error).toMatch(STALE);

    const cancelled = await cancelInhouseNight(null, form({
      expectedNightId: night.id,
      expectedNightRevision: String(night.revision),
    }));
    expect(cancelled?.message).toMatch(/cancelled.+told it's off\. The Discord event is deleted\.$/);
    expect(await stored()).toBeNull();
  });

  it("refuses a missing time and a non-admin", async () => {
    await signInAdmin();
    expect(await setInhouseNight(null, form({ startsAt: "", startsAtTs: "" }))).toEqual({
      error: "Pick when the inhouse night starts.",
    });
    vi.mocked(requireAdmin).mockRejectedValue(new Error("no"));
    expect(
      (await setInhouseNight(null, form({ startsAtTs: String(Date.now() + DAY), startsAt: "x" })))?.error,
    ).toBeTruthy();
    expect(await stored()).toBeNull();
  });
});

describe("the start post", () => {
  async function queuePresent(count: number) {
    for (let i = 0; i < count; i++) {
      const user = await makeUser(`Queued ${i}`);
      await prisma.inhouseQueueEntry.create({ data: { userId: user.id, lastSeenAt: new Date() } });
    }
  }
  const markerOf = (night: InhouseNight) =>
    prisma.setting.findUnique({ where: { key: inhouseNightStartKey(night.id, night.startsAtMs) } });

  it("pings the role once when the night starts, with the queue so far", async () => {
    const night = await storeNight({ startsAtMs: Date.now() - 60_000 });
    await queuePresent(3);
    expect(await announceInhouseNightStart()).toBe(true);
    expect(await announceInhouseNightStart()).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [content, mentions] = mockSend.mock.calls[0];
    expect(content).toBe(
      `<@&${ROLE}> 🎮 **Inhouse night is on!** 3/10 in the queue so far. Jump in: <${(await import("@/lib/discord")).joinLink()}>`,
    );
    expect(mentions).toEqual({ roles: [ROLE], users: [] });
    expect((await markerOf(night))?.value).toMatch(/^sent:/);
  });

  it("also pings the players who said they're in on the site, counting the unlinked", async () => {
    const night = await storeNight();
    const linked = await prisma.user.create({
      data: { steamId: "76561197960999001", name: "Linked", discordId: "700000000000000001" },
    });
    const unlinked = await makeUser("Unlinked");
    const otherNight = await prisma.user.create({
      data: { steamId: "76561197960999002", name: "Old night", discordId: "700000000000000002" },
    });
    // Stored straight in: the night has started, so the form no longer takes "I'm in".
    await prisma.inhouseNightRsvp.createMany({
      data: [
        { nightId: night.id, userId: linked.id },
        { nightId: night.id, userId: unlinked.id },
        // A row left by a night that's gone is never pinged.
        { nightId: "night-0", userId: otherNight.id },
      ],
    });
    expect(await announceInhouseNightStart()).toBe(true);
    const [content, mentions] = mockSend.mock.calls[0];
    expect(content).toMatch(/\nSaid they're in on the site: <@700000000000000001> and 1 more$/);
    expect(content).not.toContain("700000000000000002");
    expect(mentions).toEqual({ roles: [ROLE], users: ["700000000000000001"] });
  });

  it("posts only once when two workers run together", async () => {
    await storeNight({ startsAtMs: Date.now() - 60_000 });
    const posted = await raceN(2, () => announceInhouseNightStart());
    expect(posted.filter(Boolean)).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("waits for the start and stays quiet once the post window has closed", async () => {
    const upcoming = await storeNight({ startsAtMs: Date.now() + HOUR });
    expect(await announceInhouseNightStart()).toBe(false);
    const late = await storeNight({
      startsAtMs: Date.now() - INHOUSE_NIGHT_START_POST_WINDOW_MS - 1_000,
    });
    expect(await announceInhouseNightStart()).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    expect(await markerOf(upcoming)).toBeNull();
    expect(await markerOf(late)).toBeNull();
  });

  it("records the post as covered when there's nowhere to post, so nothing retries", async () => {
    const night = await storeNight();
    mockWebhook.mockResolvedValue(null);
    expect(await announceInhouseNightStart()).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    expect((await markerOf(night))?.value).toMatch(/^sent:/);
    mockWebhook.mockResolvedValue("https://discord.test/inhouse");
    expect(await announceInhouseNightStart()).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("retries a post Discord refused while the window is open", async () => {
    const night = await storeNight();
    mockSend.mockResolvedValueOnce(false);
    expect(await announceInhouseNightStart()).toBe(false);
    expect((await markerOf(night))?.value).toMatch(/^failed:/);
    expect(await announceInhouseNightStart()).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("stands down for a night moved after its post was claimed", async () => {
    const night = await storeNight();
    let fired = false;
    setRaceHook(
      onceAt("inhouseNight.start.afterClaim", async () => {
        fired = true;
        await storeNight({ startsAtMs: Date.now() + DAY, revision: 1 });
      }),
    );
    expect(await announceInhouseNightStart()).toBe(false);
    expect(fired).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    // Released, not burned: the moved night posts under its own key later.
    expect(await markerOf(night)).toBeNull();
  });

  it("runs in the automation worker", async () => {
    await storeNight();
    await runResultSync();
    expect(mockSend.mock.calls.map(([content]) => content)).toEqual([
      expect.stringContaining("**Inhouse night is on!**"),
    ]);
  });
});

describe("saying I'm in on the site", () => {
  const upcoming = () => storeNight({ startsAtMs: Date.now() + DAY });
  const count = () => prisma.inhouseNightRsvp.count();

  it("puts a player on the night's list once, and takes them off again", async () => {
    const night = await upcoming();
    const player = await makeUser("Player");
    const say = (going: boolean) =>
      setInhouseNightRsvp({ userId: player.id, nightId: night.id, going });
    expect(await say(true)).toMatchObject({ outcome: "in", linked: false, night: { id: night.id } });
    expect(await say(true)).toMatchObject({ outcome: "already-in" });
    expect((await readInhouseNightRsvps(night.id)).players).toEqual([
      { id: player.id, name: "Player", avatar: null },
    ]);
    expect(await say(false)).toMatchObject({ outcome: "out" });
    expect(await say(false)).toMatchObject({ outcome: "already-out" });
    expect(await count()).toBe(0);
  });

  it("leaves one row when one player's two taps race", async () => {
    const night = await upcoming();
    const player = await makeUser("Double tap");
    const outcomes = await raceN(2, () =>
      setInhouseNightRsvp({ userId: player.id, nightId: night.id, going: true }),
    );
    expect(outcomes.map((r) => r.outcome).sort()).toEqual(["already-in", "in"]);
    expect(await count()).toBe(1);
  });

  it("refuses a night that changed, has started or is gone; taking it back always works", async () => {
    const player = await makeUser("Late");
    const say = (nightId: string, going = true) =>
      setInhouseNightRsvp({ userId: player.id, nightId, going });
    await expect(say("night-1")).rejects.toThrow(/changed or is over/);
    const night = await upcoming();
    await expect(say("night-0")).rejects.toThrow(/changed or is over/);
    await storeNight({ id: night.id, startsAtMs: Date.now() - 60_000 });
    await expect(say(night.id)).rejects.toThrow(/has started/);
    expect(await count()).toBe(0);
    // A row from before the start (or for a night since replaced) still goes.
    await prisma.inhouseNightRsvp.create({ data: { nightId: night.id, userId: player.id } });
    await prisma.inhouseNightRsvp.create({ data: { nightId: "night-0", userId: player.id } });
    expect(await say(night.id, false)).toMatchObject({ outcome: "out" });
    expect(await say("night-0", false)).toMatchObject({ outcome: "out", night: null });
    expect(await count()).toBe(0);
  });

  it("lists the first to say so first and keeps linked Discord ids beside them", async () => {
    const night = await upcoming();
    const first = await prisma.user.create({
      data: { steamId: "76561197960999101", name: "First", discordId: "700000000000000101" },
    });
    const second = await makeUser("Second");
    await prisma.inhouseNightRsvp.create({
      data: { nightId: night.id, userId: second.id, createdAt: new Date(Date.now() - 1_000) },
    });
    await prisma.inhouseNightRsvp.create({
      data: { nightId: night.id, userId: first.id, createdAt: new Date(Date.now() - 5_000) },
    });
    const rsvps = await readInhouseNightRsvps(night.id);
    expect(rsvps.players.map((p) => p.name)).toEqual(["First", "Second"]);
    expect(rsvps.discordIds).toEqual(["700000000000000101", null]);
    // Display fields only: nothing else about the player leaves the read.
    expect(Object.keys(rsvps.players[0]).sort()).toEqual(["avatar", "id", "name"]);
    expect((await readInhouseNightRsvps("night-0")).players).toEqual([]);
  });

  it("keeps the list through a move, and planning the next night starts it empty", async () => {
    const save = await saveInhouseNight({ startsAtMs: Date.now() + DAY, note: "", expected: null });
    const player = await makeUser("Coming");
    await setInhouseNightRsvp({ userId: player.id, nightId: save.night.id, going: true });
    await prisma.inhouseNightRsvp.create({ data: { nightId: "night-gone", userId: player.id } });

    const moved = await saveInhouseNight({
      startsAtMs: save.night.startsAtMs + HOUR,
      note: "",
      expected: { id: save.night.id, revision: save.night.revision },
    });
    expect(moved.change).toBe("moved");
    expect(await count()).toBe(2);

    // Once it has started, a save plans the next night: only that list survives.
    const next = await saveInhouseNight({
      startsAtMs: moved.night.startsAtMs + 7 * DAY,
      note: "",
      expected: { id: moved.night.id, revision: moved.night.revision },
      nowMs: moved.night.startsAtMs + HOUR,
    });
    expect(next.change).toBe("new");
    expect(await count()).toBe(0);
  });

  it("drops a cancelled night's list, never another night's", async () => {
    const save = await saveInhouseNight({ startsAtMs: Date.now() + DAY, note: "", expected: null });
    const player = await makeUser("Was coming");
    await setInhouseNightRsvp({ userId: player.id, nightId: save.night.id, going: true });
    // A newer night's row, as if one was planned right after this cancel.
    await prisma.inhouseNightRsvp.create({ data: { nightId: "night-newer", userId: player.id } });
    await clearInhouseNight({ expected: { id: save.night.id, revision: save.night.revision } });
    expect(await prisma.inhouseNightRsvp.findMany({ select: { nightId: true } })).toEqual([
      { nightId: "night-newer" },
    ]);
  });

  it("goes with the player's account", async () => {
    const night = await upcoming();
    const player = await makeUser("Leaving");
    await setInhouseNightRsvp({ userId: player.id, nightId: night.id, going: true });
    await prisma.user.delete({ where: { id: player.id } });
    expect(await count()).toBe(0);
  });

  describe("the action", () => {
    function form(fields: Record<string, string>) {
      const data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
      return data;
    }

    it("says the player is in, and how they'll hear about the start", async () => {
      const night = await upcoming();
      const player = await makeUser("Player");
      vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
      const inForm = form({ nightId: night.id, going: "1" });
      expect((await setInhouseNightRsvpAction(null, inForm))?.message).toMatch(
        /^You're in for .+\. Link Discord under My account to get a ping when it starts\.$/,
      );
      expect((await setInhouseNightRsvpAction(null, inForm))?.message).toMatch(/^You're already in for /);
      await prisma.user.update({ where: { id: player.id }, data: { discordId: "700000000000000201" } });
      await setInhouseNightRsvpAction(null, form({ nightId: night.id, going: "0" }));
      expect((await setInhouseNightRsvpAction(null, inForm))?.message).toMatch(
        /You'll get a Discord ping when it starts\.$/,
      );
      expect((await setInhouseNightRsvpAction(null, form({ nightId: night.id, going: "0" })))?.message).toBe(
        "Okay, you're off the list for this inhouse night.",
      );
    });

    it("asks a signed-out player to sign in, and refuses a night that's gone", async () => {
      const night = await upcoming();
      vi.mocked(requireUser).mockRejectedValue(new Error("signed out"));
      expect(await setInhouseNightRsvpAction(null, form({ nightId: night.id, going: "1" }))).toEqual({
        error: SIGN_IN_REQUIRED,
      });
      const player = await makeUser("Player");
      vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
      expect(
        (await setInhouseNightRsvpAction(null, form({ nightId: "night-0", going: "1" })))?.error,
      ).toMatch(/changed or is over/);
      expect(await count()).toBe(0);
    });
  });
});

describe("reading the stored night", () => {
  it("parses what the service stores", async () => {
    const save = await saveInhouseNight({ startsAtMs: Date.now() + DAY, note: "n", expected: null });
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: SETTING_KEYS.INHOUSE_NIGHT } });
    expect(row.value).toBe(save.raw);
    expect(parseInhouseNight(row.value)).toEqual(save.night);
  });
});
