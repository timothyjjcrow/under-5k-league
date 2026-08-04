import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

// signFreeAgent is a server action: stub the request-scope bits so it can be
// driven against the test DB.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => ({ id: "audit-admin", name: "Audit Admin" })),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { sendDiscordMessage } from "@/lib/discord";
const mockSend = vi.mocked(sendDiscordMessage);
import {
  promoteStandinToPlayer,
  releasePlayer,
  signFreeAgent,
  startDraft,
  withdrawSignup,
} from "@/app/actions/admin";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
  ON_POSTGRES,
} from "./factories";

// Roster top-ups after the draft. These guards are what keep a season's
// rosters legal once the auction is over — and signFreeAgent had no coverage
// at all, so its Serializable seat claim and standin check were unverified.

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function setup(teamSize = 5) {
  const season = await makeSeason({
    status: SEASON_STATUS.REGULAR_SEASON,
    teamSize,
  });
  const team = await makeTeam(season.id, "Shorthanded", 0);
  const other = await makeTeam(season.id, "Opponent", 1);
  // A registered, unrostered full player — the free agent.
  const agent = await makeUser("Free Agent");
  await prisma.registration.create({
    data: {
      seasonId: season.id,
      userId: agent.id,
      type: REGISTRATION_TYPE.PLAYER,
      status: "ACTIVE",
      mmr: 3000,
      roles: "1",
    },
  });
  return { season, team, other, agent };
}

describe("signFreeAgent", () => {
  it("signs a registered free agent into an open seat", async () => {
    const { team, agent } = await setup();
    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));
    expect(res).toHaveProperty("message");
    const seat = await prisma.teamMember.findFirst({
      where: { teamId: team.id, userId: agent.id },
    });
    expect(seat).not.toBeNull();
    expect(seat?.price).toBe(0);
    expect(seat?.isCaptain).toBe(false);
  });

  it("refuses when the roster is already full", async () => {
    const { season, team, agent } = await setup(1);
    // teamSize 1 — fill the single seat first.
    const filler = await makeUser("Filler");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: filler.id, price: 0 },
    });
    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));
    expect(res).toMatchObject({ error: expect.stringMatching(/no open roster seats/i) });
  });

  it("never overfills a seat under concurrent signs", async () => {
    // The Postgres race this guards: two admins (or one with two tabs) signing
    // different players into the last seat both read "room available" under
    // read-committed and both insert. SQLite serializes writers so this passes
    // either way here — the assertion is that the SERIALIZABLE claim didn't
    // break the normal path or the guard.
    const { season, team, agent } = await setup(2);
    const filler = await makeUser("Captainish");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: filler.id, price: 0 },
    });
    const second = await makeUser("Second Agent");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: second.id,
        type: REGISTRATION_TYPE.PLAYER,
        status: "ACTIVE",
        mmr: 2500,
        roles: "2",
      },
    });

    const results = await Promise.allSettled([
      signFreeAgent(null, fd({ teamId: team.id, userId: agent.id })),
      signFreeAgent(null, fd({ teamId: team.id, userId: second.id })),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const seats = await prisma.teamMember.count({ where: { teamId: team.id } });
    expect(seats).toBeLessThanOrEqual(2); // teamSize — never overfilled
  });

  it("refuses a player who is standing in on an unplayed match", async () => {
    // Signing them would put ONE account in both teams' account sets for that
    // match, so classifyGame sees the same player on each side and every
    // import path for it fails.
    const { season, team, other, agent } = await setup();
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 3,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: other.id,
        awayTeamId: team.id,
        bestOf: 2,
        status: MATCH_STATUS.SCHEDULED,
      },
    });
    const covered = await makeUser("Covered Player");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: other.id, userId: covered.id, price: 1 },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: other.id,
        standinUserId: agent.id,
        replacingUserId: covered.id,
      },
    });

    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));
    expect(res).toMatchObject({ error: expect.stringMatching(/standing in/i) });
    const seat = await prisma.teamMember.findFirst({
      where: { teamId: team.id, userId: agent.id },
    });
    expect(seat).toBeNull();
  });

  it("allows the sign once that match has been played", async () => {
    const { season, team, other, agent } = await setup();
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 3,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: other.id,
        awayTeamId: team.id,
        bestOf: 2,
        status: MATCH_STATUS.COMPLETED,
      },
    });
    const covered = await makeUser("Covered Player 2");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: other.id, userId: covered.id, price: 1 },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: other.id,
        standinUserId: agent.id,
        replacingUserId: covered.id,
      },
    });

    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));
    expect(res).toHaveProperty("message");
  });
});

