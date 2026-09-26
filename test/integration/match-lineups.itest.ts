import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(), requireAdmin: vi.fn(), getSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/discord", async (original) => ({ ...(await original<typeof import("@/lib/discord")>()), getWebhookUrl: vi.fn(async () => ""), sendDiscordMessage: vi.fn(async () => true) }));

import { prisma } from "@/lib/prisma";
import { requireAdmin, requireUser } from "@/lib/auth";
import { setMatchTime } from "@/app/actions/admin";
import { confirmLineupAction } from "@/app/actions/match-lineups";
import { setAvailability } from "@/app/actions/availability";
import { captainAssignStandin } from "@/app/actions/standins";
import { confirmMatchLineup, invalidateMatchLineups, invalidateTeamLineups } from "@/lib/match-lineups";
import { assignStandinGuarded, removeStandinGuarded } from "@/lib/standin-service";
import { makeSeason, makeUser, raceN, sessionFor } from "./factories";

async function setup() {
  const season = await makeSeason({ status: "REGULAR_SEASON", teamSize: 3 });
  const people = await Promise.all(Array.from({ length: 6 }, (_, i) => makeUser(`Lineup ${i}`)));
  const home = await prisma.team.create({ data: { seasonId: season.id, name: "Home", captainId: people[0].id } });
  const away = await prisma.team.create({ data: { seasonId: season.id, name: "Away", captainId: people[3].id } });
  await prisma.teamMember.createMany({ data: people.map((p, i) => ({ seasonId: season.id, teamId: i < 3 ? home.id : away.id, userId: p.id, isCaptain: i === 0 || i === 3 })) });
  await prisma.registration.createMany({ data: people.map((p) => ({ seasonId: season.id, userId: p.id, mmr: 2800, roles: "4,5" })) });
  const match = await prisma.match.create({ data: { seasonId: season.id, week: 1, homeTeamId: home.id, awayTeamId: away.id, scheduledAt: new Date(Date.now() + 86400_000), bestOf: 3 } });
  await prisma.matchAvailability.createMany({ data: people.map((p) => ({ matchId: match.id, userId: p.id, status: "IN", scheduleRevision: match.scheduleRevision })) });
  const request = (teamId = home.id) => ({
    actor: sessionFor(teamId === home.id ? people[0] : people[3]), matchId: match.id, teamId,
    expectedScheduleRevision: match.scheduleRevision, expectedLogisticsRevision: match.logisticsRevision,
    expectedLineupRevision: 0, selections: people.slice(teamId === home.id ? 0 : 3, teamId === home.id ? 3 : 6).map((p, i) => ({ userId: p.id, position: i === 0 ? 1 : null })),
  });
  return { season, people, home, away, match, request };
}

function form(values: Record<string, string>) {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}

