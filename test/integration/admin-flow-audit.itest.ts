/**
 * The 2026-07-28 admin-flow audit fixes.
 *
 * Every claim below came back from that audit with `existingCoverage: NONE` —
 * the engines in this repo are heavily tested, the ADMIN ACTIONS that call them
 * were not, and that is exactly where the defects were. Each test names the
 * damage the guard prevents, because "an admin clicked the button the panel
 * offered and the league quietly broke" is the shape all six shared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  // logAdminAction resolves the actor itself; an undefined mock throws inside
  // its try/catch and silently skips the rows the forfeit test asserts on.
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import {
  assignStandin,
  generateSchedule,
  removeCaptain,
  removeGame,
  renameTeam,
  releasePlayer,
  reopenMatch,
  signFreeAgent,
  setLeagueId,
  setMatchTime,
  setWeekNight,
  recordResult,
  reinstateSignup,
  setSeasonPhase,
  startDraft,
  withdrawSignup,
} from "@/app/actions/admin";
import { nominatePlayer } from "@/lib/draft-service";
import { advancePlayoffBracket } from "@/lib/playoff-service";
import { sendDiscordMessage } from "@/lib/discord";
import { getWebhookUrl } from "@/lib/discord";
import { updateTag } from "next/cache";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { recomputeSeries } from "@/lib/match-import";
import { loadImportSkips } from "@/lib/match-import";
import {
  getSetting,
  honorsAnnouncedKey,
  setSetting,
  SETTING_KEYS,
} from "@/lib/settings";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import {
  addGameToMatch,
  generateRegularSchedule,
  makeCaptain,
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
  ON_POSTGRES,
  raceN,
  recordMatch,
  resetDb,
  sessionFor,
  startDraftState,
} from "./factories";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};
const empty: ActionResult = {};

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  setRaceHook(null);
});

/** A season with 4 teams and a generated round robin. */
async function seasonWithSchedule(
  status: string = SEASON_STATUS.REGULAR_SEASON,
) {
  const season = await makeSeason({ status });
  for (let i = 0; i < 4; i++) {
    await makeTeam(season.id, `Team ${i + 1}`, i + 1);
  }
  if (status === SEASON_STATUS.DRAFT) {
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
  }
  const matches = await generateRegularSchedule(season.id);
  return { season, matches };
}

describe("renameTeam — cached record matchups", () => {
  it("expires the shared games tag after the guarded rename commits", async () => {
    const { season, matches } = await seasonWithSchedule();
    vi.mocked(updateTag).mockClear();

    const res = await renameTeam(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        teamId: matches[0].homeTeamId,
        name: "Renamed Radiants",
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(
      await prisma.team.findUniqueOrThrow({
        where: { id: matches[0].homeTeamId },
      }),
    ).toMatchObject({ name: "Renamed Radiants" });
    expect(vi.mocked(updateTag)).toHaveBeenCalledWith("games");
  });
});

describe("removeGame — the removal must survive automatic re-import", () => {
  // The defect: both importers decide "already recorded" from the Game rows
  // themselves, so deleting the row made the game a fresh candidate again and
  // the next /api/sync ping (from any page view, the admin's own tab included)
  // re-imported it inside a minute. Silently — the removal had toasted success.
  it("remembers the removed dotaMatchId so auto-sync will not re-add it", async () => {
    const { season, matches } = await seasonWithSchedule();
    const target = matches[0];
    const game = await addGameToMatch(target.id, "777001", target.homeTeamId);
    const honorsMarker = honorsAnnouncedKey(season.id, target.week);
    await setSetting(honorsMarker, "sent:old-award");

    const res = await removeGame(empty, fd({ gameId: game.id }));

    expect(res?.error).toBeUndefined();
    expect(await prisma.game.findUnique({ where: { id: game.id } })).toBeNull();
    const skips = await loadImportSkips(season.id);
    expect(skips.has("777001")).toBe(true);
    expect(await getSetting(honorsMarker)).toMatch(/^stale:/);
  });

  it("does not reopen Fantasy when the last legacy game is removed", async () => {
    const { season, matches } = await seasonWithSchedule();
    const game = await addGameToMatch(
      matches[0].id,
      "777001-fantasy-lock",
      matches[0].homeTeamId,
    );
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .fantasyLockedAt,
    ).toBeNull();

    const res = await removeGame(empty, fd({ gameId: game.id }));

    expect(res?.error).toBeUndefined();
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .fantasyLockedAt,
    ).toBeInstanceOf(Date);
    expect(
      await prisma.game.count({ where: { match: { seasonId: season.id } } }),
    ).toBe(0);
  });

  it("says so in the toast — silence is what made this invisible", async () => {
    const { matches } = await seasonWithSchedule();
    const game = await addGameToMatch(
      matches[0].id,
      "777002",
      matches[0].homeTeamId,
    );
    const res = await removeGame(empty, fd({ gameId: game.id }));
    expect(res?.message).toMatch(/re-import/i);
  });

  it("keeps the committed removal visible and reports a failed post-commit effect honestly", async () => {
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await addGameToMatch(target.id, "777002-home-a", target.homeTeamId);
    await addGameToMatch(target.id, "777002-home-b", target.homeTeamId);
    const losingGame = await addGameToMatch(
      target.id,
      "777002-away",
      target.awayTeamId,
    );
    await prisma.match.update({
      where: { id: target.id },
      data: {
        bestOf: 3,
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 1,
        winnerTeamId: target.homeTeamId,
      },
    });
    vi.mocked(getWebhookUrl).mockResolvedValue("https://discord.invalid/hook");
    vi.mocked(sendDiscordMessage).mockRejectedValueOnce(
      new Error("Discord unavailable"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await removeGame(empty, fd({ gameId: losingGame.id }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/removal is saved/i);
    expect(res?.message).toMatch(/result announcement/i);
    expect(
      await prisma.game.findUnique({ where: { id: losingGame.id } }),
    ).toBeNull();
    expect(vi.mocked(updateTag)).toHaveBeenCalledWith("games");
  });

  it("keeps the memory per-season and bounded, not per-match", async () => {
    const { season, matches } = await seasonWithSchedule();
    const a = await addGameToMatch(
      matches[0].id,
      "777003",
      matches[0].homeTeamId,
    );
    const b = await addGameToMatch(
      matches[1].id,
      "777004",
      matches[1].homeTeamId,
    );
    await removeGame(empty, fd({ gameId: a.id }));
    await removeGame(empty, fd({ gameId: b.id }));
    const skips = await loadImportSkips(season.id);
    expect([...skips].sort()).toEqual(["777003", "777004"]);
  });

  it("tolerates corrupt skip memory rather than failing the removal", async () => {
    const { season, matches } = await seasonWithSchedule();
    await setSetting(`importSkip:${season.id}`, "{not json");
    const game = await addGameToMatch(
      matches[0].id,
      "777005",
      matches[0].homeTeamId,
    );
    const res = await removeGame(empty, fd({ gameId: game.id }));
    expect(res?.error).toBeUndefined();
    expect(await loadImportSkips(season.id)).toEqual(new Set(["777005"]));
  });

  it("deletes the game, recomputes the series, clears the ruling, and bumps the cursor together", async () => {
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await prisma.match.update({
      where: { id: target.id },
      data: {
        bestOf: 3,
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 0,
        winnerTeamId: target.homeTeamId,
        forfeit: true,
      },
    });
    const removed = await addGameToMatch(
      target.id,
      "777006",
      target.homeTeamId,
    );
    const remaining = await addGameToMatch(
      target.id,
      "777007",
      target.homeTeamId,
    );
    const oldCursor = "1999-01-01T00:00:00.000Z";
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, oldCursor);

    const res = await removeGame(empty, fd({ gameId: removed.id }));

    expect(res?.error).toBeUndefined();
    const snapshot = await prisma.$transaction(async (tx) => ({
      removed: await tx.game.findUnique({ where: { id: removed.id } }),
      remaining: await tx.game.findUnique({ where: { id: remaining.id } }),
      match: await tx.match.findUniqueOrThrow({ where: { id: target.id } }),
      cursor: await tx.setting.findUnique({
        where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
      }),
    }));
    expect(snapshot.removed).toBeNull();
    expect(snapshot.remaining).not.toBeNull();
    expect(snapshot.match).toMatchObject({
      homeScore: 1,
      awayScore: 0,
      winnerTeamId: null,
      status: MATCH_STATUS.LIVE,
      forfeit: false,
    });
    expect(snapshot.cursor?.value).not.toBe(oldCursor);
    expect(Date.parse(snapshot.cursor?.value ?? "")).toBeGreaterThan(
      Date.parse(oldCursor),
    );
  });

  it.each([
    ["an archived season", { isActive: false }],
    [
      "a regular fixture after Playoffs starts",
      { status: SEASON_STATUS.PLAYOFFS },
    ],
  ])("refuses to correct %s", async (_label, seasonChange) => {
    const { season, matches } = await seasonWithSchedule();
    const target = matches[0];
    await prisma.match.update({
      where: { id: target.id },
      data: {
        bestOf: 3,
        status: MATCH_STATUS.LIVE,
        homeScore: 1,
        awayScore: 0,
      },
    });
    const game = await addGameToMatch(
      target.id,
      `777-blocked-${"isActive" in seasonChange ? "archive" : "phase"}`,
      target.homeTeamId,
    );
    const oldCursor = "1999-01-01T00:00:00.000Z";
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, oldCursor);
    await prisma.season.update({
      where: { id: season.id },
      data: seasonChange,
    });

    const res = await removeGame(empty, fd({ gameId: game.id }));

    expect(res?.error).toMatch(/active Regular season phase/i);
    expect(
      await prisma.game.findUnique({ where: { id: game.id } }),
    ).not.toBeNull();
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: target.id } }),
    ).toMatchObject({
      homeScore: 1,
      awayScore: 0,
      winnerTeamId: null,
      status: MATCH_STATUS.LIVE,
      forfeit: false,
    });
    expect(await getSetting(SETTING_KEYS.RESULT_CHANGED_AT)).toBe(oldCursor);
    expect(await loadImportSkips(season.id)).toEqual(new Set());
  });
});

