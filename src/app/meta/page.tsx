import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { getSeasonGameScores } from "@/lib/cached-queries";
import {
  bestWinRates,
  heroMeta,
  metaMinPicks,
  type HeroMetaRow,
  type MetaGame,
} from "@/lib/hero-meta";
import type { PlayerStat } from "@/lib/match-import";
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

export const metadata = { title: "Hero meta" };

function safeParse(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
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
}: {
  rows: HeroMetaRow[];
  nameOf: Map<string, string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
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
                  {row.topPlayer && topName ? (
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
                    <span className="text-muted/60">—</span>
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
  searchParams: Promise<{ season?: string }>;
}) {
  const { season: seasonParam } = await searchParams;
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

  const metaGames: MetaGame[] = games.map((g) => ({
    radiantWin: g.radiantWin,
    lines: safeParse(g.players).map((p) => ({
      userId: p.userId,
      heroId: p.heroId,
      isRadiant: p.isRadiant,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
    })),
  }));

  const meta = heroMeta(metaGames);
  if (meta.rows.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle
          title="Hero meta"
          subtitle={
            season.isActive ? season.name : `${season.name} · archived`
          }
        />
        <EmptyState
          title="No games yet"
          description="The meta report fills in once match games are imported."
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
  const poolSeenPct = Math.round((meta.rows.length / HEROES.length) * 100);

  return (
    <div className="space-y-6">
      <PageTitle
        title="Hero meta"
        subtitle={`${season.name}${season.isActive ? "" : " · archived"} — what the league is actually playing`}
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Games analyzed" value={String(meta.games)} />
        <Stat label="Heroes picked" value={String(meta.rows.length)} />
        <Stat label="Hero pool seen" value={`${poolSeenPct}%`} />
        <Stat label="Never picked" value={String(unpicked.length)} />
      </div>

      <Card>
        <CardHeader
          title="Most contested"
          subtitle="The league's most-picked heroes this season"
        />
        <CardBody>
          <MetaTable rows={contested} nameOf={nameOf} />
        </CardBody>
      </Card>

      {best.length > 0 && (
        <Card>
          <CardHeader
            title="Winning the meta"
            subtitle={`Best win rates among heroes with ${minPicks}+ picks`}
          />
          <CardBody>
            <MetaTable rows={best.slice(0, 10)} nameOf={nameOf} />
          </CardBody>
        </Card>
      )}

      {unpicked.length > 0 && unpicked.length <= 30 && (
        <Card>
          <CardHeader
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
