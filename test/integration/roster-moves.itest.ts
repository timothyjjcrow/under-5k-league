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
import { signFreeAgent } from "@/app/actions/admin";
import {
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import { makeSeason, makeTeam, makeUser } from "./factories";

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