// A release is three things, not one: free the seat, RETURN THE FEE, and cancel
// the cover that existed for that seat. Doing only the first broke the auction's
// `budget >= need * MIN_BID` invariant and left match-night rosters one player
// too large.
describe("releasePlayer — refunds the fee and cancels cover for the seat", () => {
  async function rosteredWithMatch(price: number) {
    const season = await makeSeason({
      teamSize: 5,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const alpha = await makeTeam(season.id, "Alpha", 0);
    const bravo = await makeTeam(season.id, "Bravo", 1);
    const p = await makePlayer(season.id, "Released Player", 3000);
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: alpha.id, userId: p.id, price },
    });
    await prisma.team.update({
      where: { id: alpha.id },
      data: { budget: 100 - price },
    });
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 4,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: alpha.id,
        awayTeamId: bravo.id,
        bestOf: 2,
        status: MATCH_STATUS.SCHEDULED,
      },
    });
    return { season, alpha, bravo, p, match };
  }

  it("returns the fee to the team, restoring budget + spent", async () => {
    const { alpha, p } = await rosteredWithMatch(57);
    const member = await prisma.teamMember.findFirstOrThrow({
      where: { userId: p.id },
    });

    const res = await releasePlayer({}, fd({ memberId: member.id }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/\$57 refunded/);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: alpha.id } })).budget).toBe(100);
  });

  // Being told to turn up for a game is the most action-demanding message this
  // league sends. Both removeStandin paths announce the stand-down; release
  // cancelled the booking in SILENCE, so the standin kept a live @mention
  // telling them to play a match they had been dropped from.
  it("announces the stand-down to the standin it just cancelled", async () => {
    const { season, alpha, p, match } = await rosteredWithMatch(20);
    const standin = await makePlayer(season.id, "Cover Caller", 2500);
    await prisma.user.update({
      where: { id: standin.id },
      data: { discordId: "111222333444555666" },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: alpha.id,
        standinUserId: standin.id,
        replacingUserId: p.id,
      },
    });
    const member = await prisma.teamMember.findFirstOrThrow({
      where: { userId: p.id },
    });
    mockSend.mockClear();

    await releasePlayer({}, fd({ memberId: member.id }));

    const standDown = mockSend.mock.calls.find(([msg]) =>
      String(msg).includes("no longer standing in"),
    );
    expect(standDown, "release must send a stand-down").toBeTruthy();
    expect(String(standDown![0])).toContain("Cover Caller");
    // …and it must PING them, not just state it into the channel.
    expect(standDown![1]).toEqual({ users: ["111222333444555666"] });
  });

  // The counterpart guard: cover on a series that already has a game is
  // deliberately LEFT in place, so no stand-down may be claimed for it.
  it("sends no stand-down for cover it deliberately left alone", async () => {
    const { season, alpha, bravo, p, match } = await rosteredWithMatch(20);
    const standin = await makePlayer(season.id, "Mid Series", 2500);
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: alpha.id,
        standinUserId: standin.id,
        replacingUserId: p.id,
      },
    });
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "990001",
        radiantWin: true,
        winnerTeamId: bravo.id,
        players: "[]",
      },
    });
    const member = await prisma.teamMember.findFirstOrThrow({
      where: { userId: p.id },
    });
    mockSend.mockClear();

    await releasePlayer({}, fd({ memberId: member.id }));

    expect(
      mockSend.mock.calls.some(([msg]) =>
        String(msg).includes("no longer standing in"),
      ),
    ).toBe(false);
  });

  it("cancels standin assignments covering the released player", async () => {
    const { season, alpha, p, match } = await rosteredWithMatch(20);
    const standin = await makePlayer(season.id, "Cover", 2500);
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: alpha.id,
        standinUserId: standin.id,
        replacingUserId: p.id,
      },
    });
    const member = await prisma.teamMember.findFirstOrThrow({
      where: { userId: p.id },
    });

    const res = await releasePlayer({}, fd({ memberId: member.id }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).toMatch(/standin assignment\(s\) covering them cancelled/);
    expect(await prisma.standinAssignment.count({ where: { matchId: match.id } })).toBe(0);
  });

  it("leaves cover on an ALREADY PLAYED match alone — that is history", async () => {
    const { season, alpha, bravo, p } = await rosteredWithMatch(20);
    const standin = await makePlayer(season.id, "Cover", 2500);
    const played = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: alpha.id,
        awayTeamId: bravo.id,
        bestOf: 2,
        status: MATCH_STATUS.COMPLETED,
        winnerTeamId: alpha.id,
      },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId: played.id,
        teamId: alpha.id,
        standinUserId: standin.id,
        replacingUserId: p.id,
      },
    });
    const member = await prisma.teamMember.findFirstOrThrow({
      where: { userId: p.id },
    });

    await releasePlayer({}, fd({ memberId: member.id }));

    expect(await prisma.standinAssignment.count({ where: { matchId: played.id } })).toBe(1);
  });

  it("does not touch cover for a DIFFERENT player on the same match", async () => {
    const { season, alpha, p, match } = await rosteredWithMatch(20);
    const other = await makePlayer(season.id, "Other Player", 3100);
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: alpha.id, userId: other.id, price: 5 },
    });
    const s1 = await makePlayer(season.id, "Cover One", 2500);
    const s2 = await makePlayer(season.id, "Cover Two", 2600);
    await prisma.standinAssignment.createMany({
      data: [
        { matchId: match.id, teamId: alpha.id, standinUserId: s1.id, replacingUserId: p.id },
        { matchId: match.id, teamId: alpha.id, standinUserId: s2.id, replacingUserId: other.id },
      ],
    });
    const member = await prisma.teamMember.findFirstOrThrow({ where: { userId: p.id } });

    await releasePlayer({}, fd({ memberId: member.id }));

    const left = await prisma.standinAssignment.findMany({ where: { matchId: match.id } });
    expect(left).toHaveLength(1);
    expect(left[0].replacingUserId).toBe(other.id);
  });

  it("LEAVES cover in place on a series that already has imported games", async () => {
    // removeStandinGuarded refuses this deletion because gatherTeamAccounts
    // re-reads assignments on every import — dropping the standin mid-Bo3 takes
    // them out of the team's account set for games 2 and 3. Release must not do
    // it by the back door; it reports the assignment instead.
    const { season, alpha, p, match } = await rosteredWithMatch(20);
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.LIVE, bestOf: 3, homeScore: 1 },
    });
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "8333333333",
        radiantWin: true,
        winnerTeamId: alpha.id,
        players: "[]",
      },
    });
    const standin = await makePlayer(season.id, "Mid Series Cover", 2500);
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: alpha.id,
        standinUserId: standin.id,
        replacingUserId: p.id,
      },
    });
    const member = await prisma.teamMember.findFirstOrThrow({ where: { userId: p.id } });

    const res = await releasePlayer({}, fd({ memberId: member.id }));

    expect(res?.error).toBeUndefined();
    expect(await prisma.standinAssignment.count({ where: { matchId: match.id } })).toBe(1);
    // "stay in place", with no removal advice: removeStandinGuarded refuses
    // once games import, so the old "remove by hand" pointed at a dead end.
    expect(res?.message).toMatch(/stay in place/);
    expect(res?.message).toMatch(/record whoever actually plays/);
    expect(res?.message).not.toMatch(/cancelled/);
    expect(res?.message).not.toMatch(/remove by hand/);
  });

  it("cancels the not-yet-started series' cover while keeping the in-progress one", async () => {
    const { season, alpha, bravo, p, match } = await rosteredWithMatch(20);
    // match = untouched (SCHEDULED, no games) -> cancel
    const started = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 5,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: alpha.id,
        awayTeamId: bravo.id,
        bestOf: 3,
        status: MATCH_STATUS.LIVE,
      },
    });
    await prisma.game.create({
      data: {
        matchId: started.id,
        dotaMatchId: "8444444444",
        radiantWin: true,
        winnerTeamId: alpha.id,
        players: "[]",
      },
    });
    const s1 = await makePlayer(season.id, "Cover Scheduled", 2500);
    const s2 = await makePlayer(season.id, "Cover Live", 2600);
    await prisma.standinAssignment.createMany({
      data: [
        { matchId: match.id, teamId: alpha.id, standinUserId: s1.id, replacingUserId: p.id },
        { matchId: started.id, teamId: alpha.id, standinUserId: s2.id, replacingUserId: p.id },
      ],
    });
    const member = await prisma.teamMember.findFirstOrThrow({ where: { userId: p.id } });

    const res = await releasePlayer({}, fd({ memberId: member.id }));

    expect(res?.message).toMatch(/1 standin assignment\(s\) covering them cancelled/);
    expect(res?.message).toMatch(/1 assignment\(s\) on an already-started series stay in place/);
    expect(await prisma.standinAssignment.count({ where: { matchId: match.id } })).toBe(0);
    expect(await prisma.standinAssignment.count({ where: { matchId: started.id } })).toBe(1);
  });

  it("says nothing about refunds for a $0 free-agent signing", async () => {
    const { p } = await rosteredWithMatch(0);
    const member = await prisma.teamMember.findFirstOrThrow({ where: { userId: p.id } });

    const res = await releasePlayer({}, fd({ memberId: member.id }));

    expect(res?.error).toBeUndefined();
    expect(res?.message).not.toMatch(/refunded/);
  });
});

