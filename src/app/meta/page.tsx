import { HeroMetaExplorer } from "@/components/hero-meta-explorer";
import Link from "next/link";
import type { Metadata } from "next";
import { decodeGamePlayers, trustedGamePlayers } from "@/lib/player-stats";
import { notFound } from "next/navigation";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { getSeasonGameScores } from "@/lib/cached-queries";
import {
  allHeroesKnown,
  bestWinRates,
  heroMeta,
  heroPoolSeenPercent,
  metaMinPicks,
  type HeroMetaRow,
  type MetaGame,
} from "@/lib/hero-meta";
import { HEROES, heroById } from "@/lib/heroes";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  HeroIcon,
  PageTitle,
  PlayerLink,
  Stat,
  buttonClasses,
} from "@/components/ui";
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
      "The heroes GGD2L players pick, win with, and make their signatures each season.",
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
      "The heroes GGD2L players pick, win with, and make their signatures each season.",
      "/meta",
    );
  }
  const path = `/meta?${new URLSearchParams({ season: seasonId })}`;
  return shareMetadata(
    `${season.name} hero meta`,
    `Hero pick rates, win rates, and signature players from ${season.name}.`,
    path,
  );
}

function winRateTone(rate: number): string {
  if (rate >= 60) return "text-success";
  if (rate <= 40) return "text-danger";
  return "text-fg";
}

function HeroCell({ heroId }: { heroId: number }) {
  const hero = heroById(heroId);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {hero ? (
        <HeroIcon hero={hero} size={26} />
      ) : (
        <span className="h-[26px] w-[26px] shrink-0 rounded-md border border-line/70 bg-surface-2" />
      )}
      <span className="truncate font-medium">
        {hero?.name ?? `Hero #${heroId}`}
      </span>
    </span>
  );
}

