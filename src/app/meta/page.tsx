import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  HeroMetaExplorer,
  type HeroMetaEntry,
} from "@/components/hero-meta-explorer";
import Link from "next/link";
import type { Metadata } from "next";
import { decodeGamePlayers, trustedGamePlayers } from "@/lib/player-stats";
import { notFound } from "next/navigation";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { getSeasonGameScores } from "@/lib/cached-queries";
import {
  allHeroesKnown,
  heroMeta,
  metaMinPicks,
  type MetaGame,
} from "@/lib/hero-meta";
import { HEROES, heroById } from "@/lib/heroes";
import { EmptyState, PageTitle, buttonClasses } from "@/components/ui";
import { StatsDataNotice, StatsNav } from "@/components/stats-nav";
import { shareMetadata } from "@/lib/share-metadata";
import { singleSearchParam } from "@/lib/search-params";

type MetaSearchParams = { season?: string | string[] };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<MetaSearchParams>;
}): Promise<Metadata> {
  const seasonId = singleSearchParam((await searchParams).season);
  if (seasonId === null) notFound();
  if (!seasonId) {
    return shareMetadata(
      "Hero meta",
      "The heroes " +
        LEAGUE_CONFIG.name +
        " players pick, win with, and make their signatures each season.",
      "/meta",
    );
  }
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { name: true, isActive: true },
  });
  if (!season) notFound();
  if (season.isActive) {
    return shareMetadata(
      "Hero meta",
      "The heroes " +
        LEAGUE_CONFIG.name +
        " players pick, win with, and make their signatures each season.",
      "/meta",
    );
  }
  const path = "/meta?" + new URLSearchParams({ season: seasonId });
  return shareMetadata(
    season.name + " hero meta",
    "Hero pick rates, win rates, and player favorites from " +
      season.name +
      ".",
    path,
  );
}

export default async function MetaPage({
  searchParams,
}: {
  searchParams: Promise<MetaSearchParams>;
}) {
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
  const season = seasonParam
    ? await prisma.season.findUnique({ where: { id: seasonParam } })
    : await getActiveSeason();
  if (seasonParam && !season) notFound();
  if (!season) {
    const archived = await prisma.season.findMany({
      where: { isActive: false },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    });
    return (
      <div>
        <PageTitle title="Hero meta" />
        <StatsNav active="meta" />
        <EmptyState
          title="No active season"
          description={
            archived.length > 0
              ? "Browse a past season's meta instead."
              : undefined
          }
          action={
            archived.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-2">
                {archived.map((s) => (
                  <Link
                    key={s.id}
                    href={"/meta?season=" + s.id}
                    className={buttonClasses("secondary", "sm")}
                  >
                    {s.name} →
                  </Link>
                ))}
              </div>
            ) : undefined
          }
        />
      </div>
    );
  }

  const games = await getSeasonGameScores(season.id);
  const decodedGames = games.map((game) => ({
    game,
    decoded: decodeGamePlayers(game.players),
  }));
  const invalidLines = decodedGames.reduce(
    (total, row) => total + row.decoded.invalidLines,
    0,
  );
  const malformedGames = decodedGames.filter(
    (row) => row.decoded.malformed,
  ).length;
  const unusableGames = decodedGames.filter(
    (row) => !row.decoded.malformed && !row.decoded.completeRoster,
  ).length;
  const unknownHeroLines = decodedGames.reduce(
    (total, row) =>
      total +
      trustedGamePlayers(row.decoded).filter(
        (player) => !heroById(player.heroId),
      ).length,
    0,
  );
  const unmappedLines = decodedGames.reduce(
    (total, row) =>
      total + row.decoded.players.filter((player) => !player.userId).length,
    0,
  );
  const knownHeroIds = new Set(HEROES.map((hero) => hero.id));
  const metaGames: MetaGame[] = decodedGames
    .map(({ game, decoded }) => {
      const trusted = trustedGamePlayers(decoded);
      return {
        radiantWin: game.radiantWin,
        lines: (allHeroesKnown(trusted, knownHeroIds) ? trusted : []).map(
          (player) => ({
            userId: player.userId,
            heroId: player.heroId,
            isRadiant: player.isRadiant,
            kills: player.kills,
            deaths: player.deaths,
            assists: player.assists,
          }),
        ),
      };
    })
    // Unusable games cannot dilute the pick-rate denominator.
    .filter((game) => game.lines.length > 0);

  const meta = heroMeta(metaGames);
  const seasonSubtitle = season.isActive
    ? season.name
    : season.name + " · archived";
  const pageTitle = (
    <PageTitle
      title="Hero meta"
      subtitle={seasonSubtitle + " · Picks, results, and the stories behind them"}
      action={
        !season.isActive ? (
          <Link
            href={"/seasons/" + season.id}
            className={buttonClasses("secondary", "sm")}
          >
            Season archive →
          </Link>
        ) : undefined
      }
    />
  );
  const dataNotice = (
    <StatsDataNotice
      invalidLines={invalidLines}
      malformedGames={malformedGames}
      unusableGames={unusableGames}
      unknownHeroLines={unknownHeroLines}
      unmappedLines={unmappedLines}
    />
  );

  if (meta.rows.length === 0) {
    return (
      <div className="space-y-6">
        {pageTitle}
        <StatsNav
          active="meta"
          seasonId={season.isActive ? undefined : season.id}
        />
        {dataNotice}
        <EmptyState
          title={games.length > 0 ? "No usable box scores" : "No games yet"}
          description={
            games.length > 0
              ? unknownHeroLines > 0 &&
                unusableGames === 0 &&
                malformedGames === 0
                ? "Games are imported, but their heroes are missing from the bundled catalogue. Update the hero catalogue before publishing this meta report."
                : "Games are imported, but no trusted hero data is available. Inspect and re-import incomplete box scores; unknown hero IDs require a hero-catalogue update."
              : "The meta report fills in once match games are imported."
          }
        />
      </div>
    );
  }

  const topIds = [
    ...new Set(
      meta.rows.flatMap((row) =>
        row.topPlayer ? [row.topPlayer.userId] : [],
      ),
    ),
  ];
  const users = await prisma.user.findMany({
    where: { id: { in: topIds } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((user) => [user.id, user.name]));
  const byHeroId = new Map(meta.rows.map((row) => [row.heroId, row]));
  const entries: HeroMetaEntry[] = HEROES.map((hero) => {
    const stats = byHeroId.get(hero.id) ?? null;
    const userId = stats?.topPlayer?.userId;
    return {
      hero,
      stats,
      topPlayerName: userId
        ? (nameOf.get(userId) ?? "Former player")
        : "",
      topPlayerUserId: userId && nameOf.has(userId) ? userId : null,
    };
  });

  return (
    <div className="space-y-6">
      {pageTitle}
      <StatsNav
        active="meta"
        seasonId={season.isActive ? undefined : season.id}
      />
      {dataNotice}
      <HeroMetaExplorer
        rows={entries}
        games={meta.games}
        importedGames={games.length}
        minPicks={metaMinPicks(meta.games)}
      />
    </div>
  );
}
