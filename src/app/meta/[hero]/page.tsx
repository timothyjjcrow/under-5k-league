import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { prisma } from "@/lib/prisma";
import { getSeasonHeroGames } from "@/lib/cached-queries";
import { heroPageView, type HeroGameRow, type HeroItemTally } from "@/lib/hero-games";
import { HEROES, heroBySlug, heroSlug, type Hero } from "@/lib/heroes";
import { itemOrUnknown } from "@/lib/items";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { gameClock } from "@/lib/tale-of-the-tape";
import {
  loadSeasonChoices,
  resolveSeasonScope,
  seasonScopeMetadata,
} from "@/lib/season-scope";
import { singleSearchParam } from "@/lib/search-params";
import { NoSeasonYet, SeasonSwitcher } from "@/components/season-scope";
import { StatsNav } from "@/components/stats-nav";
import { HeroSearch } from "@/components/hero-search";
import { ItemBuild } from "@/components/item-build";
import { ItemIcon } from "@/components/item-icon";
import { LocalTime } from "@/components/local-time";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  HeroIcon,
  KDA,
  LinkArrow,
  PageTitle,
  PlayerLink,
  StatCell,
  StatStrip,
  buttonClasses,
  textLink,
} from "@/components/ui";

type HeroPageParams = { hero: string };
type HeroSearchParams = { season?: string | string[] };

/** How many of the most-built items and neutral items the page lists. */
const TOP_ITEMS = 12;
const TOP_NEUTRALS = 6;

const numbers = new Intl.NumberFormat("en-US");

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<HeroPageParams>;
  searchParams: Promise<HeroSearchParams>;
}): Promise<Metadata> {
  const hero = heroBySlug((await params).hero);
  if (!hero) notFound();
  return seasonScopeMetadata((await searchParams).season, {
    path: `/meta/${heroSlug(hero)}`,
    title: `${hero.name} games and builds`,
    description: `Every ${LEAGUE_CONFIG.name} game on ${hero.name} this season: who played it, how it went and the items they finished with.`,
    archived: (name) => ({
      title: `${hero.name} in ${name}`,
      description: `${hero.name}'s games and builds from ${name}.`,
    }),
  });
}