// Withdrawing a standin who still owes cover left the covered team looking
// staffed on match night by somebody who had left the league — and nothing
// downstream re-checks registration status.
describe("withdrawSignup — refuses a standin who still owes cover", () => {
  async function standinOnTheHook() {
    const season = await makeSeason({
      teamSize: 5,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const alpha = await makeTeam(season.id, "Alpha", 0);
    const bravo = await makeTeam(season.id, "Bravo", 1);
    const covered = await makePlayer(season.id, "Covered Player", 3000);
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: alpha.id, userId: covered.id, price: 10 },
    });
    const standin = await makePlayer(season.id, "The Standin", 2500);
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: standin.id } },
      data: { type: REGISTRATION_TYPE.STANDIN },
    });
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 4,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: alpha.id,
        awayTeamId: bravo.id,
        bestOf: 2,
        status: MATCH_STATUS.SCHEDULED,
      },
    });
    return { season, alpha, covered, standin, match };
  }

  it("refuses while the assignment is on an unplayed match", async () => {
    const { season, alpha, covered, standin, match } = await standinOnTheHook();
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: alpha.id,
        standinUserId: standin.id,
        replacingUserId: covered.id,
      },
    });
    const reg = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: standin.id } },
    });

    const res = await withdrawSignup({}, fd({ registrationId: reg.id }));

    expect(res?.error).toMatch(/standing in for an unplayed match/i);
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe("ACTIVE"); // untouched
  });

  it("allows it once the assignment is removed", async () => {
    const { season, alpha, covered, standin, match } = await standinOnTheHook();
    const a = await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: alpha.id,
        standinUserId: standin.id,
        replacingUserId: covered.id,
      },
    });
    const reg = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: standin.id } },
    });
    await prisma.standinAssignment.delete({ where: { id: a.id } });

    const res = await withdrawSignup({}, fd({ registrationId: reg.id }));

    expect(res?.error).toBeUndefined();
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).not.toBe("ACTIVE");
  });

  it("allows it when the only assignment is on a COMPLETED match", async () => {
    const { season, alpha, covered, standin } = await standinOnTheHook();
    const played = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: alpha.id,
        awayTeamId: (await prisma.team.findFirstOrThrow({ where: { name: "Bravo" } })).id,
        bestOf: 2,
        status: MATCH_STATUS.COMPLETED,
        winnerTeamId: alpha.id,
      },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId: played.id,
        teamId: alpha.id,
        standinUserId: standin.id,
        replacingUserId: covered.id,
      },
    });
    const reg = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: standin.id } },
    });

    const res = await withdrawSignup({}, fd({ registrationId: reg.id }));

    expect(res?.error).toBeUndefined();
  });
});

