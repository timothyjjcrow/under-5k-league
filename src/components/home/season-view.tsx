import type { Match } from "@prisma/client";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Bracket } from "@/components/bracket";
import { RegularSeasonProgress } from "@/components/league-progress";
import { LocalTime } from "@/components/local-time";
import {
  PlayoffOutlook,
  playoffStatusLine,
} from "@/components/playoff-outlook";
import { PlayoffStatusLine } from "@/components/playoff-status-line";
import { StandingsTable } from "@/components/standings-table-server";
import { SteamSignInNote } from "@/components/steam-sign-in";
import { TiebreakerNotice } from "@/components/tiebreaker-notice";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  LinkArrow,
  PlayerLink,
  Skeleton,
  TAP_SAFE,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { REGISTRATION_TYPE } from "@/lib/constants";
import { heroById } from "@/lib/heroes";
import { honorBestGame, weeklyHonors } from "@/lib/honors";
import { HONOR_WEEK_STATE } from "@/lib/honors-readiness";
import { getSeasonHonorReadiness } from "@/lib/honors-readiness-service";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { leagueProgress } from "@/lib/league-progress";
import { predictionOpen } from "@/lib/pickem";
import {
  projectPlayoffField,
  publicDeadHeatTeamIds,
} from "@/lib/playoff-field";
import { playoffStatuses, type TeamPlayoffStatus } from "@/lib/playoff-status";
import { prisma } from "@/lib/prisma";
import { getViewerFantasyEntered, type SeasonSnapshot } from "@/lib/queries";
import {
  bracketRounds,
  byKickoff,
  focusSlate,
  isRelevantOpenMatch,
  matchRoundLabel,
  playoffTotalRounds,
  roundName,
  slotRound,
} from "@/lib/schedule";
import { regularSeasonStatus } from "@/lib/schedule-status";
import { fantasyListed } from "@/lib/site-nav";
import {
  clinchFromReport,
  playoffOutlookShown,
  seasonScenarioReport,
} from "@/lib/stakes";
import { standingsMovement } from "@/lib/standings";
import { formByTeam } from "@/lib/team-matches";
import { cn } from "@/lib/utils";
import {
  NewcomerStandinLine,
  SignInHereButton,
  StandinSignupLink,
} from "./hero-controls";
import { HeroStat, type HeroParts, type HomeViewer } from "./hero";
import { MyNextMatch } from "./my-next-match";
import { ThisWeek } from "./this-week";
import { fmtWhen } from "./when";

/**
 * The hero in the regular season and the playoffs. A league member gets
 * their next match's check-in in the panel (MyNextMatch); someone without a
 * team gets the late standin signup and the inhouse queue instead. The counts
 * are the season's progress, or in the playoffs the teams still alive.
 */
