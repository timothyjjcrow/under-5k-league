import type { Match } from "@prisma/client";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "@/components/app-link";
import { LocalTime } from "@/components/local-time";
import { SectionNav } from "@/components/section-nav";
import {
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  LinkArrow,
  PageTitle,
  buttonClasses,
} from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { CAPTAINS_HREF, captainsPageOpen } from "@/lib/captains";
import { getCaptainTeam, loadCaptainTodoRows } from "@/lib/captains-service";
import { DRAFT_STATUS, SEASON_STATUS } from "@/lib/constants";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { formatLeagueMatchTime } from "@/lib/match-time";
import {
  getSeasonMatches,
  getSeasonSnapshot,
  type SeasonSnapshot,
} from "@/lib/queries";
import { playoffTotalRounds } from "@/lib/schedule";
import { singleSearchParam } from "@/lib/search-params";
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
 * banner and its Remind button, the scrim forms, the team name and logo
 * form, and the coaches card. Each posts to the same server action, which
 * re-checks the captain and the season, so nothing here can do more than
 * those cards can. "Needs you" is `captainTodos` over every open match, the
 * rule the match page's "Waiting on you" list and Home's captain line read.
 */
export default async function CaptainsPage({
  searchParams,
}: {
  searchParams: Promise<{ match?: string | string[] }>;
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
  const sections = [
    ...(fixturesOpen ? [{ id: "needs-you", label: "Needs you" }] : []),
    ...(selected ? [{ id: "matches", label: "Matches" }] : []),
    { id: "scrims", label: "Scrims" },
    { id: "team", label: "Team" },
  ];

  return (
    <div className="space-y-5">
      <PageTitle
        title="Captains"
        subtitle={`${team.name} · ${season.name}. Move matches, book standins, check your roster in, set up the lobby, book scrims and edit your team, all from here.`}
      />
      <SectionNav items={sections} label="Captains sections" />
      {fixturesOpen ? (
        <NeedsYou todos={todos} />
      ) : (
        <DraftCard season={season} draftStatus={draftStatus} />
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
          />
        </Suspense>
      ) : fixturesOpen ? (
        <EmptyState
          compact
          title="No matches left to play"
          description="Your team has no open fixtures right now. New ones show up here as soon as they are published."
        />
      ) : null}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <div className="min-w-0">
          <Suspense fallback={<CardSkeleton rows={4} />}>
            <ScrimDesk
              seasonId={season.id}
              team={team}
              seasonOpen={seasonOpen}
              nowMs={nowMs}
            />
          </Suspense>
        </div>
        <div className="min-w-0">
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
      </div>
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

function DraftCard({
  season,
  draftStatus,
}: {
  season: SeasonSnapshot["season"];
  draftStatus: string | null;
}) {
  return (
    <Card tone="feature">
      <CardHeader
        headingLevel={2}
        title="The draft"
        subtitle={
          season.draftAt ? (
            <>
              Draft night:{" "}
              <LocalTime
                ts={season.draftAt.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(season.draftAt, "full")}
              />
            </>
          ) : (
            "Draft night isn't set yet"
          )
        }
      />
      <CardBody className="flex flex-wrap gap-2">
        <Link
          href="/draft"
          className={buttonClasses(
            draftStatus === DRAFT_STATUS.IN_PROGRESS ? "primary" : "secondary",
            "sm",
          )}
        >
          Draft room <LinkArrow />
        </Link>
        <Link href="/players" className={buttonClasses("secondary", "sm")}>
          Scout the player pool <LinkArrow />
        </Link>
      </CardBody>
    </Card>
  );
}