describe("signFreeAgent — redundant empty-seat cover (the reverse of releasePlayer's rule)", () => {
  // An empty-seat assignment is permanently "live" to matchNightRoster, so a
  // signing that fills the team's last seat must cancel it — left behind, the
  // refilled side computes as teamSize+1 everywhere (schedule counts, the week
  // reminder, gatherTeamAccounts' import set) and the standin keeps a live
  // @-mentioned instruction to show up for a seat that no longer exists.
  async function withEmptySeatCover(teamSize: number, withGame = false) {
    const season = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
      teamSize,
    });
    const team = await makeTeam(season.id, "Shorthanded", 0);
    const other = await makeTeam(season.id, "Opponent", 1);
    const filler = await makeUser("Filler");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: filler.id, price: 0 },
    });
    const agent = await makeUser("Free Agent");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: agent.id,
        type: REGISTRATION_TYPE.PLAYER,
        status: "ACTIVE",
        mmr: 3000,
        roles: "1",
      },
    });
    const standin = await makeUser("Cover Standin");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: standin.id,
        type: REGISTRATION_TYPE.STANDIN,
        status: "ACTIVE",
        mmr: 2500,
      },
    });
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: team.id,
        awayTeamId: other.id,
        bestOf: 2,
      },
    });
    if (withGame) {
      await prisma.game.create({
        data: {
          matchId: match.id,
          dotaMatchId: `84${Math.floor(Math.random() * 1e8)}`,
          radiantWin: true,
          winnerTeamId: team.id,
          players: "[]",
        },
      });
    }
    const cover = await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: team.id,
        standinUserId: standin.id,
        replacingUserId: null,
      },
    });
    return { season, team, agent, standin, match, cover };
  }

  it("cancels the booking and stands the standin down when the last seat fills", async () => {
    const { team, agent, cover, standin } = await withEmptySeatCover(2);
    mockSend.mockClear();

    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));

    expect(res).toMatchObject({
      message: expect.stringMatching(/open-seat standin booking\(s\) cancelled/i),
    });
    expect(
      await prisma.standinAssignment.findUnique({ where: { id: cover.id } }),
    ).toBeNull();
    // The stand-down went out (signing announcement + one stand-down).
    const sent = mockSend.mock.calls.map((c) => String(c[0]));
    expect(sent.some((m) => m.includes(standin.name))).toBe(true);
  });

  it("keeps the booking on an already-started series and says so", async () => {
    const { team, agent, cover } = await withEmptySeatCover(2, true);

    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));

    expect(res).toMatchObject({
      message: expect.stringMatching(/LEFT in place/),
    });
    expect(
      await prisma.standinAssignment.findUnique({ where: { id: cover.id } }),
    ).not.toBeNull();
  });

  it("leaves cover alone while the team is still short after the signing", async () => {
    // 1 member + agent = 2 of 3: an open seat remains, so the booking is
    // still doing its job.
    const { team, agent, cover } = await withEmptySeatCover(3);

    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));

    expect(res).toMatchObject({
      message: expect.not.stringMatching(/cancelled|LEFT in place/),
    });
    expect(
      await prisma.standinAssignment.findUnique({ where: { id: cover.id } }),
    ).not.toBeNull();
  });
});

