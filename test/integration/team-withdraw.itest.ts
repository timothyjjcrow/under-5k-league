import { afterEach, describe, expect, it, vi } from "vitest";

// withdrawTeam is the tool for the most common amateur-league disaster — a
// whole team quitting mid-season. Before it existed the admin hand-typed a
// forfeit score for every remaining fixture, week after week, while the dead
// team stayed in the standings math, pick'em and the reminders, and got
// seeded into the playoff bracket on its banked points.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
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

import { reinstateTeam, withdrawTeam } from "@/app/actions/admin";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { createPlayoffBracket } from "@/lib/playoff-service";
import { prisma } from "@/lib/prisma";
import { sendDiscordMessage } from "@/lib/discord";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  recordMatch,
} from "./factories";

const mockSend = vi.mocked(sendDiscordMessage);

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function midSeason(teamCount = 4) {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const teams = [];
  for (let i = 0; i < teamCount; i++) {
    teams.push(await makeTeam(season.id, `WD Team ${i}`, i));
  }
  const matches = await generateRegularSchedule(season.id);
  return { season, teams, matches };
}

describe("withdrawTeam", () => {
  afterEach(() => setRaceHook(null));

  it("forfeits every unplayed fixture to the opponent and flags the team", async () => {
    const { teams, matches } = await midSeason();
    const quitter = teams[0];
    const mine = matches.filter(
      (m) => m.homeTeamId === quitter.id || m.awayTeamId === quitter.id,
    );
    // One match already PLAYED for real — its result must survive untouched.
    const played = mine[0];
    await recordMatch(played.id, 2, 0);
    // A pending proposal on a doomed fixture — nobody should be left waiting
    // on an answer about a match that just got ruled.
    const doomed = mine[1];
    await prisma.rescheduleRequest.create({
      data: {
        matchId: doomed.id,
        proposedById: quitter.captainId,
        proposedTime: new Date(Date.now() + 3600_000),
      },
    });
    mockSend.mockClear();

    const res = await withdrawTeam(null, fd({ teamId: quitter.id }));

    expect(res).toMatchObject({
      message: expect.stringMatching(/withdrawn · 2 fixture\(s\) forfeited/),
    });
    // The team is flagged; roster/rows kept.
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: quitter.id } }))
        .withdrawn,
    ).toBe(true);
    // Unplayed fixtures: COMPLETED, forfeit, 0-N to the opponent.
    for (const m of mine.slice(1)) {
      const row = await prisma.match.findUniqueOrThrow({ where: { id: m.id } });
      expect(row.status).toBe(MATCH_STATUS.COMPLETED);
      expect(row.forfeit).toBe(true);
      const opponent =
        m.homeTeamId === quitter.id ? m.awayTeamId : m.homeTeamId;
      expect(row.winnerTeamId).toBe(opponent);
      const quitterScore =
        m.homeTeamId === quitter.id ? row.homeScore : row.awayScore;
      const opponentScore =
        m.homeTeamId === quitter.id ? row.awayScore : row.homeScore;
      expect(quitterScore).toBe(0);
      expect(opponentScore).toBe(Math.floor(row.bestOf / 2) + 1);
    }
    // The real result was never rewritten.
    const kept = await prisma.match.findUniqueOrThrow({
      where: { id: played.id },
    });
    expect(kept.forfeit).toBe(false);
    expect(kept.homeScore).toBe(2);
    // The stranded proposal was cancelled with its fixture.
    expect(
      (
        await prisma.rescheduleRequest.findFirstOrThrow({
          where: { matchId: doomed.id },
        })
      ).status,
    ).toBe("CANCELLED");
    // One broadcast, naming the withdrawal — not N result pings.
    const sent = mockSend.mock.calls.map((c) => String(c[0]));
    expect(sent.some((m) => m.includes("withdrawn from the season"))).toBe(
      true,
    );
    // The record outlives the click.
    const log = await prisma.adminAction.findFirst({
      where: { action: "withdrawTeam" },
      orderBy: { createdAt: "desc" },
    });
    expect(log?.summary).toMatch(/2 remaining fixture\(s\) forfeited/);
  });

  it("is REGULAR_SEASON-only, with the right pointer per phase", async () => {
    const { teams } = await midSeason();
    await prisma.season.updateMany({ data: { status: SEASON_STATUS.SIGNUPS } });
    const early = await withdrawTeam(null, fd({ teamId: teams[0].id }));
    expect(early).toMatchObject({
      error: expect.stringMatching(/remove the captain/i),
    });
    await prisma.season.updateMany({
      data: { status: SEASON_STATUS.PLAYOFFS },
    });
    const late = await withdrawTeam(null, fd({ teamId: teams[0].id }));
    expect(late).toMatchObject({
      error: expect.stringMatching(/Save as final/),
    });
  });

  it("a withdrawn team is excluded from playoff seeding, whatever it banked", async () => {
    const { season, teams, matches } = await midSeason();
    const quitter = teams[0];
    // The quitter WINS its early games — banked points that would seed it.
    for (const m of matches) {
      const home = m.homeTeamId === quitter.id;
      const away = m.awayTeamId === quitter.id;
      if (home) await recordMatch(m.id, 2, 0);
      else if (away) await recordMatch(m.id, 0, 2);
    }
    await withdrawTeam(null, fd({ teamId: quitter.id }));
    // Finish the rest of the slate for real.
    for (const m of matches) {
      const row = await prisma.match.findUniqueOrThrow({ where: { id: m.id } });
      if (row.status !== MATCH_STATUS.COMPLETED) await recordMatch(m.id, 2, 0);
    }

    await createPlayoffBracket(season.id);

    const bracket = await prisma.match.findMany({
      where: { seasonId: season.id, phase: { not: MATCH_PHASE.REGULAR } },
    });
    expect(bracket.length).toBeGreaterThan(0);
    for (const b of bracket) {
      expect(b.homeTeamId).not.toBe(quitter.id);
      expect(b.awayTeamId).not.toBe(quitter.id);
    }
    // 3 alive teams → a size-2 bracket (single grand final).
    expect(bracket).toHaveLength(1);
    expect(bracket[0].phase).toBe(MATCH_PHASE.FINAL);
  });

  it("reinstateTeam flips the flag back (and only when withdrawn)", async () => {
    const { teams } = await midSeason();
    const target = teams[1];
    expect(await reinstateTeam(null, fd({ teamId: target.id }))).toMatchObject({
      error: expect.stringMatching(/isn't withdrawn/i),
    });
    await withdrawTeam(null, fd({ teamId: target.id }));
    const res = await reinstateTeam(null, fd({ teamId: target.id }));
    expect(res).toMatchObject({
      message: expect.stringMatching(/reinstated/i),
    });
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: target.id } }))
        .withdrawn,
    ).toBe(false);
  });

  it("a REAL result landing mid-withdrawal wins — the forfeit claim is skipped", async () => {
    // RACED, not staged: staging a completed match before the call is caught
    // by the action's own read-time filter, so the test would pass against a
    // blind write (verified — that sabotage survived the staged version).
    // Here the rival commits in the gap the seam holds open, which is exactly
    // auto-sync importing from a visitor's page view mid-click.
    const { teams, matches } = await midSeason();
    const quitter = teams[0];
    const mine = matches.filter(
      (m) => m.homeTeamId === quitter.id || m.awayTeamId === quitter.id,
    );
    const sniped = mine[0];
    let fired = false;
    setRaceHook(
      onceAt("admin.withdrawTeam.beforeTx", async () => {
        fired = true;
        // The quitter actually turned up and WON this one before quitting.
        const asHome = sniped.homeTeamId === quitter.id;
        await recordMatch(sniped.id, asHome ? 2 : 0, asHome ? 0 : 2);
      }),
    );

    const res = await withdrawTeam(null, fd({ teamId: quitter.id }));

    expect(fired).toBe(true);
    // The real result STANDS — not overwritten by the forfeit ruling.
    const row = await prisma.match.findUniqueOrThrow({
      where: { id: sniped.id },
    });
    expect(row.forfeit).toBe(false);
    expect(row.winnerTeamId).toBe(quitter.id);
    // …and the toast counts it honestly rather than claiming it forfeited.
    expect(res).toMatchObject({
      message: expect.stringMatching(/completed for real while you clicked/),
    });
  });

  it("withdrawing twice is refused by the CLAIM, not a read-time check", async () => {
    // There is deliberately no read-time `if (team.withdrawn)` — it would be
    // strictly weaker (the forfeit legs would still run) and would make the
    // claim untestable. Deleting the `withdrawn: false` predicate turns this
    // red, which is the whole point.
    const { teams, matches } = await midSeason();
    const quitter = teams[0];
    await withdrawTeam(null, fd({ teamId: quitter.id }));
    const scoresAfterFirst = await prisma.match.findMany({
      where: { id: { in: matches.map((m) => m.id) } },
      select: { id: true, homeScore: true, awayScore: true, forfeit: true },
      orderBy: { id: "asc" },
    });

    const again = await withdrawTeam(null, fd({ teamId: quitter.id }));

    expect(again).toMatchObject({
      error: expect.stringMatching(/already withdrawn/i),
    });
    // …and nothing moved on the second pass.
    const scoresAfterSecond = await prisma.match.findMany({
      where: { id: { in: matches.map((m) => m.id) } },
      select: { id: true, homeScore: true, awayScore: true, forfeit: true },
      orderBy: { id: "asc" },
    });
    expect(scoresAfterSecond).toEqual(scoresAfterFirst);
    expect(
      await prisma.adminAction.count({ where: { action: "withdrawTeam" } }),
    ).toBe(1); // no second log line, no second Discord broadcast
  });

  it("only OPEN proposals are cancelled — a settled one keeps its status", async () => {
    const { teams, matches } = await midSeason();
    const quitter = teams[0];
    const mine = matches.filter(
      (m) => m.homeTeamId === quitter.id || m.awayTeamId === quitter.id,
    );
    const settled = await prisma.rescheduleRequest.create({
      data: {
        matchId: mine[0].id,
        proposedById: quitter.captainId,
        proposedTime: new Date(Date.now() + 3600_000),
        status: "ACCEPTED",
      },
    });
    const open = await prisma.rescheduleRequest.create({
      data: {
        matchId: mine[1].id,
        proposedById: quitter.captainId,
        proposedTime: new Date(Date.now() + 3600_000),
      },
    });

    await withdrawTeam(null, fd({ teamId: quitter.id }));

    // The ACCEPTED record of what the captains agreed is history — rewriting
    // it to CANCELLED would erase why the fixture moved.
    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: settled.id },
        })
      ).status,
    ).toBe("ACCEPTED");
    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: open.id },
        })
      ).status,
    ).toBe("CANCELLED");
  });
});

