import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import { loadLeagueStatusSnapshot } from "@/lib/league-status-snapshot";
import {
  STATUS_MAX_COMPONENTS,
  STATUS_MAX_TEXT,
  countComponents,
  renderLeagueStatus,
  totalText,
  type LeagueStatusSnapshot,
} from "@/lib/league-status";
import { castBallot, createPoll } from "@/lib/match-night-poll-service";
import { slotKey, type PollSlot } from "@/lib/match-night-poll";
import { serializeInhouseNight } from "@/lib/inhouse-night";
import { serializeNextSeasonPlan } from "@/lib/next-season";
import { matchNightForWeek } from "@/lib/schedule";
import { resolveSiteUrl } from "@/lib/site-url";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { SETTING_KEYS, setSetting } from "@/lib/settings";
import { serializeRescheduleOptions } from "@/lib/reschedule-ready-check";
import { makeCaptain, makePlayer, makeSeason, makeTeam, makeUser } from "./factories";

// The status card's loader against real leagues, one phase at a time: every
// number must be the one the site already prints (capacityInfo, the week in
// focus, the table and its cut, the honors, the champion), and reading must
// never change the league.

const DAY = 86_400_000;
const SUN_18: PollSlot = { day: 0, minute: 18 * 60 };

/** Every rendered card must stay inside Discord's limits. */
function fits(snapshot: LeagueStatusSnapshot) {
  const { payload } = renderLeagueStatus(snapshot);
  expect(countComponents(payload.components)).toBeLessThanOrEqual(STATUS_MAX_COMPONENTS);
  expect(totalText(payload.components)).toBeLessThanOrEqual(STATUS_MAX_TEXT);
}

/** The league's one table; fails on a group season's tables. */
function oneTable(snapshot: LeagueStatusSnapshot) {
  const table = snapshot.table;
  if (!table || table.kind === "GROUPS") throw new Error("expected the league's one table");
  return table;
}

/** A group season's tables; fails on one table. */
function groupTables(snapshot: LeagueStatusSnapshot) {
  const table = snapshot.table;
  if (!table || table.kind !== "GROUPS") throw new Error("expected one table per group");
  return table.groups;
}

/** Every text display's content in the rendered card, in order. */
function cardText(snapshot: LeagueStatusSnapshot): string {
  const out: string[] = [];
  const walk = (list: unknown[]) => {
    for (const c of list) {
      const node = c as { content?: unknown; components?: unknown[] };
      if (typeof node.content === "string") out.push(node.content);
      if (Array.isArray(node.components)) walk(node.components);
    }
  };
  walk(renderLeagueStatus(snapshot).payload.components);
  return out.join("\n");
}

describe("league status snapshot — between seasons", () => {
  it("names the last champion when no season is active", async () => {
    const old = await makeSeason({
      name: "Season 1",
      status: SEASON_STATUS.COMPLETE,
      isActive: false,
    });
    const champ = await makeTeam(old.id, "Bad Boys of Dota", 0);
    await prisma.season.update({
      where: { id: old.id },
      data: { championTeamId: champ.id },
    });

    const snap = await loadLeagueStatusSnapshot();
    expect(snap.phase).toBe("OFFSEASON");
    expect(snap.lastChampion).toEqual({ team: "Bad Boys of Dota", seasonName: "Season 1" });
    expect(snap.logoUrl).toBe(`${resolveSiteUrl()}${LEAGUE_CONFIG.branding.logo}`);
    fits(snap);
  });
});