describe("reopenMatch — the retraction is one guarded command", () => {
  const oldCursor = "1999-01-01T00:00:00.000Z";

  async function manuallyFinalMatch() {
    const { season, matches } = await seasonWithSchedule();
    const target = matches[0];
    const autoSyncedAt = new Date("2026-07-31T03:00:00.000Z");
    const markerKey = `resultAnnounced:${target.id}`;
    const markerValue = "2026-07-31T03:01:00.000Z";
    await prisma.match.update({
      where: { id: target.id },
      data: {
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 0,
        winnerTeamId: target.homeTeamId,
        forfeit: true,
        autoSyncedAt,
        autoSyncAttempts: 4,
      },
    });
    await setSetting(markerKey, markerValue);
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, oldCursor);
    return {
      season,
      matches,
      target,
      markerKey,
      markerValue,
      autoSyncedAt,
    };
  }

  async function coordinationSnapshot(matchId: string, markerKey: string) {
    return prisma.$transaction(async (tx) => ({
      match: await tx.match.findUniqueOrThrow({ where: { id: matchId } }),
      marker: await tx.setting.findUnique({ where: { key: markerKey } }),
      cursor: await tx.setting.findUnique({
        where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
      }),
    }));
  }

  it("resets the match, releases its announcement, and advances freshness together", async () => {
    const { season, target, markerKey } = await manuallyFinalMatch();
    const honorsMarker = honorsAnnouncedKey(season.id, target.week);
    await setSetting(honorsMarker, "sent:old-award");

    const res = await reopenMatch(
      empty,
      fd({ matchId: target.id, expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toBeUndefined();
    const snapshot = await coordinationSnapshot(target.id, markerKey);
    expect(snapshot.match).toMatchObject({
      status: MATCH_STATUS.SCHEDULED,
      homeScore: 0,
      awayScore: 0,
      winnerTeamId: null,
      forfeit: false,
      autoSyncedAt: null,
      autoSyncAttempts: 0,
    });
    expect(snapshot.marker).toBeNull();
    expect(await getSetting(honorsMarker)).toMatch(/^stale:/);
    expect(snapshot.cursor?.value).not.toBe(oldCursor);
    expect(Date.parse(snapshot.cursor?.value ?? "")).toBeGreaterThan(
      Date.parse(oldCursor),
    );
  });

  it("leaves the match, announcement marker, and cursor untouched when a game exists", async () => {
    const { season, target, markerKey, markerValue, autoSyncedAt } =
      await manuallyFinalMatch();
    await addGameToMatch(target.id, "reopen-command-game", target.homeTeamId);

    const res = await reopenMatch(
      empty,
      fd({ matchId: target.id, expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toMatch(/imported games/i);
    const snapshot = await coordinationSnapshot(target.id, markerKey);
    expect(snapshot.match).toMatchObject({
      status: MATCH_STATUS.COMPLETED,
      homeScore: 2,
      awayScore: 0,
      winnerTeamId: target.homeTeamId,
      forfeit: true,
      autoSyncedAt,
      autoSyncAttempts: 4,
    });
    expect(snapshot.marker?.value).toBe(markerValue);
    expect(snapshot.cursor?.value).toBe(oldCursor);
  });

  it.each([
    [
      "an archived regular season",
      { isActive: false },
      MATCH_PHASE.REGULAR,
      /archived season/i,
    ],
    [
      "a regular match after playoffs start",
      { status: SEASON_STATUS.PLAYOFFS },
      MATCH_PHASE.REGULAR,
      /active Regular season phase/i,
    ],
    [
      "a playoff match while the season is still regular",
      { status: SEASON_STATUS.REGULAR_SEASON },
      MATCH_PHASE.PLAYOFF,
      /active season is in Playoffs/i,
    ],
    [
      "a playoff match after a manual Complete close-out",
      { status: SEASON_STATUS.COMPLETE },
      MATCH_PHASE.PLAYOFF,
      /marked Complete.*Move it back to Playoffs/i,
    ],
  ])(
    "refuses %s without releasing its coordination state",
    async (_label, seasonData, phase, error) => {
      const { season, target, markerKey, markerValue } =
        await manuallyFinalMatch();
      await prisma.season.update({
        where: { id: season.id },
        data: seasonData,
      });
      await prisma.match.update({
        where: { id: target.id },
        data: {
          phase,
          bracketSlot: phase === MATCH_PHASE.REGULAR ? null : "R0M0",
        },
      });

      const res = await reopenMatch(
        empty,
        fd({ matchId: target.id, expectedActiveSeasonId: season.id }),
      );

      expect(res?.error).toMatch(error);
      const snapshot = await coordinationSnapshot(target.id, markerKey);
      expect(snapshot.match).toMatchObject({
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 0,
        winnerTeamId: target.homeTeamId,
        forfeit: true,
      });
      expect(snapshot.marker?.value).toBe(markerValue);
      expect(snapshot.cursor?.value).toBe(oldCursor);
    },
  );

  it("atomically un-crowns and reopens the authoritative grand final", async () => {
    const { season, target, markerKey } = await manuallyFinalMatch();
    await prisma.season.update({
      where: { id: season.id },
      data: {
        status: SEASON_STATUS.COMPLETE,
        championTeamId: target.homeTeamId,
      },
    });
    await prisma.match.update({
      where: { id: target.id },
      data: { phase: MATCH_PHASE.FINAL, bracketSlot: "R1M0" },
    });

    const res = await reopenMatch(
      empty,
      fd({ matchId: target.id, expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toBeUndefined();
    const snapshot = await coordinationSnapshot(target.id, markerKey);
    expect(snapshot.match.status).toBe(MATCH_STATUS.SCHEDULED);
    expect(snapshot.marker).toBeNull();
    expect(snapshot.cursor?.value).not.toBe(oldCursor);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.PLAYOFFS,
      championTeamId: null,
    });
  });

  it("refuses a stale result form whose expected active season differs", async () => {
    const { target, markerKey, markerValue } = await manuallyFinalMatch();
    const staleSeason = await makeSeason({ isActive: false });

    const res = await reopenMatch(
      empty,
      fd({ matchId: target.id, expectedActiveSeasonId: staleSeason.id }),
    );

    expect(res?.error).toMatch(/active season changed/i);
    const snapshot = await coordinationSnapshot(target.id, markerKey);
    expect(snapshot.match.status).toBe(MATCH_STATUS.COMPLETED);
    expect(snapshot.marker?.value).toBe(markerValue);
    expect(snapshot.cursor?.value).toBe(oldCursor);
  });

  it("refuses a playoff source after a later bracket round exists", async () => {
    const { season, matches, target, markerKey, markerValue } =
      await manuallyFinalMatch();
    const descendant = matches.find((match) => match.id !== target.id)!;
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.PLAYOFFS },
    });
    await prisma.match.update({
      where: { id: target.id },
      data: { phase: MATCH_PHASE.PLAYOFF, bracketSlot: "R0M0" },
    });
    await prisma.match.update({
      where: { id: descendant.id },
      data: { phase: MATCH_PHASE.FINAL, bracketSlot: "R1M0" },
    });

    const res = await reopenMatch(
      empty,
      fd({ matchId: target.id, expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toMatch(/already advanced the bracket/i);
    const snapshot = await coordinationSnapshot(target.id, markerKey);
    expect(snapshot.match.status).toBe(MATCH_STATUS.COMPLETED);
    expect(snapshot.marker?.value).toBe(markerValue);
    expect(snapshot.cursor?.value).toBe(oldCursor);
    expect(
      await prisma.match.findUnique({ where: { id: descendant.id } }),
    ).toMatchObject({ phase: MATCH_PHASE.FINAL, bracketSlot: "R1M0" });
  });

  it("maps a Serializable conflict to reload-and-retry guidance", async () => {
    const { season, target, markerKey, markerValue } =
      await manuallyFinalMatch();
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      Object.assign(new Error("write conflict"), { code: "P2034" }),
    );

    const res = await reopenMatch(
      empty,
      fd({ matchId: target.id, expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toMatch(/changed.*reload and try again/i);
    expect(res).not.toHaveProperty("message");
    const snapshot = await coordinationSnapshot(target.id, markerKey);
    expect(snapshot.match.status).toBe(MATCH_STATUS.COMPLETED);
    expect(snapshot.marker?.value).toBe(markerValue);
    expect(snapshot.cursor?.value).toBe(oldCursor);
  });

  it.skipIf(!ON_POSTGRES)(
    "loses cleanly when real bracket advancement builds a descendant mid-reopen",
    async () => {
      const { season, matches } = await seasonWithSchedule();
      const roundZero = matches
        .filter((match) => match.week === matches[0].week)
        .slice(0, 2);
      expect(roundZero).toHaveLength(2);
      await prisma.season.update({
        where: { id: season.id },
        data: { status: SEASON_STATUS.PLAYOFFS },
      });
      for (const [index, match] of roundZero.entries()) {
        await prisma.match.update({
          where: { id: match.id },
          data: {
            phase: MATCH_PHASE.PLAYOFF,
            bracketSlot: `R0M${index}`,
            bestOf: 1,
            status: MATCH_STATUS.COMPLETED,
            homeScore: 1,
            awayScore: 0,
            winnerTeamId: match.homeTeamId,
          },
        });
      }

      let advanced = false;
      setRaceHook(
        onceAt("admin.reopenMatch.beforeWrite", async () => {
          await advancePlayoffBracket(season.id);
          advanced = true;
        }),
      );

      const res = await reopenMatch(
        empty,
        fd({
          matchId: roundZero[0].id,
          expectedActiveSeasonId: season.id,
        }),
      );

      expect(advanced).toBe(true);
      expect(res?.error).toMatch(/changed.*reload and try again/i);
      expect(
        await prisma.match.findUniqueOrThrow({
          where: { id: roundZero[0].id },
        }),
      ).toMatchObject({
        status: MATCH_STATUS.COMPLETED,
        homeScore: 1,
        winnerTeamId: roundZero[0].homeTeamId,
      });
      expect(
        await prisma.match.count({
          where: { seasonId: season.id, bracketSlot: "R1M0" },
        }),
      ).toBe(1);
    },
  );
});

describe("removeCaptain — the season-wide match delete needs a results guard", () => {
  // The delete is `deleteMany({ where: { seasonId } })` — the WHOLE season. Its
  // only lock was Draft.status !== NOT_STARTED, and a NULL Draft row passes.
  // Legacy seasons may have reached REGULAR_SEASON without pressing Start
  // draft; the current transition policy blocks that new jump, but this action
  // still has to defend old and repaired data.
  it("refuses once a result is recorded, instead of erasing the schedule", async () => {
    const { season, matches } = await seasonWithSchedule(SEASON_STATUS.SIGNUPS);
    await recordMatch(matches[0].id, 2, 0);
    const doomed = await prisma.team.findFirstOrThrow({
      where: { seasonId: season.id },
    });

    const res = await removeCaptain(
      empty,
      fd({ teamId: doomed.id, expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toMatch(/result landed/i);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      matches.length,
    );
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(4);
  });

  it("refuses on an imported GAME too, not just a decided series", async () => {
    // Opening night is routinely "one series LIVE at 1-0" — counting only
    // COMPLETED matches left exactly that window open.
    const { season, matches } = await seasonWithSchedule(SEASON_STATUS.SIGNUPS);
    await addGameToMatch(matches[0].id, "778001", matches[0].homeTeamId);
    const doomed = await prisma.team.findFirstOrThrow({
      where: { seasonId: season.id },
    });

    const res = await removeCaptain(
      empty,
      fd({ teamId: doomed.id, expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toMatch(/result landed/i);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      matches.length,
    );
  });

  it("still works on a clean pre-results season, clearing the fixtures", async () => {
    // The guard must not break the case it was always for: captains are still
    // being sorted out and the round robin has to be regenerated anyway.
    const { season, matches } = await seasonWithSchedule(SEASON_STATUS.SIGNUPS);
    expect(matches.length).toBeGreaterThan(0);
    const doomed = await prisma.team.findFirstOrThrow({
      where: { seasonId: season.id },
    });

    const res = await removeCaptain(
      empty,
      fd({ teamId: doomed.id, expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/schedule was cleared/i);
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(3);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      0,
    );
  });
});

describe("generateSchedule — the collateral must be named, not silent", () => {
  // The results counts protect games, but NOT the night-specific state hanging
  // off a fixture id. The regenerated fixtures are the same pairings with NEW
  // ids, so cover the captains already arranged is gone and nothing said so.
  it("reports the check-ins, picks, bookings and proposals it cleared", async () => {
    const { season, matches } = await seasonWithSchedule(SEASON_STATUS.DRAFT);
    const player = await makeUser("RSVP Player");
    await prisma.matchAvailability.create({
      data: { matchId: matches[0].id, userId: player.id, status: "IN" },
    });
    await prisma.prediction.create({
      data: {
        matchId: matches[0].id,
        userId: player.id,
        pickedTeamId: matches[0].homeTeamId,
      },
    });

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/1 check-in/);
    expect(res?.message).toMatch(/1 pick'em pick/);
    expect(
      await prisma.matchAvailability.count({
        where: { match: { seasonId: season.id } },
      }),
    ).toBe(0);
  });

  it("reads exactly as before on a first-ever generate (no zeros in the toast)", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    for (let i = 0; i < 4; i++) await makeTeam(season.id, `T${i}`, i + 1);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/Schedule generated/);
    expect(res?.message).not.toMatch(/clearing/);
    expect(res?.message).not.toMatch(/\b0 /);
  });

  it("refuses to expose a schedule while the auction is still live", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    for (let i = 0; i < 4; i++) await makeTeam(season.id, `Live${i}`, i + 1);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.IN_PROGRESS },
    });

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    if (!res) throw new Error("generateSchedule returned no action result");
    expect(res.error).toMatch(/finish the auction/i);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      0,
    );
  });

  it("releases the week reminder markers so they re-fire on the new slate", async () => {
    // The reminders quoted kickoffs for fixtures that no longer exist, and
    // Discord edits notify nobody.
    const { season } = await seasonWithSchedule(SEASON_STATUS.DRAFT);
    await setSetting(`weekReminder:${season.id}:1`, new Date().toISOString());

    await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    expect(await getSetting(`weekReminder:${season.id}:1`)).toBeNull();
  });

  it("refuses to generate around a withdrawn team instead of silently scheduling it", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    for (let i = 0; i < 4; i++) await makeTeam(season.id, `Active ${i}`, i + 1);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
    const withdrawn = await prisma.team.findFirstOrThrow({
      where: { seasonId: season.id },
    });
    await prisma.team.update({
      where: { id: withdrawn.id },
      data: { withdrawn: true },
    });

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toMatch(/reinstate/i);
    expect(res?.error).toContain(withdrawn.name);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      0,
    );
  });

  it("builds from the decisive team list and series length inside the transaction", async () => {
    const season = await makeSeason({
      status: SEASON_STATUS.DRAFT,
      regularBestOf: 2,
    });
    for (let i = 0; i < 4; i++)
      await makeTeam(season.id, `Original ${i}`, i + 1);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
    setRaceHook(
      onceAt("admin.generateSchedule.beforeTx", async () => {
        await makeTeam(season.id, "Late authoritative team", 5);
        await prisma.season.update({
          where: { id: season.id },
          data: { regularBestOf: 3 },
        });
      }),
    );

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toBeUndefined();
    const matches = await prisma.match.findMany({
      where: { seasonId: season.id },
    });
    expect(matches).toHaveLength(10);
    expect(matches.every((match) => match.bestOf === 3)).toBe(true);
  });
});

describe("schedule controls — stale season claims", () => {
  it("requires an active-season claim on every schedule mutation", async () => {
    const { matches } = await seasonWithSchedule();
    const when = new Date(Date.now() + 864e5);

    const generated = await generateSchedule(empty, fd({ firstNight: "" }));
    const week = await setWeekNight(
      empty,
      fd({
        week: String(matches[0].week),
        night: when.toISOString(),
        nightTs: String(when.getTime()),
      }),
    );
    const match = await setMatchTime(
      empty,
      fd({
        matchId: matches[0].id,
        scheduledAt: when.toISOString(),
        scheduledAtTs: String(when.getTime()),
      }),
    );

    expect(generated?.error).toMatch(/form is stale/i);
    expect(week?.error).toMatch(/form is stale/i);
    expect(match?.error).toMatch(/form is stale/i);
  });

  it("refuses generate, week move, and match retime forms from an archived tab", async () => {
    const { season, matches } = await seasonWithSchedule();
    const original = new Date(Date.now() + 864e5);
    await prisma.match.updateMany({
      where: { seasonId: season.id },
      data: { scheduledAt: original },
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    await makeSeason({
      name: "Replacement season",
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const moved = new Date(original.getTime() + 7 * 864e5);

    const generated = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );
    const week = await setWeekNight(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        week: String(matches[0].week),
        night: moved.toISOString(),
        nightTs: String(moved.getTime()),
      }),
    );
    const match = await setMatchTime(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        matchId: matches[0].id,
        scheduledAt: moved.toISOString(),
        scheduledAtTs: String(moved.getTime()),
      }),
    );

    expect(generated?.error).toMatch(/active season changed/i);
    expect(week?.error).toMatch(/active season changed/i);
    expect(match?.error).toMatch(/active season changed/i);
    expect(
      await prisma.match.count({
        where: { id: { in: matches.map((row) => row.id) } },
      }),
    ).toBe(matches.length);
    expect(
      (
        await prisma.match.findUniqueOrThrow({
          where: { id: matches[0].id },
        })
      ).scheduledAt?.getTime(),
    ).toBe(original.getTime());
  });

  it("maps serializable write conflicts to retry guidance", async () => {
    const { season, matches } = await seasonWithSchedule();
    const when = new Date(Date.now() + 864e5);
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    const transaction = vi.spyOn(prisma, "$transaction");

    transaction.mockRejectedValueOnce(conflict);
    const generated = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );
    transaction.mockRejectedValueOnce(conflict);
    const week = await setWeekNight(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        week: String(matches[0].week),
        night: when.toISOString(),
        nightTs: String(when.getTime()),
      }),
    );
    transaction.mockRejectedValueOnce(conflict);
    const match = await setMatchTime(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        matchId: matches[0].id,
        scheduledAt: when.toISOString(),
        scheduledAtTs: String(when.getTime()),
      }),
    );

    expect(generated?.error).toMatch(/reload and try again/i);
    expect(week?.error).toMatch(/reload and try again/i);
    expect(match?.error).toMatch(/reload and try again/i);
  });
});