describe("releasePlayer — the person it happens to is told", () => {
  it("@-mentions the released player, not just the channel", async () => {
    // Release is the most personal roster event the league produces, and its
    // subject was the one participant never notified: the announcement was a
    // bare broadcast while the stand-down loop right below it (and both
    // removeStandin paths, and signFreeAgent) all mention their subject. They
    // found out when the "Your team" block vanished from /me.
    const { season, team } = await setup();
    const player = await makeUser("Released Player");
    await prisma.user.update({
      where: { id: player.id },
      data: { discordId: "999000111222333444" },
    });
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: player.id,
        type: REGISTRATION_TYPE.PLAYER,
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    const member = await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId: team.id,
        userId: player.id,
        price: 7,
      },
    });
    mockSend.mockClear();

    const res = await releasePlayer(null, fd({ memberId: member.id }));

    expect(res).toHaveProperty("message");
    const call = mockSend.mock.calls.find((c) =>
      String(c[0]).includes("Released Player"),
    );
    expect(call, "the release announcement was sent").toBeTruthy();
    expect(call![1]).toMatchObject({ users: ["999000111222333444"] });
  });
});

describe("signFreeAgent — PARTIAL refill reports surplus open-seat bookings, never cancels them", () => {
  // A partial refill shrinks the seat count every open-seat booking was
  // budgeted against, and nothing re-audits existing bookings — but which
  // booking dies is the captain's call (the withdrawGateError
  // refuse-don't-auto-cancel precedent), so the surplus is REPORTED per match.
  it("keeps both bookings and names the per-match surplus in the toast", async () => {
    const { season, team, other, agent } = await setup(5);
    // 3 of 5 rostered — the sign leaves ONE open seat, under two bookings.
    for (const n of ["Filler A", "Filler B", "Filler C"]) {
      const u = await makeUser(n);
      await prisma.teamMember.create({
        data: { seasonId: season.id, teamId: team.id, userId: u.id, price: 0 },
      });
    }
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 4,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: team.id,
        awayTeamId: other.id,
        bestOf: 2,
        status: MATCH_STATUS.SCHEDULED,
      },
    });
    for (const n of ["Booked One", "Booked Two"]) {
      const s = await makeUser(n);
      await prisma.registration.create({
        data: {
          seasonId: season.id,
          userId: s.id,
          type: REGISTRATION_TYPE.STANDIN,
          status: "ACTIVE",
          mmr: 2500,
        },
      });
      await prisma.standinAssignment.create({
        data: {
          matchId: match.id,
          teamId: team.id,
          standinUserId: s.id,
          replacingUserId: null,
        },
      });
    }

    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));

    expect(res).toHaveProperty("message");
    expect(res?.message).toMatch(
      /2 open-seat booking\(s\) on week 4 .* now exceed the team's 1 open seat\(s\)/,
    );
    expect(res?.message).toMatch(/remove the extra on the match page/);
    expect(res?.message).not.toMatch(/cancelled/);
    // Reported, never auto-cancelled — BOTH bookings survive.
    expect(
      await prisma.standinAssignment.count({ where: { matchId: match.id } }),
    ).toBe(2);
  });
});