describe("league status snapshot — signups", () => {
  it("counts the pool the way Home does and keeps the poll's count hidden", async () => {
    const season = await makeSeason({
      name: "Season 2",
      teamSize: 5,
      minTeams: 4,
      draftAt: new Date(Date.now() + 5 * DAY),
    });
    // One named captain, two volunteers (one of them the captain again).
    await makeCaptain(season.id, "Cap Carl", 100, 0);
    await makePlayer(season.id, "Volunteer Val", 4000, { wantsCaptain: true });
    for (let i = 0; i < 9; i++) await makePlayer(season.id, `Player ${i}`, 3000);
    const standin = await makeUser("Spare Sam");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: standin.id, type: "STANDIN", status: "ACTIVE" },
    });
    const withdrawn = await makePlayer(season.id, "Gone", 3000);
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: withdrawn.id } },
      data: { status: "WITHDRAWN" },
    });

    const admin = await makeUser("Admin", "ADMIN");
    const poll = await createPoll({
      question: "When should match night be?",
      slots: [SUN_18],
      closesAt: new Date(Date.now() + 3 * DAY),
      createdById: admin.id,
    });
    if (!poll.ok) throw new Error(poll.error);
    const voters = await prisma.registration.findMany({
      where: { seasonId: season.id, type: "PLAYER", status: "ACTIVE" },
      take: 3,
    });
    for (const v of voters) {
      await castBallot({
        pollId: poll.poll.id,
        userId: v.userId,
        availability: [slotKey(SUN_18)],
      });
    }

    const snap = await loadLeagueStatusSnapshot();
    expect(snap.phase).toBe("SIGNUPS");
    expect(snap.seasonName).toBe("Season 2");
    // 11 active players (the captain's own signup included), 1 standin.
    expect(snap.signups).toEqual({
      players: 11,
      standins: 1,
      captainVolunteers: 2,
      minTeams: 4,
      teamsFormable: 2,
      needed: 9,
      toNextTeam: 4,
      teamsNeeded: 4,
    });
    expect(snap.matchNight).toEqual({
      kind: "poll",
      voted: 3,
      eligible: expect.any(Number),
      closesAtMs: poll.poll.closesAt.getTime(),
      voteUrl: `${resolveSiteUrl()}/#match-night-poll`,
    });
    expect((snap.matchNight as { eligible: number }).eligible).toBeGreaterThanOrEqual(11);
    // Nothing that could name the leading slot reaches the card.
    expect(JSON.stringify(snap)).not.toContain(slotKey(SUN_18));
    expect(snap.draft).toMatchObject({
      state: "NOT_STARTED",
      atMs: season.draftAt!.getTime(),
      soon: false,
      captains: 1,
      pool: 10,
    });
    fits(snap);
  });

  it("names the season's night once no poll is open, and the draft room on draft night", async () => {
    await makeSeason({ draftAt: new Date(Date.now() + 60 * 60_000) });
    const snap = await loadLeagueStatusSnapshot();
    expect(snap.matchNight.kind).not.toBe("poll");
    expect(snap.draft?.soon).toBe(true);
  });
});

describe("league status snapshot — the draft", () => {
  it("reads a live draft without resolving its clock", async () => {
    const season = await makeSeason({ teamSize: 3 });
    const a = await makeCaptain(season.id, "Cap A", 100, 0);
    await makeCaptain(season.id, "Cap B", 100, 1);
    const players = [];
    for (let i = 0; i < 5; i++) players.push(await makePlayer(season.id, `P${i}`, 3000));
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: a.team.id, userId: players[0].id, price: 12 },
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    const expired = new Date(Date.now() - 60_000);
    await prisma.draft.create({
      data: {
        seasonId: season.id,
        status: DRAFT_STATUS.IN_PROGRESS,
        nominatorTeamId: a.team.id,
        nominatedUserId: players[1].id,
        currentBid: 1,
        currentBidTeamId: a.team.id,
        bidEndsAt: expired,
      },
    });
    const before = await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } });

    const snap = await loadLeagueStatusSnapshot();
    expect(snap.phase).toBe("DRAFT");
    // Two teams of three: four seats to sell, one sold.
    expect(snap.draft).toMatchObject({ state: "LIVE", captains: 2, sold: 1, pool: 4 });
    // The loader is a read: an expired bid clock is the draft engine's to
    // resolve, never the card's.
    const after = await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } });
    expect(after).toEqual(before);
    expect(await prisma.teamMember.count({ where: { seasonId: season.id } })).toBe(3);
    fits(snap);
  });

  it("lists the drafted teams and week 1's kickoff once the draft is over", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    const a = await makeTeam(season.id, "Alpha", 0);
    const b = await makeTeam(season.id, "Bravo", 1);
    const withdrawn = await makeTeam(season.id, "Gone", 2);
    await prisma.team.update({ where: { id: withdrawn.id }, data: { withdrawn: true } });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
    const kickoff = new Date(Date.now() + 4 * DAY);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        homeTeamId: a.id,
        awayTeamId: b.id,
        scheduledAt: kickoff,
      },
    });
    const snap = await loadLeagueStatusSnapshot();
    expect(snap.draft).toMatchObject({
      state: "COMPLETE",
      captains: 2,
      teams: ["Alpha", "Bravo"],
      seasonStartsAtMs: kickoff.getTime(),
    });
  });
});