describe("setMatchTime — a retime must report itself", () => {
  it("clears the week's reminder marker so Discord can re-announce", async () => {
    const { season, matches } = await seasonWithSchedule();
    const target = matches[0];
    await setSetting(
      `weekReminder:${season.id}:${target.week}`,
      new Date().toISOString(),
    );
    await setSetting(
      `weekReminder:${season.id}:${target.week}:kickoff-cluster`,
      new Date().toISOString(),
    );
    const otherWeekKey = `weekReminder:${season.id}:${target.week}0`;
    await setSetting(otherWeekKey, new Date().toISOString());
    const when = new Date(Date.now() + 6 * 864e5);

    const res = await setMatchTime(
      empty,
      fd({
        matchId: target.id,
        expectedActiveSeasonId: season.id,
        scheduledAt: when.toISOString(),
        scheduledAtTs: String(when.getTime()),
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(
      await getSetting(`weekReminder:${season.id}:${target.week}`),
    ).toBeNull();
    expect(
      await getSetting(
        `weekReminder:${season.id}:${target.week}:kickoff-cluster`,
      ),
    ).toBeNull();
    expect(await getSetting(otherWeekKey)).not.toBeNull();
  });

  it("names the check-ins it wiped", async () => {
    const { season, matches } = await seasonWithSchedule();
    const target = matches[0];
    for (const n of ["A", "B", "C"]) {
      const u = await makeUser(`Checkin ${n}`);
      await prisma.matchAvailability.create({
        data: { matchId: target.id, userId: u.id, status: "IN" },
      });
    }
    const captain = await prisma.team.findUniqueOrThrow({
      where: { id: target.homeTeamId },
      select: { captainId: true },
    });
    await prisma.rescheduleRequest.create({
      data: {
        matchId: target.id,
        proposedById: captain.captainId,
        proposedTime: new Date(Date.now() + 10 * 864e5),
      },
    });
    const when = new Date(Date.now() + 6 * 864e5);

    const res = await setMatchTime(
      empty,
      fd({
        matchId: target.id,
        expectedActiveSeasonId: season.id,
        scheduledAt: when.toISOString(),
        scheduledAtTs: String(when.getTime()),
      }),
    );

    expect(res?.message).toMatch(/3 check-in/);
    expect(res?.message).toMatch(/1 open reschedule proposal/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: target.id } }),
    ).toBe(0);
  });

  it("reports a cleared kickoff separately from a retime", async () => {
    const { season, matches } = await seasonWithSchedule();
    const target = matches[0];
    const before = new Date(Date.now() + 6 * 864e5);
    await prisma.match.update({
      where: { id: target.id },
      data: { scheduledAt: before },
    });

    const res = await setMatchTime(
      empty,
      fd({
        matchId: target.id,
        expectedActiveSeasonId: season.id,
        scheduledAt: "",
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/kickoff time cleared/i);
    expect(res?.message).toMatch(/now unscheduled/i);
    expect(res?.message).toMatch(/0 check-in/);
    expect(res?.message).toMatch(/0 open reschedule proposal/);
    expect(
      (await prisma.match.findUniqueOrThrow({ where: { id: target.id } }))
        .scheduledAt,
    ).toBeNull();
  });

  it("an unchanged resubmit wipes nothing and says nothing was changed", async () => {
    // The `changed` branch is the thing most likely to regress: a stray resubmit
    // must not cost the team its check-ins.
    const { season, matches } = await seasonWithSchedule();
    const target = matches[0];
    const when = new Date(Date.now() + 6 * 864e5);
    await prisma.match.update({
      where: { id: target.id },
      data: { scheduledAt: when },
    });
    const u = await makeUser("Steady");
    await prisma.matchAvailability.create({
      data: { matchId: target.id, userId: u.id, status: "IN" },
    });
    const captain = await prisma.team.findUniqueOrThrow({
      where: { id: target.homeTeamId },
      select: { captainId: true },
    });
    const proposal = await prisma.rescheduleRequest.create({
      data: {
        matchId: target.id,
        proposedById: captain.captainId,
        proposedTime: new Date(when.getTime() + 864e5),
      },
    });
    await setSetting(
      `weekReminder:${season.id}:${target.week}`,
      new Date().toISOString(),
    );

    const res = await setMatchTime(
      empty,
      fd({
        matchId: target.id,
        expectedActiveSeasonId: season.id,
        scheduledAt: when.toISOString(),
        scheduledAtTs: String(when.getTime()),
      }),
    );

    expect(res?.message).toMatch(/unchanged/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: target.id } }),
    ).toBe(1);
    expect(
      await getSetting(`weekReminder:${season.id}:${target.week}`),
    ).not.toBeNull();
    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: proposal.id },
        })
      ).status,
    ).toBe("PENDING");
  });

  it("refuses an unparseable time instead of silently leaving it alone", async () => {
    const { season, matches } = await seasonWithSchedule();
    const res = await setMatchTime(
      empty,
      fd({
        matchId: matches[0].id,
        expectedActiveSeasonId: season.id,
        scheduledAt: "not a date",
      }),
    );
    expect(res?.error).toMatch(/valid date/i);
  });

  it.each([MATCH_STATUS.LIVE, MATCH_STATUS.COMPLETED])(
    "refuses to retime a %s match and preserves its kickoff",
    async (status) => {
      const { season, matches } = await seasonWithSchedule();
      const target = matches[0];
      const before = new Date(Date.now() + 864e5);
      const after = new Date(before.getTime() + 864e5);
      await prisma.match.update({
        where: { id: target.id },
        data: { scheduledAt: before, status },
      });

      const res = await setMatchTime(
        empty,
        fd({
          matchId: target.id,
          expectedActiveSeasonId: season.id,
          scheduledAt: after.toISOString(),
          scheduledAtTs: String(after.getTime()),
        }),
      );

      expect(res?.error).toMatch(/only a scheduled match/i);
      expect(
        (
          await prisma.match.findUniqueOrThrow({ where: { id: target.id } })
        ).scheduledAt?.getTime(),
      ).toBe(before.getTime());
    },
  );

  it.each([SEASON_STATUS.SIGNUPS, SEASON_STATUS.COMPLETE])(
    "refuses kickoff edits while the season is %s",
    async (status) => {
      const { season, matches } = await seasonWithSchedule(status);
      const target = matches[0];
      const when = new Date(Date.now() + 864e5);

      const res = await setMatchTime(
        empty,
        fd({
          matchId: target.id,
          expectedActiveSeasonId: season.id,
          scheduledAt: when.toISOString(),
          scheduledAtTs: String(when.getTime()),
        }),
      );

      expect(res?.error).toMatch(/locked in this league phase/i);
      expect(
        (await prisma.match.findUniqueOrThrow({ where: { id: target.id } }))
          .scheduledAt,
      ).toBeNull();
    },
  );
});