describe("signFreeAgent — refuses a withdrawn team", () => {
  // A withdrawn team's fixtures are all forfeited and rostered players can't
  // stand in — signing onto it parks the player on a dead roster for nothing.
  it("refuses with 'has withdrawn' and creates no seat", async () => {
    const { team, agent } = await setup();
    await prisma.team.update({ where: { id: team.id }, data: { withdrawn: true } });

    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));

    expect(res).toMatchObject({ error: expect.stringContaining("has withdrawn") });
    expect(
      await prisma.teamMember.findFirst({
        where: { teamId: team.id, userId: agent.id },
      }),
    ).toBeNull();
  });
});

describe("signFreeAgent — the signing announcement pings its subject", () => {
  // A signing is a season-long obligation (every remaining match night), and
  // this send was a bare broadcast while the one-night standin assign has
  // always mentioned its subject.
  it("@-mentions the signed player on the Discord send", async () => {
    const { agent, team } = await setup();
    await prisma.user.update({
      where: { id: agent.id },
      data: { discordId: "555666777888999000" },
    });
    mockSend.mockClear();

    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));

    expect(res).toHaveProperty("message");
    const signing = mockSend.mock.calls.find(([msg]) =>
      String(msg).includes("signs with"),
    );
    expect(signing, "the signing announcement was sent").toBeTruthy();
    expect(String(signing![0])).toContain("Free Agent");
    expect(String(signing![0])).toContain("Shorthanded");
    expect(signing![1]).toEqual({ users: ["555666777888999000"] });
  });
});

describe("releasePlayer — a double release fails clean and refunds once", () => {
  // The claim is a deleteMany re-asserting the row exists, never a raw delete
  // — the loser of a double release must land on an error toast, not an
  // unhandled P2025 blowing the admin panel to the error page, and the refund
  // rides behind the claim so it can only ever be credited once.
  it("second release returns { error } with the budget credited exactly once", async () => {
    const season = await makeSeason({
      teamSize: 5,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const team = await makeTeam(season.id, "Refund Once", 0, 60);
    const p = await makePlayer(season.id, "Twice Released", 3000);
    const member = await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: p.id, price: 40 },
    });

    const first = await releasePlayer({}, fd({ memberId: member.id }));
    expect(first?.error).toBeUndefined();

    // Sequential re-release: must resolve to a clean { error } — either the
    // read-time "Unknown roster spot" or the claim's "already released".
    const second = await releasePlayer({}, fd({ memberId: member.id }));
    expect(second?.error).toMatch(/Unknown roster spot|already released/);
    expect(second).not.toHaveProperty("message");

    // Exactly one refund: 60 + 40, never + 80.
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).budget,
    ).toBe(100);
  });
});

