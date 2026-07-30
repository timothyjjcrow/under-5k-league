import { afterEach, describe, expect, it, vi } from "vitest";
import { onceAt, setRaceHook } from "@/lib/race-hook";

// Admin actions are server actions, so auth and cache invalidation are stubbed
// exactly as abort-draft.itest.ts does.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import {
  recordResult,
  reopenMatch,
  setMatchTime,
  setWeekNight,
} from "@/app/actions/admin";
import { proposeReschedule, respondReschedule } from "@/lib/reschedule-service";
import { MATCH_STATUS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  raceAll,
  recordMatch as recordMatchDirect,
} from "./factories";

/** The two captains of a specific fixture (a 4-team round robin pairs teams
 *  differently each week, so never assume matches[0] is Home v Away). */
async function captainsOf(matchId: string) {
  const m = await prisma.match.findUniqueOrThrow({
    where: { id: matchId },
    include: {
      homeTeam: { select: { captainId: true } },
      awayTeam: { select: { captainId: true } },
    },
  });
  return { proposer: m.homeTeam.captainId!, responder: m.awayTeam.captainId! };
}

/** FormData from a plain object — server actions take nothing else. */
function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

async function seasonWithMatches() {
  const season = await makeSeason();
  // FOUR teams, so every week holds two fixtures — a week whose only match is
  // completed has nothing to move and setWeekNight refuses outright, which
  // makes any assertion after it vacuous.
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  await makeTeam(season.id, "Third", 2);
  await makeTeam(season.id, "Fourth", 3);
  const matches = await generateRegularSchedule(season.id);
  const when = new Date(Date.now() + 864e5);
  await prisma.match.updateMany({
    where: { seasonId: season.id },
    data: { scheduledAt: when },
  });
  const withTimes = await prisma.match.findMany({
    where: { seasonId: season.id },
    orderBy: [{ week: "asc" }, { id: "asc" }],
  });
  return { season, home, away, matches: withTimes };
}

// ---------------------------------------------------------------------------
// These claims are DETERMINISTIC to test — the guard's predicate scopes a bulk
// write, so removing it visibly touches rows it should not have. No race
// needed, which makes them the cheapest gaps in the mutation baseline to close.
// ---------------------------------------------------------------------------