export function seasonHero(
  snapshot: SeasonSnapshot,
  viewer: HomeViewer,
  matches: Match[],
  championTeamId: string | null,
): HeroParts {
  const { season } = snapshot;
  const { user, isActiveReg, standinRegistrationOpen } = viewer;

  let action: ReactNode = null;
  if (standinRegistrationOpen) {
    // Someone without a team mid-season can still play tonight: the inhouse
    // queue has no season gate, and it was otherwise the last thing on the
    // page, below the news.
    const inhouse = (
      <Link href="/inhouse" className={buttonClasses("secondary", "lg")}>
        Play an inhouse <LinkArrow />
      </Link>
    );
    action = !user ? (
      <>
        <SignInHereButton variant="primary" />
        {inhouse}
        <NewcomerStandinLine />
        <SteamSignInNote />
      </>
    ) : season.status === "PLAYOFFS" ? (
      // Two or three matches are left, so the standin signup has almost no
      // use: the playoffs lead, and the signup is a line.
      <>
        <Link
          href="/schedule#playoff-bracket"
          className={buttonClasses("primary", "lg")}
        >
          Follow the playoffs <LinkArrow />
        </Link>
        {inhouse}
        <p className="w-full text-sm text-muted">
          Want to play?{" "}
          <Link href="/me" className={textLink()}>
            Register as a standin
          </Link>
        </p>
      </>
    ) : (
      <>
        <StandinSignupLink variant="primary" />
        {inhouse}
      </>
    );
  }

  let meta: ReactNode = null;
  if (season.status === "REGULAR_SEASON") {
    // One time snapshot for the progress labels.
    const progressNow = Date.now();
    meta = (
      <RegularSeasonProgress progress={leagueProgress(matches, progressNow)} />
    );
  } else if (season.status === "PLAYOFFS") {
    const playoff = matches.filter(
      (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
    );
    const inBracket = new Set(
      playoff.flatMap((m) => [m.homeTeamId, m.awayTeamId]),
    );
    const losers = new Set(
      playoff
        .filter((m) => m.status === "COMPLETED" && m.winnerTeamId)
        .map((m) =>
          m.winnerTeamId === m.homeTeamId ? m.awayTeamId : m.homeTeamId,
        ),
    );
    const alive = [...inBracket].filter((id) => !losers.has(id)).length;
    meta = (
      <>
        {alive > 0 ? (
          <HeroStat
            value={alive}
            label={alive === 1 ? "team still alive" : "teams still alive"}
            tone="accent"
          />
        ) : null}
        {currentRoundLabel(playoff) ? (
          <Badge tone="accent">{currentRoundLabel(playoff)}</Badge>
        ) : null}
      </>
    );
  }

  // The hero's control slot. A signed-in viewer gets their next-match
  // check-in (it used to be the lowest-contrast strip on the page, below the
  // hero), unless the late standin signup above has taken the slot.
  const aside =
    user && !action ? (
      <Suspense
        fallback={<Skeleton className="h-32 w-full rounded-[var(--radius)]" />}
      >
        <MyNextMatch
          seasonId={season.id}
          seasonStatus={season.status}
          viewer={user}
          viewerHasActiveRegistration={isActiveReg}
          teamSize={season.teamSize}
          matches={matches}
          teams={snapshot.teams}
          championTeamId={championTeamId}
          standin={
            isActiveReg &&
            snapshot.myReg?.type === REGISTRATION_TYPE.STANDIN
          }
        />
      </Suspense>
    ) : null;

  return { action, meta, aside };
}

// Fallback for the mid-season dashboard. It MUST mirror the real bands — This
// week, then the full-width standings (in the playoffs, the bracket), the
// team / Coming up / Recent results band, then the side games — or the page
// paints one layout and then visibly rearranges into another.
export function SeasonViewSkeleton() {
  return (
    <div className="space-y-6">
      <CardSkeleton rows={4} />
      <CardSkeleton rows={6} />
      <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]">
        {Array.from({ length: 2 }).map((_, i) => (
          <CardSkeleton key={i} rows={3} className="min-w-0" />
        ))}
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr))]">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="skeleton h-16 rounded-[var(--radius)]" />
        ))}
      </div>
    </div>
  );
}

/** "Semifinals underway" — the name of the earliest playoff round still open. */
function currentRoundLabel(playoff: Match[]): string | null {
  const slotted = playoff.filter((m) => m.bracketSlot);
  const first = slotted.filter((m) => slotRound(m.bracketSlot) === 0);
  if (first.length === 0) return null;
  const total = bracketRounds(first.length * 2);
  const open = slotted.filter((m) => m.status !== "COMPLETED");
  if (open.length === 0) return null;
  const round = Math.min(...open.map((m) => slotRound(m.bracketSlot)));
  return `${roundName(round, total)} underway`;
}