describe("setLeagueId — a bogus id disables ALL result import", () => {
  it("refuses a pasted dota2.com URL rather than storing league '2'", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });

    const res = await setLeagueId(
      empty,
      fd({
        dotaLeagueId: "https://www.dota2.com/leagues/17119",
        expectedActiveSeasonId: season.id,
        expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
      }),
    );

    expect(res?.error).toBeUndefined();
    const after = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    expect(after.dotaLeagueId).toBe("17119");
  });

  it("leaves a working id alone when the new input is junk", async () => {
    const season = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const current = await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17119" },
    });

    const res = await setLeagueId(
      empty,
      fd({
        dotaLeagueId: "dota2.com",
        expectedActiveSeasonId: current.id,
        expectedSeasonUpdatedAt: current.updatedAt.toISOString(),
      }),
    );

    expect(res?.error).toMatch(/doesn't look like a league id/i);
    const after = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    expect(after.dotaLeagueId).toBe("17119");
  });

  it("treats an empty submit as an explicit clear", async () => {
    const season = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const current = await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17119" },
    });

    const res = await setLeagueId(
      empty,
      fd({
        dotaLeagueId: "  ",
        expectedActiveSeasonId: current.id,
        expectedSeasonUpdatedAt: current.updatedAt.toISOString(),
      }),
    );

    expect(res?.message).toMatch(/cleared/i);
    const after = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    expect(after.dotaLeagueId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The minor items from the same audit. Same theme: each was a control or a
// message that told the admin something untrue, or an effect nothing reported.
// ---------------------------------------------------------------------------

describe("resultAnnounced marker — a corrected result must be able to announce", () => {
  // announceSeriesResultOnce is idempotent through this marker, and the
  // result-sync retry sweep only re-claims values starting with "failed:" — so
  // once a wrong score reached Discord, NOTHING could ever correct the channel.
  it("reopenMatch releases the marker", async () => {
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await recordMatch(target.id, 2, 0);
    await setSetting(`resultAnnounced:${target.id}`, new Date().toISOString());

    const res = await reopenMatch(empty, fd({ matchId: target.id }));

    expect(res?.error).toBeUndefined();
    expect(await getSetting(`resultAnnounced:${target.id}`)).toBeNull();
  });

  it("removeGame releases it via recomputeSeries when the series stops being decided", async () => {
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    // bestOf 1 in the factory season, so one game decides it.
    const game = await addGameToMatch(target.id, "779001", target.homeTeamId);
    await recomputeSeries(target.id);
    await setSetting(`resultAnnounced:${target.id}`, new Date().toISOString());

    await removeGame(empty, fd({ gameId: game.id }));

    expect(await getSetting(`resultAnnounced:${target.id}`)).toBeNull();
    const after = await prisma.match.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(after.status).not.toBe(MATCH_STATUS.COMPLETED);
  });

  it("leaves the marker alone while the series is still decided", async () => {
    // The release must key on "no longer decided", not on "recompute ran" —
    // otherwise every later import would re-announce a settled series.
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await addGameToMatch(target.id, "779002", target.homeTeamId);
    await recomputeSeries(target.id);
    const marker = new Date().toISOString();
    await setSetting(`resultAnnounced:${target.id}`, marker);

    await recomputeSeries(target.id);

    expect(await getSetting(`resultAnnounced:${target.id}`)).toBe(marker);
  });
});

describe("setSeasonPhase — Complete belongs to authoritative crowning", () => {
  it("refuses to mark an unfinished bracket Complete", async () => {
    const { season, matches } = await seasonWithSchedule();
    for (const m of matches) await recordMatch(m.id, 1, 0);
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.PLAYOFFS },
    });
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 99,
        phase: MATCH_PHASE.FINAL,
        homeTeamId: matches[0].homeTeamId,
        awayTeamId: matches[0].awayTeamId,
        bracketSlot: "R0M0",
        bestOf: 1,
      },
    });

    const res = await setSeasonPhase(
      empty,
      fd({
        phase: SEASON_STATUS.COMPLETE,
        expectedActiveSeasonId: season.id,
      }),
    );

    expect(res?.error).toMatch(/automatically.*grand final/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.PLAYOFFS,
      championTeamId: null,
    });
  });

  it("also refuses a manual Complete when no bracket exists", async () => {
    const { season, matches } = await seasonWithSchedule();
    for (const m of matches) await recordMatch(m.id, 1, 0);
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.PLAYOFFS },
    });

    const res = await setSeasonPhase(
      empty,
      fd({
        phase: SEASON_STATUS.COMPLETE,
        expectedActiveSeasonId: season.id,
      }),
    );

    expect(res?.error).toMatch(/automatically.*grand final/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      status: SEASON_STATUS.PLAYOFFS,
      championTeamId: null,
    });
  });
});