describe("league status snapshot — the regular season", () => {
  async function seasonInWeekTwo() {
    // Week 1 was played last week; week 2's night is tomorrow.
    const firstMatchNight = new Date(Date.now() - 6 * DAY);
    const season = await makeSeason({
      name: "Season 2",
      status: SEASON_STATUS.REGULAR_SEASON,
      firstMatchNight,
      teamSize: 5,
    });
    const [a, b, c, d, e] = await Promise.all(
      ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((name, i) =>
        makeTeam(season.id, name, i),
      ),
    );
    const night = (week: number) => matchNightForWeek(firstMatchNight, week);
    const star = await makeUser("Star Carry");
    const homePlayers = [
      star,
      ...(await Promise.all([1, 2, 3, 4].map((i) => makeUser(`Alpha ${i}`)))),
    ];
    const awayPlayers = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => makeUser(`Bravo ${i}`)),
    );
    for (const [team, roster] of [
      [a, homePlayers],
      [b, awayPlayers],
    ] as const) {
      for (const user of roster) {
        await prisma.teamMember.create({
          data: { seasonId: season.id, teamId: team.id, userId: user.id, price: 10 },
        });
      }
    }
    const week1 = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: a.id,
        awayTeamId: b.id,
        scheduledAt: night(1),
        bestOf: 1,
        homeScore: 1,
        awayScore: 0,
        winnerTeamId: a.id,
        status: MATCH_STATUS.COMPLETED,
        completedAt: new Date(),
      },
    });
    await prisma.game.create({
      data: {
        matchId: week1.id,
        dotaMatchId: `${Date.now()}`,
        radiantWin: true,
        radiantTeamId: a.id,
        direTeamId: b.id,
        winnerTeamId: a.id,
        players: JSON.stringify([
          ...homePlayers.map((player, i) => ({
            accountId: i + 1,
            userId: player.id,
            teamId: a.id,
            isRadiant: true,
            // 6 is Drow Ranger: the star's best game.
            heroId: i === 0 ? 6 : i + 1,
            kills: i === 0 ? 14 : 2,
            deaths: 1,
            assists: i === 0 ? 9 : 4,
            gpm: i === 0 ? 650 : 400,
            lastHits: 200,
          })),
          ...awayPlayers.map((player, i) => ({
            accountId: i + 101,
            userId: player.id,
            teamId: b.id,
            isRadiant: false,
            heroId: i + 101,
            kills: 1,
            deaths: 5,
            assists: 2,
            gpm: 300,
            lastHits: 100,
          })),
        ]),
      },
    });
    const onNight = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 2,
        homeTeamId: a.id,
        awayTeamId: c.id,
        scheduledAt: night(2),
        bestOf: 2,
      },
    });
    const moved = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 2,
        homeTeamId: b.id,
        awayTeamId: d.id,
        scheduledAt: new Date(night(2).getTime() + DAY),
        bestOf: 2,
      },
    });
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 3,
        homeTeamId: c.id,
        awayTeamId: e.id,
        scheduledAt: night(3),
        bestOf: 2,
      },
    });
    return { season, teams: { a, b, c, d, e }, star, homePlayers, onNight, moved, night };
  }

  it("shows the week in focus with its standins, offers, moves and bye", async () => {
    const { season, teams, homePlayers, onNight, night } = await seasonInWeekTwo();
    const standin = await makeUser("Fill_In");
    await prisma.standinAssignment.create({
      data: {
        matchId: onNight.id,
        teamId: teams.a.id,
        standinUserId: standin.id,
        replacingUserId: homePlayers[1].id,
      },
    });
    // Cover for somebody who isn't on Charlie's roster: stale, left out.
    await prisma.standinAssignment.create({
      data: {
        matchId: onNight.id,
        teamId: teams.c.id,
        standinUserId: standin.id,
        replacingUserId: homePlayers[2].id,
      },
    });
    const later = night(2).getTime() + 2 * DAY;
    await prisma.rescheduleRequest.create({
      data: {
        matchId: onNight.id,
        proposedById: teams.c.captainId,
        proposedTime: new Date(later),
        options: serializeRescheduleOptions([later, later + DAY]),
      },
    });

    const snap = await loadLeagueStatusSnapshot();
    expect(snap.phase).toBe("REGULAR_SEASON");
    expect(snap.week).toMatchObject({
      label: "Week 2 of 3",
      matchNightAtMs: night(2).getTime(),
      byes: ["Echo"],
    });
    expect(snap.week!.fixtures).toEqual([
      expect.objectContaining({
        home: "Alpha",
        away: "Charlie",
        state: "UPCOMING",
        moved: false,
        standins: [{ standin: "Fill_In", replaced: "Alpha 1", team: "Alpha" }],
        reschedule: { proposer: "Charlie", waitingOn: "Alpha", options: 2 },
      }),
      expect.objectContaining({ home: "Bravo", away: "Delta", moved: true, standins: [] }),
    ]);
    // Alpha won week 1; five teams make a four-team bracket.
    expect(oneTable(snap).rows[0]).toEqual({ pos: 1, team: "Alpha", points: 3 });
    expect(oneTable(snap).rows).toHaveLength(5);
    expect(oneTable(snap).playoffSpots).toBe(4);
    expect(cardText(snap)).toContain("**Standings**\n```");
    expect(snap.highlights).toMatchObject({
      week: 1,
      player: { name: "Star Carry", hero: "Drow Ranger" },
      team: { name: "Alpha", wins: 1 },
      recapUrl: `${resolveSiteUrl()}/seasons/${season.id}/weeks/1`,
    });
    expect(snap.highlights?.heroImageUrl).toMatch(/^https:\/\/.+drow_ranger\.png$/);
    fits(snap);
  });

  it("drops an offer whose every time has passed, and a result's notes", async () => {
    const { teams, onNight, moved } = await seasonInWeekTwo();
    const past = Date.now() - DAY;
    await prisma.rescheduleRequest.create({
      data: {
        matchId: onNight.id,
        proposedById: teams.c.captainId,
        proposedTime: new Date(past),
        options: serializeRescheduleOptions([past]),
      },
    });
    await prisma.match.update({
      where: { id: moved.id },
      data: {
        homeScore: 1,
        awayScore: 1,
        status: MATCH_STATUS.COMPLETED,
        completedAt: new Date(),
      },
    });
    const snap = await loadLeagueStatusSnapshot();
    expect(snap.week!.fixtures[0].reschedule).toBeNull();
    expect(snap.week!.fixtures[1]).toMatchObject({ state: "FINAL", winner: null });
  });

  it("moves the whole week with an admin's new night instead of calling every fixture moved", async () => {
    const { onNight, moved, night } = await seasonInWeekTwo();
    const newNight = new Date(night(2).getTime() + 2 * 60 * 60_000);
    await prisma.match.updateMany({
      where: { id: { in: [onNight.id, moved.id] } },
      data: { scheduledAt: newNight },
    });
    const snap = await loadLeagueStatusSnapshot();
    expect(snap.week?.matchNightAtMs).toBe(newNight.getTime());
    expect(snap.week!.fixtures.map((f) => f.moved)).toEqual([false, false]);
  });
});

