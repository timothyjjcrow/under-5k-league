import { Suspense } from "react";
import { openFixtures } from "@/app/captains/match-desk";
import { loadMatch } from "@/app/matches/[id]/load";
import { CardSkeleton } from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { STANDIN_REQUEST_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { getSeasonMatches } from "@/lib/queries";
import { matchRoundLabel, playoffTotalRounds } from "@/lib/schedule";
import { loadSideNeeds } from "@/lib/standin-offer-service";
import { StandinCoverCard } from "./cover-card";

/**
 * A captain's standin work on the Standins page: one card per open fixture
 * of their team that has anything to do or show (`StandinCoverCard`). The
 * next fixture is always there, so a captain told on Discord that someone
 * can't come can book ahead; a later one only once it has a need, a
 * booking, a request, or a link opened it. Every other page sends a captain
 * here for standin work.
 */
export async function TeamCover({
  season,
  team,
  viewer,
  focusMatchId,
}: {
  season: { id: string; status: string; teamSize: number };
  team: { id: string; name: string };
  viewer: SessionUser;
  /** The game a link opened (`/standins?match=`): shown and highlighted. */
  focusMatchId: string | null;
}) {
  const matches = await getSeasonMatches(season.id);
  const fixtures = openFixtures(matches, team.id);
  if (fixtures.length === 0) return null;
  const ids = fixtures.map((m) => m.id);
  const [needs, activity] = await Promise.all([
    loadSideNeeds(season, ids),
    prisma.match.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        standins: { select: { id: true }, take: 1 },
        standinRequests: {
          where: { status: STANDIN_REQUEST_STATUS.PENDING },
          select: { id: true },
          take: 1,
        },
      },
    }),
  ]);
  const busy = new Set(
    activity
      .filter((m) => m.standins.length > 0 || m.standinRequests.length > 0)
      .map((m) => m.id),
  );
  const shown = fixtures.filter(
    (m, i) =>
      i === 0 ||
      m.id === focusMatchId ||
      busy.has(m.id) ||
      needs.has(`${m.id}:${team.id}`),
  );
  const rounds = playoffTotalRounds(matches);
  return (
    <section aria-labelledby="team-cover-title" className="space-y-3">
      <h2
        id="team-cover-title"
        className="font-display text-xl font-semibold [overflow-wrap:anywhere]"
      >
        Your team&apos;s cover
        <span className="ml-2 text-base font-normal text-muted">
          {team.name}
        </span>
      </h2>
      {shown.map((m) => (
        <Suspense key={m.id} fallback={<CardSkeleton rows={3} />}>
          <FixtureCover
            matchId={m.id}
            viewer={viewer}
            roundLabel={matchRoundLabel(m, rounds, { bestOf: true })}
            highlighted={m.id === focusMatchId}
          />
        </Suspense>
      ))}
    </section>
  );
}

async function FixtureCover({
  matchId,
  viewer,
  roundLabel,
  highlighted,
}: {
  matchId: string;
  viewer: SessionUser;
  roundLabel: string;
  highlighted: boolean;
}) {
  const match = await loadMatch(matchId);
  if (!match) return null;
  return (
    <StandinCoverCard
      match={match}
      viewer={viewer}
      seriesStarted={match.games.length > 0}
      roundLabel={roundLabel}
      highlighted={highlighted}
    />
  );
}