describe("withdrawSignup is reachable after SIGNUPS", () => {
  // The action was always phase-agnostic; only its single render site was
  // gated, so from the first moment of the draft an admin could not remove a
  // signup at all — including the ghosted player the auction then buys.
  it("removes an unrostered signup during REGULAR_SEASON", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const ghost = await makePlayer(season.id, "Ghost", 3000);
    const reg = await prisma.registration.findFirstOrThrow({
      where: { seasonId: season.id, userId: ghost.id },
    });

    const res = await withdrawSignup(empty, fd({ registrationId: reg.id }));

    expect(res?.error).toBeUndefined();
    const after = await prisma.registration.findUniqueOrThrow({
      where: { id: reg.id },
    });
    expect(after.status).toBe("REMOVED");
  });
});

describe("the auction can't be bypassed before it runs", () => {
  // `if (draftRow && draftRow.status !== COMPLETE)` fell straight through on a
  // NULL Draft row — and a season only gets one when Start draft is pressed.
  // The safe Signups → Draft waiting-room transition intentionally preserves
  // that pre-start state, so the downstream action must still reject it.
  it("signFreeAgent refuses in the DRAFT phase when no draft row exists", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    const team = await makeTeam(season.id, "Alpha", 0);
    const free = await makePlayer(season.id, "Undrafted", 4000);

    const res = await signFreeAgent(
      empty,
      fd({ teamId: team.id, userId: free.id }),
    );

    expect(res?.error).toMatch(/hasn't run yet/i);
    expect(await prisma.teamMember.count({ where: { teamId: team.id } })).toBe(
      0,
    );
  });

  it("releasePlayer refuses in the same state", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    const team = await makeTeam(season.id, "Alpha", 0);
    const p = await makePlayer(season.id, "Rostered", 3000);
    const member = await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: team.id,
        userId: p.id,
        price: 5,
      },
    });

    const res = await releasePlayer(empty, fd({ memberId: member.id }));

    expect(res?.error).toMatch(/hasn't run yet/i);
    expect(
      await prisma.teamMember.findUnique({ where: { id: member.id } }),
    ).not.toBeNull();
  });

  it("still allows a signing once the auction has COMPLETED", async () => {
    // The guard must not break the pool-dry top-up window it exists for.
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    const team = await makeTeam(season.id, "Alpha", 0);
    const free = await makePlayer(season.id, "Late Joiner", 3000);
    await prisma.draft.create({
      data: { seasonId: season.id, status: "COMPLETE" },
    });

    const res = await signFreeAgent(
      empty,
      fd({ teamId: team.id, userId: free.id }),
    );

    expect(res?.error).toBeUndefined();
    expect(await prisma.teamMember.count({ where: { teamId: team.id } })).toBe(
      1,
    );
  });
});

