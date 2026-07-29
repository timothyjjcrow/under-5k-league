import { describe, expect, it, vi } from "vitest";

// signFreeAgent is a server action: stub the request-scope bits so it can be
// driven against the test DB.
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
import { sendDiscordMessage } from "@/lib/discord";
const mockSend = vi.mocked(sendDiscordMessage);
import { releasePlayer, signFreeAgent, withdrawSignup } from "@/app/actions/admin";
import {
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import { makePlayer, makeSeason, makeTeam, makeUser } from "./factories";

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
    expect(res?.message).toMatch(/LEFT in place/);
    expect(res?.message).not.toMatch(/cancelled/);
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
    expect(res?.message).toMatch(/1 assignment\(s\) on an already-started series were LEFT/);
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