function MetaTable({
  rows,
  nameOf,
  label,
}: {
  rows: HeroMetaRow[];
  nameOf: Map<string, string>;
  label: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label={label}>
        <thead>
          <tr className="border-b border-line/70 text-left text-xs uppercase tracking-wide text-muted">
            <th className="py-2 pr-3 font-medium">Hero</th>
            <th className="py-2 pr-3 text-right font-medium">Picks</th>
            <th className="hidden py-2 pr-3 text-right font-medium sm:table-cell">
              Pick rate
            </th>
            <th className="py-2 pr-3 text-right font-medium">W–L</th>
            <th className="py-2 pr-3 text-right font-medium">Win %</th>
            <th className="hidden py-2 pr-3 text-right font-medium sm:table-cell">
              KDA
            </th>
            <th className="hidden py-2 text-left font-medium md:table-cell">
              Signature player
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const topName = row.topPlayer
              ? nameOf.get(row.topPlayer.userId)
              : null;
            return (
              <tr key={row.heroId} className="border-b border-line/40">
                <td className="max-w-[12rem] py-2 pr-3">
                  <HeroCell heroId={row.heroId} />
                  {row.topPlayer ? (
                    topName ? (
                      <PlayerLink
                        userId={row.topPlayer.userId}
                        className="mt-1 block truncate text-xs text-muted md:hidden"
                      >
                        Signature: {topName} ({row.topPlayer.wins}–
                        {row.topPlayer.games - row.topPlayer.wins})
                      </PlayerLink>
                    ) : (
                      <span className="mt-1 block truncate text-xs text-muted md:hidden">
                        Signature: Former player ({row.topPlayer.wins}–
                        {row.topPlayer.games - row.topPlayer.wins})
                      </span>
                    )
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {row.picks}
                </td>
                <td className="hidden py-2 pr-3 text-right tabular-nums text-muted sm:table-cell">
                  {row.pickRate}%
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted">
                  {row.wins}–{row.losses}
                </td>
                <td
                  className={`py-2 pr-3 text-right font-semibold tabular-nums ${winRateTone(row.winRate)}`}
                >
                  {row.winRate}%
                </td>
                <td className="hidden py-2 pr-3 text-right tabular-nums text-muted sm:table-cell">
                  {row.kda}
                </td>
                <td className="hidden max-w-[11rem] py-2 md:table-cell">
                  {row.topPlayer ? (
                    topName ? (
                      <PlayerLink
                        userId={row.topPlayer.userId}
                        className="block truncate text-muted"
                      >
                        {topName}{" "}
                        <span className="tabular-nums">
                          ({row.topPlayer.wins}–
                          {row.topPlayer.games - row.topPlayer.wins})
                        </span>
                      </PlayerLink>
                    ) : (
                      <span className="block truncate text-muted">
                        Former player{" "}
                        <span className="tabular-nums">
                          ({row.topPlayer.wins}–
                          {row.topPlayer.games - row.topPlayer.wins})
                        </span>
                      </span>
                    )
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function MetaPage({
  searchParams,
}: {
  searchParams: Promise<MetaSearchParams>;
}) {
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
  // ?season=<id> shows an archived season's meta (recap's pattern).
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
                    href={`/meta?season=${s.id}`}
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
        lines: (allHeroesKnown(trusted, knownHeroIds) ? trusted : []).map((p) => ({
          userId: p.userId,
          heroId: p.heroId,
          isRadiant: p.isRadiant,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
        })),
      };
    })
    // Empty/malformed box scores contain no analyzable picks and must not
    // dilute every pick-rate denominator while claiming they were analyzed.
    .filter((game) => game.lines.length > 0);

  const meta = heroMeta(metaGames);
  if (meta.rows.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle
          title="Hero meta"
          subtitle={season.isActive ? season.name : `${season.name} · archived`}
          action={
            !season.isActive ? (
              <Link
                href={`/seasons/${season.id}`}
                className={buttonClasses("secondary", "sm")}
              >
                Season archive →
              </Link>
            ) : undefined
          }
        />
        <StatsNav
          active="meta"
          seasonId={season.isActive ? undefined : season.id}
        />
        <StatsDataNotice
          invalidLines={invalidLines}
          malformedGames={malformedGames}
          unusableGames={unusableGames}
          unknownHeroLines={unknownHeroLines}
          unmappedLines={unmappedLines}
        />
        <EmptyState
          title={games.length > 0 ? "No usable box scores" : "No games yet"}
          description={
            games.length > 0
              ? unknownHeroLines > 0 && unusableGames === 0 && malformedGames === 0
                ? "Games are imported, but their heroes are missing from the bundled catalogue. Update the hero catalogue before publishing this meta report."
                : "Games are imported, but no trusted hero data is available. Inspect and re-import incomplete box scores; unknown hero IDs require a hero-catalogue update."
              : "The meta report fills in once match games are imported."
          }
        />
      </div>
    );
  }

  // Names for every signature player shown anywhere on the page.
  const topIds = [
    ...new Set(
      meta.rows.flatMap((r) => (r.topPlayer ? [r.topPlayer.userId] : [])),
    ),
  ];
  const users = await prisma.user.findMany({
    where: { id: { in: topIds } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const minPicks = metaMinPicks(meta.games);
  const best = bestWinRates(meta.rows, minPicks);
  const contested = meta.rows.slice(0, 20);
  const unpicked = HEROES.filter(
    (h) => !meta.rows.some((r) => r.heroId === h.id),
  );
  const poolSeenPct = heroPoolSeenPercent(meta.rows, knownHeroIds);

  return (
    <div className="space-y-6">
      <PageTitle
        title="Hero meta"
        subtitle={`${season.name}${season.isActive ? "" : " · archived"} — what the league is actually playing`}
        action={
          !season.isActive ? (
            <Link
              href={`/seasons/${season.id}`}
              className={buttonClasses("secondary", "sm")}
            >
              Season archive →
            </Link>
          ) : undefined
        }
      />
      <StatsNav
        active="meta"
        seasonId={season.isActive ? undefined : season.id}
      />
      <StatsDataNotice
        invalidLines={invalidLines}
        malformedGames={malformedGames}
        unusableGames={unusableGames}
        unknownHeroLines={unknownHeroLines}
        unmappedLines={unmappedLines}
      />

      <p className="text-sm text-muted">
        {meta.games} of {games.length} imported games eligible for hero
        analysis. Complete 5v5 scores and known hero IDs are required.
      </p>
      <HeroMetaExplorer
        rows={meta.rows.map((row) => ({
          ...row,
          signatureUserId:
            row.topPlayer && nameOf.has(row.topPlayer.userId)
              ? row.topPlayer.userId
              : null,
          name: heroById(row.heroId)?.name ?? `Hero #${row.heroId}`,
          signatureName: row.topPlayer
            ? (nameOf.get(row.topPlayer.userId) ?? "Former player")
            : "",
        }))}
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Games analyzed" value={String(meta.games)} />
        <Stat label="Heroes picked" value={String(meta.rows.length)} />
        <Stat label="Hero pool seen" value={`${poolSeenPct}%`} />
        <Stat label="Never picked" value={String(unpicked.length)} />
      </div>

      <Card>
        <CardHeader
          headingLevel={2}
          title="Most contested"
          subtitle="The league's most-picked heroes this season"
        />
        <CardBody>
          <MetaTable
            rows={contested}
            nameOf={nameOf}
            label="Most contested heroes"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          headingLevel={2}
          title="Winning the meta"
          subtitle={`Best win rates among heroes with ${minPicks}+ picks`}
        />
        <CardBody>
          {best.length > 0 ? (
            <MetaTable
              rows={best.slice(0, 10)}
              nameOf={nameOf}
              label="Highest hero win rates"
            />
          ) : (
            <p className="text-sm text-muted">
              No hero has reached the {minPicks}-pick sample yet. This board
              will appear as the season develops.
            </p>
          )}
        </CardBody>
      </Card>

      {unpicked.length > 0 && unpicked.length <= 30 && (
        <Card>
          <CardHeader
            headingLevel={2}
            title="Untouched"
            subtitle="Heroes nobody has dared to pick yet"
          />
          <CardBody>
            <div className="flex flex-wrap gap-1.5">
              {unpicked.map((hero) => (
                <HeroIcon key={hero.id} hero={hero} size={30} />
              ))}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
