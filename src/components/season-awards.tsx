import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSeasonGamesForRecap } from "@/lib/cached-queries";
import { computeSeasonAwards, type Award } from "@/lib/awards";
import { impactPointsRule } from "@/lib/fantasy";
import { summarizeRecapGames } from "@/lib/recap";
import { heroById } from "@/lib/heroes";
import {
  Avatar,
  EmptyState,
  HeroIcon,
  PlayerLink,
  RankBadge,
  SectionTitle,
  Stat,
  TeamCrest,
  textLink,
} from "@/components/ui";

/**
 * A finished season's numbers and awards, on that season's own page (it used
 * to be the separate /recap page, which also repeated the champion and the
 * bracket). Streamed: the award scan reads every game of the season.
 */
export async function SeasonAwards({
  seasonId,
  completedSeries,
}: {
  seasonId: string;
  /** Decided series, counted by the page from the matches it already has. */
  completedSeries: number;
}) {
  const games = await getSeasonGamesForRecap(seasonId);
  const {
    awardGames,
    totalKills,
    trustedStatGames,
    totalDuration,
    timedGames,
    playerIds: players,
    heroIds: heroes,
  } = summarizeRecapGames(games);
  const awards = computeSeasonAwards(awardGames);

  const userIds = [
    ...new Set(awards.map((a) => a.userId).filter((x): x is string => !!x)),
  ];
  const [users, memberships] = userIds.length
    ? await Promise.all([
        prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, avatar: true, rankTier: true },
        }),
        prisma.teamMember.findMany({
          where: { seasonId, userId: { in: userIds } },
          select: {
            userId: true,
            team: { select: { id: true, name: true, logoUrl: true } },
          },
        }),
      ])
    : [[], []];
  const userMap = new Map(users.map((u) => [u.id, u]));
  // Which team the winner played for THAT season; standins simply have none.
  const teamByUser = new Map(memberships.map((m) => [m.userId, m.team]));
  const avgMins =
    timedGames > 0 ? Math.round(totalDuration / timedGames / 60) : null;

  return (
    <section
      id="season-awards"
      aria-labelledby="season-awards-title"
      className="scroll-mt-24 space-y-4"
    >
      <SectionTitle>
        <span id="season-awards-title">Season awards</span>
      </SectionTitle>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat size="md" label="Completed series" value={completedSeries} />
        <Stat
          size="md"
          label="Imported games"
          value={games.length}
          hint={
            games.length > 0
              ? trustedStatGames > 0
                ? `${trustedStatGames} complete · ${totalKills} kills`
                : "no complete box scores"
              : undefined
          }
        />
        <Stat size="md" label="Players" value={players.size} />
        <Stat
          size="md"
          label="Avg game"
          value={avgMins != null ? `${avgMins}m` : "—"}
          hint={`${heroes.size} heroes`}
        />
      </div>
      {awards.length > 0 ? (
        // Rows that fill themselves: each card starts at 16rem and grows,
        // so however many awards the season produced (they are skipped
        // until someone qualifies) the last row has no empty cells.
        <div className="flex flex-wrap gap-3 [&>*]:min-w-0 [&>*]:flex-[1_1_16rem]">
          {awards.map((a) => (
            <AwardCard
              key={a.key}
              award={a}
              user={a.userId ? userMap.get(a.userId) : undefined}
              team={a.userId ? teamByUser.get(a.userId) : undefined}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          compact
          title={
            games.length > 0 ? "No trusted game stats" : "No imported game stats"
          }
          description={
            games.length > 0
              ? "Games were imported, but none has a complete 5v5 box score, so no player awards are given. The results, bracket and champion on this page still stand."
              : "Player awards need imported Dota games, so none are given for a season decided by manual results or rulings. The results, bracket and champion on this page still stand."
          }
        />
      )}
      {awards.some((a) => a.key === "mvp") ? (
        <p className="text-xs leading-relaxed text-muted">
          The MVP is ranked by impact points, the Player of the Week score:{" "}
          {impactPointsRule()}.
        </p>
      ) : null}
    </section>
  );
}

/**
 * One award: the title and the figure on one line, the winner under it and
 * the rule at the foot. The figure used to sit under a rule of its own, so a
 * card stood about 190px tall; this is about 130px.
 */
function AwardCard({
  award,
  user,
  team,
}: {
  award: Award;
  user?: {
    id: string;
    name: string;
    avatar: string | null;
    rankTier: number | null;
  };
  team?: { id: string; name: string; logoUrl: string | null };
}) {
  const hero = award.heroId ? heroById(award.heroId) : null;
  return (
    <div className="flex flex-col rounded-xl border border-line bg-surface-2/40 p-3.5 transition-colors hover:border-muted/60">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-lg leading-none" aria-hidden>
            {award.emoji}
          </span>
          <span className="font-display text-sm font-semibold uppercase tracking-wide">
            {award.title}
          </span>
        </div>
        <div className="ml-auto text-right">
          <span className="font-display text-xl font-bold leading-none text-accent">
            {award.value}
          </span>
          {award.detail ? (
            <span className="mt-1 block text-[11px] leading-tight text-muted">
              {award.detail}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-2.5 flex min-w-0 items-center gap-2.5">
        {user ? (
          <>
            <PlayerLink userId={user.id}>
              <Avatar name={user.name} src={user.avatar} size={32} />
            </PlayerLink>
            <div className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5">
                <PlayerLink
                  userId={user.id}
                  className="block truncate font-medium"
                >
                  {user.name}
                </PlayerLink>
                <RankBadge rankTier={user.rankTier} />
              </span>
              {team ? (
                <Link
                  href={`/teams/${team.id}`}
                  className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted hover:text-info"
                >
                  <TeamCrest
                    name={team.name}
                    seed={team.id}
                    logoUrl={team.logoUrl}
                    size={14}
                  />
                  <span className="truncate">{team.name}</span>
                </Link>
              ) : null}
            </div>
          </>
        ) : hero ? (
          <>
            <HeroIcon hero={hero} size={32} />
            <div className="min-w-0 truncate font-medium">{hero.name}</div>
          </>
        ) : award.matchId ? (
          <Link
            href={`/matches/${award.matchId}`}
            className={textLink("text-sm")}
          >
            View the match →
          </Link>
        ) : (
          <span className="text-sm text-muted">
            {award.heroId ? `Hero #${award.heroId}` : "—"}
          </span>
        )}
      </div>

      <div className="mt-2.5 text-xs text-muted">{award.blurb}</div>
    </div>
  );
}