describe("confirmed playing lineups", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  it("snapshots the exact configured side size, explicit positions and observed rating without inventing played roles", async () => {
    const { match, request } = await setup();
    const before = Date.now();
    const saved = await confirmMatchLineup(request());
    const row = await prisma.matchLineup.findUniqueOrThrow({ where: { id: saved.id }, include: { seats: true } });
    expect(row).toMatchObject({ status: "CONFIRMED", revision: 1, scheduleRevision: 0, logisticsRevision: 0, scheduledAtSnapshot: match.scheduledAt });
    expect(row.confirmedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.seats).toHaveLength(3);
    expect(row.seats.filter((seat) => seat.position != null)).toHaveLength(1);
    expect(row.seats.every((seat) => seat.entryKind === "ROSTER" && seat.mmr === 2800 && seat.mmrSource === "REGISTRATION_AT_CONFIRMATION" && seat.ratingAt?.getTime() === row.confirmedAt.getTime())).toBe(true);
    expect(await prisma.gameParticipant.count()).toBe(0);
  });

  it("rejects a selection that is short, duplicates a person or duplicates a planned position", async () => {
    const { request } = await setup();
    const opts = request();
    await expect(confirmMatchLineup({ ...opts, selections: opts.selections.slice(0, 2) })).rejects.toThrow(/exactly 3/);
    await expect(confirmMatchLineup({ ...opts, selections: [opts.selections[0], opts.selections[0], opts.selections[2]] })).rejects.toThrow(/different players/);
    await expect(confirmMatchLineup({ ...opts, selections: opts.selections.map((s) => ({ ...s, position: 1 })) })).rejects.toThrow(/only one player/);
    expect(await prisma.matchLineup.count()).toBe(0);
  });

  it("requires each selected player to have a current-schedule IN, including admins", async () => {
    const { match, people, request } = await setup();
    const admin = await makeUser("Admin", "ADMIN");
    await prisma.matchAvailability.update({ where: { matchId_userId: { matchId: match.id, userId: people[1].id } }, data: { scheduleRevision: 7 } });
    await expect(confirmMatchLineup({ ...request(), actor: sessionFor(admin) })).rejects.toThrow(/must check in/);
    expect(await prisma.matchLineup.count()).toBe(0);
  });

  it("checks captain/admin authority inside the write transaction, including an admin demotion", async () => {
    const { people, request } = await setup();
    await expect(confirmMatchLineup({ ...request(), actor: sessionFor(people[3]) })).rejects.toThrow(/Only this team's captain/);
    const formerAdmin = await makeUser("Former admin", "USER");
    await expect(confirmMatchLineup({ ...request(), actor: { ...sessionFor(formerAdmin), role: "ADMIN" } })).rejects.toThrow(/Only this team's captain/);
  });

  it.each(["SIGNUPS", "COMPLETE"])("refuses confirmation in %s", async (status) => {
    const { season, request } = await setup();
    await prisma.season.update({ where: { id: season.id }, data: { status } });
    await expect(confirmMatchLineup(request())).rejects.toThrow(/closed/);
  });

  it("refuses an unscheduled LIVE fixture with a clear error", async () => {
    const { match, people, request } = await setup();
    await prisma.match.update({ where: { id: match.id }, data: { status: "LIVE", scheduledAt: null } });
    await expect(confirmMatchLineup(request())).rejects.toThrow(/closed/);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[0]));
    expect((await setAvailability({}, form({ matchId: match.id, status: "IN", expectedScheduleRevision: "0" })))?.error).toMatch(/does not have a kickoff/);
    expect(await prisma.matchLineup.count()).toBe(0);
  });

  it("refuses archived fixtures and stale schedule/logistics/lineup revisions", async () => {
    const { season, match, request } = await setup();
    await expect(confirmMatchLineup({ ...request(), expectedScheduleRevision: 1 })).rejects.toThrow(/kickoff or playing roster changed/);
    await expect(confirmMatchLineup({ ...request(), expectedLogisticsRevision: 1 })).rejects.toThrow(/kickoff or playing roster changed/);
    await confirmMatchLineup(request());
    await expect(confirmMatchLineup(request())).rejects.toThrow(/Another lineup/);
    await prisma.season.update({ where: { id: season.id }, data: { isActive: false } });
    await expect(confirmMatchLineup({ ...request(), expectedLineupRevision: 1 })).rejects.toThrow(/not in the active season/);
    expect(await prisma.matchLineup.count({ where: { matchId: match.id } })).toBe(1);
  });

  it("scoped logistics changes preserve the opposing plan and every immutable old seat", async () => {
    const { match, home, away, request } = await setup();
    const oldHome = await confirmMatchLineup(request());
    const oldAway = await confirmMatchLineup(request(away.id));
    const before = await prisma.matchLineupSeat.findMany({ where: { lineupId: oldHome.id } });
    await prisma.match.update({ where: { id: match.id }, data: { status: "LIVE" } });
    const endedAt = new Date();
    await prisma.$transaction((tx) => invalidateTeamLineups(tx, home.id, "ROSTER_CHANGED", endedAt));
    expect(await prisma.matchLineup.findUnique({ where: { id: oldHome.id } })).toMatchObject({ status: "SUPERSEDED", activeKey: null, supersededAt: endedAt });
    expect(await prisma.matchLineup.findUnique({ where: { id: oldAway.id } })).toMatchObject({ status: "CONFIRMED", supersededAt: null });
    expect(await prisma.matchLineupSeat.findMany({ where: { lineupId: oldHome.id } })).toEqual(before);
    expect(await prisma.match.findUnique({ where: { id: match.id } })).toMatchObject({ logisticsRevision: 1 });
    const again = await confirmMatchLineup({ ...request(away.id), expectedLineupRevision: 1, expectedLogisticsRevision: 1 });
    expect(again.id).toBe(oldAway.id);
  });

  it("retiming supersedes both teams while completed historical lineups stay intact", async () => {
    const { match, home, away, request } = await setup();
    const a = await confirmMatchLineup(request());
    const b = await confirmMatchLineup(request(away.id));
    await prisma.$transaction((tx) => invalidateMatchLineups(tx, match.id, "KICKOFF_CHANGED"));
    expect(await prisma.matchLineup.count({ where: { id: { in: [a.id, b.id] }, status: "SUPERSEDED" } })).toBe(2);
    const next = await confirmMatchLineup({ ...request(), expectedLineupRevision: 1, expectedLogisticsRevision: 1 });
    await prisma.match.update({ where: { id: match.id }, data: { status: "COMPLETED" } });
    await prisma.$transaction((tx) => invalidateTeamLineups(tx, home.id, "LATER_RELEASE"));
    await prisma.$transaction((tx) => invalidateMatchLineups(tx, match.id, "LATE_DIRECT_INVALIDATION"));
    expect(await prisma.matchLineup.findUnique({ where: { id: next.id } })).toMatchObject({ status: "CONFIRMED", supersededAt: null });
  });

  it("later confirmation and invalidation never rewrite a previously ended lineup interval", async () => {
    const { match, request } = await setup();
    const first = await confirmMatchLineup(request());
    await prisma.$transaction((tx) => invalidateMatchLineups(tx, match.id, "FIRST_TIME_CHANGE"));
    const historical = await prisma.matchLineup.findUniqueOrThrow({ where: { id: first.id } });
    await confirmMatchLineup({ ...request(), expectedLineupRevision: 1, expectedLogisticsRevision: 1 });
    const changed = request();
    changed.selections[0].position = 2;
    await confirmMatchLineup({ ...changed, expectedLineupRevision: 2, expectedLogisticsRevision: 1 });
    expect(await prisma.matchLineup.findUnique({ where: { id: first.id } })).toEqual(historical);
    await prisma.$transaction((tx) => invalidateMatchLineups(tx, match.id, "SECOND_TIME_CHANGE"));
    expect(await prisma.matchLineup.findUnique({ where: { id: first.id } })).toEqual(historical);
  });

  it("the actual admin retime keeps a same-time confirmation but invalidates both plans and old check-in forms on change", async () => {
    const { season, match, people, away, request } = await setup();
    const admin = await makeUser("Scheduler", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    const a = await confirmMatchLineup(request());
    const b = await confirmMatchLineup(request(away.id));
    const retime = (when: Date) => setMatchTime({}, form({ matchId: match.id, expectedActiveSeasonId: season.id, scheduledAt: when.toISOString(), scheduledAtTs: String(when.getTime()) }));
    expect((await retime(match.scheduledAt!))?.error).toBeUndefined();
    expect(await prisma.matchLineup.count({ where: { activeKey: { not: null } } })).toBe(2);
    expect(await prisma.match.findUnique({ where: { id: match.id } })).toMatchObject({ scheduleRevision: 0, logisticsRevision: 0 });
    expect((await retime(new Date(match.scheduledAt!.getTime() + 3600_000)))?.error).toBeUndefined();
    expect(await prisma.matchLineup.count({ where: { id: { in: [a.id, b.id] }, status: "SUPERSEDED" } })).toBe(2);
    expect(await prisma.match.findUnique({ where: { id: match.id } })).toMatchObject({ scheduleRevision: 1, logisticsRevision: 1 });
    expect(await prisma.matchAvailability.count({ where: { matchId: match.id } })).toBe(0);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[0]));
    expect((await setAvailability({}, form({ matchId: match.id, status: "IN", expectedScheduleRevision: "0" })))?.error).toMatch(/kickoff changed/);
    expect((await setAvailability({}, form({ matchId: match.id, status: "IN", expectedScheduleRevision: "1" })))?.message).toBeTruthy();
    expect(await prisma.matchAvailability.findFirst({ where: { matchId: match.id } })).toMatchObject({ scheduleRevision: 1 });
  });

  it("an RSVP change supersedes only that side; repeating the same answer is a no-op", async () => {
    const { match, people, away, request } = await setup();
    const a = await confirmMatchLineup(request());
    const b = await confirmMatchLineup(request(away.id));
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[1]));
    const answer = (status: string) => form({ matchId: match.id, status, expectedScheduleRevision: String(match.scheduleRevision) });
    expect((await setAvailability({}, answer("IN")))?.message).toBeTruthy();
    expect(await prisma.match.findUnique({ where: { id: match.id } })).toMatchObject({ logisticsRevision: 0 });
    expect((await setAvailability({}, answer("OUT")))?.message).toBeTruthy();
    expect(await prisma.matchLineup.findUnique({ where: { id: a.id } })).toMatchObject({ status: "SUPERSEDED" });
    expect(await prisma.matchLineup.findUnique({ where: { id: b.id } })).toMatchObject({ status: "CONFIRMED" });
  });

  it("a stale or missing kickoff revision cannot post a fresh RSVP", async () => {
    const { match, people } = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[1]));
    await prisma.match.update({ where: { id: match.id }, data: { scheduleRevision: { increment: 1 } } });
    expect((await setAvailability({}, form({ matchId: match.id, status: "IN", expectedScheduleRevision: "0" })))?.error).toMatch(/kickoff changed/);
    expect((await setAvailability({}, form({ matchId: match.id, status: "IN" })))?.error).toMatch(/Reload/);
    expect(await prisma.matchAvailability.count({ where: { matchId: match.id, scheduleRevision: 1 } })).toBe(0);
  });

  it("supports midseries cover with a fresh check-in and preserves unknown legacy offer acceptance", async () => {
    const { season, match, home, people, request } = await setup();
    const original = await confirmMatchLineup(request());
    const standin = await makeUser("Midseries cover");
    await prisma.registration.create({ data: { seasonId: season.id, userId: standin.id, type: "STANDIN", mmr: 0 } });
    await prisma.match.update({ where: { id: match.id }, data: { status: "LIVE" } });
    expect(await assignStandinGuarded({ matchId: match.id, standinUserId: standin.id, replacingUserId: people[1].id, actingCaptainId: people[0].id })).toMatchObject({ ok: true });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));
    expect((await setAvailability({}, form({ matchId: match.id, status: "IN", expectedScheduleRevision: "0" })))?.message).toMatch(/next game/);
    const fresh = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    const saved = await confirmMatchLineup({ ...request(), expectedLineupRevision: 1, expectedLogisticsRevision: fresh.logisticsRevision, selections: [request().selections[0], { userId: standin.id, position: 2 }, request().selections[2]] });
    expect(await prisma.matchLineupSeat.findFirst({ where: { lineupId: saved.id, userId: standin.id } })).toMatchObject({ entryKind: "STANDIN", acceptanceStatusSnapshot: "UNKNOWN", mmr: null, ratingAt: null, replacingUserId: people[1].id });
    expect(await prisma.matchLineupSeat.count({ where: { lineupId: original.id, userId: people[1].id } })).toBe(1);
    const assignment = await prisma.standinAssignment.findFirstOrThrow({ where: { matchId: match.id, teamId: home.id } });
    expect(await removeStandinGuarded({ assignmentId: assignment.id, actingCaptainId: people[0].id })).toMatchObject({ ok: true });
    expect(await prisma.matchLineup.findUnique({ where: { id: saved.id } })).toMatchObject({ status: "SUPERSEDED" });
  });

  it("a captain brings in a standin and re-confirms through the real forms, and no position is ever saved", async () => {
    const { season, match, home, people } = await setup();
    const confirmForm = async (playerIds: string[]) => {
      const fresh = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
      const active = await prisma.matchLineup.findFirst({ where: { matchId: match.id, teamId: home.id }, orderBy: { revision: "desc" } });
      const result = form({ matchId: match.id, teamId: home.id, expectedScheduleRevision: String(fresh.scheduleRevision),
        expectedLogisticsRevision: String(fresh.logisticsRevision), expectedLineupRevision: String(active?.revision ?? 0) });
      for (const id of playerIds) result.append("playerId", id);
      // A stale tab that still renders the old dropdown must not smuggle a position in.
      result.set(`position:${playerIds[0]}`, "1");
      return result;
    };
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[0]));
    expect((await confirmLineupAction({}, await confirmForm([people[0].id, people[1].id, people[2].id])))?.message).toMatch(/confirmed/);

    const standin = await makeUser("Pre-match cover");
    await prisma.registration.create({ data: { seasonId: season.id, userId: standin.id, type: "STANDIN", mmr: 2700 } });
    expect((await captainAssignStandin({}, form({ matchId: match.id, standinUserId: standin.id, replacingUserId: people[1].id })))?.message).toBeTruthy();
    expect(await prisma.matchLineup.findFirst({ where: { matchId: match.id, teamId: home.id, revision: 1 } })).toMatchObject({ status: "SUPERSEDED" });

    vi.mocked(requireUser).mockResolvedValue(sessionFor(standin));
    const fresh = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect((await setAvailability({}, form({ matchId: match.id, status: "IN", expectedScheduleRevision: String(fresh.scheduleRevision) })))?.error).toBeUndefined();

    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[0]));
    expect((await confirmLineupAction({}, await confirmForm([people[0].id, standin.id, people[2].id])))?.message).toMatch(/confirmed/);
    const saved = await prisma.matchLineup.findFirstOrThrow({ where: { matchId: match.id, teamId: home.id, activeKey: { not: null } }, include: { seats: true } });
    expect(saved).toMatchObject({ status: "CONFIRMED", revision: 2 });
    expect(saved.seats.map((seat) => seat.userId).sort()).toEqual([people[0].id, standin.id, people[2].id].sort());
    expect(saved.seats.find((seat) => seat.userId === standin.id)).toMatchObject({ entryKind: "STANDIN", replacingUserId: people[1].id });
    expect(await prisma.matchLineupSeat.count({ where: { position: { not: null } } })).toBe(0);
  });

  it("concurrent submissions leave one active revision and return a reviewable result", async () => {
    const { people, request } = await setup();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(people[0]));
    const opts = request();
    const makeForm = () => {
      const result = form({ matchId: opts.matchId, teamId: opts.teamId, expectedScheduleRevision: "0", expectedLogisticsRevision: "0", expectedLineupRevision: "0" });
      for (const selected of opts.selections) result.append("playerId", selected.userId);
      return result;
    };
    const results = await raceN(2, () => confirmLineupAction({}, makeForm()));
    expect(results.some((result) => result?.message)).toBe(true);
    expect(results.every((result) => result?.message || result?.error)).toBe(true);
    expect(await prisma.matchLineup.count({ where: { activeKey: { not: null } } })).toBe(1);
  });
});
