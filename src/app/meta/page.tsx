import { getSessionUser } from "@/lib/auth";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  HeroMetaTable,
  type HeroMetaTableRow,
} from "@/components/hero-meta-table";
import Link from "@/components/app-link";
import type { Metadata } from "next";
import { decodeGamePlayers, trustedGamePlayers } from "@/lib/player-stats";
import { notFound } from "next/navigation";
import {
  loadSeasonChoices,
  resolveSeasonScope,
  seasonScopeMetadata,
} from "@/lib/season-scope";
import { NoSeasonYet, SeasonSwitcher } from "@/components/season-scope";
import { finishedSeasonLink } from "@/lib/season-choices";
import { prisma } from "@/lib/prisma";
import { getSeasonGameScores } from "@/lib/cached-queries";
import {
  heroMeta,
  metaHeadlines,
  metaLines,
  toMetaGame,
  META_HEADLINE_MIN_PICKS,
  type MetaGame,
} from "@/lib/hero-meta";
import {
  HEROES,
  heroById,
  heroPagePath,
  heroPortrait,
  type Hero,
} from "@/lib/heroes";
import {
  EmptyState,
  LinkArrow,
  PageTitle,
  PlayerLink,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { StatsDataNotice, StatsNav } from "@/components/stats-nav";
import { HeroSearch } from "@/components/hero-search";
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
    .map(({ game, decoded }) =>
      toMetaGame(game.radiantWin, metaLines(decoded, knownHeroIds)),
    )
    // Unusable games cannot dilute the pick-rate denominator.
    .filter((game) => game.lines.length > 0);

  const meta = heroMeta(metaGames);
  // A finished season's page holds its champion and awards.
  const finishedLink = finishedSeasonLink(season);
  const seasonSubtitle = season.isActive
    ? season.name
    : season.name + " · archived";
  const pageTitle = (
    <PageTitle
      title="Hero meta"
      subtitle={seasonSubtitle + " · The heroes the league picks, and who plays them most"}
      action={
        finishedLink ? (
          <Link
            href={finishedLink.href}
            className={buttonClasses("secondary", "sm")}
          >
            {finishedLink.label} <LinkArrow />
          </Link>
        ) : undefined
      }
    />
  );
  const switcher = (
    <>
      <HeroSearch
        seasonId={season.isActive ? undefined : season.id}
        className="max-w-md"
      />
      <SeasonSwitcher
        label="hero meta"
        basePath="/meta"
        seasons={seasonChoices}
        selectedId={season.id}
      />
    </>
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
                  : "Games are imported, but their hero data is incomplete. The meta report fills in once an admin fixes it."
                : viewerIsAdmin
                  ? "Games are imported, but no trusted hero data is available. Inspect and re-import incomplete box scores; unknown hero IDs require a hero-catalogue update."
                  : "Games are imported, but their hero data is incomplete. The meta report fills in once an admin fixes it."
              : "The meta report fills in once match games are imported."
          }
        />
      </div>
    );
  }

  const { mostPicked, bestWinRate, signature } = metaHeadlines(meta.rows);
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
        href: heroPagePath(hero, season.isActive ? undefined : season.id),
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
  const archivedId = season.isActive ? undefined : season.id;
  const signatureHero = signature ? heroOf.get(signature.heroId) : undefined;

  return (
    <div className="space-y-6">
      {pageTitle}
      <StatsNav active="meta" seasonId={archivedId} />
      {switcher}
      {dataNotice}
      <section aria-labelledby="meta-sample" className="space-y-3">
        <p id="meta-sample" className="text-sm text-muted">
          {`${meta.rows.length} of ${HEROES.length} heroes picked across ${meta.games} complete ${meta.games === 1 ? "game" : "games"}.`}
        </p>
        {/* The season's headlines over each hero's art. An auto-fit band:
            the count depends on the sample (a win-rate headline needs
            eight picks, a signature three games). */}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]">
          {mostPicked ? (
            <Headline
              label="Most picked"
              hero={heroOf.get(mostPicked.heroId)}
              href={heroOf.has(mostPicked.heroId) ? heroPagePath(heroOf.get(mostPicked.heroId)!, archivedId) : undefined}
              value={`${mostPicked.picks} ${mostPicked.picks === 1 ? "pick" : "picks"}`}
              detail={`In ${mostPicked.pickRate}% of games · ${mostPicked.wins}–${mostPicked.losses}`}
            />
          ) : null}
          {bestWinRate ? (
            <Headline
              label={`Best win rate, ${META_HEADLINE_MIN_PICKS}+ picks`}
              hero={heroOf.get(bestWinRate.heroId)}
              href={heroOf.has(bestWinRate.heroId) ? heroPagePath(heroOf.get(bestWinRate.heroId)!, archivedId) : undefined}
              value={`${bestWinRate.winRate}%`}
              detail={`${bestWinRate.wins}–${bestWinRate.losses} over ${bestWinRate.picks} picks`}
            />
          ) : null}
          {signature && signatureHero ? (
            <Headline
              label="Signature pick"
              hero={signatureHero}
              href={heroPagePath(signatureHero, archivedId)}
              value={`${signature.games} games`}
              detail={
                <>
                  {nameOf.has(signature.userId) ? (
                    <PlayerLink userId={signature.userId} className="font-medium text-fg">
                      {nameOf.get(signature.userId)}
                    </PlayerLink>
                  ) : (
                    "Former player"
                  )}
                  {` · ${signature.wins}–${signature.games - signature.wins}`}
                </>
              }
            />
          ) : null}
        </div>
      </section>
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

/**
 * One headline over its hero's portrait, which fades in from the right
 * behind the text. The art is decoration: the hero is named in the text.
 */
function Headline({
  label,
  hero,
  href,
  value,
  detail,
}: {
  label: string;
  hero: Hero | undefined;
  /** The hero's page. */
  href: string | undefined;
  value: string;
  detail: React.ReactNode;
}) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
      {hero ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-3/5"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={heroPortrait(hero)}
            alt=""
            loading="lazy"
            decoding="async"
            className="profile-hero-bg h-full w-full object-cover object-top opacity-45"
          />
        </div>
      ) : null}
      <div className="relative min-w-0 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">
          {label}
        </p>
        <p className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2.5">
          <span className="min-w-0 font-display text-2xl font-semibold leading-tight text-fg [overflow-wrap:anywhere]">
            {hero && href ? (
              <Link href={href} prefetch={false} className={textLink("text-fg")}>
                {hero.name}
              </Link>
            ) : (
              (hero?.name ?? "Unknown hero")
            )}
          </span>
          <span className="font-display text-lg font-semibold tabular-nums text-accent">
            {value}
          </span>
        </p>
        <p className="mt-0.5 text-sm text-muted">{detail}</p>
      </div>
    </div>
  );
}