describe("assignStandin unpacks the empty-seat option from the form", () => {
  // One <select> carries both cases: a plain userId covers that player,
  // `seat:<teamId>` fills an open roster seat. That string transform is the
  // only untested link between the UI and the service, and getting it wrong
  // would silently send "seat:abc" through as a replacingUserId.
  async function shortTeamMatch() {
    const season = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
      teamSize: 3,
    });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    // Home carries only its captain → 2 open seats.
    const sub = await makeUser("Seat Filler");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: sub.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
        scheduledAt: new Date(Date.now() + 3600_000),
      },
    });
    return { season, home, sub, match };
  }

  it("stores a null replacingUserId for a seat: value", async () => {
    const { home, sub, match } = await shortTeamMatch();

    const res = await assignStandin(
      empty,
      fd({
        matchId: match.id,
        standinUserId: sub.id,
        replacingUserId: `seat:${home.id}`,
      }),
    );

    expect(res?.error).toBeUndefined();
    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    expect(row.replacingUserId).toBeNull();
    expect(row.teamId).toBe(home.id);
  });

  it("still treats a plain userId as the covered player", async () => {
    const { season, home, sub, match } = await shortTeamMatch();
    const covered = await makeUser("Covered");
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: home.id,
        userId: covered.id,
        price: 1,
      },
    });

    const res = await assignStandin(
      empty,
      fd({
        matchId: match.id,
        standinUserId: sub.id,
        replacingUserId: covered.id,
      }),
    );

    expect(res?.error).toBeUndefined();
    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    expect(row.replacingUserId).toBe(covered.id);
  });
});

describe("reinstateSignup medal advisory", () => {
  // The flag flow is one-way: syncPlayerRanks names over-ceiling signups in
  // its own toast and expects a withdraw — nothing warned when the same admin
  // later REINSTATED a flagged signup. Advisory only, never a gate: the
  // mutation must succeed either way (operator's call).
  async function removedSignup(rankTier: number | null) {
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const user = await prisma.user.create({
      data: {
        steamId: `7656119${Math.floor(Math.random() * 1e10)}`,
        name: "Flagged",
        rankTier,
      },
    });
    const reg = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "REMOVED",
        mmr: 4000,
      },
    });
    return { season, user, reg };
  }

  it("appends the over-ceiling warning for an Immortal medal", async () => {
    const { reg } = await removedSignup(80); // Immortal
    const res = await reinstateSignup(empty, fd({ registrationId: reg.id }));
    expect(res?.error).toBeUndefined();
    expect(res?.message).toContain("⚠️");
    expect(res?.message).toContain("review before the draft");
    const after = await prisma.registration.findUniqueOrThrow({
      where: { id: reg.id },
    });
    expect(after.status).toBe("ACTIVE"); // never a gate
  });

  it("keeps the plain message for an ordinary medal", async () => {
    const { reg } = await removedSignup(44); // Archon 4
    const res = await reinstateSignup(empty, fd({ registrationId: reg.id }));
    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe("Flagged is back in the pool");
  });
});

describe("generateSchedule — the results gate (both halves)", () => {
  // The guard protecting against "Regenerate erases the season" had ZERO
  // coverage in either shape — the read-time refusal and the in-transaction
  // count-then-throw are both invisible to the mutation ratchet (it models
  // only updateMany WHERE-claims). Verified non-vacuous by sabotage: deleting
  // either half turns its test red.
  afterEach(() => setRaceHook(null));

  it("refuses to regenerate once a series result is recorded", async () => {
    const { season, matches } = await seasonWithSchedule(
      SEASON_STATUS.REGULAR_SEASON,
    );
    await prisma.match.update({
      where: { id: matches[0].id },
      data: {
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 0,
        winnerTeamId: matches[0].homeTeamId,
      },
    });

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toMatch(/results are already recorded/i);
    // The old slate survives untouched — same rows, same ids.
    expect(
      await prisma.match.count({
        where: { id: { in: matches.map((m) => m.id) } },
      }),
    ).toBe(matches.length);
    void season;
  });

  it("refuses on an imported game alone, before any series is decided", async () => {
    const { season, matches } = await seasonWithSchedule(
      SEASON_STATUS.REGULAR_SEASON,
    );
    await addGameToMatch(matches[0].id, "8666000001", matches[0].homeTeamId);

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toMatch(/results are already recorded/i);
    expect(
      await prisma.match.count({
        where: { id: { in: matches.map((m) => m.id) } },
      }),
    ).toBe(matches.length);
  });

  it("a result landing mid-generate rolls the whole regeneration back", async () => {
    // Auto-sync imports from any visitor's page view, so "no results yet" can
    // stop being true between the read-time gate and the deleteMany it
    // authorizes. The in-tx re-count throws; the fixtures the delete would
    // have cascaded away must survive with their original ids.
    const { season, matches } = await seasonWithSchedule(
      SEASON_STATUS.REGULAR_SEASON,
    );
    let fired = false;
    setRaceHook(
      onceAt("admin.generateSchedule.beforeTx", async () => {
        fired = true;
        await prisma.match.update({
          where: { id: matches[0].id },
          data: {
            status: MATCH_STATUS.COMPLETED,
            homeScore: 2,
            awayScore: 0,
            winnerTeamId: matches[0].homeTeamId,
          },
        });
      }),
    );

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/result landed/i);
    // Original fixtures intact — nothing was deleted or recreated…
    expect(
      await prisma.match.count({
        where: { id: { in: matches.map((m) => m.id) } },
      }),
    ).toBe(matches.length);
    // …and the result that interrupted the regenerate survives too.
    expect(
      (await prisma.match.findUniqueOrThrow({ where: { id: matches[0].id } }))
        .status,
    ).toBe(MATCH_STATUS.COMPLETED);
  });
});

describe("generateSchedule — the double-round-robin switch is actually wired", () => {
  // roundRobin(ids, doubleRound) was built and unit-tested from the start but
  // no caller ever passed the flag — the exact "the rendering half was built,
  // the switch was never wired" class. This pins the wiring end to end.
  it("doubleRound=on mirrors every pairing home/away over twice the weeks", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    for (let i = 0; i < 4; i++) await makeTeam(season.id, `RR${i}`, i + 1);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });

    const res = await generateSchedule(
      empty,
      fd({
        firstNight: "",
        doubleRound: "on",
        expectedActiveSeasonId: season.id,
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(
      /12 matches over 6 week\(s\) \(double round robin\)/,
    );
    const matches = await prisma.match.findMany({
      where: { seasonId: season.id },
    });
    expect(matches).toHaveLength(12);
    expect(new Set(matches.map((m) => m.week)).size).toBe(6);
    // Every pairing appears exactly twice, once each way around.
    const key = (h: string, a: string) => `${h}>${a}`;
    const seen = new Map<string, number>();
    for (const m of matches) {
      seen.set(
        key(m.homeTeamId, m.awayTeamId),
        (seen.get(key(m.homeTeamId, m.awayTeamId)) ?? 0) + 1,
      );
    }
    for (const [k, n] of seen) {
      expect(n).toBe(1); // no repeated identical fixture…
      const [h, a] = k.split(">");
      expect(seen.get(key(a, h))).toBe(1); // …and the mirror exists
    }
  });

  it("unchecked stays a single round robin, byte-for-byte the old behavior", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    for (let i = 0; i < 4; i++) await makeTeam(season.id, `SR${i}`, i + 1);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/6 matches over 3 week\(s\)/);
    expect(res?.message).not.toMatch(/double round robin/);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      6,
    );
  });
});

