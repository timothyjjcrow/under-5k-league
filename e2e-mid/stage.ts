// Stage the fixture states seed-fixture doesn't cover: a LIVE mid-series
// match inside the auto-sync window (the chip the schedule/dashboard specs
// assert), with the rest of the open week retimed to tonight so this-week
// surfaces stay populated. Guarded like every fixture writer: it accepts only
// the midseason browser suite's exact SQLite database.
import { AUTO_SYNC } from "@/lib/constants";
import { assertExpectedFixtureDatabase } from "@/lib/fixture-database";
import { prisma } from "@/lib/prisma";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  assertExpectedFixtureDatabase(url, ["midseason"], "stage midseason data");
  const open = await prisma.match.findMany({
    where: { status: { not: "COMPLETED" } },
    orderBy: { week: "asc" },
  });
  if (open.length === 0)
    throw new Error("fixture has no open matches to stage");

  await prisma.match.update({
    where: { id: open[0].id },
    data: {
      status: "LIVE",
      homeScore: 1,
      awayScore: 0,
      scheduledAt: new Date(Date.now() - 90 * 60_000),
      // In the auto-sync window on purpose (the specs assert watch-mode UI),
      // but parked at MAX BACKOFF: the real <ResultSyncPing> runs in the test
      // browser against the real /api/sync, and without this every page view
      // of every run would claim the match and roster-scan REAL OpenDota
      // (junk lookups of real early Steam accounts, the dev's API key from
      // .env attached, and a flake tail-risk if a fetch ever validated).
      // 240s << BACKOFF_DOUBLINGS ≈ 4.3h — unclaimable for the whole run.
      autoSyncedAt: new Date(),
      autoSyncAttempts: AUTO_SYNC.BACKOFF_DOUBLINGS,
    },
  });

  // Import one valid game for the LIVE match without completing its week's
  // slate. This is deliberately the state that used to publish premature
  // weekly honors: the stats exist, but the award must remain visibly locked
  // until every match in the week is final.
  const [liveHomeMembers, liveAwayMembers] = await Promise.all([
    prisma.teamMember.findMany({
      where: { teamId: open[0].homeTeamId },
      orderBy: { id: "asc" },
    }),
    prisma.teamMember.findMany({
      where: { teamId: open[0].awayTeamId },
      orderBy: { id: "asc" },
    }),
  ]);
  if (liveHomeMembers.length === 0 || liveAwayMembers.length === 0) {
    throw new Error("fixture rosters are too small for a live 5v5 game");
  }
  const livePlayers = [
    ...liveHomeMembers.map((member, index) => ({
      accountId: null,
      heroId: index + 1,
      isRadiant: true,
      kills: 7 + index,
      deaths: 2 + (index % 2),
      assists: 10 + index,
      personaname: null,
      netWorth: 14_000 + index * 500,
      gpm: 480 + index * 10,
      lastHits: 160 + index * 8,
      userId: member.userId,
      teamId: member.teamId,
    })),
    ...liveAwayMembers.map((member, index) => ({
      accountId: null,
      heroId: liveHomeMembers.length + index + 1,
      isRadiant: false,
      kills: 3 + index,
      deaths: 6 + (index % 2),
      assists: 7 + index,
      personaname: null,
      netWorth: 10_000 + index * 400,
      gpm: 360 + index * 10,
      lastHits: 110 + index * 7,
      userId: member.userId,
      teamId: member.teamId,
    })),
  ];
  await prisma.game.upsert({
    where: { dotaMatchId: "e2e-mid-partial-live" },
    update: {
      matchId: open[0].id,
      radiantWin: true,
      durationSecs: 2_040,
      startTime: Math.floor(Date.now() / 1000) - 7_200,
      radiantScore: 34,
      direScore: 19,
      radiantTeamId: open[0].homeTeamId,
      direTeamId: open[0].awayTeamId,
      winnerTeamId: open[0].homeTeamId,
      players: JSON.stringify(livePlayers),
    },
    create: {
      matchId: open[0].id,
      dotaMatchId: "e2e-mid-partial-live",
      radiantWin: true,
      durationSecs: 2_040,
      startTime: Math.floor(Date.now() / 1000) - 7_200,
      radiantScore: 34,
      direScore: 19,
      radiantTeamId: open[0].homeTeamId,
      direTeamId: open[0].awayTeamId,
      winnerTeamId: open[0].homeTeamId,
      players: JSON.stringify(livePlayers),
    },
  });
  for (const m of open.slice(1)) {
    await prisma.match.update({
      where: { id: m.id },
      data: { scheduledAt: new Date(Date.now() + 3 * 3600_000) },
    });
  }

  // Give one still-SCHEDULED fixture stable browser identities for the real
  // player/captain logistics flow. seed-fixture's roster marks a member as
  // isCaptain but makeTeam's authoritative Team.captainId points at a
  // different bootstrap user; align those two sources before testing captain
  // permissions, and never make the spec discover identities from DB internals.
  const target = open.slice(1).find((m) => m.status === "SCHEDULED");
  if (!target) throw new Error("fixture has no scheduled match for logistics");
  const [homeMembers, awayMembers] = await Promise.all([
    prisma.teamMember.findMany({
      where: { teamId: target.homeTeamId },
      orderBy: { id: "asc" },
    }),
    prisma.teamMember.findMany({
      where: { teamId: target.awayTeamId },
      orderBy: { id: "asc" },
    }),
  ]);
  if (homeMembers.length < 2 || awayMembers.length < 1) {
    throw new Error("fixture rosters are too small for logistics identities");
  }
  const identities = {
    homeCaptain: {
      userId: homeMembers[0].userId,
      steamId: "76561190000991001",
    },
    awayCaptain: {
      userId: awayMembers[0].userId,
      steamId: "76561190000991002",
    },
    player: { userId: homeMembers[1].userId, steamId: "76561190000991003" },
  };
  await prisma.$transaction([
    prisma.user.update({
      where: { id: identities.homeCaptain.userId },
      data: { steamId: identities.homeCaptain.steamId },
    }),
    prisma.user.update({
      where: { id: identities.awayCaptain.userId },
      data: { steamId: identities.awayCaptain.steamId },
    }),
    prisma.user.update({
      where: { id: identities.player.userId },
      data: { steamId: identities.player.steamId },
    }),
    prisma.team.update({
      where: { id: target.homeTeamId },
      data: { captainId: identities.homeCaptain.userId },
    }),
    prisma.team.update({
      where: { id: target.awayTeamId },
      data: { captainId: identities.awayCaptain.userId },
    }),
    prisma.teamMember.updateMany({
      where: { teamId: { in: [target.homeTeamId, target.awayTeamId] } },
      data: { isCaptain: false },
    }),
    prisma.teamMember.update({
      where: { id: homeMembers[0].id },
      data: { isCaptain: true },
    }),
    prisma.teamMember.update({
      where: { id: awayMembers[0].id },
      data: { isCaptain: true },
    }),
    prisma.user.upsert({
      where: { id: "e2e-mid-no-history" },
      update: {
        name: "New Spectator",
        steamId: "76561190000991999",
      },
      create: {
        id: "e2e-mid-no-history",
        name: "New Spectator",
        steamId: "76561190000991999",
      },
    }),
  ]);
  // Keep staging replay-safe even when this helper is invoked twice without a
  // seed in between: replace only the two rows this script owns.
  await prisma.newsPost.deleteMany({
    where: {
      id: { in: ["e2e-mid-news-pinned", "e2e-mid-news-latest"] },
    },
  });
  await prisma.newsPost.createMany({
    data: [
      {
        id: "e2e-mid-news-pinned",
        title: "Match night reminder",
        body: "Check in with your captain before the first lobby.",
        pinned: true,
        authorId: identities.homeCaptain.userId,
        createdAt: new Date("2026-08-01T20:00:00.000Z"),
      },
      {
        id: "e2e-mid-news-latest",
        title: "Week schedule published",
        body: "The latest fixtures are ready on the schedule page.\nhttps://localhost:3212/e2e-news.gif",
        pinned: false,
        authorId: identities.awayCaptain.userId,
        createdAt: new Date("2026-08-02T20:00:00.000Z"),
      },
    ],
  });
  console.log(
    `staged: 1 LIVE match with one valid 5v5 game + ${open.length - 1} tonight; logistics match ${target.id}; 2 news posts`,
  );
}

main().finally(() => prisma.$disconnect());