describe("league status snapshot — a group season", () => {
  it("prints each group's own table: places within the group, a line under its qualifiers", async () => {
    const firstMatchNight = new Date(Date.now() - 6 * DAY);
    const season = await makeSeason({
      name: "Season 3",
      status: SEASON_STATUS.REGULAR_SEASON,
      firstMatchNight,
      teamSize: 5,
    });
    // Ten teams: two groups of five, as schedule generation draws them.
    const groups = {
      A: ["Alpha", "Bravo", "Charlie", "Delta", "Echo"],
      B: ["Foxtrot", "Golf", "Hotel", "India", "Juliet"],
    };
    const id: Record<string, string> = {};
    let draftOrder = 0;
    for (const [groupKey, names] of Object.entries(groups)) {
      for (const name of names) {
        const team = await makeTeam(season.id, name, draftOrder++);
        await prisma.team.update({ where: { id: team.id }, data: { groupKey } });
        id[name] = team.id;
      }
    }
    const night = (week: number) => matchNightForWeek(firstMatchNight, week);
    const fixture = (week: number, home: string, away: string, score?: [number, number]) =>
      prisma.match.create({
        data: {
          seasonId: season.id,
          week,
          phase: MATCH_PHASE.REGULAR,
          homeTeamId: id[home],
          awayTeamId: id[away],
          scheduledAt: night(week),
          bestOf: 3,
          ...(score
            ? {
                homeScore: score[0],
                awayScore: score[1],
                winnerTeamId: id[score[0] > score[1] ? home : away],
                status: MATCH_STATUS.COMPLETED,
                completedAt: new Date(),
              }
            : {}),
        },
      });
    // Week 1 inside each group: the 2–0 winners lead, the 2–1 winners are
    // second, and the teams that sat out sit third.
    await fixture(1, "Alpha", "Bravo", [2, 0]);
    await fixture(1, "Charlie", "Delta", [2, 1]);
    await fixture(1, "Golf", "Foxtrot", [2, 0]);
    await fixture(1, "Hotel", "India", [2, 1]);
    await fixture(2, "Alpha", "Charlie");
    await fixture(2, "Echo", "Bravo");
    await fixture(2, "Golf", "Hotel");
    await fixture(2, "Juliet", "Foxtrot");

    const snap = await loadLeagueStatusSnapshot();
    expect(snap.phase).toBe("REGULAR_SEASON");
    expect(snap.week).toMatchObject({ label: "Week 2 of 2", byes: ["Delta", "India"] });
    // Group B's leader is first in Group B, never 6th of one table, and the
    // top four of each group go through to an eight-team bracket.
    const row = (pos: number, team: string, points: number) => ({ pos, team, points });
    expect(groupTables(snap)).toEqual([
      {
        title: "Group A",
        rows: [
          row(1, "Alpha", 3),
          row(2, "Charlie", 3),
          row(3, "Echo", 0),
          row(4, "Delta", 0),
          row(5, "Bravo", 0),
        ],
        playoffSpots: 4,
      },
      {
        title: "Group B",
        rows: [
          row(1, "Golf", 3),
          row(2, "Hotel", 3),
          row(3, "Juliet", 0),
          row(4, "India", 0),
          row(5, "Foxtrot", 0),
        ],
        playoffSpots: 4,
      },
    ]);
    const text = cardText(snap);
    expect(text).not.toContain("**Standings**");
    expect(text).toContain(
      [
        "**Group A**",
        "```",
        " # Team                  Pts",
        " 1 Alpha                   3",
        " 2 Charlie                 3",
        " 3 Echo                    0",
        " 4 Delta                   0",
        "   ── playoff line ─────────",
        " 5 Bravo                   0",
        "```",
        "**Group B**",
        "```",
        " # Team                  Pts",
        " 1 Golf                    3",
        " 2 Hotel                   3",
        " 3 Juliet                  0",
        " 4 India                   0",
        "   ── playoff line ─────────",
        " 5 Foxtrot                 0",
        "```",
      ].join("\n"),
    );
    fits(snap);
  });
});

