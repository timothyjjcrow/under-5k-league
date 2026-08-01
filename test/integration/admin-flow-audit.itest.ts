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
  releasePlayer,
  reopenMatch,
  signFreeAgent,
  setLeagueId,
  setMatchTime,
  recordResult,
  reinstateSignup,
  setSeasonPhase,
  withdrawSignup,
} from "@/app/actions/admin";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { recomputeSeries } from "@/lib/match-import";
import { loadImportSkips } from "@/lib/match-import";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import {
  addGameToMatch,
  generateRegularSchedule,
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
  recordMatch,
  resetDb,
} from "./factories";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};
const empty: ActionResult = {};

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** A season with 4 teams and a generated round robin. */
async function seasonWithSchedule(
  status: string = SEASON_STATUS.REGULAR_SEASON,
) {
  const season = await makeSeason({ status });
  for (let i = 0; i < 4; i++) {
    await makeTeam(season.id, `Team ${i + 1}`, i + 1);
  }
  const matches = await generateRegularSchedule(season.id);
  return { season, matches };
}

describe("removeGame — the removal must survive automatic re-import", () => {
  // The defect: both importers decide "already recorded" from the Game rows
  // themselves, so deleting the row made the game a fresh candidate again and
  // the next /api/sync ping (from any page view, the admin's own tab included)
  // re-imported it inside a minute. Silently — the removal had toasted success.
  it("remembers the removed dotaMatchId so auto-sync will not re-add it", async () => {
    const { season, matches } = await seasonWithSchedule();
    const target = matches[0];
    const game = await addGameToMatch(target.id, "777001", target.homeTeamId);

    const res = await removeGame(empty, fd({ gameId: game.id }));

    expect(res?.error).toBeUndefined();
    expect(await prisma.game.findUnique({ where: { id: game.id } })).toBeNull();
    const skips = await loadImportSkips(season.id);
    expect(skips.has("777001")).toBe(true);
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

  it("keeps the memory per-season and bounded, not per-match", async () => {
    const { season, matches } = await seasonWithSchedule();
    const a = await addGameToMatch(matches[0].id, "777003", matches[0].homeTeamId);
    const b = await addGameToMatch(matches[1].id, "777004", matches[1].homeTeamId);
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
});

describe("removeCaptain — the season-wide match delete needs a results guard", () => {
  // The delete is `deleteMany({ where: { seasonId } })` — the WHOLE season. Its
  // only lock was Draft.status !== NOT_STARTED, and a NULL Draft row passes:
  // createSeason never creates one and setSeasonPhase enforces no phase
  // adjacency, so a season walked SIGNUPS -> REGULAR_SEASON without ever
  // pressing Start draft left the gate open all season.
  it("refuses once a result is recorded, instead of erasing the schedule", async () => {
    const { season, matches } = await seasonWithSchedule();
    await recordMatch(matches[0].id, 2, 0);
    const doomed = await prisma.team.findFirstOrThrow({
      where: { seasonId: season.id },
    });

    const res = await removeCaptain(empty, fd({ teamId: doomed.id }));

    expect(res?.error).toMatch(/results are already recorded/i);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      matches.length,
    );
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(4);
  });

  it("refuses on an imported GAME too, not just a decided series", async () => {
    // Opening night is routinely "one series LIVE at 1-0" — counting only
    // COMPLETED matches left exactly that window open.
    const { season, matches } = await seasonWithSchedule();
    await addGameToMatch(matches[0].id, "778001", matches[0].homeTeamId);
    const doomed = await prisma.team.findFirstOrThrow({
      where: { seasonId: season.id },
    });

    const res = await removeCaptain(empty, fd({ teamId: doomed.id }));

    expect(res?.error).toMatch(/results are already recorded/i);
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

    const res = await removeCaptain(empty, fd({ teamId: doomed.id }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/schedule was cleared/i);
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(3);
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(0);
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

    const res = await generateSchedule(empty, fd({ firstNight: "" }));

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

    const res = await generateSchedule(empty, fd({ firstNight: "" }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/Schedule generated/);
    expect(res?.message).not.toMatch(/clearing/);
    expect(res?.message).not.toMatch(/\b0 /);
  });

  it("releases the week reminder markers so they re-fire on the new slate", async () => {
    // The reminders quoted kickoffs for fixtures that no longer exist, and
    // Discord edits notify nobody.
    const { season } = await seasonWithSchedule(SEASON_STATUS.DRAFT);
    await setSetting(`weekReminder:${season.id}:1`, new Date().toISOString());

    await generateSchedule(empty, fd({ firstNight: "" }));

    expect(await getSetting(`weekReminder:${season.id}:1`)).toBeNull();
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
    const when = new Date(Date.now() + 6 * 864e5);

    const res = await setMatchTime(
      empty,
      fd({
        matchId: target.id,
        scheduledAt: when.toISOString(),
        scheduledAtTs: String(when.getTime()),
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(
      await getSetting(`weekReminder:${season.id}:${target.week}`),
    ).toBeNull();
  });

  it("names the check-ins it wiped", async () => {
    const { matches } = await seasonWithSchedule();
    const target = matches[0];
    for (const n of ["A", "B", "C"]) {
      const u = await makeUser(`Checkin ${n}`);
      await prisma.matchAvailability.create({
        data: { matchId: target.id, userId: u.id, status: "IN" },
      });
    }
    const when = new Date(Date.now() + 6 * 864e5);

    const res = await setMatchTime(
      empty,
      fd({
        matchId: target.id,
        scheduledAt: when.toISOString(),
        scheduledAtTs: String(when.getTime()),
      }),
    );

    expect(res?.message).toMatch(/3 check-in/);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: target.id } }),
    ).toBe(0);
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
    await setSetting(
      `weekReminder:${season.id}:${target.week}`,
      new Date().toISOString(),
    );

    const res = await setMatchTime(
      empty,
      fd({
        matchId: target.id,
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
  });

  it("refuses an unparseable time instead of silently leaving it alone", async () => {
    const { matches } = await seasonWithSchedule();
    const res = await setMatchTime(
      empty,
      fd({ matchId: matches[0].id, scheduledAt: "not a date" }),
    );
    expect(res?.error).toMatch(/valid date/i);
  });
});

describe("setLeagueId — a bogus id disables ALL result import", () => {
  it("refuses a pasted dota2.com URL rather than storing league '2'", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });

    const res = await setLeagueId(
      empty,
      fd({ dotaLeagueId: "https://www.dota2.com/leagues/17119" }),
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
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17119" },
    });

    const res = await setLeagueId(empty, fd({ dotaLeagueId: "dota2.com" }));

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
    await prisma.season.update({
      where: { id: season.id },
      data: { dotaLeagueId: "17119" },
    });

    const res = await setLeagueId(empty, fd({ dotaLeagueId: "  " }));

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
    await setSetting(
      `resultAnnounced:${target.id}`,
      new Date().toISOString(),
    );

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
    await setSetting(
      `resultAnnounced:${target.id}`,
      new Date().toISOString(),
    );

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

describe("setSeasonPhase — completing a season mid-bracket must say what it costs", () => {
  it("warns, with the way back, when COMPLETE is set with the bracket unfinished", async () => {
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

    const res = await setSeasonPhase(empty, fd({ phase: SEASON_STATUS.COMPLETE }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/no champion will be crowned/i);
    expect(res?.message).toMatch(/back to Playoffs/i);
  });

  it("says nothing extra when the bracket is finished", async () => {
    const { season, matches } = await seasonWithSchedule();
    for (const m of matches) await recordMatch(m.id, 1, 0);
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.PLAYOFFS },
    });

    const res = await setSeasonPhase(empty, fd({ phase: SEASON_STATUS.COMPLETE }));

    expect(res?.message).toBe("Season moved to Complete");
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
  // NULL Draft row — and a season only gets one when Start draft is pressed,
  // while setSeasonPhase enforces no adjacency. So an admin who clicked the
  // "Draft" phase button first could sign the whole pool onto teams at $0,
  // one player at a time, without the auction ever running.
  it("signFreeAgent refuses in the DRAFT phase when no draft row exists", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    const team = await makeTeam(season.id, "Alpha", 0);
    const free = await makePlayer(season.id, "Undrafted", 4000);

    const res = await signFreeAgent(
      empty,
      fd({ teamId: team.id, userId: free.id }),
    );

    expect(res?.error).toMatch(/hasn't run yet/i);
    expect(
      await prisma.teamMember.count({ where: { teamId: team.id } }),
    ).toBe(0);
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
    expect(
      await prisma.teamMember.count({ where: { teamId: team.id } }),
    ).toBe(1);
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
      data: { steamId: `7656119${Math.floor(Math.random() * 1e10)}`, name: "Flagged", rankTier },
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
    const { season, matches } = await seasonWithSchedule(SEASON_STATUS.REGULAR_SEASON);
    await prisma.match.update({
      where: { id: matches[0].id },
      data: {
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        awayScore: 0,
        winnerTeamId: matches[0].homeTeamId,
      },
    });

    const res = await generateSchedule(empty, fd({ firstNight: "" }));

    expect(res?.error).toMatch(/results are already recorded/i);
    // The old slate survives untouched — same rows, same ids.
    expect(
      await prisma.match.count({ where: { id: { in: matches.map((m) => m.id) } } }),
    ).toBe(matches.length);
    void season;
  });

  it("refuses on an imported game alone, before any series is decided", async () => {
    const { matches } = await seasonWithSchedule(SEASON_STATUS.REGULAR_SEASON);
    await addGameToMatch(matches[0].id, "8666000001", matches[0].homeTeamId);

    const res = await generateSchedule(empty, fd({ firstNight: "" }));

    expect(res?.error).toMatch(/results are already recorded/i);
    expect(
      await prisma.match.count({ where: { id: { in: matches.map((m) => m.id) } } }),
    ).toBe(matches.length);
  });

  it("a result landing mid-generate rolls the whole regeneration back", async () => {
    // Auto-sync imports from any visitor's page view, so "no results yet" can
    // stop being true between the read-time gate and the deleteMany it
    // authorizes. The in-tx re-count throws; the fixtures the delete would
    // have cascaded away must survive with their original ids.
    const { matches } = await seasonWithSchedule(SEASON_STATUS.REGULAR_SEASON);
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

    const res = await generateSchedule(empty, fd({ firstNight: "" }));

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/result landed/i);
    // Original fixtures intact — nothing was deleted or recreated…
    expect(
      await prisma.match.count({ where: { id: { in: matches.map((m) => m.id) } } }),
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

    const res = await generateSchedule(
      empty,
      fd({ firstNight: "", doubleRound: "on" }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/12 matches over 6 week\(s\) \(double round robin\)/);
    const matches = await prisma.match.findMany({
      where: { seasonId: season.id },
    });
    expect(matches).toHaveLength(12);
    expect(new Set(matches.map((m) => m.week)).size).toBe(6);
    // Every pairing appears exactly twice, once each way around.
    const key = (h: string, a: string) => `${h}>${a}`;
    const seen = new Map<string, number>();
    for (const m of matches) {
      seen.set(key(m.homeTeamId, m.awayTeamId), (seen.get(key(m.homeTeamId, m.awayTeamId)) ?? 0) + 1);
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

    const res = await generateSchedule(empty, fd({ firstNight: "" }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/6 matches over 3 week\(s\)/);
    expect(res?.message).not.toMatch(/double round robin/);
    expect(
      await prisma.match.count({ where: { seasonId: season.id } }),
    ).toBe(6);
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
    let row = await prisma.match.findUniqueOrThrow({ where: { id: target.id } });
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
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, "1999-01-01T00:00:00.000Z");
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
    await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, "1999-01-01T00:00:00.000Z");
    const before = await cursor();

    const res = await reopenMatch(empty, fd({ matchId: matches[0].id }));

    expect(res?.error).toBeUndefined();
    expect(await cursor()).not.toBe(before);
  });
});