export default async function HeroGamesPage({
  params,
  searchParams,
}: {
  params: Promise<HeroPageParams>;
  searchParams: Promise<HeroSearchParams>;
}) {
  const hero = heroBySlug((await params).hero);
  if (!hero) notFound();
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
  const season = await resolveSeasonScope(seasonParam);
  if (!season) {
    return (
      <NoSeasonYet title={hero.name}>
        <StatsNav active="meta" />
      </NoSeasonYet>
    );
  }

  const archivedId = season.isActive ? undefined : season.id;
  const [games, seasonChoices] = await Promise.all([
    getSeasonHeroGames(season.id),
    loadSeasonChoices("games", season.id),
  ]);
  const view = heroPageView(hero.id, games, new Set(HEROES.map((row) => row.id)));
  const userIds = [
    ...new Set(view.rows.flatMap((row) => (row.userId ? [row.userId] : []))),
  ];
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(users.map((user) => [user.id, user.name]));

  const metaHref = archivedId
    ? `/meta?${new URLSearchParams({ season: archivedId })}`
    : "/meta";
  const header = (
    <>
      <PageTitle
        title={hero.name}
        subtitle={`${season.isActive ? season.name : `${season.name} · archived`} · Every league game on ${hero.name} and the items players finished with`}
        action={
          <Link href={metaHref} className={buttonClasses("secondary", "sm")}>
            All heroes <LinkArrow />
          </Link>
        }
      />
      <StatsNav active="meta" seasonId={archivedId} />
      <HeroSearch seasonId={archivedId} className="max-w-md" />
      <SeasonSwitcher
        label={hero.name}
        basePath={`/meta/${heroSlug(hero)}`}
        seasons={seasonChoices}
        selectedId={season.id}
      />
    </>
  );

  if (!view.meta) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          title={`No ${hero.name} games in ${season.name}`}
          description={
            games.length > 0
              ? `Nobody has played ${hero.name} in a counted league game this season.`
              : "Hero pages fill in once match games are imported."
          }
          action={
            games.length > 0 ? (
              <Link href={metaHref} className={buttonClasses("secondary", "sm")}>
                See the heroes that were picked <LinkArrow />
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }

  const meta = view.meta;
  return (
    <div className="space-y-6">
      {header}
      <StatStrip>
        <span aria-hidden="true" className="flex shrink-0">
          <HeroIcon hero={hero} size={40} className="rounded-lg" />
        </span>
        <StatCell label="Games" value={meta.picks} />
        <StatCell label="Record" value={`${meta.wins}–${meta.losses}`} />
        <StatCell
          label="Win %"
          value={`${meta.winRate}%`}
          tone={meta.winRate >= 50 ? "success" : "default"}
        />
        <StatCell label="KDA" value={meta.kda.toFixed(1)} />
        <StatCell
          label="Picked in"
          value={`${meta.pickRate}%`}
          hint={`of ${view.countedGames} ${view.countedGames === 1 ? "game" : "games"}`}
        />
      </StatStrip>

      <BuildsCard hero={hero} view={view} />

      <Card>
        <CardHeader
          headingLevel={2}
          title="Games"
          subtitle={`${view.rows.length} ${view.rows.length === 1 ? "game" : "games"}, newest first`}
        />
        <ol className="divide-y divide-line-soft">
          {view.rows.map((row) => (
            <GameRow
              key={row.gameId}
              row={row}
              playerName={row.userId ? nameOf.get(row.userId) : undefined}
            />
          ))}
        </ol>
      </Card>

      {view.players.length > 0 ? (
        <Card>
          <CardHeader
            headingLevel={2}
            title={`Who plays ${hero.name}`}
            subtitle="League players on the hero this season, most games first"
          />
          <ul className="grid grid-cols-1 gap-x-6 gap-y-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {view.players.map((player) => (
              <li
                key={player.userId}
                className="flex min-w-0 items-baseline justify-between gap-3 text-sm"
              >
                {nameOf.has(player.userId) ? (
                  <PlayerLink userId={player.userId} className="min-w-6 truncate font-medium">
                    {nameOf.get(player.userId)}
                  </PlayerLink>
                ) : (
                  <span className="truncate text-muted">Former player</span>
                )}
                <span className="shrink-0 tabular-nums text-muted">
                  {`${player.games} ${player.games === 1 ? "game" : "games"} · ${player.wins}–${player.games - player.wins}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <p className="border-t border-line-soft pt-4 text-xs leading-relaxed text-muted">
        The same games as Hero meta: complete 5v5 box scores with known heroes.
        Items are what each player finished the game with, from OpenDota; buy
        order and timings need a parsed replay, which league games don&apos;t
        have. Consumables, recipes and the neutral slot are left out of the
        most-built list.
      </p>
    </div>
  );
}

function BuildsCard({
  hero,
  view,
}: {
  hero: Hero;
  view: ReturnType<typeof heroPageView>;
}) {
  const missing = view.rows.length - view.itemGames;
  const subtitle =
    view.itemGames === 0
      ? undefined
      : missing > 0
        ? `Finished items from ${view.itemGames} of ${view.rows.length} games; older games fill in over the next few days`
        : `Finished items across ${view.itemGames} ${view.itemGames === 1 ? "game" : "games"}, with the record when built`;
  return (
    <Card>
      <CardHeader headingLevel={2} title="Most-built items" subtitle={subtitle} />
      <CardBody className="space-y-4">
        {view.itemGames === 0 ? (
          <EmptyState
            inline
            title="Items aren't recorded for these games yet"
            description={`They fill in by themselves over the next few days, as each ${hero.name} game is fetched again from OpenDota.`}
          />
        ) : (
          <>
            <ItemTallyList tallies={view.items.slice(0, TOP_ITEMS)} label="Most-built items" />
            {view.neutrals.length > 0 ? (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  Neutral items
                </h3>
                <ItemTallyList
                  tallies={view.neutrals.slice(0, TOP_NEUTRALS)}
                  label="Neutral items"
                  round
                />
              </div>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function ItemTallyList({
  tallies,
  label,
  round = false,
}: {
  tallies: HeroItemTally[];
  label: string;
  round?: boolean;
}) {
  return (
    <ul
      aria-label={label}
      // Two across even on a phone (12 rows in one column ran a screen and a
      // half); grid-cols-2 is minmax(0, 1fr), so a long name truncates.
      className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:gap-x-6 lg:grid-cols-3"
    >
      {tallies.map((tally) => {
        const item = itemOrUnknown(tally.itemId);
        return (
          <li key={tally.itemId} className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden="true" className="flex shrink-0">
              <ItemIcon
                item={{ id: item.id, img: item.img, name: item.name }}
                height={28}
                round={round}
              />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg">
                {item.name}
              </span>
              <span className="block text-xs tabular-nums text-muted">
                {`${tally.games} ${tally.games === 1 ? "game" : "games"} · ${tally.wins}–${tally.games - tally.wins}`}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function GameRow({
  row,
  playerName,
}: {
  row: HeroGameRow;
  playerName: string | undefined;
}) {
  const startMs = row.startTime * 1000;
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <Badge tone={row.won ? "success" : "danger"} className="shrink-0">
          {row.won ? "Win" : "Loss"}
        </Badge>
        <span className="min-w-0 font-medium text-fg">
          {row.userId && playerName ? (
            <PlayerLink userId={row.userId} className="min-w-6">
              {playerName}
            </PlayerLink>
          ) : row.userId ? (
            "Former player"
          ) : (
            (row.personaname ?? "Unlinked account")
          )}
        </span>
        {row.team && row.opponent ? (
          <span className="min-w-0 text-muted [overflow-wrap:anywhere]">
            {`${row.team.name} vs ${row.opponent.name}`}
          </span>
        ) : null}
        <span className="text-muted">
          {`Week ${row.week}`}
          {row.startTime > 0 ? (
            <>
              {" · "}
              <LocalTime
                ts={startMs}
                variant="date"
                initial={formatLeagueMatchTime(new Date(startMs), "date")}
              />
            </>
          ) : null}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          {row.items ? (
            <ItemBuild build={row} />
          ) : (
            <span className="text-xs text-muted">Items not recorded yet</span>
          )}
          <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
            <KDA kills={row.kills} deaths={row.deaths} assists={row.assists} className="text-sm" />
            {row.gpm !== null ? <span>{`${numbers.format(Math.round(row.gpm))} GPM`}</span> : null}
            {row.durationSecs > 0 ? <span>{gameClock(row.durationSecs)}</span> : null}
          </span>
        </div>
        <Link
          href={`/matches/${row.matchId}`}
          prefetch={false}
          className={textLink("shrink-0 text-sm")}
        >
          Match <LinkArrow />
        </Link>
      </div>
    </li>
  );
}