describe("admin schedule writes only touch the rows they claim to", () => {
  it("setWeekNight leaves a COMPLETED match on the night it was played", async () => {
    const { matches } = await seasonWithMatches();
    const week = matches[0].week;
    const inWeek = matches.filter((m) => m.week === week);
    expect(inWeek.length).toBeGreaterThan(1); // one to move, one already played

    // One of them has already been played.
    await recordMatchDirect(inWeek[0].id, 2, 0);
    const played = await prisma.match.findUniqueOrThrow({
      where: { id: inWeek[0].id },
    });
    expect(played.status).toBe(MATCH_STATUS.COMPLETED);
    const playedAt = played.scheduledAt;

    const night = new Date(Date.now() + 7 * 864e5);
    const out = await setWeekNight(
      { message: "" },
      fd({
        week: String(week),
        night: night.toISOString(),
        nightTs: String(night.getTime()),
      }),
    );
    // Assert the action SUCCEEDED. Without this the test passes when the form
    // is rejected outright — which is exactly what happened while the field
    // names were wrong, and the assertion below still held vacuously.
    expect(out).not.toHaveProperty("error");

    // The played match keeps its night; moving it would drag a finished series
    // out of its own auto-sync window and wipe the RSVPs that answered for it.
    const after = await prisma.match.findUniqueOrThrow({
      where: { id: inWeek[0].id },
    });
    expect(after.scheduledAt?.getTime()).toBe(playedAt?.getTime());
    // Positive control: the UNPLAYED match in the same week really did move,
    // so the assertion above is about the guard and not about a no-op.
    const moved = await prisma.match.findUniqueOrThrow({
      where: { id: inWeek[1].id },
    });
    expect(moved.scheduledAt?.getTime()).toBe(night.getTime());
  });

  it("setWeekNight cancels only the OPEN proposal, not a settled one", async () => {
    const { matches } = await seasonWithMatches();
    const target = matches[0];
    const { proposer, responder } = await captainsOf(target.id);

    // A settled (DECLINED) proposal, then a fresh open one.
    await proposeReschedule(proposer, target.id, new Date(Date.now() + 864e5));
    const settled = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { matchId: target.id, status: "PENDING" },
    });
    await respondReschedule(responder, settled.id, false);
    await proposeReschedule(proposer, target.id, new Date(Date.now() + 2 * 864e5));

    const night = new Date(Date.now() + 5 * 864e5);
    await setWeekNight(
      { message: "" },
      fd({
        week: String(target.week),
        night: night.toISOString(),
        nightTs: String(night.getTime()),
      }),
    );

    // The retime kills the live ask; the answered one stays answered, or the
    // audit trail stops recording that the opponent ever said no.
    expect(
      (await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: settled.id } }))
        .status,
    ).toBe("DECLINED");
    expect(
      await prisma.rescheduleRequest.count({
        where: { matchId: target.id, status: "PENDING" },
      }),
    ).toBe(0);
  });

  it("setMatchTime cancels only the OPEN proposal, not a settled one", async () => {
    const { matches } = await seasonWithMatches();
    const target = matches[0];
    const { proposer, responder } = await captainsOf(target.id);

    await proposeReschedule(proposer, target.id, new Date(Date.now() + 864e5));
    const settled = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { matchId: target.id, status: "PENDING" },
    });
    await respondReschedule(responder, settled.id, false);
    await proposeReschedule(proposer, target.id, new Date(Date.now() + 2 * 864e5));

    const when = new Date(Date.now() + 6 * 864e5);
    await setMatchTime(
      {},
      fd({
        matchId: target.id,
        scheduledAt: when.toISOString(),
        scheduledAtTs: String(when.getTime()),
      }),
    );

    expect(
      (await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: settled.id } }))
        .status,
    ).toBe("DECLINED");
  });
});

describe("recordResult won't stamp over a result that landed while it was typed", () => {
  afterEach(() => setRaceHook(null));

  it("refuses the typed score when an import lands mid-call", async () => {
    // Previously left uncovered: the CAS guards the import-lands-FIRST
    // ordering, and racing real calls reliably produced the opposite one. The
    // seam stages it exactly — recordResult reads the match, the import
    // commits, then the swap runs. recordResult is not transactional, so
    // nothing is locked and the rival cannot block.
    const { matches } = await seasonWithMatches();
    const target = matches[0];
    // LIVE at 1-1 so the rival can change the SCORES without touching status —
    // the case the source comment exists for: "a bracket can advance in the
    // gap without this row's status ever changing".
    await prisma.match.update({
      where: { id: target.id },
      data: {
        bestOf: 3,
        status: MATCH_STATUS.LIVE,
        homeScore: 1,
        awayScore: 1,
      },
    });

    let fired = false;
    setRaceHook(
      onceAt("recordResult.beforeSwap", async () => {
        fired = true;
        await prisma.match.update({
          where: { id: target.id },
          data: { homeScore: 1, awayScore: 2, status: MATCH_STATUS.LIVE },
        });
      }),
    );

    const out = await recordResult(
      { message: "" },
      fd({ matchId: target.id, homeScore: "2", awayScore: "1" }),
    );

    expect(fired).toBe(true);
    expect(out).toMatchObject({
      error: expect.stringContaining("a game was imported while you were typing"),
    });
    expect(out).not.toHaveProperty("message");

    const after = await prisma.match.findUniqueOrThrow({
      where: { id: target.id },
    });
    // The import's score stands, and the stale ruling never completed it.
    expect([after.homeScore, after.awayScore]).toEqual([1, 2]);
    expect(after.status).toBe(MATCH_STATUS.LIVE);
  });
});

