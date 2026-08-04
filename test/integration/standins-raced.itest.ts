import { describe, it, expect, vi, beforeEach } from "vitest";

// RACED coverage for the standin system's in-transaction guards. Every test
// in standins.itest.ts is STAGED — the rival row exists before the call — so
// the function's own READ-TIME checks answer and the suite stays green with
// the in-transaction re-reads deleted (the false-green pattern the repo's
// concurrency notes warn about). These races are the net over the tx copies:
// on SQLite raceAll degrades to sequential (writers serialize, nothing to
// race), so `npm run test:pg` is what runs them for real.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { assignStandinGuarded } from "@/lib/standin-service";
import { releasePlayer } from "@/app/actions/admin";
import { leaveLeague } from "@/app/actions/registration";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  makeSeason,
  makeTeam,
  makeUser,
  raceAll,
  sessionFor,
} from "./factories";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** A mid-season fixture between two 3-a-side teams, with room to maneuver. */
async function midSeasonMatch(opts: { rosterSize?: number } = {}) {
  const season = await makeSeason({ status: "REGULAR_SEASON", teamSize: 3 });
  const home = await makeTeam(season.id, "Raced Home", 0);
  const away = await makeTeam(season.id, "Raced Away", 1);
  // makeTeam creates no TeamMember rows — seat exactly `rosterSize` players.
  const rosterSize = opts.rosterSize ?? 3;
  const rostered: { id: string; name: string }[] = [];
  for (let i = 0; i < rosterSize; i++) {
    const p = await makeUser(`Rostered ${i}`);
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: p.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 2000 + i,
      },
    });
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: home.id,
        userId: p.id,
        price: 10,
        isCaptain: false,
      },
    });
    rostered.push(p);
  }
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: "REGULAR",
      homeTeamId: home.id,
      awayTeamId: away.id,
      bestOf: 2,
      scheduledAt: new Date("2030-01-10T20:00:00Z"),
    },
  });
  return { season, home, away, match, rostered };
}

async function makeStandin(seasonId: string, name: string, mmr = 2500) {
  const u = await makeUser(name);
  await prisma.registration.create({
    data: { seasonId, userId: u.id, type: "STANDIN", status: "ACTIVE", mmr },
  });
  return u;
}

const okCount = (results: Array<{ ok: boolean }>) =>
  results.filter((r) => r.ok).length;