describe("promoteStandinToPlayer — the write is a guarded claim", () => {
  afterEach(() => setRaceHook(null));

  async function draftReadyStandin(name = "Draft-edge Standin") {
    const season = await makeSeason({
      teamSize: 2,
      status: SEASON_STATUS.DRAFT,
    });
    await makeCaptain(season.id, "Captain Alpha", 100, 0);
    await makeCaptain(season.id, "Captain Bravo", 100, 1);
    await makePlayer(season.id, "Existing Draft Player", 3100);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.NOT_STARTED },
    });
    const standin = await makeUser(name);
    const registration = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: standin.id,
        type: REGISTRATION_TYPE.STANDIN,
        status: "ACTIVE",
        mmr: 2800,
      },
    });
    return { season, standin, registration };
  }

  // SQLite cannot run a second writer inside an open interactive transaction,
  // so this seam commits the rival immediately before the authoritative
  // snapshot. The transaction must observe the changed signup and refuse it.
  it("refuses when the signup changes immediately before its snapshot", async () => {
    const season = await makeSeason({
      teamSize: 5,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const standin = await makeUser("Late Joiner");
    const reg = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: standin.id,
        type: REGISTRATION_TYPE.STANDIN,
        status: "ACTIVE",
        mmr: 2800,
      },
    });

    let fired = false;
    setRaceHook(
      onceAt("admin.promoteStandin.beforeTx", async () => {
        fired = true;
        await prisma.registration.update({
          where: { id: reg.id },
          data: { status: "WITHDRAWN" },
        });
      }),
    );

    const res = await promoteStandinToPlayer({}, fd({ userId: standin.id }));

    expect(fired, "the seam must fire — a drifted label is a vacuous test").toBe(true);
    expect(res).toEqual({ error: "This signup isn't active." });
    const after = await prisma.registration.findUniqueOrThrow({
      where: { id: reg.id },
    });
    expect(after.status).toBe("WITHDRAWN");
    // The blind write used to stamp PLAYER here.
    expect(after.type).toBe(REGISTRATION_TYPE.STANDIN);
    expect(
      await prisma.adminAction.count({
        where: { action: "promoteStandinToPlayer" },
      }),
    ).toBe(0);
  });

  it.skipIf(!ON_POSTGRES)(
    "re-asserts ACTIVE standin state at the write, not only at the gate read",
    async () => {
      const season = await makeSeason({
        teamSize: 5,
        status: SEASON_STATUS.REGULAR_SEASON,
      });
      const standin = await makeUser("Claim Predicate Standin");
      const registration = await prisma.registration.create({
        data: {
          seasonId: season.id,
          userId: standin.id,
          type: REGISTRATION_TYPE.STANDIN,
          status: "ACTIVE",
          mmr: 2800,
        },
      });

      // A genuine second-connection update after the gate read makes PostgreSQL
      // abort this same-row Serializable write with P2034 whether or not the
      // copied predicate exists. That is a useful product invariant but a
      // vacuous mutation tripwire. Wrap only this action's REAL PostgreSQL
      // transaction client and inject the drift on that same client immediately
      // before its Registration updateMany. This isolates the claim predicate:
      // with it, zero rows match; if mutation testing strips `status: ACTIVE,
      // type: STANDIN`, the blind identity write promotes the WITHDRAWN row.
      type InteractiveOptions = {
        maxWait?: number;
        timeout?: number;
        isolationLevel?: Prisma.TransactionIsolationLevel;
      };
      type InteractiveTransaction = <Result>(
        callback: (tx: Prisma.TransactionClient) => Promise<Result>,
        options?: InteractiveOptions,
      ) => Promise<Result>;
      const realTransaction = prisma.$transaction.bind(
        prisma,
      ) as InteractiveTransaction;
      const wrappedTransaction: InteractiveTransaction = (callback, options) =>
        realTransaction(async (tx) => {
          const originalUpdateMany = tx.registration.updateMany.bind(
            tx.registration,
          );
          let injected = false;
          const registrationWithDrift = new Proxy(tx.registration, {
            get(target, property, receiver) {
              if (property !== "updateMany") {
                return Reflect.get(target, property, receiver);
              }
              return async (args: Prisma.RegistrationUpdateManyArgs) => {
                if (!injected) {
                  injected = true;
                  await tx.registration.update({
                    where: { id: registration.id },
                    data: { status: "WITHDRAWN" },
                  });
                }
                return originalUpdateMany(args);
              };
            },
          });
          const txWithDrift = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === "registration") return registrationWithDrift;
              return Reflect.get(target, property, receiver);
            },
          }) as Prisma.TransactionClient;
          return callback(txWithDrift);
        }, options);
      vi.spyOn(prisma, "$transaction").mockImplementationOnce(
        wrappedTransaction as typeof prisma.$transaction,
      );

      const result = await promoteStandinToPlayer(
        {},
        fd({ userId: standin.id }),
      );
      const after = await prisma.registration.findUniqueOrThrow({
        where: { id: registration.id },
      });

      expect(result).toEqual({
        error:
          "Claim Predicate Standin's signup just changed — reload and check it before promoting",
      });
      expect(after).toMatchObject({
        status: "WITHDRAWN",
        type: REGISTRATION_TYPE.STANDIN,
      });
      expect(
        await prisma.adminAction.count({
          where: { action: "promoteStandinToPlayer" },
        }),
      ).toBe(0);
    },
  );

  // This is the former defect in a deterministic, SQLite-safe ordering:
  // startDraft commits after the old action's gate read and before its blind
  // update. With the gate inside the transaction, the live draft is visible
  // and the unchanged product copy is returned instead of injecting a player.
  it("refuses promotion when startDraft wins immediately before its snapshot", async () => {
    const { season, standin, registration } = await draftReadyStandin();
    let draftResult: Awaited<ReturnType<typeof startDraft>> | null = null;
    setRaceHook(
      onceAt("admin.promoteStandin.beforeTx", async () => {
        draftResult = await startDraft(
          {},
          fd({ expectedActiveSeasonId: season.id }),
        );
      }),
    );

    const result = await promoteStandinToPlayer(
      {},
      fd({ userId: standin.id }),
    );

    expect(draftResult).toHaveProperty("message");
    expect(result).toEqual({
      error: "The draft is live — promote before it starts or after it completes.",
    });
    expect(
      await prisma.registration.findUniqueOrThrow({
        where: { id: registration.id },
      }),
    ).toMatchObject({
      status: "ACTIVE",
      type: REGISTRATION_TYPE.STANDIN,
    });
  });

  it("audits only a successful promotion", async () => {
    const season = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    const standin = await makeUser("Audited Late Joiner");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: standin.id,
        type: REGISTRATION_TYPE.STANDIN,
        status: "ACTIVE",
        mmr: 2700,
      },
    });

    const result = await promoteStandinToPlayer(
      {},
      fd({ userId: standin.id }),
    );

    expect(result).toHaveProperty("message");
    expect(
      await prisma.adminAction.findMany({
        where: { action: "promoteStandinToPlayer" },
      }),
    ).toEqual([
      expect.objectContaining({
        actorId: "audit-admin",
        actorName: "Audit Admin",
        seasonId: season.id,
        summary: "Promoted Audited Late Joiner from standin to full player",
      }),
    ]);
  });

  it("maps a Serializable conflict to reload guidance without auditing", async () => {
    const { standin } = await draftReadyStandin("Conflict Standin");
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      Object.assign(new Error("write conflict"), { code: "P2034" }),
    );

    const result = await promoteStandinToPlayer(
      {},
      fd({ userId: standin.id }),
    );

    expect(result).toEqual({
      error:
        "The season, draft, or signup just changed — reload and check it before promoting",
    });
    expect(
      await prisma.adminAction.count({
        where: { action: "promoteStandinToPlayer" },
      }),
    ).toBe(0);
  });

  it.skipIf(!ON_POSTGRES)(
    "loses cleanly when startDraft commits after the promotion gate snapshot",
    async () => {
      const { season, standin, registration } = await draftReadyStandin(
        "Postgres Race Standin",
      );
      let draftResult: Awaited<ReturnType<typeof startDraft>> | null = null;
      setRaceHook(
        onceAt("admin.promoteStandin.afterGate", async () => {
          draftResult = await startDraft(
            {},
            fd({ expectedActiveSeasonId: season.id }),
          );
        }),
      );

      const result = await promoteStandinToPlayer(
        {},
        fd({ userId: standin.id }),
      );

      expect(draftResult).toHaveProperty("message");
      expect(result).toEqual({
        error:
          "Postgres Race Standin's signup just changed — reload and check it before promoting",
      });
      expect(
        await prisma.registration.findUniqueOrThrow({
          where: { id: registration.id },
        }),
      ).toMatchObject({
        status: "ACTIVE",
        type: REGISTRATION_TYPE.STANDIN,
      });
      expect(
        await prisma.draft.findUniqueOrThrow({
          where: { seasonId: season.id },
        }),
      ).toMatchObject({ status: DRAFT_STATUS.IN_PROGRESS });
      expect(
        await prisma.adminAction.count({
          where: { action: "promoteStandinToPlayer" },
        }),
      ).toBe(0);
    },
  );
});

