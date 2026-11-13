import type { Match } from "@prisma/client";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "@/components/app-link";
import { SectionNav } from "@/components/section-nav";
import {
  CardSkeleton,
  EmptyState,
  LinkArrow,
  PageTitle,
  buttonClasses,
} from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import {
  CAPTAINS_ANCHOR,
  CAPTAINS_HREF,
  captainsPageOpen,
} from "@/lib/captains";
import { getCaptainTeam, loadCaptainTodoRows } from "@/lib/captains-service";
import { SEASON_STATUS } from "@/lib/constants";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { getSeasonMatches, getSeasonSnapshot } from "@/lib/queries";
import { playoffTotalRounds } from "@/lib/schedule";
import { singleSearchParam } from "@/lib/search-params";
import { DraftDesk } from "./draft-desk";
import { MatchDesk, openFixtures } from "./match-desk";
import { NeedsYou } from "./needs-you";
import { ScrimDesk } from "./scrim-desk";
import { TeamDesk } from "./team-desk";

export const metadata = { title: "Captains" };

/**
 * The Captains page: where a team's captain runs their team. Every control
 * is the one the rest of the site already uses, drawn here as well: the match
 * page's Captain tools (the ready check that moves a match, standins, lobby
 * setup and reporting) for any of the team's open fixtures, the check-in
 * banner and its Remind button, the scrim forms and a booked scrim's lobby,
 * guests and results (the scrim page's own), the team name and logo form,
 * and the coaches card. Before the auction is done the draft card leads
 * instead. Each control posts to the same server action, which
 * re-checks the captain and the season, so nothing here can do more than
 * those cards can. "Needs you" is `captainTodos` over every open match, the
 * rule the match page's "Waiting on you" list and Home's captain line read.
 */
export default async function CaptainsPage({
  searchParams,
}: {
  searchParams: Promise<{
    match?: string | string[];
    scrim?: string | string[];
  }>;
}) {
  const [user, query] = await Promise.all([getSessionUser(), searchParams]);
  if (!user) redirect(`/login?next=${CAPTAINS_HREF}`);
  const snapshot = await getSeasonSnapshot(user.id);
  const team = snapshot
    ? await getCaptainTeam(snapshot.season.id, user.id)
    : null;
  if (!snapshot || !team || !captainsPageOpen(snapshot.season, team)) {
    return <NotACaptain />;
  }
  const { season, draftStatus } = snapshot;
  // A server component renders once per request: one clock for every card.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const fixturesOpen = postAuctionWorkOpen(season.status, draftStatus);
  const seasonOpen = season.isActive && season.status !== SEASON_STATUS.COMPLETE;
  const [matches, todos] = await Promise.all([
    fixturesOpen ? getSeasonMatches(season.id) : Promise.resolve([] as Match[]),
    loadCaptainTodoRows({
      season,
      draftStatus,
      teamId: team.id,
      viewerId: user.id,
      nowMs,
    }),
  ]);
  const fixtures = openFixtures(matches, team.id);
  // A repeated or unknown ?match= falls back to the next fixture.
  const requested = singleSearchParam(query.match);
  const selected =
    fixtures.find((m) => m.id === requested) ?? fixtures[0] ?? null;
  // A repeated ?scrim= reads as none; the scrim desk checks it is the team's.
  const requestedScrim = singleSearchParam(query.scrim) ?? null;
  const todoCounts = new Map<string, number>();
  for (const row of todos) {
    todoCounts.set(row.matchId, (todoCounts.get(row.matchId) ?? 0) + 1);
  }
  const sections = [
    fixturesOpen
      ? { id: CAPTAINS_ANCHOR.needsYou, label: "Needs you" }
      : { id: "draft", label: "Draft" },
    ...(selected ? [{ id: CAPTAINS_ANCHOR.matches, label: "Matches" }] : []),
    { id: CAPTAINS_ANCHOR.scrims, label: "Scrims" },
    { id: CAPTAINS_ANCHOR.team, label: "Team" },
  ];

  return (
    <div className="space-y-5">
      <PageTitle
        title="Captains"
        subtitle={`${team.name} · ${season.name}. Move matches, book standins, check your roster in, set up lobbies, run your scrims and edit your team, all from here.`}
      />
      <SectionNav items={sections} label="Captains sections" />
      {fixturesOpen ? (
        <NeedsYou todos={todos} />
      ) : (
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <DraftDesk snapshot={snapshot} teamId={team.id} />
        </Suspense>
      )}
      {selected ? (
        <Suspense fallback={<CardSkeleton rows={6} />}>
          <MatchDesk
            fixtures={fixtures}
            selectedId={selected.id}
            teamId={team.id}
            teams={snapshot.teams}
            rounds={playoffTotalRounds(matches)}
            viewer={user}
            nowMs={nowMs}
            todoCounts={todoCounts}
            scrimId={requestedScrim}
          />
        </Suspense>
      ) : fixturesOpen ? (
        <EmptyState
          compact
          title="No matches left to play"
          description="Your team has no open fixtures right now. New ones show up here as soon as they are published."
        />
      ) : null}
      <Suspense fallback={<CardSkeleton rows={4} />}>
        <ScrimDesk
          seasonId={season.id}
          team={team}
          viewer={user}
          seasonOpen={seasonOpen}
          leagueId={season.dotaLeagueId}
          nowMs={nowMs}
          matchId={selected?.id ?? null}
          requestedScrimId={requestedScrim}
        />
      </Suspense>
      <Suspense fallback={<CardSkeleton rows={4} />}>
        <TeamDesk
          snapshot={snapshot}
          matches={matches}
          team={team}
          viewer={user}
          seasonOpen={seasonOpen}
        />
      </Suspense>
    </div>
  );
}

function NotACaptain() {
  return (
    <div className="space-y-5">
      <PageTitle title="Captains" />
      <EmptyState
        title="This page is for team captains"
        description="A season's captains run their team from here: matches, standins, check-ins, scrims and the team's name and logo. It opens for a captain once their team exists in the active season."
        action={
          <Link href="/teams" className={buttonClasses("secondary", "sm")}>
            See the teams <LinkArrow />
          </Link>
        }
      />
    </div>
  );
}
