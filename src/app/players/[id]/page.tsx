import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { steamIdToAccountId, getHeroNames } from "@/lib/dota";
import { heroById, heroPortrait, parseHeroList } from "@/lib/heroes";
import { roleLabels } from "@/lib/roles";
import { computeStandings } from "@/lib/standings";
import {
  currentStreak,
  summarizePlayerGames,
  wonGame,
  type PlayerGameLine,
} from "@/lib/player-stats";
import type { PlayerStat } from "@/lib/match-import";
import { formatNetWorth } from "@/lib/utils";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  HeroIcon,
  HeroList,
  RankMedal,
  RoleBadges,
  Stat,
} from "@/components/ui";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await prisma.user.findUnique({
    where: { id },
    select: { name: true },
  });
  return { title: user ? `${user.name} · Player` : "Player" };
}

function safeParse(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default async function PlayerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) notFound();

  const season = await getActiveSeason();

  const [registration, membership, seasonTeams, seasonMatches, games] =
    await Promise.all([
      season
        ? prisma.registration.findUnique({
            where: { seasonId_userId: { seasonId: season.id, userId: id } },
          })
        : null,
      season
        ? prisma.teamMember.findFirst({
            where: { seasonId: season.id, userId: id },
            include: { team: { include: { captain: true } } },
          })
        : null,
      season
        ? prisma.team.findMany({ where: { seasonId: season.id } })
        : [],
      season
        ? prisma.match.findMany({ where: { seasonId: season.id } })
        : [],
      season
        ? prisma.game.findMany({
            where: { match: { seasonId: season.id } },
            include: { match: { include: { homeTeam: true, awayTeam: true } } },
            orderBy: { startTime: "desc" },
          })
        : [],
    ]);

  const accountId = user.dotaAccountId ?? steamIdToAccountId(user.steamId);
  const heroNames = await getHeroNames();

  // Pull this player's line out of each imported game.
  const gameRows = games
    .map((g) => {
      const stat = safeParse(g.players).find((p) => p.userId === id);
      if (!stat) return null;
      return { game: g, stat };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const lines: PlayerGameLine[] = gameRows.map(({ game, stat }) => ({
    isRadiant: stat.isRadiant,
    radiantWin: game.radiantWin,
    kills: stat.kills,
    deaths: stat.deaths,
    assists: stat.assists,
    heroId: stat.heroId,
  }));
  const summary = summarizePlayerGames(lines);
  const streak = currentStreak(lines); // `lines` is newest-first (games desc)
  const streakLabel =
    streak.count > 1 ? `${streak.type}${streak.count} streak` : undefined;

  // Team + record for this season, if drafted.
  const team = membership?.team ?? null;
  const standings =
    team && seasonTeams.length
      ? computeStandings(
          seasonTeams.map((t) => t.id),
          seasonMatches,
        )
      : [];
  const teamRow = team ? standings.find((s) => s.teamId === team.id) : undefined;
  const teamRank = team
    ? standings.findIndex((s) => s.teamId === team.id) + 1
    : 0;

  const roles = roleLabels(registration?.roles);
  const isStandin = registration?.type === "STANDIN";
  const isCaptain = !!membership?.isCaptain;
  const subtitle = season
    ? isStandin
      ? `Standin · ${season.name}`
      : team
        ? `${isCaptain ? "Captain" : "Player"} · ${team.name}`
        : registration
          ? `Registered · ${season.name}`
          : season.name
    : null;
  // A signature hero for the banner backdrop: most-played if we have games,
  // otherwise the player's first listed favorite.
  const signatureHero =
    (summary.topHeroes[0] ? heroById(summary.topHeroes[0].heroId) : null) ??
    parseHeroList(registration?.favoriteHeroes).matched[0] ??
    null;

  // Economy averages + a standout game. Net-worth/GPM/last-hits are optional per
  // game (older imports may lack them), so average only over games that have it.
  type GameRow = (typeof gameRows)[number];
  const avgOf = (
    rows: GameRow[],
    pick: (s: PlayerStat) => number | null | undefined,
  ) =>
    rows.length
      ? Math.round(
          rows.reduce((sum, r) => sum + (pick(r.stat) ?? 0), 0) / rows.length,
        )
      : null;
  const avgNet = avgOf(
    gameRows.filter((r) => r.stat.netWorth != null),
    (s) => s.netWorth,
  );
  const avgGpm = avgOf(
    gameRows.filter((r) => r.stat.gpm != null),
    (s) => s.gpm,
  );
  const avgLh = avgOf(
    gameRows.filter((r) => r.stat.lastHits != null),
    (s) => s.lastHits,
  );
  const bestGame =
    gameRows.length > 0
      ? [...gameRows].sort(
          (a, b) =>
            (b.stat.netWorth ?? 0) - (a.stat.netWorth ?? 0) ||
            b.stat.kills + b.stat.assists - (a.stat.kills + a.stat.assists),
        )[0]
      : null;
  const hasPerf = avgNet != null || avgGpm != null;
  const bestView = bestGame
    ? {
        matchId: bestGame.game.matchId,
        hero: heroById(bestGame.stat.heroId),
        heroId: bestGame.stat.heroId,
        won: bestGame.stat.isRadiant === bestGame.game.radiantWin,
        kills: bestGame.stat.kills,
        deaths: bestGame.stat.deaths,
        assists: bestGame.stat.assists,
        netWorth: bestGame.stat.netWorth,
        gpm: bestGame.stat.gpm,
        week: bestGame.game.match.week,
        opponent:
          bestGame.stat.teamId === bestGame.game.match.homeTeamId
            ? bestGame.game.match.awayTeam.name
            : bestGame.stat.teamId === bestGame.game.match.awayTeamId
              ? bestGame.game.match.homeTeam.name
              : `${bestGame.game.match.homeTeam.name} / ${bestGame.game.match.awayTeam.name}`,
      }
    : null;

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3">
          <Link href="/players" className="text-sm text-info hover:underline">
            ← All players
          </Link>
        </div>
        <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-br from-surface-2/70 via-surface/50 to-surface/30 shadow-sm">
          {/* Signature hero portrait fading in from the right. */}
          {signatureHero ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-2/3 sm:w-1/2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={heroPortrait(signatureHero)}
                alt=""
                className="profile-hero-bg h-full w-full object-cover object-center opacity-30"
              />
            </div>
          ) : null}
          {/* Ambient graphics shared with the home hero for brand cohesion. */}
          <div
            aria-hidden
            className="hero-grid pointer-events-none absolute inset-0 opacity-50"
          />
          <div
            aria-hidden
            className="animate-hero-glow pointer-events-none absolute -left-8 top-0 h-40 w-40 -translate-y-1/3 rounded-full bg-brand/20 blur-3xl"
          />
          <div
            aria-hidden
            className="animate-hero-glow-alt pointer-events-none absolute -right-8 bottom-0 h-40 w-40 translate-y-1/3 rounded-full bg-accent/15 blur-3xl"
          />
          <div className="relative flex flex-wrap items-center gap-5 p-6">
            <Avatar
              name={user.name}
              src={user.avatar}
              size={88}
              className="shrink-0 shadow-lg shadow-black/40 ring-2 ring-line/80"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                  {user.name}
                </h1>
                {user.role === "ADMIN" ? (
                  <Badge tone="accent">Admin</Badge>
                ) : null}
                {isCaptain ? <Badge tone="brand">Captain</Badge> : null}
                {isStandin ? <Badge tone="info">Standin</Badge> : null}
                <RankMedal rankTier={user.rankTier} size={34} showLabel />
              </div>
              {subtitle ? (
                <div className="mt-1 text-sm text-muted">{subtitle}</div>
              ) : null}
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
                {registration ? (
                  <span>
                    <span className="font-semibold text-fg">
                      {registration.mmr}
                    </span>{" "}
                    MMR
                  </span>
                ) : null}
                {roles.length > 0 ? (
                  <RoleBadges roles={registration?.roles} />
                ) : null}
                {user.profileUrl ? (
                  <a
                    href={user.profileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-info hover:underline"
                  >
                    Steam ↗
                  </a>
                ) : null}
                {accountId ? (
                  <>
                    <a
                      href={`https://www.dotabuff.com/players/${accountId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-info hover:underline"
                    >
                      Dotabuff ↗
                    </a>
                    <a
                      href={`https://www.opendota.com/players/${accountId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-info hover:underline"
                    >
                      OpenDota ↗
                    </a>
                  </>
                ) : null}
              </div>
            </div>
            {team ? (
              <Link
                href={`/teams/${team.id}`}
                className="rounded-lg border border-line bg-surface/60 px-4 py-2 text-sm backdrop-blur transition-colors hover:border-muted/60"
              >
                <div className="text-xs uppercase tracking-wide text-muted">
                  Team
                </div>
                <div className="font-medium">{team.name}</div>
                {membership ? (
                  <div className="text-xs text-muted">
                    {membership.isCaptain
                      ? "Captain"
                      : `Drafted for $${membership.price}`}
                  </div>
                ) : null}
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {summary.games > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Record"
            value={`${summary.wins}–${summary.losses}`}
            hint={`${summary.winRate}% win rate`}
          />
          <Stat label="Games" value={summary.games} hint={streakLabel} />
          <Stat
            label="Avg KDA"
            value={`${summary.avgKills}/${summary.avgDeaths}/${summary.avgAssists}`}
            hint={`${summary.kda} ratio`}
          />
          {team ? (
            <Stat
              label="Team rank"
              value={teamRank > 0 ? `#${teamRank}` : "—"}
              hint={
                teamRow ? `${teamRow.wins}–${teamRow.losses} · ${teamRow.points} pts` : undefined
              }
            />
          ) : (
            <Stat label="Hero pool" value={summary.topHeroes.length} hint="heroes played" />
          )}
        </div>
      ) : null}

      {hasPerf ? (
        <Card>
          <CardHeader
            title="Performance"
            subtitle="Averages across imported games"
          />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {avgNet != null ? (
                <Stat label="Avg net worth" value={formatNetWorth(avgNet)} />
              ) : null}
              {avgGpm != null ? <Stat label="Avg GPM" value={avgGpm} /> : null}
              {avgLh != null ? <Stat label="Avg last hits" value={avgLh} /> : null}
            </div>
            {bestView ? (
              <Link
                href={`/matches/${bestView.matchId}`}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3 text-sm transition-colors hover:border-muted/60"
              >
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                  Standout
                </span>
                {bestView.hero ? (
                  <HeroIcon hero={bestView.hero} size={30} />
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {bestView.hero?.name ?? `Hero ${bestView.heroId}`}
                  </span>
                  <span className="block text-xs text-muted">
                    vs {bestView.opponent} · Wk {bestView.week}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-mono text-xs tabular-nums">
                    {bestView.kills}/{bestView.deaths}/{bestView.assists}
                  </span>
                  <span className="block text-xs text-muted">
                    {formatNetWorth(bestView.netWorth)}
                    {bestView.gpm != null ? ` · ${bestView.gpm} GPM` : ""}
                  </span>
                </span>
                <Badge tone={bestView.won ? "success" : "danger"}>
                  {bestView.won ? "W" : "L"}
                </Badge>
              </Link>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {registration &&
      (roles.length > 0 || registration.favoriteHeroes || registration.statement) ? (
        <Card>
          <CardHeader title="Signup profile" />
          <CardBody className="space-y-4 text-sm">
            {roles.length > 0 ? (
              <Detail label="Preferred roles">
                <RoleBadges roles={registration.roles} />
                <span className="text-muted">{roles.join(", ")}</span>
              </Detail>
            ) : null}
            {registration.favoriteHeroes ? (
              <Detail label="Signature heroes">
                <HeroList value={registration.favoriteHeroes} size={26} />
              </Detail>
            ) : null}
            {registration.statement ? (
              <Detail label="Goals">
                <span className="text-muted">{registration.statement}</span>
              </Detail>
            ) : null}
            {registration.captainNote ? (
              <Detail label="Note for captains">
                <span className="italic text-muted">
                  &ldquo;{registration.captainNote}&rdquo;
                </span>
              </Detail>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {summary.topHeroes.length > 0 ? (
        <Card>
          <CardHeader title="Most played heroes" />
          <CardBody>
            <div className="flex flex-wrap gap-3">
              {summary.topHeroes.slice(0, 8).map((h) => {
                const hero = heroById(h.heroId);
                return (
                  <div
                    key={h.heroId}
                    className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/40 px-2.5 py-1.5"
                  >
                    {hero ? (
                      <HeroIcon hero={hero} size={30} />
                    ) : null}
                    <div className="text-xs">
                      <div className="font-medium">
                        {hero?.name ?? heroNames[h.heroId] ?? `Hero ${h.heroId}`}
                      </div>
                      <div className="text-muted">
                        {h.games}g · {Math.round((h.wins / h.games) * 100)}% W
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Match history" subtitle={season?.name} />
        <CardBody className="p-0">
          {gameRows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No games recorded yet"
                description={
                  season
                    ? "Games appear here once this player's matches are imported."
                    : "There's no active season."
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-line/60">
              {gameRows.map(({ game, stat }) => {
                const won = wonGame({
                  isRadiant: stat.isRadiant,
                  radiantWin: game.radiantWin,
                  kills: 0,
                  deaths: 0,
                  assists: 0,
                  heroId: 0,
                });
                const hero = heroById(stat.heroId);
                const opponentName =
                  stat.teamId === game.match.homeTeamId
                    ? game.match.awayTeam.name
                    : stat.teamId === game.match.awayTeamId
                      ? game.match.homeTeam.name
                      : `${game.match.homeTeam.name} / ${game.match.awayTeam.name}`;
                return (
                  <li key={game.id}>
                    <Link
                      href={`/matches/${game.matchId}`}
                      className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-surface-2/40"
                    >
                      <Badge tone={won ? "success" : "danger"}>
                        {won ? "W" : "L"}
                      </Badge>
                      {hero ? <HeroIcon hero={hero} size={26} /> : null}
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-muted">vs </span>
                        <span className="font-medium">{opponentName}</span>
                        <span className="ml-2 text-xs uppercase text-muted">
                          Wk {game.match.week}
                          {game.match.phase !== "REGULAR"
                            ? ` · ${game.match.phase}`
                            : ""}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-xs">
                        {stat.kills}/{stat.deaths}/{stat.assists}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-32 shrink-0 text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
    </div>
  );
}