describe("roster moves stay open through the PLAYOFFS", () => {
  // The gates single out SIGNUPS / DRAFT / COMPLETE; playoffs are deliberately
  // permissive — a bracket run is when a short roster hurts most. Pin the
  // window so a future gate doesn't quietly close it.
  async function playoffSeason() {
    const season = await makeSeason({
      teamSize: 5,
      status: SEASON_STATUS.PLAYOFFS,
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
    const team = await makeTeam(season.id, "Playoff Team", 0);
    return { season, team };
  }

  it("signFreeAgent signs onto a short team mid-playoffs", async () => {
    const { season, team } = await playoffSeason();
    const agent = await makeUser("Playoff Agent");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: agent.id,
        type: REGISTRATION_TYPE.PLAYER,
        status: "ACTIVE",
        mmr: 3000,
      },
    });

    const res = await signFreeAgent(null, fd({ teamId: team.id, userId: agent.id }));

    expect(res).toHaveProperty("message");
    expect(
      await prisma.teamMember.count({ where: { teamId: team.id, userId: agent.id } }),
    ).toBe(1);
  });

  it("releasePlayer releases mid-playoffs", async () => {
    const { season, team } = await playoffSeason();
    const p = await makePlayer(season.id, "Playoff Released", 3000);
    const member = await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: p.id, price: 5 },
    });

    const res = await releasePlayer({}, fd({ memberId: member.id }));

    expect(res?.error).toBeUndefined();
    expect(res).toHaveProperty("message");
  });

  it("promoteStandinToPlayer promotes mid-playoffs", async () => {
    const { season } = await playoffSeason();
    const s = await makeUser("Playoff Standin");
    const reg = await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: s.id,
        type: REGISTRATION_TYPE.STANDIN,
        status: "ACTIVE",
        mmr: 2500,
      },
    });

    const res = await promoteStandinToPlayer({}, fd({ userId: s.id }));

    expect(res).toHaveProperty("message");
    expect(
      (await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } })).type,
    ).toBe(REGISTRATION_TYPE.PLAYER);
  });
});