describe("league status snapshot — the playoffs", () => {
  it("shows the open round, who advanced, the next round and the stream", async () => {
    const firstMatchNight = new Date(Date.now() - 20 * DAY);
    const season = await makeSeason({
      status: SEASON_STATUS.PLAYOFFS,
      firstMatchNight,
      playoffBestOf: 3,
      finalBestOf: 5,
    });
    const [a, b, c, d] = await Promise.all(
      ["Alpha", "Bravo", "Charlie", "Delta"].map((name, i) => makeTeam(season.id, name, i)),
    );
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 4,
        phase: MATCH_PHASE.PLAYOFF,
        bracketSlot: "R0M0",
        homeTeamId: a.id,
        awayTeamId: d.id,
        bestOf: 3,
        homeScore: 2,
        awayScore: 1,
        winnerTeamId: a.id,
        status: MATCH_STATUS.COMPLETED,
        completedAt: new Date(),
      },
    });
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 4,
        phase: MATCH_PHASE.PLAYOFF,
        bracketSlot: "R0M1",
        homeTeamId: b.id,
        awayTeamId: c.id,
        bestOf: 3,
        scheduledAt: new Date(Date.now() + DAY),
      },
    });
    await setSetting(SETTING_KEYS.LEAGUE_STREAM_URL, "https://www.twitch.tv/ggd2l");

    const snap = await loadLeagueStatusSnapshot();
    expect(snap.phase).toBe("PLAYOFFS");
    expect(snap.playoffs).toMatchObject({
      round: "Semifinals",
      next: {
        round: "Grand final",
        bestOf: 5,
        atMs: matchNightForWeek(firstMatchNight, 5).getTime(),
      },
      stream: { platform: "Twitch", url: "https://www.twitch.tv/ggd2l" },
      bracketUrl: `${resolveSiteUrl()}/seasons/${season.id}#playoffs`,
    });
    expect(snap.playoffs!.fixtures).toEqual([
      expect.objectContaining({
        home: "Alpha",
        state: "FINAL",
        winner: "HOME",
        outcome: "Alpha advance to the grand final",
      }),
      expect.objectContaining({ home: "Bravo", state: "UPCOMING", bestOf: 3, outcome: null }),
    ]);
    fits(snap);
  });
});