describe("standin claims under contention (raced — meaningful on Postgres only)", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
  });

  // Pins the tx re-read of `seatTaken`: outside the transaction both racers
  // see a clear seat, and StandinAssignment has NO unique constraint — only
  // the re-read stops a double-covered seat (a six-player match night).
  it("two assigns for the same NAMED seat produce exactly one cover", async () => {
    const { season, match, rostered } = await midSeasonMatch();
    const covered = rostered[0];
    const s1 = await makeStandin(season.id, "Seat Racer A");
    const s2 = await makeStandin(season.id, "Seat Racer B");

    const results = await raceAll(
      [s1, s2].map(
        (s) => () =>
          assignStandinGuarded({
            matchId: match.id,
            standinUserId: s.id,
            replacingUserId: covered.id,
            actingCaptainId: null,
          }),
      ),
    );

    expect(okCount(results)).toBe(1);
    expect(
      await prisma.standinAssignment.count({
        where: { matchId: match.id, replacingUserId: covered.id },
      }),
    ).toBe(1);
  });

  // Pins the tx open-seat-budget re-read (the count+seats block inside the
  // transaction): two racers each see the one open seat free and, unguarded,
  // both fill it.
  it("two empty-seat assigns into ONE open seat produce exactly one cover", async () => {
    const { season, home, match } = await midSeasonMatch({ rosterSize: 2 });
    const s1 = await makeStandin(season.id, "Open Seat A");
    const s2 = await makeStandin(season.id, "Open Seat B");

    const results = await raceAll(
      [s1, s2].map(
        (s) => () =>
          assignStandinGuarded({
            matchId: match.id,
            standinUserId: s.id,
            replacingUserId: null,
            teamId: home.id,
            actingCaptainId: null,
          }),
      ),
    );

    expect(okCount(results)).toBe(1);
    expect(
      await prisma.standinAssignment.count({
        where: { matchId: match.id, teamId: home.id, replacingUserId: null },
      }),
    ).toBe(1);
  });

  // Pins the tx re-read of findClashingCover: one human, two fixtures, one
  // night. Outside the tx both assigns see an empty field.
  it("one standin raced onto two same-night fixtures holds exactly one booking", async () => {
    const a = await midSeasonMatch();
    // Second fixture in the SAME season at the same kickoff (between the same
    // two teams is fine — the clash rule cares about the standin, not the
    // pairing).
    const match2 = await prisma.match.create({
      data: {
        seasonId: a.season.id,
        week: 1,
        phase: "REGULAR",
        homeTeamId: a.home.id,
        awayTeamId: a.away.id,
        bestOf: 2,
        scheduledAt: a.match.scheduledAt,
      },
    });
    const s = await makeStandin(a.season.id, "Double Booker");

    const results = await raceAll(
      [a.match.id, match2.id].map(
        (matchId) => () =>
          assignStandinGuarded({
            matchId,
            standinUserId: s.id,
            replacingUserId: a.rostered[0].id,
            actingCaptainId: null,
          }),
      ),
    );

    expect(okCount(results)).toBe(1);
    expect(
      await prisma.standinAssignment.count({
        where: { standinUserId: s.id },
      }),
    ).toBe(1);
  });

  // The assign-vs-RELEASE write-skew pair: assign reads the replaced player's
  // TeamMember and writes an assignment; release reads the assignments and
  // deletes the TeamMember. Both sides are Serializable and each re-reads the
  // other's table in-tx, so one of a conflicting pair must lose — unguarded,
  // both commit and the released player's cover survives as a stale row that
  // matchNightRoster counts as a SIXTH player whose stand-down never fired.
  // Invariant: after the dust settles there is never cover for a seat whose
  // player is gone.
  it("assign racing releasePlayer never strands cover for the released seat", async () => {
    for (let i = 0; i < 3; i++) {
      const { season, match, rostered } = await midSeasonMatch();
      const covered = rostered[0];
      const s = await makeStandin(season.id, `Release Racer ${i}`);
      const member = await prisma.teamMember.findFirstOrThrow({
        where: { userId: covered.id },
      });

      await raceAll<unknown>([
        () =>
          assignStandinGuarded({
            matchId: match.id,
            standinUserId: s.id,
            replacingUserId: covered.id,
            actingCaptainId: null,
          }),
        () => releasePlayer({}, fd({ memberId: member.id })),
      ]);

      const memberGone =
        (await prisma.teamMember.count({ where: { id: member.id } })) === 0;
      const staleCover = await prisma.standinAssignment.count({
        where: { matchId: match.id, replacingUserId: covered.id },
      });
      // The release path can legitimately lose (P2034 → clean error, player
      // still rostered, cover fine). What must NEVER happen is both winning.
      if (memberGone) expect(staleCover).toBe(0);
      // Each loop is an independent season/race repetition. Hand the league
      // into offseason before creating the next fixture so the test obeys the
      // same single-active-season invariant as production.
      if (i < 2) {
        await prisma.season.update({
          where: { id: season.id },
          data: { isActive: false },
        });
      }
    }
  });

  // The assign-vs-WITHDRAW pair from the assign side, raced (the registration
  // suite seams the withdraw side): a standin self-withdrawing while a
  // captain books them must end as exactly one of the two outcomes — never a
  // WITHDRAWN registration holding live cover.
  it("assign racing the standin's own leaveLeague never leaves a withdrawn standin covering", async () => {
    for (let i = 0; i < 3; i++) {
      const { season, match, rostered } = await midSeasonMatch();
      const s = await makeStandin(season.id, `Withdraw Racer ${i}`);
      vi.mocked(requireUser).mockResolvedValue(sessionFor(s));

      await raceAll<unknown>([
        () =>
          assignStandinGuarded({
            matchId: match.id,
            standinUserId: s.id,
            replacingUserId: rostered[0].id,
            actingCaptainId: null,
          }),
        () => leaveLeague({}, new FormData()),
      ]);

      const reg = await prisma.registration.findUniqueOrThrow({
        where: { seasonId_userId: { seasonId: season.id, userId: s.id } },
      });
      const cover = await prisma.standinAssignment.count({
        where: { standinUserId: s.id },
      });
      if (reg.status === "WITHDRAWN") expect(cover).toBe(0);
      // (ACTIVE + cover, or ACTIVE + no cover after a lost assign, are both
      // legal end states — the invariant is only about the withdrawn+covering
      // combination.)
      if (i < 2) {
        await prisma.season.update({
          where: { id: season.id },
          data: { isActive: false },
        });
      }
    }
  });
});
