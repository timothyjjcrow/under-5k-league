import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { shareMetadata } from "@/lib/share-metadata";
import { computeSeasonAwards, type AwardGame, type Award } from "@/lib/awards";
import type { PlayerStat } from "@/lib/match-import";
import { heroById } from "@/lib/heroes";
import { getHeroNames } from "@/lib/dota";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  EmptyState,
  HeroIcon,
  PageTitle,
  PlayerLink,
  RankBadge,
  SectionTitle,
  Stat,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";

export const metadata = shareMetadata(
  "Season Recap",
  "Awards, superlatives, and the story of the season in the Under 4.5K League.",
);

function safeParse(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default async function RecapPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season: seasonParam } = await searchParams;
  // ?season=<id> recaps an archived (or any) season; default is the active one.
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
      <div className="space-y-6">
        <PageTitle title="Season Recap" />
        <EmptyState
          title="No active season"
          description={
            archived.length > 0
              ? "Relive a past season's awards instead."
              : undefined
          }
          action={
            archived.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-2">
                {archived.map((s) => (
                  <Link
                    key={s.id}
                    href={`/recap?season=${s.id}`}
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

  const games = await prisma.game.findMany({
    where: { match: { seasonId: season.id } },
    select: {
      matchId: true,
      radiantWin: true,
      radiantScore: true,
      direScore: true,
      durationSecs: true,
      players: true,
    },
  });

  if (games.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle title="Season Recap" subtitle={season.name} />
        <EmptyState
          title="No games yet"
          description="The recap fills in with awards and superlatives once matches are played."
        />
      </div>
    );
  }

  // Build the pure award input + a few headline totals.
  const awardGames: AwardGame[] = [];
  // Header radiantScore/direScore and durationSecs can be legitimately
  // unreported (0) — fall back to summing the player lines for kills, and
  // average duration only over games that actually carry one.
  let headerKills = 0;
  let lineKills = 0;
  let totalDuration = 0;
  let timedGames = 0;
  const players = new Set<string>();
  const heroes = new Set<number>();
  for (const g of games) {
    headerKills += g.radiantScore + g.direScore;
    if (g.durationSecs > 0) {
      totalDuration += g.durationSecs;
      timedGames++;
    }
    // ALL lines feed the awards input — hero tallies must match /meta (a
    // ringer's pick is still a pick); computeSeasonAwards itself skips
    // unmapped lines for player awards.
    const lines = safeParse(g.players).map((p) => {
      lineKills += p.kills;
      if (p.userId) players.add(p.userId);
      heroes.add(p.heroId);
      return {
        userId: p.userId,
        heroId: p.heroId,
        isRadiant: p.isRadiant,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        netWorth: p.netWorth,
        gpm: p.gpm,
      };
    });
    awardGames.push({
      matchId: g.matchId,
      radiantWin: g.radiantWin,
      radiantScore: g.radiantScore,
      direScore: g.direScore,
      lines,
    });
  }

  const awards = computeSeasonAwards(awardGames);

  // Resolve everything the award cards need to render.
  const userIds = [
    ...new Set(awards.map((a) => a.userId).filter((x): x is string => !!x)),
  ];
  const [users, heroNames, champion, memberships] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, avatar: true, rankTier: true },
        })
      : Promise.resolve([]),
    getHeroNames(),
    season.championTeamId
      ? prisma.team.findUnique({
          where: { id: season.championTeamId },
          include: { members: { include: { user: true } } },
        })
      : Promise.resolve(null),
    userIds.length
      ? prisma.teamMember.findMany({
          where: { seasonId: season.id, userId: { in: userIds } },
          select: { userId: true, team: { select: { id: true, name: true } } },
        })
      : Promise.resolve([]),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));
  // Which team the winner played for THAT season — standins simply have none.
  const teamByUser = new Map(memberships.map((m) => [m.userId, m.team]));

  const isComplete = season.status === "COMPLETE";
  const totalKills = headerKills > 0 ? headerKills : lineKills;
  const avgMins =
    timedGames > 0 ? Math.round(totalDuration / timedGames / 60) : null;

  return (
    <div className="space-y-8">
      <PageTitle
        title="Season Recap"
        subtitle={isComplete ? season.name : `${season.name} · awards so far`}
        action={
          <Link href="/leaders" className={buttonClasses("secondary", "sm")}>
            Leaderboards →
          </Link>
        }
      />

      {champion ? (
        <Card className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-0 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400/15 blur-3xl"
          />
          <CardBody className="relative flex flex-col items-center gap-3 py-9 text-center">
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-amber-300/90">
              {isComplete ? `${season.name} Champion` : "Current leader"}
            </div>
            <div className="relative">
              <TeamCrest
                name={champion.name}
                seed={champion.id}
                size={72}
                className="rounded-2xl shadow-lg ring-2 ring-amber-400/50"
              />
              <span
                aria-hidden
                className="absolute -bottom-2 -right-2 grid h-8 w-8 place-items-center rounded-full border border-amber-400/40 bg-surface text-lg shadow-md"
              >
                🏆
              </span>
            </div>
            <Link
              href={`/teams/${champion.id}`}
              className="font-display text-2xl font-bold hover:text-info"
            >
              {champion.name}
            </Link>
            {champion.members.length > 0 ? (
              <div className="mt-1 flex flex-wrap justify-center gap-1.5">
                {champion.members.map((m) => (
                  <PlayerLink
                    key={m.id}
                    userId={m.userId}
                    className="flex items-center gap-1.5 rounded-full border border-line bg-surface-2/50 py-0.5 pl-0.5 pr-2.5 text-xs hover:border-muted/60 hover:no-underline"
                  >
                    <Avatar name={m.user.name} src={m.user.avatar} size={20} />
                    <span>{m.user.name}</span>
                  </PlayerLink>
                ))}
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Games played" value={games.length} />
        <Stat label="Total kills" value={totalKills} />
        <Stat label="Players" value={players.size} />
        <Stat
          label="Avg game"
          value={avgMins != null ? `${avgMins}m` : "—"}
          hint={`${heroes.size} heroes`}
        />
      </div>

      <div className="space-y-4">
        <SectionTitle>Season awards</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {awards.map((a) => (
            <AwardCard
              key={a.key}
              award={a}
              user={a.userId ? userMap.get(a.userId) : undefined}
              team={a.userId ? teamByUser.get(a.userId) : undefined}
              heroName={a.heroId ? heroNames[a.heroId] : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AwardCard({
  award,
  user,
  team,
  heroName,
}: {
  award: Award;
  user?: { id: string; name: string; avatar: string | null; rankTier: number | null };
  team?: { id: string; name: string };
  heroName?: string;
}) {
  const hero = award.heroId ? heroById(award.heroId) : null;
  return (
    <div className="flex flex-col rounded-xl border border-line bg-surface-2/40 p-4 transition-colors hover:border-muted/60">
      <div className="flex items-center gap-2">
        <span className="text-xl" aria-hidden>
          {award.emoji}
        </span>
        <span className="font-display text-sm font-semibold uppercase tracking-wide">
          {award.title}
        </span>
      </div>

      <div className="mt-3 flex min-w-0 items-center gap-3">
        {user ? (
          <>
            <PlayerLink userId={user.id}>
              <Avatar name={user.name} src={user.avatar} size={38} />
            </PlayerLink>
            <div className="min-w-0">
              <PlayerLink
                userId={user.id}
                className="block truncate font-medium"
              >
                {user.name}
              </PlayerLink>
              {team ? (
                <Link
                  href={`/teams/${team.id}`}
                  className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted hover:text-info"
                >
                  <TeamCrest name={team.name} seed={team.id} size={14} />
                  <span className="truncate">{team.name}</span>
                </Link>
              ) : null}
              <span className="mt-0.5 block">
                <RankBadge rankTier={user.rankTier} />
              </span>
            </div>
          </>
        ) : hero ? (
          <>
            <HeroIcon hero={hero} size={38} />
            <div className="min-w-0 font-medium truncate">{hero.name}</div>
          </>
        ) : award.matchId ? (
          <Link
            href={`/matches/${award.matchId}`}
            className="text-sm text-info hover:underline"
          >
            View the match →
          </Link>
        ) : (
          <span className="text-sm text-muted">
            {heroName ?? "—"}
          </span>
        )}
      </div>

      <div className="mt-3 flex items-baseline gap-2 border-t border-line/60 pt-3">
        <span className="font-display text-xl font-bold text-accent">
          {award.value}
        </span>
        {award.detail ? (
          <span className="text-xs text-muted">{award.detail}</span>
        ) : null}
      </div>
      <div className="mt-1 text-[11px] text-muted">{award.blurb}</div>
    </div>
  );
}