describe("recordResult — lifecycle and imported-game authority", () => {
  it.each([
    [
      "an inactive season even when its status still says Regular season",
      false,
      SEASON_STATUS.REGULAR_SEASON,
      MATCH_PHASE.REGULAR,
      /active Regular season phase/i,
    ],
    [
      "a regular fixture after the season enters Playoffs",
      true,
      SEASON_STATUS.PLAYOFFS,
      MATCH_PHASE.REGULAR,
      /active Regular season phase/i,
    ],
    [
      "a playoff fixture while the season is still Regular season",
      true,
      SEASON_STATUS.REGULAR_SEASON,
      MATCH_PHASE.PLAYOFF,
      /active season is in Playoffs/i,
    ],
  ])(
    "refuses a direct write to %s",
    async (_label, isActive, seasonStatus, matchPhase, error) => {
      const { season, matches } = await seasonWithSchedule();
      const target = matches[0];
      await prisma.season.update({
        where: { id: season.id },
        data: { isActive, status: seasonStatus },
      });
      await prisma.match.update({
        where: { id: target.id },
        data: { phase: matchPhase },
      });

      const res = await recordResult(
        empty,
        fd({ matchId: target.id, homeScore: "2", awayScore: "0" }),
      );

      expect(res?.error).toMatch(error);
      expect(
        await prisma.match.findUniqueOrThrow({ where: { id: target.id } }),
      ).toMatchObject({
        status: MATCH_STATUS.SCHEDULED,
        homeScore: 0,
        awayScore: 0,
        winnerTeamId: null,
        forfeit: false,
      });
      expect(
        await prisma.adminAction.count({ where: { action: "recordResult" } }),
      ).toBe(0);
    },
  );

  it("does not let a non-forfeit final overwrite an imported series", async () => {
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await prisma.match.update({
      where: { id: target.id },
      data: { bestOf: 3 },
    });
    const game = await addGameToMatch(target.id, "889001", target.homeTeamId);
    await recomputeSeries(target.id);

    const res = await recordResult(
      empty,
      fd({ matchId: target.id, homeScore: "2", awayScore: "0" }),
    );

    expect(res?.error).toMatch(/score is derived from them/i);
    expect(
      await prisma.game.findUnique({ where: { id: game.id } }),
    ).not.toBeNull();
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: target.id } }),
    ).toMatchObject({
      status: MATCH_STATUS.LIVE,
      homeScore: 1,
      awayScore: 0,
      winnerTeamId: null,
      forfeit: false,
    });
  });

  it("rejects an early played Bo3 final unless it is explicitly ruled a forfeit", async () => {
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await prisma.match.update({
      where: { id: target.id },
      data: { bestOf: 3 },
    });

    const played = await recordResult(
      empty,
      fd({ matchId: target.id, homeScore: "1", awayScore: "0" }),
    );
    expect(played?.error).toMatch(/reaches 2 wins.*forfeit\/ruling/i);
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: target.id } }),
    ).toMatchObject({
      status: MATCH_STATUS.SCHEDULED,
      homeScore: 0,
      awayScore: 0,
    });

    const ruled = await recordResult(
      empty,
      fd({
        matchId: target.id,
        homeScore: "1",
        awayScore: "0",
        forfeit: "on",
      }),
    );
    expect(ruled?.error).toBeUndefined();
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: target.id } }),
    ).toMatchObject({
      status: MATCH_STATUS.COMPLETED,
      homeScore: 1,
      awayScore: 0,
      winnerTeamId: target.homeTeamId,
      forfeit: true,
    });
  });

  it("does not let a forfeit ruling erase either side's imported game wins", async () => {
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await prisma.match.update({
      where: { id: target.id },
      data: { bestOf: 3 },
    });
    await addGameToMatch(target.id, "889002", target.homeTeamId);
    await addGameToMatch(target.id, "889003", target.awayTeamId);
    await recomputeSeries(target.id);

    const res = await recordResult(
      empty,
      fd({
        matchId: target.id,
        homeScore: "2",
        awayScore: "0",
        forfeit: "on",
      }),
    );

    expect(res?.error).toMatch(/cannot erase imported game wins/i);
    expect(await prisma.game.count({ where: { matchId: target.id } })).toBe(2);
    expect(
      await prisma.match.findUniqueOrThrow({ where: { id: target.id } }),
    ).toMatchObject({
      status: MATCH_STATUS.LIVE,
      homeScore: 1,
      awayScore: 1,
      winnerTeamId: null,
      forfeit: false,
    });
  });
});

describe("recordResult — the forfeit flag rides the ruling end to end", () => {
  it("stamps forfeit on the CAS write, logs it, and reopen un-rules it", async () => {
    const { matches } = await seasonWithSchedule(SEASON_STATUS.REGULAR_SEASON);
    const target = matches[0];

    const res = await recordResult(
      empty,
      fd({ matchId: target.id, homeScore: "2", awayScore: "0", forfeit: "on" }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/forfeit/i);
    let row = await prisma.match.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.forfeit).toBe(true);
    expect(row.status).toBe(MATCH_STATUS.COMPLETED);
    expect(row.winnerTeamId).toBe(target.homeTeamId);
    const log = await prisma.adminAction.findFirst({
      where: { action: "recordResult" },
      orderBy: { createdAt: "desc" },
    });
    expect(log?.summary).toMatch(/forfeit/);

    // Reopen un-rules it — the flag must not survive into the next result.
    const reopened = await reopenMatch(empty, fd({ matchId: target.id }));
    expect(reopened?.error).toBeUndefined();
    row = await prisma.match.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.forfeit).toBe(false);
    expect(row.status).toBe(MATCH_STATUS.SCHEDULED);
  });

  it("re-saving without the box un-rules a mistaken forfeit", async () => {
    const { matches } = await seasonWithSchedule(SEASON_STATUS.REGULAR_SEASON);
    const target = matches[0];
    await recordResult(
      empty,
      fd({ matchId: target.id, homeScore: "2", awayScore: "0", forfeit: "on" }),
    );

    const res = await recordResult(
      empty,
      fd({ matchId: target.id, homeScore: "2", awayScore: "0" }),
    );

    expect(res?.error).toBeUndefined();
    const row = await prisma.match.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(row.forfeit).toBe(false);
    expect(row.homeScore).toBe(2);
    expect(row.awayScore).toBe(0);
  });
});

describe("recordResult — a forfeit ruling on an unplayed series stands its standins down", () => {
  // A forfeit with zero imported games is a fixture that won't be played, but
  // its booked standins hold a live @-mentioned instruction to show up — and
  // completing the match drops the booking from their /me list, so nothing on
  // the site could correct them.
  async function bookCover(
    matchId: string,
    teamId: string,
    name: string,
    discordId: string,
  ) {
    const standin = await makeUser(name);
    await prisma.user.update({
      where: { id: standin.id },
      data: { discordId },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId,
        teamId,
        standinUserId: standin.id,
        replacingUserId: null,
      },
    });
    return standin;
  }

  it("forfeit + zero games: stands down and permanently deletes every booking", async () => {
    // Pins the stand-down block: standinRemovedMessage per booking, the
    // covered team named correctly per side, mentionsOf carrying the discordId.
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await bookCover(
      target.id,
      target.homeTeamId,
      "Home Cover",
      "810000000000000001",
    );
    await bookCover(
      target.id,
      target.awayTeamId,
      "Away Cover",
      "810000000000000002",
    );
    vi.mocked(sendDiscordMessage).mockClear();

    const res = await recordResult(
      empty,
      fd({ matchId: target.id, homeScore: "2", awayScore: "0", forfeit: "on" }),
    );

    expect(res?.error).toBeUndefined();
    const standDowns = vi
      .mocked(sendDiscordMessage)
      .mock.calls.filter(([m]) => String(m).includes("stand down"));
    expect(standDowns).toHaveLength(2);
    const homeSend = standDowns.find(([m]) => String(m).includes("Home Cover"));
    expect(homeSend, "the home side's cover must be stood down").toBeTruthy();
    expect(homeSend![1]).toEqual({ users: ["810000000000000001"] });
    const awaySend = standDowns.find(([m]) => String(m).includes("Away Cover"));
    expect(awaySend, "the away side's cover must be stood down").toBeTruthy();
    expect(awaySend![1]).toEqual({ users: ["810000000000000002"] });

    expect(
      await prisma.standinAssignment.count({ where: { matchId: target.id } }),
    ).toBe(0);
    const reopened = await reopenMatch(empty, fd({ matchId: target.id }));
    expect(reopened?.error).toBeUndefined();
    expect(
      await prisma.standinAssignment.count({ where: { matchId: target.id } }),
    ).toBe(0);
  });

  it("forfeit on a series WITH an imported game keeps quiet — that series was played", async () => {
    // The games === 0 gate: a forfeit ruling over a partially-imported series
    // (say a 1-0 abandoned Bo3) must not tell a standin who actually played
    // to stand down.
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await addGameToMatch(target.id, "888001", target.homeTeamId);
    await bookCover(
      target.id,
      target.homeTeamId,
      "Played Cover",
      "810000000000000003",
    );
    vi.mocked(sendDiscordMessage).mockClear();

    const res = await recordResult(
      empty,
      fd({ matchId: target.id, homeScore: "2", awayScore: "0", forfeit: "on" }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/forfeit/i); // the ruling itself still saved
    expect(
      vi
        .mocked(sendDiscordMessage)
        .mock.calls.some(([m]) => String(m).includes("stand down")),
    ).toBe(false);
  });

  it("a normal manual score (no forfeit, no games) never stands anyone down", async () => {
    // The forfeit half of the gate: a manual score for a PLAYED series with
    // private match data has no imports either — its standin may well have
    // been in the game.
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    await bookCover(
      target.id,
      target.awayTeamId,
      "Quiet Cover",
      "810000000000000004",
    );
    vi.mocked(sendDiscordMessage).mockClear();

    const res = await recordResult(
      empty,
      fd({ matchId: target.id, homeScore: "2", awayScore: "0" }),
    );

    expect(res?.error).toBeUndefined();
    expect(
      vi
        .mocked(sendDiscordMessage)
        .mock.calls.some(([m]) => String(m).includes("stand down")),
    ).toBe(false);
  });
});

