import { describe, expect, it, vi } from "vitest";

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

import { setInhouseTimeAction } from "@/app/actions/inhouse-times";
import { requireUser } from "@/lib/auth";
import { serializeInhouseNight } from "@/lib/inhouse-night";
import {
  INHOUSE_TIME_AT_CAP,
  INHOUSE_TIME_DURING_NIGHT,
  INHOUSE_TIME_MAX_LEAD_MS,
  INHOUSE_TIME_MAX_PER_PLAYER,
  INHOUSE_TIME_ON_MS,
  INHOUSE_TIME_STEP_MS,
  inhouseTimeParam,
} from "@/lib/inhouse-times";
import {
  readInhouseTime,
  readInhouseTimes,
  setInhouseTimeRsvp,
} from "@/lib/inhouse-times-service";
import { prisma } from "@/lib/prisma";
import { SETTING_KEYS } from "@/lib/settings";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import { ON_POSTGRES, makeUser, raceAll, raceN, sessionFor } from "./factories";

const HOUR = 3_600_000;

/** The quarter hour at least `hours` from now. */
const ahead = (hours: number) =>
  Math.ceil((Date.now() + hours * HOUR) / INHOUSE_TIME_STEP_MS) * INHOUSE_TIME_STEP_MS;
/** The latest quarter hour that has started: a time on now. */
const startedQuarter = () => Math.floor(Date.now() / INHOUSE_TIME_STEP_MS) * INHOUSE_TIME_STEP_MS;

const count = () => prisma.inhouseTimeRsvp.count();
const say = (userId: string, startsAtMs: number, going = true) =>
  setInhouseTimeRsvp({ userId, startsAtMs, going });
/** The outcome, or the refusal's message: a race keeps every side's answer. */
const settle = (call: Promise<{ outcome: string }>) =>
  call.then(
    (result) => result.outcome,
    (error: Error) => error.message,
  );
/** A row written straight to the table: a time from the past, or one posted earlier. */
const insert = (userId: string, startsAtMs: number, createdAt = new Date()) =>
  prisma.inhouseTimeRsvp.create({ data: { userId, startsAt: new Date(startsAtMs), createdAt } });

describe("posting a time and saying I'm in", () => {
  it("posts a time by being first in, puts the next player in, and takes them off again", async () => {
    const [first, second] = [await makeUser("First"), await makeUser("Second")];
    const at = ahead(2);
    expect(await say(first.id, at)).toEqual({ outcome: "posted" });
    expect(await say(second.id, at)).toEqual({ outcome: "in" });
    expect(await say(first.id, at)).toEqual({ outcome: "already-in" });
    expect((await readInhouseTimes()).map((time) => time.players.map((p) => p.name))).toEqual([
      ["First", "Second"],
    ]);
    expect(await say(first.id, at, false)).toEqual({ outcome: "out" });
    expect(await say(first.id, at, false)).toEqual({ outcome: "already-out" });
    expect(await say(second.id, at, false)).toEqual({ outcome: "out" });
    // Nobody in: the time is gone.
    expect(await readInhouseTimes()).toEqual([]);
    expect(await count()).toBe(0);
  });

  it("leaves one row when one player's two taps race", async () => {
    // On Postgres the second tap, which read the key before the first
    // committed, is cancelled as a serialization conflict; its retry reads
    // the first tap's row and says "already in".
    for (let round = 0; round < (ON_POSTGRES ? 10 : 1); round++) {
      await prisma.inhouseTimeRsvp.deleteMany();
      const player = await makeUser(`Double tap ${round}`);
      const at = ahead(2);
      const outcomes = await raceN(2, () => settle(say(player.id, at)));
      expect(outcomes.sort()).toEqual(["already-in", "posted"]);
      expect(await count()).toBe(1);
    }
  });

  it("tells one of two players posting the same time at once that they posted it", async () => {
    for (let round = 0; round < (ON_POSTGRES ? 10 : 1); round++) {
      await prisma.inhouseTimeRsvp.deleteMany();
      const [a, b] = [await makeUser(`A${round}`), await makeUser(`B${round}`)];
      const at = ahead(3);
      const outcomes = await raceAll([() => settle(say(a.id, at)), () => settle(say(b.id, at))]);
      expect(outcomes.sort()).toEqual(["in", "posted"]);
      expect(await count()).toBe(2);
    }
  });

  it("refuses a time that's on, over, off the quarter hour or too far off; taking it back always works", async () => {
    const player = await makeUser("Late");
    await expect(say(player.id, startedQuarter())).rejects.toThrow(/started: join the queue/);
    await expect(say(player.id, startedQuarter() - 2 * HOUR)).rejects.toThrow(/been and gone/);
    await expect(say(player.id, ahead(2) + 60_000)).rejects.toThrow(/quarter hour/);
    await expect(
      say(player.id, ahead(0) + INHOUSE_TIME_MAX_LEAD_MS + INHOUSE_TIME_STEP_MS),
    ).rejects.toThrow(/next day/);
    expect(await count()).toBe(0);
    // In before it started: still free to take it back.
    await insert(player.id, startedQuarter());
    expect(await say(player.id, startedQuarter(), false)).toEqual({ outcome: "out" });
    expect(await count()).toBe(0);
  });
});

