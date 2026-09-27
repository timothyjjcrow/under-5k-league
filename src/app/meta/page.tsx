import { getSessionUser } from "@/lib/auth";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  HeroMetaTable,
  type HeroMetaTableRow,
} from "@/components/hero-meta-table";
import Link from "next/link";
import type { Metadata } from "next";
import { decodeGamePlayers, trustedGamePlayers } from "@/lib/player-stats";
import { notFound } from "next/navigation";
import {
  loadSeasonChoices,
  resolveSeasonScope,
  seasonScopeMetadata,
} from "@/lib/season-scope";
import { NoSeasonYet, SeasonSwitcher } from "@/components/season-scope";
import { prisma } from "@/lib/prisma";
import { getSeasonGameScores } from "@/lib/cached-queries";
import {
  allHeroesKnown,
  heroMeta,
  metaHeadlines,
  META_HEADLINE_MIN_PICKS,
  type MetaGame,
} from "@/lib/hero-meta";
import { HEROES, heroById, type Hero } from "@/lib/heroes";
import {
  EmptyState,
  HeroIcon,
  PageTitle,
  buttonClasses,
} from "@/components/ui";
import { StatsDataNotice, StatsNav } from "@/components/stats-nav";
import { singleSearchParam } from "@/lib/search-params";

type MetaSearchParams = { season?: string | string[] };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<MetaSearchParams>;
}): Promise<Metadata> {
  return seasonScopeMetadata((await searchParams).season, {
    path: "/meta",
    title: "Hero meta",
    description:
      "The heroes " +
      LEAGUE_CONFIG.name +
      " players pick, win with, and make their signatures each season.",
    archived: (name) => ({
      title: name + " hero meta",
      description:
        "Hero pick rates, win rates, and player favorites from " + name + ".",
    }),
  });
}

export default async function MetaPage({
  searchParams,
}: {
  searchParams: Promise<MetaSearchParams>;
}) {
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
  // ?season=<id> shows an archived season; with no season running the page
  // opens on the most recent one (resolveSeasonScope).
  const season = await resolveSeasonScope(seasonParam);
  if (!season) {
    return (
      <NoSeasonYet title="Hero meta">
        <StatsNav active="meta" />
      </NoSeasonYet>
    );
  }

  const [games, seasonChoices] = await Promise.all([
    getSeasonGameScores(season.id),
    loadSeasonChoices("games", season.id),
  ]);
  const importedGames = games.length;
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
      subtitle={seasonSubtitle + " · The heroes the league picks, and who plays them most"}
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
  const switcher = (
    <SeasonSwitcher
      label="hero meta"
      basePath="/meta"
      seasons={seasonChoices}
      selectedId={season.id}
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
    const viewerIsAdmin = (await getSessionUser())?.role === "ADMIN";
    return (
      <div className="space-y-6">
        {pageTitle}
        <StatsNav
          active="meta"
          seasonId={season.isActive ? undefined : season.id}
        />
        {switcher}
        {dataNotice}
        <EmptyState
          title={games.length > 0 ? "No usable box scores" : "No games yet"}
          description={
            games.length > 0
              ? unknownHeroLines > 0 &&
                unusableGames === 0 &&
                malformedGames === 0
                ? viewerIsAdmin
                  ? "Games are imported, but their heroes are missing from the bundled catalogue. Update the hero catalogue before publishing this meta report."
                  : "Games are imported, but their hero data is still being checked. The meta report fills in once it is."
                : viewerIsAdmin
                  ? "Games are imported, but no trusted hero data is available. Inspect and re-import incomplete box scores; unknown hero IDs require a hero-catalogue update."
                  : "Games are imported, but their hero data is still being checked. The meta report fills in once it is."
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
  const heroOf = new Map(HEROES.map((hero) => [hero.id, hero]));
  // Every row's hero is in the catalogue (allHeroesKnown above).
  const tableRows: HeroMetaTableRow[] = meta.rows.flatMap((row) => {
    const hero = heroOf.get(row.heroId);
    if (!hero) return [];
    const top = row.topPlayer;
    return [
      {
        hero,
        picks: row.picks,
        wins: row.wins,
        losses: row.losses,
        winRate: row.winRate,
        topPlayer: top
          ? {
              userId: nameOf.has(top.userId) ? top.userId : null,
              name: nameOf.get(top.userId) ?? "Former player",
              games: top.games,
            }
          : null,
      },
    ];
  });
  const pickedIds = new Set(meta.rows.map((row) => row.heroId));
  const neverPicked = HEROES.filter((hero) => !pickedIds.has(hero.id))
    .map((hero) => hero.name)
    .sort((a, b) => a.localeCompare(b));
  const { mostPicked, bestWinRate } = metaHeadlines(meta.rows);
  const heroName = (heroId: number) => heroOf.get(heroId)?.name ?? "";

  return (
    <div className="space-y-6">
      {pageTitle}
      <StatsNav
        active="meta"
        seasonId={season.isActive ? undefined : season.id}
      />
      {switcher}
      {dataNotice}
      <div className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm sm:p-5">
        <p id="meta-sample" className="text-muted">
          {`${meta.rows.length} of ${HEROES.length} heroes picked across ${meta.games} complete ${meta.games === 1 ? "game" : "games"}.`}
        </p>
        {mostPicked ? (
          <Headline
            label="Most picked"
            hero={heroOf.get(mostPicked.heroId)}
            text={`${heroName(mostPicked.heroId)}, ${mostPicked.picks} ${mostPicked.picks === 1 ? "pick" : "picks"} (in ${mostPicked.pickRate}% of games)`}
          />
        ) : null}
        {bestWinRate ? (
          <Headline
            label={`Best win rate, ${META_HEADLINE_MIN_PICKS}+ picks`}
            hero={heroOf.get(bestWinRate.heroId)}
            text={`${heroName(bestWinRate.heroId)}, ${bestWinRate.winRate}% (${bestWinRate.wins}–${bestWinRate.losses})`}
          />
        ) : null}
      </div>
      <HeroMetaTable rows={tableRows} />
      {neverPicked.length > 0 ? (
        <details className="rounded-xl border border-line-soft bg-surface/60 px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium text-fg">
            {`${neverPicked.length} ${neverPicked.length === 1 ? "hero" : "heroes"} not picked yet`}
          </summary>
          <p className="mt-2 leading-relaxed text-muted">
            {neverPicked.join(", ")}
          </p>
        </details>
      ) : null}
      <p className="border-t border-line-soft pt-4 text-xs leading-relaxed text-muted">
        Only complete 5v5 box scores with known heroes count ({meta.games} of{" "}
        {importedGames} imported). Unlinked accounts still count toward picks
        and results. Win % is winning picks divided by picks; the headline
        needs {META_HEADLINE_MIN_PICKS} or more picks.
      </p>
    </div>
  );
}

function Headline({
  label,
  hero,
  text,
}: {
  label: string;
  hero: Hero | undefined;
  text: string;
}) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-accent">
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-2 font-medium text-fg">
        {hero ? (
          <span aria-hidden="true" className="flex shrink-0">
            <HeroIcon hero={hero} size={24} className="rounded" />
          </span>
        ) : null}
        <span className="min-w-0">{text}</span>
      </span>
    </p>
  );
}