describe("withdrawTeam — booked standins are stood down with their fixtures", () => {
  afterEach(() => setRaceHook(null));

  /** A linked standin booked to cover a seat (either side) on one fixture. */
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
      data: { matchId, teamId, standinUserId: standin.id, replacingUserId: null },
    });
    return standin;
  }

  it("a standin on a doomed fixture is stood down by name, with a ping — and the toast says so", async () => {
    // Pins the post-commit stand-down loop: every booking on a forfeited
    // fixture gets standinRemovedMessage + mentionsOf([discordId]). The human
    // holds a live @-mentioned instruction to show up, and the row vanishing
    // from /me (pendingCoverWhere filters COMPLETED) can't correct them.
    const { teams, matches } = await midSeason();
    const quitter = teams[0];
    const doomed = matches.find(
      (m) => m.homeTeamId === quitter.id || m.awayTeamId === quitter.id,
    )!;
    await bookCover(doomed.id, quitter.id, "Moot Cover", "800000000000000001");
    mockSend.mockClear();

    const res = await withdrawTeam(null, fd({ teamId: quitter.id }));

    const standDown = mockSend.mock.calls.find(([m]) =>
      String(m).includes("stand down"),
    );
    expect(standDown, "the booked standin must be stood down").toBeTruthy();
    expect(String(standDown![0])).toContain("Moot Cover");
    // …and PINGED — they were @-mentioned when told to show up.
    expect(standDown![1]).toEqual({ users: ["800000000000000001"] });
    expect(res).toMatchObject({
      message: expect.stringMatching(
        /1 standin booking\(s\) on those fixtures stood down/,
      ),
    });
  });

  it("cover on the OPPONENT's side of a doomed fixture dies with it too", async () => {
    // The fixture is dead for BOTH sides — mootCover keys on the match, never
    // on the withdrawing team's side of it, and the message names the team
    // the standin was actually covering for.
    const { teams, matches } = await midSeason();
    const quitter = teams[0];
    const doomed = matches.find(
      (m) => m.homeTeamId === quitter.id || m.awayTeamId === quitter.id,
    )!;
    const opponentId =
      doomed.homeTeamId === quitter.id ? doomed.awayTeamId : doomed.homeTeamId;
    const opponent = teams.find((t) => t.id === opponentId)!;
    await bookCover(doomed.id, opponentId, "Rival Cover", "800000000000000002");
    mockSend.mockClear();

    await withdrawTeam(null, fd({ teamId: quitter.id }));

    const standDown = mockSend.mock.calls.find(([m]) =>
      String(m).includes("stand down"),
    );
    expect(standDown, "the opponent's cover must be stood down too").toBeTruthy();
    expect(String(standDown![0])).toContain("Rival Cover");
    expect(String(standDown![0])).toContain(
      `no longer standing in for **${opponent.name}**`,
    );
    expect(standDown![1]).toEqual({ users: ["800000000000000002"] });
  });

  it("a booking on an already-played fixture is untouched — no send, no toast note", async () => {
    // The stand-down list is scoped to the OPEN fixtures the withdraw dooms:
    // cover on a series that completed beforehand is history (its standin may
    // well have played it) and must not be told to stand down.
    const { teams, matches } = await midSeason();
    const quitter = teams[0];
    const mine = matches.filter(
      (m) => m.homeTeamId === quitter.id || m.awayTeamId === quitter.id,
    );
    const played = mine[0];
    await recordMatch(played.id, 2, 0);
    await bookCover(played.id, quitter.id, "Played Cover", "800000000000000003");
    mockSend.mockClear();

    const res = await withdrawTeam(null, fd({ teamId: quitter.id }));

    expect(
      mockSend.mock.calls.some(([m]) => String(m).includes("stand down")),
    ).toBe(false);
    expect(res).toMatchObject({
      message: expect.not.stringMatching(/stood down/),
    });
    // …and the booking row survives as the record of who played.
    expect(
      await prisma.standinAssignment.count({ where: { matchId: played.id } }),
    ).toBe(1);
  });

  it("a fixture completed for real mid-click keeps its booking un-stood-down (seam)", async () => {
    // matchClaims is index-aligned with `open`: only bookings whose forfeit
    // claim WON may send. The rival is auto-sync completing the fixture from
    // a visitor's page view in the gap — that series happened, its standin
    // may have played it, and mootCover was fetched BEFORE the rival landed,
    // so without the claim filter the send fires anyway.
    const { teams, matches } = await midSeason();
    const quitter = teams[0];
    const mine = matches.filter(
      (m) => m.homeTeamId === quitter.id || m.awayTeamId === quitter.id,
    );
    const sniped = mine[0];
    const doomed = mine[1];
    await bookCover(sniped.id, quitter.id, "Sniped Cover", "800000000000000004");
    await bookCover(doomed.id, quitter.id, "Doomed Cover", "800000000000000005");
    let fired = false;
    setRaceHook(
      onceAt("admin.withdrawTeam.beforeTx", async () => {
        fired = true;
        const asHome = sniped.homeTeamId === quitter.id;
        await recordMatch(sniped.id, asHome ? 2 : 0, asHome ? 0 : 2);
      }),
    );
    mockSend.mockClear();

    const res = await withdrawTeam(null, fd({ teamId: quitter.id }));

    expect(fired).toBe(true);
    const standDowns = mockSend.mock.calls.filter(([m]) =>
      String(m).includes("stand down"),
    );
    // Exactly one: the genuinely forfeited fixture's cover, never the played one.
    expect(standDowns).toHaveLength(1);
    expect(String(standDowns[0][0])).toContain("Doomed Cover");
    expect(String(standDowns[0][0])).not.toContain("Sniped Cover");
    expect(res).toMatchObject({
      message: expect.stringMatching(
        /1 standin booking\(s\) on those fixtures stood down/,
      ),
    });
  });
});
