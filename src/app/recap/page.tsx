import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { getSeasonGamesForRecap } from "@/lib/cached-queries";
import { shareMetadata } from "@/lib/share-metadata";
import { singleSearchParam } from "@/lib/search-params";
import { computeSeasonAwards, type Award } from "@/lib/awards";
import { summarizeRecapGames } from "@/lib/recap";
import { heroById } from "@/lib/heroes";
import { formatMatchTime } from "@/lib/match-time";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import {
  Avatar,
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
  textLink,
} from "@/components/ui";

type RecapSearchParams = { season?: string | string[] };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<RecapSearchParams>;
}): Promise<Metadata> {
  const seasonId = singleSearchParam((await searchParams).season);
  if (seasonId === null) notFound();
  if (!seasonId) {
    return shareMetadata(
      "Season Recap",
      "Awards, superlatives, and the story of the season in GGD2L.",
      "/recap",
    );
  }
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { name: true, isActive: true },
  });
  if (!season) notFound();
  if (season.isActive) {
    return shareMetadata(
      "Season Recap",
      "Awards, superlatives, and the story of the season in GGD2L.",
      "/recap",
    );
  }
  const path = `/recap?${new URLSearchParams({ season: seasonId })}`;
  return shareMetadata(
    `${season.name} recap`,
    `Champion, bracket, awards, and season totals from ${season.name}.`,
    path,
  );
}

export default async function RecapPage({
  searchParams,
}: {
  searchParams: Promise<RecapSearchParams>;
}) {
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
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

  const [games, matches, teams] = await Promise.all([
    getSeasonGamesForRecap(season.id),
    prisma.match.findMany({
      where: { seasonId: season.id },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    prisma.team.findMany({
      where: { seasonId: season.id },
      select: { id: true, name: true },
    }),
  ]);
  const teamName = new Map(teams.map((team) => [team.id, team.name]));
  const championPresentation = resolveChampionPresentation(season, matches);
  const playoffMatches = matches.filter((match) => match.phase !== "REGULAR");
  const bracketRounds = buildBracketRounds(
    playoffMatches,
    teamName,
    seedsFromFirstRound(playoffMatches),
    (date) => formatMatchTime(date, "short"),
  );
  const completedSeries = matches.filter(
    (match) => match.status === "COMPLETED",
  ).length;

  const recapGames = summarizeRecapGames(games);
  const {
    awardGames,
    totalKills,
    trustedStatGames,
    totalDuration,
    timedGames,
    playerIds: players,
    heroIds: heroes,
  } = recapGames;

  const awards = computeSeasonAwards(awardGames);

  // Resolve everything the award cards need to render.
  const userIds = [
    ...new Set(awards.map((a) => a.userId).filter((x): x is string => !!x)),
  ];
  const [users, champion, memberships] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, avatar: true, rankTier: true },
        })
      : Promise.resolve([]),
    championPresentation.championTeamId
      ? prisma.team.findUnique({
          where: { id: championPresentation.championTeamId },
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
  const avgMins =
    timedGames > 0 ? Math.round(totalDuration / timedGames / 60) : null;

  return (
    <div className="space-y-8">
      <PageTitle
        title="Season Recap"
        subtitle={isComplete ? season.name : `${season.name} · awards so far`}
        action={
          <span className="flex flex-wrap items-center gap-2">
            {!season.isActive ? (
              <Link
                href={`/seasons/${season.id}`}
                className={buttonClasses("secondary", "sm")}
              >
                Season archive
              </Link>
            ) : null}
            {games.length > 0 ? (
              <Link
                href={`/leaders${seasonParam ? `?season=${season.id}` : ""}`}
                className={buttonClasses("secondary", "sm")}
              >
                Leaderboards →
              </Link>
            ) : null}
          </span>
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
              // my-0 on the chips below: same orphaned -my-1 as the other two
              // champion racks — see teams/page.tsx for the measurement.
              <div className="mt-1 flex flex-wrap justify-center gap-1.5">
                {champion.members.map((m) => (
                  <PlayerLink
                    key={m.id}
                    userId={m.userId}
                    className="my-0 flex items-center gap-1.5 rounded-full border border-line bg-surface-2/50 py-0.5 pl-0.5 pr-2.5 text-xs hover:border-muted/60 hover:no-underline"
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

      {season.status === "COMPLETE" && !champion ? (
        <div className="rounded-xl border border-accent/40 bg-accent/10 px-5 py-4 text-sm">
          <div className="font-medium">Champion state needs review</div>
          <p className="mt-1 text-muted">
            This season is marked complete without an authoritative champion.
            The series history below is preserved, but no title is attributed
            until administrators reconcile the grand final.
          </p>
        </div>
      ) : null}

      {bracketRounds.length > 0 ? (
        <Card className="overflow-hidden">
          <CardBody className="p-0 pt-4">
            <Bracket
              rounds={bracketRounds}
              championTeamId={championPresentation.championTeamId}
            />
          </CardBody>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Completed series" value={completedSeries} />
        <Stat
          label="Imported games"
          value={games.length}
          hint={
            games.length > 0
              ? trustedStatGames > 0
                ? `${trustedStatGames} trusted · ${totalKills} kills`
                : "no trusted box scores"
              : undefined
          }
        />
        <Stat label="Players" value={players.size} />
        <Stat
          label="Avg game"
          value={avgMins != null ? `${avgMins}m` : "—"}
          hint={`${heroes.size} heroes`}
        />
      </div>

      <div className="space-y-4">
        <SectionTitle>Season awards</SectionTitle>
        {awards.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {awards.map((a) => (
              <AwardCard
                key={a.key}
                award={a}
                user={a.userId ? userMap.get(a.userId) : undefined}
                team={a.userId ? teamByUser.get(a.userId) : undefined}
                heroName={
                  a.heroId ? (heroById(a.heroId)?.name ?? undefined) : undefined
                }
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title={
              games.length > 0
                ? "No trusted game stats"
                : "No imported game stats"
            }
            description={
              games.length > 0
                ? "Stored games exist, but none has a complete, trustworthy 5v5 box score. Official series results, the bracket, and any champion remain visible; player awards stay hidden rather than turning partial data into league records."
                : "Official series results, the playoff bracket, and any champion remain part of this recap. Player awards need imported Dota games, so none can be calculated for a season decided entirely by manual results or rulings."
            }
          />
        )}
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
  user?: {
    id: string;
    name: string;
    avatar: string | null;
    rankTier: number | null;
  };
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
            className={textLink("text-sm")}
          >
            View the match →
          </Link>
        ) : (
          <span className="text-sm text-muted">{heroName ?? "—"}</span>
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
