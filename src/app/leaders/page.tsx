import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import {
  summarizePlayerGames,
  topBy,
  type LeaderboardKey,
  type LeaderEntry,
  type LeaderRow,
  type PlayerGameLine,
} from "@/lib/player-stats";
import type { PlayerStat } from "@/lib/match-import";
import { formatNetWorth } from "@/lib/utils";
import {
  Avatar,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
  RankBadge,
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
  const season = await getActiveSeason();
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
    select: { players: true, radiantWin: true },
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
      hint: (r) => `${r.summary.games} games`,
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
      hint: (r) => `${r.summary.games} games`,
    },
    {
      title: "Richest (avg net worth)",
      subtitle: `min ${rateFloor} game${rateFloor > 1 ? "s" : ""}`,
      key: "netWorth",
      minGames: rateFloor,
      format: (r) => formatNetWorth(r.value),
      hint: (r) => `${r.summary.games} games`,
    },
  ];

  return (
    <div className="space-y-6">
      <PageTitle
        title="Leaders"
        subtitle={`${season.name} · from ${games.length} imported game${games.length === 1 ? "" : "s"}`}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {boards.map((b) => (
          <LeaderCard
            key={b.title}
            title={b.title}
            subtitle={b.subtitle}
            rows={topBy(entries, b.key, { minGames: b.minGames, limit: 5 })}
            userMap={userMap}
            format={b.format}
            hint={b.hint}
          />
        ))}
      </div>
    </div>
  );
}

function LeaderCard({
  title,
  subtitle,
  rows,
  userMap,
  format,
  hint,
}: {
  title: string;
  subtitle?: string;
  rows: LeaderRow[];
  userMap: Map<string, DisplayUser>;
  format: (r: LeaderRow) => string;
  hint: (r: LeaderRow) => string;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <CardBody className="p-0">
        {rows.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">Not enough games yet.</p>
        ) : (
          <ul className="divide-y divide-line/60">
            {rows.map((r, i) => {
              const u = userMap.get(r.id);
              return (
                <li
                  key={r.id}
                  className="flex items-center gap-3 px-5 py-2.5 text-sm"
                >
                  <span className="w-4 text-center text-xs text-muted">
                    {i + 1}
                  </span>
                  <Avatar name={u?.name ?? "?"} src={u?.avatar} size={26} />
                  <span className="min-w-0 flex-1 truncate">
                    <PlayerLink userId={r.id} className="font-medium">
                      {u?.name ?? "Unknown"}
                    </PlayerLink>
                    <RankBadge rankTier={u?.rankTier} className="ml-1.5" />
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="font-semibold tabular-nums">
                      {format(r)}
                    </span>
                    <span className="block text-xs text-muted">{hint(r)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