describe("the cap", () => {
  it(`holds a player to ${INHOUSE_TIME_MAX_PER_PLAYER} upcoming times, not counting one on now`, async () => {
    const player = await makeUser("Keen");
    const times = [1, 2, 3, 4].map((hours) => ahead(hours));
    await insert(player.id, startedQuarter());
    for (const at of times.slice(0, 3)) await say(player.id, at);
    await expect(say(player.id, times[3])).rejects.toThrow(INHOUSE_TIME_AT_CAP);
    // At the cap, a time they're already in on is still just "already in".
    expect(await say(player.id, times[0])).toEqual({ outcome: "already-in" });
    expect(await say(player.id, times[1], false)).toEqual({ outcome: "out" });
    expect(await say(player.id, times[3])).toEqual({ outcome: "posted" });
    expect(await prisma.inhouseTimeRsvp.count({ where: { userId: player.id } })).toBe(4);
  });

  it("lets only one of a player's racing I'm ins past the cap", async () => {
    // Raced on Postgres, where two inserts that each counted the other's
    // rows meet in the Serializable transaction; without it both land.
    for (let round = 0; round < (ON_POSTGRES ? 12 : 1); round++) {
      await prisma.inhouseTimeRsvp.deleteMany();
      const player = await makeUser(`Racer ${round}`);
      for (let i = 1; i < INHOUSE_TIME_MAX_PER_PLAYER; i++) await say(player.id, ahead(i));
      const [left, right] = [ahead(10), ahead(11)];
      const outcomes = await raceAll([
        () => settle(say(player.id, left)),
        () => settle(say(player.id, right)),
      ]);
      expect(outcomes.sort()).toEqual(["posted", INHOUSE_TIME_AT_CAP].sort());
      expect(await prisma.inhouseTimeRsvp.count({ where: { userId: player.id } })).toBe(
        INHOUSE_TIME_MAX_PER_PLAYER,
      );
    }
  });
});

describe("the inhouse night", () => {
  it("keeps a new time out of the night, and lets players join one posted before it", async () => {
    const start = ahead(4);
    await prisma.setting.create({
      data: {
        key: SETTING_KEYS.INHOUSE_NIGHT,
        value: serializeInhouseNight({
          id: "night-1",
          startsAtMs: start,
          note: "",
          createdAtMs: Date.now(),
          revision: 0,
          discordEventId: null,
        }),
      },
    });
    const [early, late] = [await makeUser("Early"), await makeUser("Late")];
    await expect(say(late.id, start)).rejects.toThrow(INHOUSE_TIME_DURING_NIGHT);
    await expect(say(late.id, start + HOUR)).rejects.toThrow(INHOUSE_TIME_DURING_NIGHT);
    // Just before the night is fine: a warm-up isn't a split.
    expect(await say(late.id, start - INHOUSE_TIME_STEP_MS)).toEqual({ outcome: "posted" });
    // Posted before the night was planned: it stays, and others can join.
    await insert(early.id, start + HOUR);
    expect(await say(late.id, start + HOUR)).toEqual({ outcome: "in" });
  });
});