describe("league status snapshot — season complete", () => {
  it("crowns the champion with the final, the roster and the next season's date", async () => {
    const season = await makeSeason({ name: "Season 2", status: SEASON_STATUS.COMPLETE });
    const champ = await makeCaptain(season.id, "Cap Carl", 100, 0);
    await prisma.team.update({
      where: { id: champ.team.id },
      data: { name: "Bad Boys of Dota", logoUrl: "/brand/bad-boys.png" },
    });
    const sue = await makeUser("Support Sue");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: champ.team.id, userId: sue.id, price: 30 },
    });
    const other = await makeTeam(season.id, "Bleeding Hearts", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 6,
        phase: MATCH_PHASE.FINAL,
        bracketSlot: "R0M0",
        homeTeamId: other.id,
        awayTeamId: champ.team.id,
        bestOf: 5,
        homeScore: 1,
        awayScore: 3,
        winnerTeamId: champ.team.id,
        status: MATCH_STATUS.COMPLETED,
        completedAt: new Date(),
      },
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { championTeamId: champ.team.id },
    });
    const signupsAtMs = Date.now() + 30 * DAY;
    await setSetting(
      SETTING_KEYS.NEXT_SEASON_PLAN,
      serializeNextSeasonPlan({ seasonId: season.id, signupsAtMs }),
    );

    const snap = await loadLeagueStatusSnapshot();
    expect(snap.phase).toBe("COMPLETE");
    expect(snap.champion).toEqual({
      team: "Bad Boys of Dota",
      logoUrl: `${resolveSiteUrl()}/brand/bad-boys.png`,
      final: { opponent: "Bleeding Hearts", score: "3–1", forfeit: false },
      roster: [
        { name: "Cap Carl", captain: true },
        { name: "Support Sue", captain: false },
      ],
      recapUrl: `${resolveSiteUrl()}/seasons/${season.id}`,
    });
    expect(snap.nextSignupsAtMs).toBe(new Date(signupsAtMs).getTime());
    fits(snap);
  });

  it("shows no champion while the title needs review", async () => {
    await makeSeason({ status: SEASON_STATUS.COMPLETE });
    const snap = await loadLeagueStatusSnapshot();
    expect(snap.champion).toBeNull();
  });
});

describe("league status snapshot — the inhouse night", () => {
  async function storeNight(startsAtMs: number, note = "") {
    await setSetting(
      SETTING_KEYS.INHOUSE_NIGHT,
      serializeInhouseNight({
        id: "night-1",
        startsAtMs,
        note,
        createdAtMs: Date.now() - DAY,
        revision: 0,
        discordEventId: null,
      }),
    );
  }

  it("is upcoming, then on for the night's length, then gone", async () => {
    await makeSeason();
    const at = Date.now() + DAY;
    await storeNight(at, "Turbo night");
    expect((await loadLeagueStatusSnapshot()).inhouseNight).toEqual({
      startsAtMs: at,
      state: "UPCOMING",
      note: "Turbo night",
      inviteUrl: `${resolveSiteUrl()}/inhouse?imin=1`,
      joinUrl: `${resolveSiteUrl()}/inhouse?join=1`,
    });
    expect((await loadLeagueStatusSnapshot(at + 60 * 60_000)).inhouseNight?.state).toBe("ON");
    expect((await loadLeagueStatusSnapshot(at + 4 * 60 * 60_000)).inhouseNight).toBeNull();
  });
});
