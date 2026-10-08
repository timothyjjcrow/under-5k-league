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
import { requireAdmin } from "@/lib/auth";
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
    expect(mentions).toEqual({ roles: [ROLE] });
    expect((await markerOf(night))?.value).toMatch(/^sent:/);
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

describe("reading the stored night", () => {
  it("parses what the service stores", async () => {
    const save = await saveInhouseNight({ startsAtMs: Date.now() + DAY, note: "n", expected: null });
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: SETTING_KEYS.INHOUSE_NIGHT } });
    expect(row.value).toBe(save.raw);
    expect(parseInhouseNight(row.value)).toEqual(save.night);
  });
});