export async function SeasonView({
  snapshot,
  userId,
  matches,
  gamesOnRecord,
  championTeamId,
  showCheckins,
}: {
  snapshot: SeasonSnapshot;
  userId?: string;
  matches: Match[];
  gamesOnRecord: number;
  championTeamId: string | null;
  showCheckins: boolean;
}) {
  const { season, teams } = snapshot;
  const playoffField = projectPlayoffField(teams, matches);
  const standings = playoffField.standings;
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const teamLogoUrl = new Map(teams.map((t) => [t.id, t.logoUrl]));
  const playoffRounds = playoffTotalRounds(matches);
  const teamForm = formByTeam(
    teams.map((t) => t.id),
    matches,
  );

  // One scenario report powers the standings clinch marks, the this-week
  // stakes chips, and the your-team one-liner — computed once.
  const report =
    season.status === "REGULAR_SEASON"
      ? seasonScenarioReport(
          playoffField.eligibleStandings,
          matches,
          playoffField.eligibleTeamIds.length,
          playoffField,
        )
      : null;

  const myTeam = userId
    ? teams.find((t) => t.members.some((m) => m.userId === userId))
    : undefined;
  const myScenario = myTeam ? (report?.teams.get(myTeam.id) ?? null) : null;
  // Each team's playoff outlook waits for the first final regular-season
  // series; before it every team would read "Playoff spot still open".
  const outlookShown = playoffOutlookShown(matches);
  const myStakeLine =
    myScenario && outlookShown ? playoffStatusLine(myScenario) : null;
  // The stake card's "Next series" must be the SAME match its stakes are
  // about (the engine orders by kickoff when times exist), falling back to
  // chronological order like the hero's check-in panel. It keeps the hero's
  // freshness policy too: stale unreported fixtures are results debt, not the
  // team's next opponent.
  // eslint-disable-next-line react-hooks/purity
  const seasonViewNow = Date.now();
  const myOpen = myTeam
    ? matches.filter(
        (m) =>
          isRelevantOpenMatch(m, seasonViewNow) &&
          (m.homeTeamId === myTeam.id || m.awayTeamId === myTeam.id),
      )
    : [];
  const myNextMatch =
    (myScenario?.nextMatchId
      ? myOpen.find((m) => m.id === myScenario.nextMatchId)
      : undefined) ?? [...myOpen].sort(byKickoff)[0];

  const playoffMatches = matches.filter(
    (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
  );
  const bracketRoundsView = buildBracketRounds(
    playoffMatches,
    teamName,
    // Seeds come from the frozen first-round pairings, not live standings —
    // a corrected regular result must not relabel (or blank) bracket seeds.
    seedsFromFirstRound(playoffMatches),
    (d) => fmtWhen(d) ?? "",
    teamLogoUrl,
  );
  const showBracket =
    season.status === "PLAYOFFS" && bracketRoundsView.length > 0;

  const recentResults = matches
    .filter((m) => m.status === "COMPLETED")
    .sort(
      (a, b) =>
        b.week - a.week || b.createdAt.getTime() - a.createdAt.getTime(),
    )
    .slice(0, 4);

  // Visible to everyone — spectators and unrostered players had no way to
  // see what's coming up without leaving the dashboard. Chronological, not
  // week order — a reschedule can move a match past its week-mates.
  //
  // It EXCLUDES the This-week slate. Taking "the next four unplayed matches"
  // outright meant that mid-week this card listed the exact fixtures the band
  // above it was already showing in full, with check-in counts and stakes —
  // the same three games read twice on one screen. What a reader actually
  // wants here is what comes AFTER tonight, which is only definable against
  // the same focusSlate the band above used.
  const slateIds = new Set(
    focusSlate(season.status, matches, seasonViewNow).slate.map((m) => m.id),
  );
  const upcoming = matches
    .filter((m) => isRelevantOpenMatch(m, seasonViewNow) && !slateIds.has(m.id))
    .sort(byKickoff)
    .slice(0, 4);
  const openPickemIds = matches
    .filter((m) => predictionOpen(m))
    .map((m) => m.id);
  const pickemOpen = openPickemIds.length;
  // ONE viewer query feeds both the side-game hint's count and the This-week
  // pick controls (the slate's locked fixtures ride along so a LIVE card can
  // still say what the viewer called). Per-card lookups would be N queries on
  // the hottest page; signed-out viewers never reach this at all.
  const viewerPickIds = [...new Set([...openPickemIds, ...slateIds])];
  const viewerPicks =
    userId && viewerPickIds.length > 0
      ? await prisma.prediction.findMany({
          where: { userId, matchId: { in: viewerPickIds } },
          select: { matchId: true, pickedTeamId: true },
        })
      : [];
  const myPicks = new Map(
    viewerPicks.map((p) => [p.matchId, p.pickedTeamId]),
  );
  const picksMade = openPickemIds.filter((id) => myPicks.has(id)).length;
  const fantasyLocked = season.fantasyLockedAt != null || gamesOnRecord > 0;
  const picksMissing = pickemOpen - picksMade;
  // Fantasy gets a tile while picks are open and, after the lock, only for
  // managers who entered: the menus' rule (site-nav.ts). The entry read is
  // request-cached; the layout already made it for the menus.
  const showFantasy = fantasyListed({
    phase: season.status,
    draftStatus: snapshot.draftStatus,
    fantasyLocked,
    fantasyEntered:
      userId && fantasyLocked
        ? await getViewerFantasyEntered(season.id, userId)
        : false,
  });

  // The side-game band renders BELOW the table. It used to sit above both
  // the standings and This-week, so the secondary loop (pick'em, fantasy) got
  // the first full-width band on the page while the primary one — your match,
  // your team, the table — started below it.
  //
  // It only offers what is live: Pick'em while a fixture is open for picks,
  // Fantasy by the menus' rule, and Inhouse always (it runs any night). The
  // Leaders and Hero meta tiles are gone: they repeated the menus. auto-fit,
  // because the count runs from one to three.
  const sideGames = (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr))]">
      {pickemOpen > 0 ? (
        <SideGameLink
          href="/pickem"
          icon="🔮"
          title="Pick'em"
          hint={
            userId
              ? picksMissing > 0
                ? `${picksMissing} pick${picksMissing === 1 ? "" : "s"} to make — call it`
                : "All picks in — oracle board"
              : `${pickemOpen} ${pickemOpen === 1 ? "match" : "matches"} open — call it`
          }
        />
      ) : null}
      {showFantasy ? (
        <SideGameLink
          href="/fantasy"
          icon="🧙"
          title="Fantasy"
          hint={fantasyLocked ? "Rosters locked — standings" : "Build your five"}
        />
      ) : null}
      <SideGameLink
        href="/inhouse"
        icon="⚔️"
        title="Inhouse"
        hint="Pick-up 5v5s, any night"
      />
    </div>
  );

  // The viewer's own team card. Mid-season it carries only what the table
  // can't: the playoff stakes of the next series (their row is already
  // highlighted there with rank, points and W/D/L). No stakes yet (before the
  // first final series) means no card. Nor when that series is on the
  // This-week slate: its team rows already print this exact Win/Draw/Loss
  // block, and a fixture is shown once per job. What's left is a bye week or
  // a team that has finished playing, so the card joins the auto-fit band
  // below the table (like the playoffs' team card) instead of standing beside
  // a table twice its height. In the playoffs the table is gone and the card
  // says where the team stands in the bracket instead.
  const myStakesOnSlate =
    !!myScenario?.nextMatchId && slateIds.has(myScenario.nextMatchId);
  const myStakeCard =
    myTeam && myScenario && myStakeLine && !myStakesOnSlate ? (
      <Card tone="feature">
        <CardHeader headingLevel={2} title="Your team" subtitle={myTeam.name} />
        <CardBody className="space-y-3">
          {/* The stakes are about ONE match, the scenario engine's
              nextMatchId, so the block names that opponent and links it. The
              hero's check-in panel already shows its kickoff. */}
          {myNextMatch ? (
            <Link
              href={`/matches/${myNextMatch.id}`}
              className="block rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm transition-colors hover:border-accent/50"
            >
              <p className="mb-2 text-xs text-muted [overflow-wrap:anywhere]">
                Next series: vs{" "}
                {teamName.get(
                  myNextMatch.homeTeamId === myTeam.id
                    ? myNextMatch.awayTeamId
                    : myNextMatch.homeTeamId,
                ) ?? "?"}
              </p>
              <PlayoffOutlook
                scenario={myScenario}
                teamNames={teamName}
                matchId={myNextMatch.id}
                compact
              />
            </Link>
          ) : (
            // Done playing, but the table can still decide something.
            <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm">
              <PlayoffOutlook scenario={myScenario} teamNames={teamName} />
            </div>
          )}
          <Link
            href={`/teams/${myTeam.id}`}
            className={textLink("inline-block text-sm font-medium")}
          >
            Team page <LinkArrow />
          </Link>
        </CardBody>
      </Card>
    ) : null;
  // Shared with /teams and the team page. No status (no bracket yet, or a
  // title still under review) means no card: the hero's panel covers those.
  const myPlayoffStatus =
    season.status === "PLAYOFFS" && myTeam
      ? (playoffStatuses(
          [myTeam],
          matches,
          championTeamId,
          seasonViewNow,
        ).get(myTeam.id) ?? null)
      : null;
  const myPlayoffCard =
    myTeam && myPlayoffStatus ? (
      <PlayoffTeamCard
        team={myTeam}
        status={myPlayoffStatus}
        seed={seedsFromFirstRound(playoffMatches).get(myTeam.id) ?? null}
        teamName={teamName}
      />
    ) : null;
  const regularSeasonTableLink = (
    <Link href="/schedule#standings" className={textLink("text-sm")}>
      Regular-season table <LinkArrow />
    </Link>
  );

  return (
    <div className="space-y-6">
      {season.status === "REGULAR_SEASON" ? (
        <TiebreakerNotice
          report={report}
          projection={playoffField}
          teams={teams}
          regularComplete={regularSeasonStatus(matches).allComplete}
          hasTiebreakers={matches.some((m) => m.phase === "TIEBREAKER")}
        />
      ) : null}

      {/* This week's games lead in every phase; in the playoffs that is the
          round in progress, with its check-ins, and the bracket follows. */}
      <Suspense fallback={slateIds.size > 0 ? <CardSkeleton rows={3} /> : null}>
        <ThisWeek
          season={season}
          matches={matches}
          teams={teams}
          teamName={teamName}
          teamLogoUrl={teamLogoUrl}
          report={outlookShown ? report : null}
          showCheckins={showCheckins}
          myPicks={userId ? myPicks : null}
          pickemPlayable={
            season.isActive &&
            postAuctionWorkOpen(season.status, snapshot.draftStatus)
          }
        />
      </Suspense>

      {showBracket ? (
        // overflow-hidden on the CARD: Bracket's root is `overflow-x-auto` over
        // a `min-w-max` row, and Chrome propagates that inner width into the
        // page scroll area through the card (CLAUDE.md's SeasonGrid rule). All
        // four <Bracket> call sites were missing it.
        <Card className="overflow-hidden">
          <CardHeader
            headingLevel={2}
            title="Playoff bracket"
            action={
              // The regular-season table decides nothing once the bracket is
              // drawn, so Home links it on Schedule instead of printing it.
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {regularSeasonTableLink}
                <Link
                  href="/schedule#playoff-bracket"
                  className={textLink("text-sm")}
                >
                  Full bracket <LinkArrow />
                </Link>
              </div>
            }
          />
          <CardBody className="p-0 pt-4">
            <Bracket
              rounds={bracketRoundsView}
              championTeamId={championTeamId}
            />
          </CardBody>
        </Card>
      ) : season.status === "PLAYOFFS" ? (
        <Card>
          <CardHeader headingLevel={2} title="Playoff bracket" />
          <CardBody>
            <EmptyState
              title="Waiting for the bracket"
              description="The league is in Playoffs, but the first-round fixtures haven't been drawn yet. The regular-season table decides the seeds."
              action={
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-2">
                  {regularSeasonTableLink}
                  <Link
                    href="/schedule#playoff-bracket"
                    className={textLink("text-sm")}
                  >
                    Playoff schedule <LinkArrow />
                  </Link>
                </div>
              }
            />
          </CardBody>
        </Card>
      ) : (
        /* THE DASHBOARD BAND: the table, full width. The viewer's stakes
           card used to sit beside it, but it is a third of the table's height,
           which left a hole under it; it lives in the band below now. */
        <div className="min-w-0">
          <Card>
            <CardHeader
              headingLevel={2}
              title="Standings"
              action={
                <Link
                  href="/schedule#standings"
                  className={textLink("text-sm")}
                >
                  Full standings <LinkArrow />
                </Link>
              }
            />
            <CardBody className="p-0">
              <StandingsTable
                standings={standings}
                totalTeams={standings.length}
                eligibleTeams={playoffField.eligibleTeamIds.length}
                teamName={teamName}
                teamLogoUrl={teamLogoUrl}
                withdrawnIds={
                  new Set(teams.filter((t) => t.withdrawn).map((t) => t.id))
                }
                formByTeam={teamForm}
                playoffCut={playoffField.bracketSize}
                playoffSeedByTeam={playoffField.seedByTeam}
                unresolvedPlayoffTeamIds={publicDeadHeatTeamIds(
                  playoffField,
                  matches,
                )}
                clinch={clinchFromReport(report)}
                playoffScenarios={report?.forecast?.basis === "final" ? report.teams : undefined}
                viewerTeamId={myTeam?.id}
                movement={standingsMovement(
                  teams.map((t) => t.id),
                  matches,
                )}
              />
            </CardBody>
          </Card>
        </div>
      )}

      {/* The viewer's team card (in the playoffs, where it stands in the
          bracket; mid-season, the stakes of a next series This week doesn't
          show); then what comes after this slate and what just finished: short plain
          lists with a link to the rest. auto-fit, because any card can be
          missing (nothing left to play, nothing played yet), and items-start
          so the shorter card doesn't stretch into an empty box. There is no
          week-by-week results grid here: the table's form column and Recent
          results already say it, and Schedule keeps the full grid. */}
      {myPlayoffCard || myStakeCard || upcoming.length > 0 || recentResults.length > 0 ? (
        <div className="grid items-start gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]">
          {myPlayoffCard}
          {myStakeCard ? <div className="min-w-0">{myStakeCard}</div> : null}
          {upcoming.length > 0 ? (
            <Card className="min-w-0 overflow-hidden">
              <CardHeader
                className="px-4 py-3"
                headingLevel={2}
                title="Coming up"
                subtitle="After this week's slate"
              />
              <CardBody className="p-0">
                <ul className="divide-y divide-line/60">
                  {upcoming.map((m) => (
                    <li key={m.id}>
                      <Link
                        href={`/matches/${m.id}`}
                        className="block px-4 py-2.5 text-sm hover:bg-surface-2/40"
                      >
                        <div className="text-xs uppercase text-muted">
                          {matchRoundLabel(m, playoffRounds)}
                          {m.scheduledAt ? (
                            <>
                              {" · "}
                              <LocalTime
                                ts={m.scheduledAt.getTime()}
                                variant="full"
                                initial={fmtWhen(m.scheduledAt) ?? ""}
                              />
                            </>
                          ) : null}
                        </div>
                        <div className="mt-1 font-medium leading-relaxed [overflow-wrap:anywhere]">
                          {teamName.get(m.homeTeamId) ?? "?"}{" "}
                          <span className="font-normal text-muted">vs</span>{" "}
                          {teamName.get(m.awayTeamId) ?? "?"}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardBody>
              <Link
                href="/schedule#fixtures"
                className={textLink(
                  "my-0 block rounded-none border-t border-line-soft px-4 py-2.5 text-xs font-medium focus-visible:ring-inset",
                )}
              >
                Full schedule <LinkArrow />
              </Link>
            </Card>
          ) : null}

          {recentResults.length > 0 ? (
            <Card className="min-w-0 overflow-hidden">
              <CardHeader
                className="px-4 py-3"
                headingLevel={2}
                title="Recent results"
              />
              <CardBody className="p-0">
                <ul className="divide-y divide-line/60">
                  {recentResults.map((m) => (
                    <li key={m.id}>
                      <Link
                        href={`/matches/${m.id}`}
                        className="block space-y-1.5 px-4 py-3 text-sm transition-colors hover:bg-surface-2/60"
                      >
                        <p className="text-xs text-muted">
                          {matchRoundLabel(m, playoffRounds)} ·{" "}
                          {m.forfeit ? "Forfeit" : "Final score"}
                        </p>
                        {[
                          { id: m.homeTeamId, score: m.homeScore },
                          { id: m.awayTeamId, score: m.awayScore },
                        ].map((side) => (
                          <div
                            key={side.id}
                            className="flex items-center gap-2"
                          >
                            <TeamCrest
                              name={teamName.get(side.id) ?? "?"}
                              seed={side.id}
                              logoUrl={teamLogoUrl.get(side.id)}
                              size={22}
                              className="shrink-0 rounded"
                            />
                            <span
                              className={cn(
                                "min-w-0 flex-1 [overflow-wrap:anywhere]",
                                m.winnerTeamId === side.id
                                  ? "font-semibold"
                                  : "text-muted",
                              )}
                            >
                              {teamName.get(side.id) ?? "?"}
                            </span>
                            <span
                              className={cn(
                                "grid h-7 w-8 shrink-0 place-items-center rounded font-display text-lg tabular-nums",
                                m.winnerTeamId === side.id
                                  ? "bg-success/15 text-success"
                                  : "bg-surface-2 text-muted",
                              )}
                            >
                              {side.score}
                            </span>
                          </div>
                        ))}
                        <p className="sr-only">
                          {m.winnerTeamId
                            ? `${teamName.get(m.winnerTeamId) ?? "Winning team"} won the series`
                            : "Series drawn"}{" "}
                          · Match details
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardBody>
              <Link
                href="/schedule#fixtures"
                className={textLink(
                  "my-0 block rounded-none border-t border-line-soft px-4 py-2.5 text-xs font-medium focus-visible:ring-inset",
                )}
              >
                All results <LinkArrow />
              </Link>
            </Card>
          ) : null}
        </div>
      ) : null}

      <Suspense fallback={null}>
        <WeeklyHonorsLine
          seasonId={season.id}
          teams={teams}
          teamName={teamName}
        />
      </Suspense>
      {sideGames}
    </div>
  );
}

/**
 * The latest weekly honors as one open line: "Week 4 honors · Player of the
 * Week: X (best game 12/2/18 on Tiny) · Team of the Week: Y". Only official
 * honors (the same readiness rows Discord and /leaders use); until a week has
 * them it renders nothing, and /leaders explains a week still in progress or
 * waiting on box scores.
 */
async function WeeklyHonorsLine({
  seasonId,
  teams,
  teamName,
}: {
  seasonId: string;
  teams: SeasonSnapshot["teams"];
  teamName: Map<string, string>;
}) {
  const latest = (await getSeasonHonorReadiness(seasonId)).find(
    (row) => row.state === HONOR_WEEK_STATE.READY && row.games.length > 0,
  );
  if (!latest) return null;
  const teamOf = new Map(
    teams.flatMap((t) => t.members.map((m) => [m.userId, t.id] as const)),
  );
  const honors = weeklyHonors(latest.games, teamOf);
  const potw = honors.player
    ? await prisma.user.findUnique({
        where: { id: honors.player.userId },
        select: { id: true, name: true },
      })
    : null;
  if (!potw && !honors.team) return null;
  const best = potw ? honorBestGame(latest.games, potw.id) : null;
  const bestHero = best
    ? (heroById(best.heroId)?.name ?? `Hero #${best.heroId}`)
    : null;

  return (
    <section
      aria-labelledby="home-weekly-honors"
      className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-2 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm"
    >
      <h2 id="home-weekly-honors" className="text-sm font-semibold">
        Week {latest.week} honors
      </h2>
      {potw ? (
        <p className="min-w-0 [overflow-wrap:anywhere]">
          <span aria-hidden>⭐ </span>
          <span className="text-muted">Player of the Week:</span>{" "}
          <PlayerLink userId={potw.id} className="font-medium">
            {potw.name}
          </PlayerLink>
          {best ? (
            <span className="text-muted">
              {" "}
              (best game {best.kills}/{best.deaths}/{best.assists} on{" "}
              {bestHero})
            </span>
          ) : null}
        </p>
      ) : null}
      {honors.team ? (
        <p className="min-w-0 [overflow-wrap:anywhere]">
          <span aria-hidden>🛡️ </span>
          <span className="text-muted">Team of the Week:</span>{" "}
          <Link
            href={`/teams/${honors.team.teamId}`}
            className={cn(TAP_SAFE, "font-medium hover:text-info")}
          >
            {teamName.get(honors.team.teamId) ?? "?"}
          </Link>
        </p>
      ) : null}
      <Link href="/leaders#weekly-honors" className={textLink("text-sm")}>
        All honors <LinkArrow />
      </Link>
    </section>
  );
}

/**
 * Home's "Your team" card in the playoffs: the seed and where the team stands
 * in the bracket, in the words /teams and the team page use ("Semifinal vs
 * X", "Out in the quarterfinal (lost 1–2 to Y)"), instead of regular-season
 * rank and points, which decide nothing any more.
 */
function PlayoffTeamCard({
  team,
  status,
  seed,
  teamName,
}: {
  team: { id: string; name: string };
  status: TeamPlayoffStatus;
  seed: number | null;
  teamName: Map<string, string>;
}) {
  const line = (
    <>
      {seed != null ? (
        <p className="text-xs uppercase text-muted">Seed #{seed}</p>
      ) : null}
      <PlayoffStatusLine
        status={status}
        teamName={teamName}
        className="mt-1 text-sm"
      />
    </>
  );
  return (
    <Card tone="feature" className="min-w-0">
      <CardHeader headingLevel={2} title="Your team" subtitle={team.name} />
      <CardBody className="space-y-3">
        {status.kind === "playing" ? (
          // The series being played (or next) opens its match page.
          <Link
            href={`/matches/${status.matchId}`}
            className="block rounded-lg border border-accent/30 bg-accent/5 p-3 transition-colors hover:border-accent/50"
          >
            {line}
          </Link>
        ) : (
          <div>{line}</div>
        )}
        <Link
          href={`/teams/${team.id}`}
          className={textLink("inline-block text-sm font-medium")}
        >
          Team page <LinkArrow />
        </Link>
      </CardBody>
    </Card>
  );
}

function SideGameLink({
  href,
  icon,
  title,
  hint,
}: {
  href: string;
  icon: string;
  title: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 items-center gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 transition-colors hover:border-muted/60"
    >
      <span aria-hidden className="text-xl">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium group-hover:text-info">
          {title}
        </span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </Link>
  );
}
