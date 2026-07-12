// Seed a FIXTURE database into a mid-season or mid-playoffs state for UI
// verification. Refuses to touch a non-fixture DB: run with an explicit
//   DATABASE_URL="file:/abs/path/fixture.db" npx tsx scripts/seed-fixture.ts
// Modes: FIXTURE_MODE=regular (last week open, clinch/bye demo, 6 teams or
// FIXTURE_TEAMS=n) | complete (whole bracket played) | default (mid-playoffs).
// Seed a scratch DB into mid-PLAYOFFS so the interactive bracket is
// visually verifiable: 8-team bracket, quarterfinals done, one semi done,
// final still TBD. Run with: npx tsx fixture-playoffs.ts
import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";
import { matchNightForWeek } from "@/lib/schedule";
import {
  createPlayoffBracket,
  advancePlayoffBracket,
} from "@/lib/playoff-service";
import {
  resetDb,
  makeSeason,
  makeTeam,
  makeUser,
  generateRegularSchedule,
  recordMatch,
  drivePlayoffsToChampion,
} from "../test/integration/factories";

const NAMES = [
  "Radiant Raccoons",
  "Dire Straits",
  "Roshan's Revenge",
  "Pudge Patrol",
  "Techies Anonymous",
  "The Couriers of Catastrophe With Very Long Name",
  "Smoke Gank City",
  "Feed & Seed",
];

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/fixture/i.test(url)) {
    throw new Error(
      `Refusing to seed: DATABASE_URL (${url || "unset"}) doesn't look like a fixture DB. ` +
        "Point it at a throwaway file containing 'fixture'.",
    );
  }

  await resetDb();
  const season = await makeSeason({
    name: "Season 9 (fixture)",
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const firstNight = new Date("2026-06-06T18:00:00-07:00");
  await prisma.season.update({
    where: { id: season.id },
    data: { firstMatchNight: firstNight },
  });

  const teams = [];
  const teamCount = Number(process.env.FIXTURE_TEAMS) || (process.env.FIXTURE_MODE === "regular" ? 6 : NAMES.length);
  for (let i = 0; i < teamCount; i++)
    teams.push(await makeTeam(season.id, NAMES[i], i));
  const strength = new Map(teams.map((t, i) => [t.id, i]));

  // FIXTURE_MODE=regular: 6 teams, last week left open — shows
  // clinched/eliminated marks. Default: 8 teams, mid-playoffs bracket.
  const regularMode = process.env.FIXTURE_MODE === "regular";
  const matches = await generateRegularSchedule(season.id);
  // Give every regular match its league-night time (playoff rounds get theirs
  // from the bracket services) — the calendar feed and match times are part
  // of what fixtures exist to verify.
  for (const m of matches) {
    await prisma.match.update({
      where: { id: m.id },
      data: { scheduledAt: matchNightForWeek(firstNight, m.week) },
    });
  }
  const lastWeek = Math.max(...matches.map((m) => m.week));
  for (const m of matches) {
    if (regularMode && m.week === lastWeek) continue;
    const homeStronger =
      strength.get(m.homeTeamId)! < strength.get(m.awayTeamId)!;
    // A couple of draws for standings variety.
    const draw = m.week === 3 && Math.random() < 0.25;
    await recordMatch(
      m.id,
      draw ? 1 : homeStronger ? 2 : 0,
      draw ? 1 : homeStronger ? 0 : 2,
    );
  }

  // Rosters (3 players/team) + imported game box scores so /leaders,
  // honors, and fantasy have data. Deterministic stats — no RNG.
  const roster = new Map<string, { id: string; name: string }[]>();
  for (const [ti, t] of teams.entries()) {
    const members = [];
    for (let j = 0; j < 3; j++) {
      const u = await makeUser(t.name.split(" ")[0] + " Player" + (j + 1));
      await prisma.teamMember.create({
        data: {
          seasonId: season.id,
          teamId: t.id,
          userId: u.id,
          isCaptain: j === 0,
          price: ti,
        },
      });
      members.push(u);
    }
    roster.set(t.id, members);
  }
  let dotaId = 8000000000;
  let gameIndex = 0;
  // Box scores for every COMPLETED match that doesn't have them yet —
  // callable again after playoff rounds resolve so the bracket's matches get
  // real games too. The first two games ever stay "legacy" (no benchmarks /
  // extended fields) so report-card degradation is always verifiable.
  const seedBoxScores = async () => {
    const done = await prisma.match.findMany({
      where: { seasonId: season.id, status: "COMPLETED", games: { none: {} } },
    });
    for (const [mi, m] of done.entries()) {
      const total = Math.max(1, m.homeScore + m.awayScore);
      for (let g = 0; g < total; g++) {
        const homeWon = g < m.homeScore;
        const winner = homeWon ? m.homeTeamId : m.awayTeamId;
        const legacy = gameIndex < 2;
        const gi = gameIndex++;
        const lines = [];
        for (const [side, teamId] of [[true, m.homeTeamId], [false, m.awayTeamId]] as const) {
          const won = (winner === teamId);
          for (const [pi, u] of roster.get(teamId)!.entries()) {
            const seed = mi * 7 + g * 3 + pi * 11 + (side ? 0 : 5);
            const pct = (offset: number) => ((gi * 13 + pi * 7 + offset) % 20) / 20 + 0.025;
            lines.push({
              accountId: 100000 + seed,
              heroId: 1 + (seed % 30),
              isRadiant: side,
              kills: (won ? 6 : 2) + (seed % 9),
              deaths: (won ? 1 : 4) + (seed % 5),
              assists: 4 + (seed % 14),
              personaname: u.name,
              netWorth: 9000 + (seed % 40) * 450 + (won ? 4000 : 0),
              gpm: 320 + (seed % 50) * 6 + (won ? 60 : 0),
              lastHits: 80 + (seed % 120),
              userId: u.id,
              teamId,
              // Report-card fields (what a modern import stores) — spread of
              // deterministic percentiles so every grade S..D shows up.
              ...(legacy
                ? {}
                : {
                    xpm: 380 + ((seed * 3) % 300),
                    denies: seed % 25,
                    level: 18 + (seed % 8),
                    heroDamage: 9000 + (seed % 40) * 700,
                    towerDamage: 800 + (seed % 30) * 350,
                    heroHealing: pi % 3 === 2 ? 4000 + (seed % 20) * 400 : 0,
                    benchmarks: {
                      gold_per_min: { raw: 320 + (seed % 50) * 6, pct: pct(0) },
                      xp_per_min: { raw: 380 + ((seed * 3) % 300), pct: pct(5) },
                      kills_per_min: { raw: 0.2 + (seed % 10) / 20, pct: pct(9) },
                      last_hits_per_min: { raw: 2 + (seed % 30) / 5, pct: pct(13) },
                      hero_damage_per_min: { raw: 300 + (seed % 40) * 20, pct: pct(3) },
                      tower_damage: { raw: 800 + (seed % 30) * 350, pct: pct(11) },
                    },
                  }),
            });
          }
        }
        await prisma.game.create({
          data: {
            matchId: m.id,
            dotaMatchId: String(dotaId++),
            radiantWin: homeWon,
            winnerTeamId: winner,
            durationSecs: 1500 + ((gi * 97) % 1800),
            startTime: Math.floor(matchNightForWeek(firstNight, m.week).getTime() / 1000) + g * 3600,
            radiantScore: homeWon ? 30 + (gi % 15) : 18 + (gi % 10),
            direScore: homeWon ? 18 + (gi % 10) : 30 + (gi % 15),
            players: JSON.stringify(lines),
          },
        });
      }
    }
    return done.length;
  };
  const seededMatches = await seedBoxScores();
  console.log("Rosters + " + seededMatches + " matches of box scores seeded.");

  if (regularMode) {
    const anyUser = roster.get(teams[2].id)![1];
    const steam = await prisma.user.findUnique({ where: { id: anyUser.id } });
    console.log("Viewer candidate:", anyUser.name, steam!.steamId);
    console.log("Regular-season fixture ready (last week open).");
    return;
  }
  await prisma.season.update({
    where: { id: season.id },
    data: { status: SEASON_STATUS.PLAYOFFS },
  });
  await createPlayoffBracket(season.id);

  // Play all quarterfinals (home = higher seed wins), then one semifinal.
  const qfs = await prisma.match.findMany({
    where: { seasonId: season.id, phase: { in: ["PLAYOFF", "FINAL"] } },
  });
  for (const m of qfs) {
    await recordMatch(m.id, 2, 1);
    await advancePlayoffBracket(season.id);
  }
  const semis = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      phase: { in: ["PLAYOFF", "FINAL"] },
      status: { not: "COMPLETED" },
    },
    orderBy: { bracketSlot: "asc" },
  });
  if (semis[0]) {
    await recordMatch(semis[0].id, 2, 0);
    await advancePlayoffBracket(season.id);
  }

  // FIXTURE_MODE=complete: play out the whole bracket and crown a champion.
  if (process.env.FIXTURE_MODE === "complete") {
    const final = await drivePlayoffsToChampion(season.id);
    console.log("Season complete, champion:", final.championTeamId);
  }

  // Completed playoff matches deserve box scores too — a finished semi that
  // says "no games recorded" makes the fixture look broken.
  await seedBoxScores();

  const all = await prisma.match.findMany({
    where: { seasonId: season.id, phase: { in: ["PLAYOFF", "FINAL"] } },
    orderBy: { bracketSlot: "asc" },
  });
  console.log(
    all.map((m) => `${m.bracketSlot} ${m.status} ${m.homeScore}-${m.awayScore}`),
  );
  console.log("Fixture ready.");
}

main().finally(() => prisma.$disconnect());
