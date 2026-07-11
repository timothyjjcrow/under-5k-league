import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  LeaderBoard,
  type LeaderBoardRow,
} from "@/components/leader-board";
import {
  summarizePlayerGames,
  topBy,
  type LeaderboardKey,
  type LeaderEntry,
  type LeaderRow,
  type PlayerGameLine,
} from "@/lib/player-stats";
import type { PlayerStat } from "@/lib/match-import";
import { weeklyHonors } from "@/lib/honors";
import { getHeroNames } from "@/lib/dota";
import { formatNetWorth } from "@/lib/utils";
import {
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
} from "@/components/ui";

export const metadata = { title: "Leaders" };

function safeParse(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

type DisplayUser = { name: string; avatar: string | null; rankTier: number | null };

export default async function LeadersPage() {
  const [season, viewer] = await Promise.all([
    getActiveSeason(),
    getSessionUser(),
  ]);
  if (!season) {
    return (
      <div>
        <PageTitle title="Leaders" />
        <EmptyState title="No active season" />
      </div>
    );
  }

  const games = await prisma.game.findMany({
    where: { match: { seasonId: season.id } },
    select: {
      players: true,
      radiantWin: true,
      match: { select: { week: true, phase: true } },
    },
  });

  // Accumulate each mapped player's per-game lines across the whole season.
  const linesByUser = new Map<string, PlayerGameLine[]>();
  for (const g of games) {
    for (const p of safeParse(g.players)) {
      if (!p.userId) continue;
      const arr = linesByUser.get(p.userId) ?? [];
      arr.push({
        isRadiant: p.isRadiant,
        radiantWin: g.radiantWin,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        heroId: p.heroId,
        netWorth: p.netWorth,
        gpm: p.gpm,
      });
      linesByUser.set(p.userId, arr);
    }
  }

  const entries: LeaderEntry[] = [...linesByUser.entries()].map(
    ([id, lines]) => ({ id, summary: summarizePlayerGames(lines) }),
  );

  if (entries.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle title="Leaders" subtitle={season.name} />
        <EmptyState
          title="No stats yet"
          description="Leaderboards fill in once match games are imported."
        />
      </div>
    );
  }

  const users = await prisma.user.findMany({
    where: { id: { in: entries.map((e) => e.id) } },
    select: { id: true, name: true, avatar: true, rankTier: true },
  });
  const userMap = new Map<string, DisplayUser>(
    users.map((u) => [u.id, { name: u.name, avatar: u.avatar, rankTier: u.rankTier }]),
  );

  // Weekly honors: Player/Team of the Week per regular week with games in.
  const [members, teams, heroNames] = await Promise.all([
    prisma.teamMember.findMany({
      where: { seasonId: season.id },
      select: { userId: true, teamId: true },
    }),
    prisma.team.findMany({
      where: { seasonId: season.id },
      select: { id: true, name: true },
    }),
    getHeroNames(),
  ]);
  const teamOf = new Map(members.map((m) => [m.userId, m.teamId]));
  const teamNameOf = new Map(teams.map((t) => [t.id, t.name]));
  const regularWeeks = [
    ...new Set(
      games.filter((g) => g.match.phase === "REGULAR").map((g) => g.match.week),
    ),
  ].sort((a, b) => b - a);
  const honorsByWeek = regularWeeks
    .map((week) => ({
      week,
      honors: weeklyHonors(
        games
          .filter((g) => g.match.week === week && g.match.phase === "REGULAR")
          .map((g) => ({ radiantWin: g.radiantWin, players: safeParse(g.players) })),
        teamOf,
      ),
    }))
    .filter((h) => h.honors.player || h.honors.team);

  // Early in a season everyone has few games; don't let the rate floor empty
  // the board. Cap the floor at the most-played count.
  const maxGames = Math.max(1, ...entries.map((e) => e.summary.games));
  const rateFloor = Math.min(3, maxGames);

  const boards: {
    title: string;
    subtitle?: string;
    key: LeaderboardKey;
    minGames?: number;
    format: (r: LeaderRow) => string;
    hint: (r: LeaderRow) => string;
  }[] = [
    {
      title: "Most wins",
      key: "wins",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.wins}–${r.summary.losses}`,
    },
    {
      title: "Best KDA",
      subtitle: `min ${rateFloor} game${rateFloor > 1 ? "s" : ""}`,
      key: "kda",
      minGames: rateFloor,
      format: (r) => r.value.toFixed(1),
      hint: (r) =>
        `${r.summary.avgKills}/${r.summary.avgDeaths}/${r.summary.avgAssists}`,
    },
    {
      title: "Highest win rate",
      subtitle: `min ${rateFloor} game${rateFloor > 1 ? "s" : ""}`,
      key: "winRate",
      minGames: rateFloor,
      format: (r) => `${r.value}%`,
      hint: (r) => `${r.summary.games} game${r.summary.games === 1 ? "" : "s"}`,
    },
    {
      title: "Most kills",
      key: "kills",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.avgKills}/game`,
    },
    {
      title: "Most assists",
      key: "assists",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.avgAssists}/game`,
    },
    {
      title: "Most games",
      key: "games",
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.wins}–${r.summary.losses}`,
    },
    {
      title: "Best avg GPM",
      subtitle: `min ${rateFloor} game${rateFloor > 1 ? "s" : ""}`,
      key: "gpm",
      minGames: rateFloor,
      format: (r) => `${r.value}`,
      hint: (r) => `${r.summary.games} game${r.summary.games === 1 ? "" : "s"}`,
    },
    {
      title: "Richest (avg net worth)",
      subtitle: `min ${rateFloor} game${rateFloor > 1 ? "s" : ""}`,
      key: "netWorth",
      minGames: rateFloor,
      format: (r) => formatNetWorth(r.value),
      hint: (r) => `${r.summary.games} game${r.summary.games === 1 ? "" : "s"}`,
    },
  ];

  return (
    <div className="space-y-6">
      <PageTitle
        title="Leaders"
        subtitle={`${season.name} · from ${games.length} imported game${games.length === 1 ? "" : "s"}`}
        action={
          <Link href="/recap" className={buttonClasses("secondary", "sm")}>
            Season recap →
          </Link>
        }
      />
      {honorsByWeek.length > 0 ? (
        <Card>
          <CardHeader
            title="Weekly honors"
            subtitle="Player of the Week by fantasy points · Team of the Week by game wins"
          />
          <CardBody className="divide-y divide-line/60 p-0">
            {honorsByWeek.map(({ week, honors }) => (
              <div
                key={week}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm"
              >
                <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-muted">
                  Week {week}
                </span>
                {honors.player ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden>⭐</span>
                    <PlayerLink userId={honors.player.userId} className="font-medium">
                      {userMap.get(honors.player.userId)?.name ?? "?"}
                    </PlayerLink>
                    <span className="text-xs text-muted">
                      {honors.player.points} pts
                      {honors.player.heroId != null &&
                      heroNames[honors.player.heroId]
                        ? ` · ${heroNames[honors.player.heroId]}`
                        : ""}
                    </span>
                  </span>
                ) : null}
                {honors.team ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden>🛡️</span>
                    <Link
                      href={`/teams/${honors.team.teamId}`}
                      className="font-medium hover:text-info"
                    >
                      {teamNameOf.get(honors.team.teamId) ?? "?"}
                    </Link>
                    <span className="text-xs text-muted">
                      {honors.team.gameWins} game win
                      {honors.team.gameWins === 1 ? "" : "s"}
                    </span>
                  </span>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {boards.map((b) => {
          // Full ranked list per board — the client card shows top 5 and
          // expands on demand; labels are precomputed here (fns don't
          // serialize across the boundary).
          const rows: LeaderBoardRow[] = topBy(entries, b.key, {
            minGames: b.minGames,
            limit: Number.POSITIVE_INFINITY,
          }).map((r) => {
            const u = userMap.get(r.id);
            return {
              id: r.id,
              name: u?.name ?? "Unknown",
              avatar: u?.avatar ?? null,
              rankTier: u?.rankTier ?? null,
              value: r.value,
              valueLabel: b.format(r),
              hint: b.hint(r),
              isViewer: viewer?.id === r.id,
            };
          });
          return (
            <LeaderBoard
              key={b.title}
              title={b.title}
              subtitle={b.subtitle}
              rows={rows}
            />
          );
        })}
      </div>
    </div>
  );
}