describe("retractions bump the freshness cursor", () => {
  // A retraction moves the standings exactly as much as a result does, but
  // only importGameForMatch stamped the cursor — recomputeSeries doesn't. So
  // every OTHER open tab kept rendering the removed score until an unrelated
  // result landed: <ResultSyncPing> refreshes on `updated` (true for the
  // acting client only) or on the cursor advancing.
  const cursor = async () =>
    (await getSetting(SETTING_KEYS.RESULT_CHANGED_AT)) ?? "";

  it("removeGame advances it", async () => {
    const { matches } = await seasonWithSchedule(SEASON_STATUS.REGULAR_SEASON);
    const game = await addGameToMatch(
      matches[0].id,
      "8777000001",
      matches[0].homeTeamId,
    );
    await setSetting(
      SETTING_KEYS.RESULT_CHANGED_AT,
      "1999-01-01T00:00:00.000Z",
    );
    const before = await cursor();

    await removeGame(empty, fd({ gameId: game.id }));

    expect(await cursor()).not.toBe(before);
  });

  it("reopenMatch advances it", async () => {
    const { matches } = await seasonWithSchedule(SEASON_STATUS.REGULAR_SEASON);
    await recordResult(
      empty,
      fd({ matchId: matches[0].id, homeScore: "2", awayScore: "0" }),
    );
    await setSetting(
      SETTING_KEYS.RESULT_CHANGED_AT,
      "1999-01-01T00:00:00.000Z",
    );
    const before = await cursor();

    const res = await reopenMatch(empty, fd({ matchId: matches[0].id }));

    expect(res?.error).toBeUndefined();
    expect(await cursor()).not.toBe(before);
  });
});

describe("startDraft — the one-shot lives at the WRITE, not just the read", () => {
  afterEach(() => setRaceHook(null));

  /** Two captains + a one-player pool: the minimum startable season. */
  async function startableSeason() {
    const season = await makeSeason();
    const capA = await makeCaptain(season.id, "StartCapA", 100, 0);
    const capB = await makeCaptain(season.id, "StartCapB", 100, 1);
    await makePlayer(season.id, "StartPool", 3000);
    return { season, capA, capB };
  }

  it("a result landing between the read-time check and the transaction refuses the start (seam)", async () => {
    // The in-tx playedNow/gamesNow recount is the throw-inside-transaction
    // guard shape the mutation ratchet cannot see; without this seam test,
    // deleting it left every suite green — and the next season walked into
    // DRAFT with auto-sync importing an opening game got a live auction armed
    // over a played league.
    const { season } = await startableSeason();
    const matches = await generateRegularSchedule(season.id);

    let fired = false;
    setRaceHook(
      onceAt("admin.startDraft.beforeTx", async () => {
        fired = true;
        await recordMatch(matches[0].id, 2, 0);
      }),
    );

    const res = await startDraft(
      empty,
      fd({ expectedActiveSeasonId: season.id }),
    );

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/result landed/i);
    // Nothing armed: no draft row, and the season never moved to DRAFT.
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .status,
    ).toBe(SEASON_STATUS.SIGNUPS);
  });

  it("two simultaneous Starts arm the auction ONCE and announce once", async () => {
    // The old draft.upsert had no status predicate, so the loser blindly
    // restamped the just-started draft (fresh nomination clock, rotation
    // reset) and the league got a second "draft is live" announcement.
    const { season } = await startableSeason();
    vi.mocked(sendDiscordMessage).mockClear();

    const res = await raceN(2, () =>
      startDraft(empty, fd({ expectedActiveSeasonId: season.id })),
    );

    expect(res.filter((r) => r?.message)).toHaveLength(1);
    expect(res.filter((r) => r?.error)).toHaveLength(1);
    const draft = await prisma.draft.findUniqueOrThrow({
      where: { seasonId: season.id },
    });
    expect(draft.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    expect(
      vi
        .mocked(sendDiscordMessage)
        .mock.calls.filter((c) => /draft/i.test(String(c[0]))),
    ).toHaveLength(1);
  });

  it("a double re-start over an aborted draft row claims NOT_STARTED once", async () => {
    // The post-abort state: the draft row exists at NOT_STARTED, so the
    // rival pair goes through the guarded updateMany branch instead of the
    // create-P2002 one. Same invariant, other door.
    const { season } = await startableSeason();
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.NOT_STARTED },
    });

    const res = await raceN(2, () =>
      startDraft(empty, fd({ expectedActiveSeasonId: season.id })),
    );

    expect(res.filter((r) => r?.message)).toHaveLength(1);
    expect(res.filter((r) => r?.error)).toHaveLength(1);
    expect(
      (
        await prisma.draft.findUniqueOrThrow({
          where: { seasonId: season.id },
        })
      ).status,
    ).toBe(DRAFT_STATUS.IN_PROGRESS);
  });
});

describe("removeCaptain — the in-tx results recount actually refuses (seam)", () => {
  afterEach(() => setRaceHook(null));

  it("a result landing between the read-time check and the delete rolls everything back", async () => {
    const season = await makeSeason();
    const capA = await makeCaptain(season.id, "RmSeamA", 100, 0);
    await makeCaptain(season.id, "RmSeamB", 100, 1);
    const matches = await generateRegularSchedule(season.id);

    let fired = false;
    setRaceHook(
      onceAt("admin.removeCaptain.beforeTx", async () => {
        fired = true;
        await recordMatch(matches[0].id, 2, 0);
      }),
    );

    const res = await removeCaptain(
      empty,
      fd({ teamId: capA.team.id, expectedActiveSeasonId: season.id }),
    );

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/result landed/i);
    // The team survived, the schedule survived, and the result that
    // interrupted the removal survived too.
    expect(
      await prisma.team.findUnique({ where: { id: capA.team.id } }),
    ).not.toBeNull();
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      matches.length,
    );
    expect(
      (await prisma.match.findUniqueOrThrow({ where: { id: matches[0].id } }))
        .status,
    ).toBe(MATCH_STATUS.COMPLETED);
  });
});

describe("withdrawSignup — never the player currently ON THE BLOCK", () => {
  it("refuses to withdraw a live lot's nominee, and the signup stays ACTIVE", async () => {
    // This refusal is an inline early-return — invisible to the mutation
    // ratchet — and the only on-the-block test used to cover the separate
    // pure withdrawGateError branch, which this path never invokes. Deleting
    // the inline guard reopened the headless-auction bug with every suite
    // green; this pins it.
    const season = await makeSeason({ teamSize: 3 });
    const capA = await makeCaptain(season.id, "BlockCapA", 100, 0);
    await makeCaptain(season.id, "BlockCapB", 100, 1);
    const star = await makePlayer(season.id, "OnTheBlock", 4000);
    await startDraftState(season.id);
    expect(
      (await nominatePlayer(season.id, sessionFor(capA.user), star.id, 5)).ok,
    ).toBe(true);

    const reg = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: star.id } },
    });
    const res = await withdrawSignup(empty, fd({ registrationId: reg.id }));

    expect(res?.error).toMatch(/auction block/i);
    expect(
      (await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } }))
        .status,
    ).toBe("ACTIVE");
  });
});