describe("reading the times", () => {
  it("lists times soonest first, first in first, with display fields only, and drops those that are over", async () => {
    const [a, b, c] = [await makeUser("A"), await makeUser("B"), await makeUser("C")];
    const [soon, later] = [ahead(1), ahead(5)];
    await insert(b.id, later, new Date(Date.now() - 1_000));
    await insert(c.id, soon);
    await insert(a.id, later, new Date(Date.now() - 5_000));
    await insert(a.id, startedQuarter());
    await insert(c.id, startedQuarter() - INHOUSE_TIME_ON_MS - INHOUSE_TIME_STEP_MS);
    const times = await readInhouseTimes();
    expect(times.map((time) => [time.phase, time.players.map((p) => p.name)])).toEqual([
      ["on", ["A"]],
      ["upcoming", ["C"]],
      ["upcoming", ["A", "B"]],
    ]);
    expect(Object.keys(times[0].players[0]).sort()).toEqual(["avatar", "id", "name"]);
    expect((await readInhouseTime(later))?.players.map((p) => p.name)).toEqual(["A", "B"]);
    expect(await readInhouseTime(ahead(8))).toBeNull();
    expect(
      await readInhouseTime(startedQuarter() - INHOUSE_TIME_ON_MS - INHOUSE_TIME_STEP_MS),
    ).toBeNull();
  });

  it("prunes the rows of times that are over after the next I'm in", async () => {
    const player = await makeUser("Tidy");
    await insert(player.id, startedQuarter() - 3 * HOUR);
    await insert(player.id, startedQuarter());
    await say(player.id, ahead(2));
    expect(
      (await prisma.inhouseTimeRsvp.findMany({ select: { startsAt: true } }))
        .map((row) => row.startsAt.getTime())
        .sort(),
    ).toEqual([startedQuarter(), ahead(2)].sort());
  });

  it("goes with the player's account", async () => {
    const player = await makeUser("Leaving");
    await say(player.id, ahead(2));
    await prisma.user.delete({ where: { id: player.id } });
    expect(await count()).toBe(0);
  });
});

describe("the action", () => {
  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  it("says what happened, naming the time on the league's clock", async () => {
    const [poster, joiner] = [await makeUser("Poster"), await makeUser("Joiner")];
    const at = inhouseTimeParam(ahead(2));
    vi.mocked(requireUser).mockResolvedValue(sessionFor(poster));
    expect((await setInhouseTimeAction(null, form({ at, posting: "1" })))?.message).toMatch(
      /^You posted [^.]+\. Copy its link to share it in Discord\.$/,
    );
    expect((await setInhouseTimeAction(null, form({ at, going: "1" })))?.message).toMatch(
      /^You're already in for /,
    );
    vi.mocked(requireUser).mockResolvedValue(sessionFor(joiner));
    expect((await setInhouseTimeAction(null, form({ at, posting: "1" })))?.message).toMatch(
      / was already up, so you're in on it\.$/,
    );
    expect((await setInhouseTimeAction(null, form({ at, going: "0" })))?.message).toMatch(
      /^Okay, you're off /,
    );
    expect((await setInhouseTimeAction(null, form({ at, going: "1" })))?.message).toMatch(
      /^You're in for /,
    );
    expect(await count()).toBe(2);
  });

  it("asks a signed-out player to sign in, and refuses a time it can't read", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("signed out"));
    const at = inhouseTimeParam(ahead(2));
    expect(await setInhouseTimeAction(null, form({ at, going: "1" }))).toEqual({
      error: SIGN_IN_REQUIRED,
    });
    const player = await makeUser("Player");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    expect(await setInhouseTimeAction(null, form({ at: "", posting: "1" }))).toEqual({
      error: "Pick a time first.",
    });
    expect(await setInhouseTimeAction(null, form({ at: "8pm", going: "1" }))).toEqual({
      error: "Reload the page and try again.",
    });
    expect(
      (await setInhouseTimeAction(null, form({ at: inhouseTimeParam(startedQuarter()), going: "1" })))
        ?.error,
    ).toMatch(/started: join the queue/);
    expect(await count()).toBe(0);
  });
});