// Reopening a match is the admin's undo for a manual score — and it is pressed
// on exactly the matches auto-sync is scanning, from any page view in the
// league. The two preconditions it checks (still COMPLETED, no games) are read
// several statements and one admin decision before the write lands.
describe("reopenMatch — the games check is the WHERE, not a read-time if", () => {
  async function completedMatch() {
    const { matches } = await seasonWithMatches();
    const target = matches[0];
    await prisma.match.update({
      where: { id: target.id },
      data: {
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 1,
        winnerTeamId: target.homeTeamId,
      },
    });
    return target;
  }

  it("reopens a manually-scored match with no games", async () => {
    // The path this action exists for — and the reason the claim can't simply
    // refuse everything: an admin fat-fingers a score and needs it back.
    const target = await completedMatch();

    const res = await reopenMatch({ message: "" }, fd({ matchId: target.id }));

    expect(res?.error).toBeUndefined();
    const after = await prisma.match.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(after.status).toBe(MATCH_STATUS.SCHEDULED);
    expect([after.homeScore, after.awayScore]).toEqual([0, 0]);
    expect(after.winnerTeamId).toBeNull();
    // The empty-scan backoff is cleared too, or auto-sync would ignore the
    // match it was just told to look at again.
    expect(after.autoSyncedAt).toBeNull();
    expect(after.autoSyncAttempts).toBe(0);
  });

  it("refuses — and changes NOTHING — when a game has landed", async () => {
    // The race, made deterministic: an auto-sync import committing between the
    // read and the write is indistinguishable from a game that was already
    // there, because the guard is in the WHERE either way. A blind
    // `update({ where: { id } })` instead leaves the match SCHEDULED at 0-0
    // with a Game row attached — and nothing repairs that: importGameForMatch
    // dedupes on the unique dotaMatchId so the game is never re-imported,
    // recomputeSeries never runs again, and the result is simply gone from the
    // standings with no error anywhere.
    const target = await completedMatch();
    await prisma.game.create({
      data: {
        matchId: target.id,
        dotaMatchId: "7777777777",
        radiantWin: true,
        winnerTeamId: target.homeTeamId,
        players: "[]",
      },
    });

    const res = await reopenMatch({ message: "" }, fd({ matchId: target.id }));

    expect(res?.error).toMatch(/imported games/i);
    const after = await prisma.match.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(after.status).toBe(MATCH_STATUS.COMPLETED);
    expect([after.homeScore, after.awayScore]).toEqual([2, 1]);
    expect(after.winnerTeamId).toBe(target.homeTeamId);
  });

  it("refuses a match that is no longer final, and says which", async () => {
    // The other predicate in the same WHERE. Zero rows has two causes and an
    // admin can act on neither unless we say which one it was.
    const target = await completedMatch();
    await prisma.match.update({
      where: { id: target.id },
      data: { status: MATCH_STATUS.LIVE },
    });

    const res = await reopenMatch({ message: "" }, fd({ matchId: target.id }));

    expect(res?.error).toMatch(/isn't marked final/i);
    expect(
      (await prisma.match.findUniqueOrThrow({ where: { id: target.id } })).status,
    ).toBe(MATCH_STATUS.LIVE);
  });

  it("is idempotent under a double submit", async () => {
    // Two clicks, or a click and a retry: the second must land on nothing
    // rather than re-zeroing a match someone has since re-scored.
    const target = await completedMatch();
    const [first, second] = await raceAll<ActionResult>([
      () => reopenMatch({ message: "" }, fd({ matchId: target.id })),
      () => reopenMatch({ message: "" }, fd({ matchId: target.id })),
    ]);
    const wins = [first, second].filter((r) => !r?.error).length;
    expect(wins).toBe(1);
    expect(
      (await prisma.match.findUniqueOrThrow({ where: { id: target.id } })).status,
    ).toBe(MATCH_STATUS.SCHEDULED);
  });
});

describe("a manual score and a concurrent import stay self-consistent", () => {
  it("never leaves the stored score and winner disagreeing", async () => {
    // HONEST SCOPE: this does NOT cover recordResult's compare-and-swap. The
    // CAS guards the import-lands-first ordering, and in this harness the
    // import reliably commits AFTER recordResult, which is a legitimate
    // supersede rather than the bug. Forcing the other ordering needs an
    // interleaving no deterministic test can stage, so that claim is left
    // unprotected on purpose rather than covered by an assertion that passes
    // either way. What IS worth pinning is that whoever wins, the row is never
    // internally contradictory — a match page reading 2-1 HOME while the
    // recorded winner is AWAY.
    for (let run = 0; run < 6; run++) {
      const { matches } = await seasonWithMatches();
      const target = matches[0];
      await prisma.match.update({ where: { id: target.id }, data: { bestOf: 3 } });

      await raceAll<unknown>([
        () =>
          recordResult(
            { message: "" },
            fd({ matchId: target.id, homeScore: "2", awayScore: "1" }),
          ),
        () => recordMatchDirect(target.id, 0, 2),
      ]);

      const after = await prisma.match.findUniqueOrThrow({
        where: { id: target.id },
      });
      if (after.homeScore != null && after.awayScore != null) {
        const expected =
          after.homeScore > after.awayScore
            ? target.homeTeamId
            : after.awayScore > after.homeScore
              ? target.awayTeamId
              : null;
        expect(after.winnerTeamId).toBe(expected);
      }
    }
  });
});

describe("setWeekNight releases the reminder marker for EVERY retimed week", () => {
  // The cascade retimes LATER weeks too (and wipes their RSVPs/proposals),
  // but only the moved week's weekReminder marker was released — a cascaded
  // week whose reminder had already fired kept a stale marker, so it never
  // re-announced with its new kickoff.
  it("cascade on: both the moved and the shifted week's markers are released", async () => {
    const { season, matches } = await seasonWithMatches();
    const weeks = [...new Set(matches.map((m) => m.week))].sort((a, b) => a - b);
    expect(weeks.length).toBeGreaterThan(1);
    const [w1, w2] = weeks;
    await prisma.setting.createMany({
      data: [
        { key: `weekReminder:${season.id}:${w1}`, value: "sent" },
        { key: `weekReminder:${season.id}:${w2}`, value: "sent" },
      ],
    });

    const night = new Date(Date.now() + 3 * 864e5);
    const out = await setWeekNight(
      { message: "" },
      fd({
        week: String(w1),
        night: night.toISOString(),
        nightTs: String(night.getTime()),
        cascade: "on",
      }),
    );
    expect(out).not.toHaveProperty("error");

    expect(
      await prisma.setting.findUnique({
        where: { key: `weekReminder:${season.id}:${w1}` },
      }),
    ).toBeNull();
    expect(
      await prisma.setting.findUnique({
        where: { key: `weekReminder:${season.id}:${w2}` },
      }),
    ).toBeNull();
  });

  it("cascade off: only the moved week's marker is released", async () => {
    const { season, matches } = await seasonWithMatches();
    const weeks = [...new Set(matches.map((m) => m.week))].sort((a, b) => a - b);
    const [w1, w2] = weeks;
    await prisma.setting.createMany({
      data: [
        { key: `weekReminder:${season.id}:${w1}`, value: "sent" },
        { key: `weekReminder:${season.id}:${w2}`, value: "sent" },
      ],
    });

    const night = new Date(Date.now() + 3 * 864e5);
    const out = await setWeekNight(
      { message: "" },
      fd({
        week: String(w1),
        night: night.toISOString(),
        nightTs: String(night.getTime()),
      }),
    );
    expect(out).not.toHaveProperty("error");

    expect(
      await prisma.setting.findUnique({
        where: { key: `weekReminder:${season.id}:${w1}` },
      }),
    ).toBeNull();
    // The untouched week keeps its marker — releasing it would re-announce a
    // week whose kickoff never moved.
    expect(
      await prisma.setting.findUnique({
        where: { key: `weekReminder:${season.id}:${w2}` },
      }),
    ).not.toBeNull();
  });
});
