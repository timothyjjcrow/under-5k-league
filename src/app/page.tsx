import { PlayoffOutlook, playoffStatusLine } from "@/components/playoff-outlook";
import { RegularSeasonProgress } from "@/components/league-progress";
import { leagueProgress } from "@/lib/league-progress";
import { cache, Fragment, Suspense, type ReactNode } from "react";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { draftNightSoon, draftSetupOpen } from "@/lib/draft-setup";
import {
  getSeasonMatches,
  getSeasonSnapshot,
  getViewerFantasyEntered,
  type SeasonSnapshot,
} from "@/lib/queries";
import { fantasyListed } from "@/lib/site-nav";
import { prisma } from "@/lib/prisma";
import {
  computeStandings,
  standingsMovement,
} from "@/lib/standings";
import {
  clinchFromReport,
  playoffOutlookShown,
  seasonScenarioReport,
} from "@/lib/stakes";
import {
  projectPlayoffField,
  publicDeadHeatTeamIds,
} from "@/lib/playoff-field";
import { TiebreakerNotice } from "@/components/tiebreaker-notice";
import { regularSeasonStatus } from "@/lib/schedule-status";
import { type ScenarioReport } from "@/lib/scenarios";
import {
  bracketRounds,
  byKickoff,
  matchRoundLabel,
  focusSlate,
  isRelevantOpenMatch,
  playoffTotalRounds,
  roundName,
  slotRound,
  teamByeWeek,
} from "@/lib/schedule";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { Bracket } from "@/components/bracket";
import { formByTeam } from "@/lib/team-matches";
import {
  expectedSideSize,
  matchNightRoster,
  teamAvailability,
} from "@/lib/availability";
import { honorBestGame, weeklyHonors } from "@/lib/honors";
import { HONOR_WEEK_STATE } from "@/lib/honors-readiness";
import { getSeasonHonorReadiness } from "@/lib/honors-readiness-service";
import { heroById } from "@/lib/heroes";
import type { Match } from "@prisma/client";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  DiscordButton,
  EmptyState,
  LinkArrow,
  LinkifiedText,
  PlayerLink,
  RankBadge,
  RoleBadges,
  ScheduleCallout,
  Skeleton,
  TAP_SAFE,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { roleCoverage, shortRolesLine } from "@/lib/pool-stats";
import { queuePresentCutoff } from "@/lib/inhouse";
import { DiscordSetupPrompt } from "@/components/discord-setup";
import {
  DISCORD_INVITE_URL,
  DRAFT_STATUS,
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  GAME_SERVER_REGION,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
} from "@/lib/constants";
import { matchAttention } from "@/lib/admin-attention";
import { adminHomeLine } from "@/lib/admin-home-line";
import { pickemControlFor, predictionOpen } from "@/lib/pickem";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import { PickemTray } from "@/components/pickem-pick-form";
import { HeroVideo } from "@/components/hero-video";
import { CheckinBanner } from "@/components/checkin-banner";
import { ByeWeekNote } from "@/components/bye-week-note";
import { StandingsTable } from "@/components/standings-table-server";
import { LocalTime } from "@/components/local-time";
import { Countdown } from "@/components/countdown";
import { SeriesRecord } from "@/components/series-record";
import { InviteLink } from "@/components/invite-link";
import {
  DRAFT_PASSED_LABEL,
  HISTORY_PHASE_LABEL,
  draftPhasePresentation,
  leagueEligibilityLine,
  leaguePitch,
  phaseSubtitle,
  seasonPhaseLabel,
  seasonPhaseTone,
} from "@/lib/season-copy";
import { NewsMedia } from "@/components/news-media";
import { formatMatchTime } from "@/lib/match-time";
import { announcedMatchNight } from "@/lib/match-night";
import { firstMedia } from "@/lib/linkify";
import { cn } from "@/lib/utils";
import { rosterOrder } from "@/lib/team-roster";
import { myMatchPanel, type PanelIdle } from "@/lib/my-match-panel";
import { loadCheckinSide } from "@/lib/checkin-side-service";
import { playoffStatuses, type TeamPlayoffStatus } from "@/lib/playoff-status";
import { PlayoffStatusLine } from "@/components/playoff-status-line";
import {
  DRAFT_READINESS,
  draftReadiness,
  owedDraftConfirmation,
  type DraftReadiness,
} from "@/lib/draft-readiness";
import { confirmDraftReadiness } from "@/app/actions/registration";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  resolveChampionPresentation,
  type ChampionPresentation,
} from "@/lib/champion-presentation";
import {
  canViewAvailabilitySummary,
  canViewLeagueContact,
  hasActiveLeagueParticipation,
  type VisibilityViewer,
} from "@/lib/visibility";
import { DiscordTag } from "@/components/discord-tag";
import { homeMetadata } from "@/lib/link-preview-metadata";
import { MATCH_ANCHOR, matchAnchorPath } from "@/lib/match-anchors";
import {
  getDefendingChampion,
  type DefendingChampion,
} from "@/lib/official-champion";
import {
  SteamSignInButton,
  SteamSignInLink,
  SteamSignInNote,
} from "@/components/steam-sign-in";

const PHASE_ORDER = [
  "SIGNUPS",
  "DRAFT",
  "REGULAR_SEASON",
  "PLAYOFFS",
  "COMPLETE",
] as const;

const PHASE_STEP: Record<string, string> = {
  SIGNUPS: "Signups",
  DRAFT: "Draft",
  REGULAR_SEASON: "Season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Champion",
};

function fmtWhen(d: Date | null): string | null {
  // Delegates to formatMatchTime — these strings are LocalTime hydration
  // snapshots, so drifting from the client's formatter causes flicker.
  return d ? formatMatchTime(d, "full") : null;
}

// "Copy invite link" shares this page, so its link preview carries the
// season, its phase and what a visitor can do now.
export function generateMetadata() {
  return homeMetadata();
}

export default async function Home() {
  const user = await getSessionUser();
  const snapshot = await getSeasonSnapshot(user?.id);

  if (!snapshot) {
    const [latestSeason, defending] = await Promise.all([
      prisma.season.findFirst({
        where: { isActive: false },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, status: true },
      }),
      getDefendingChampion(null),
    ]);
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Hero
          phase={null}
          title="League offseason"
          subtitle={
            latestSeason
              ? latestSeason.status === "COMPLETE"
                ? `${latestSeason.name} has wrapped up. Browse the completed season or play an inhouse while the next league is organized.`
                : `${latestSeason.name} was archived before completion during the ${PHASE_STEP[latestSeason.status] ?? HISTORY_PHASE_LABEL[latestSeason.status] ?? latestSeason.status} phase. Browse its saved state or play an inhouse while administrators organize what comes next.`
              : "There isn't an active season yet. Explore how the league works or play an inhouse while the first season is organized."
          }
          pitch={
            user ? undefined : (
              <LeaguePitch matchNight={announcedMatchNight(null, [])} />
            )
          }
        />
        {defending ? (
          <DefendingChampionLine
            champion={defending}
            className="mt-4 justify-center"
          />
        ) : null}
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/inhouse" className={buttonClasses("accent")}>
            Play an inhouse <LinkArrow />
          </Link>
          {latestSeason ? (
            <Link
              href={`/seasons/${latestSeason.id}`}
              className={buttonClasses("secondary")}
            >
              Review {latestSeason.name} <LinkArrow />
            </Link>
          ) : (
            <Link href="/how-it-works" className={buttonClasses("secondary")}>
              How it works
            </Link>
          )}
          <DiscordButton />
          {user?.role === "ADMIN" ? (
            <Link href="/admin" className={buttonClasses("secondary")}>
              Create a season
            </Link>
          ) : null}
        </div>
        {/* News has no season, and between seasons is when the next one gets
            announced: the pinned strip and the latest posts show here too. */}
        <Suspense fallback={null}>
          <PinnedNotices className="mt-5" />
        </Suspense>
        {/* Inhouse is the only live play surface during the offseason. Keep its
            actual queue/lobby state visible here too, rather than replacing a
            useful "4/10 queued" signal with a generic hero button. */}
        <Suspense
          fallback={
            <div className="mt-5 skeleton h-12 rounded-[var(--radius)]" />
          }
        >
          <div className="mt-5">
            <InhouseStrip />
          </div>
        </Suspense>
        <Suspense fallback={null}>
          <LeagueNews className="mt-6" />
        </Suspense>
      </div>
    );
  }

  const { season } = snapshot;
  const draftPresentation = draftPhasePresentation(snapshot.draftStatus);
  const signedOutSignups = !user && season.status === "SIGNUPS";

  // Primary call-to-action, surfaced right in the hero during signups.
  const isActiveReg = snapshot.myReg?.status === "ACTIVE";
  const isRemovedReg = snapshot.myReg?.status === REGISTRATION_STATUS.REMOVED;
  // A rostered player already has a team, whatever their registration row
  // says; asking them to register as a standin would also push their
  // check-in panel out of the hero.
  const isRostered =
    !!user &&
    snapshot.teams.some((team) =>
      team.members.some((member) => member.userId === user.id),
    );
  const standinRegistrationOpen =
    (season.status === "DRAFT" ||
      season.status === "REGULAR_SEASON" ||
      season.status === "PLAYOFFS") &&
    !isActiveReg &&
    !isRemovedReg &&
    !isRostered;
  // Signed in without a team: the standin signup is on /me.
  const standinRegistration = (variant: "primary" | "secondary") => (
    <Link href="/me" className={buttonClasses(variant, "lg")}>
      Register as a standin <LinkArrow />
    </Link>
  );
  // Signed out from the draft on, the button just signs in and comes back
  // here: it used to read "Sign in to stand in", which told rostered players
  // opening a Discord link signed out to sign up as standins. Newcomers get
  // the standin route as a line under it. Both go straight to Steam, so the
  // sign-in note rides along (/login would otherwise have shown it).
  const signInButton = (variant: "primary" | "secondary") => (
    <SteamSignInButton next="/" variant={variant}>
      Sign in with Steam <LinkArrow />
    </SteamSignInButton>
  );
  const newcomerStandinLine = (
    <p className="w-full text-sm text-muted">
      New here?{" "}
      <SteamSignInLink next="/me">Sign in to join as a standin</SteamSignInLink>
    </p>
  );
  const steamNote = user ? null : <SteamSignInNote />;
  let heroAction: ReactNode = null;
  // Draft night during Signups: from shortly before the scheduled time until
  // the admin presses Start, the hero points everyone at the draft room (a
  // waiting room that goes live by itself) instead of How it works.
  const draftRoomSoon = draftNightSoon(
    season.status,
    season.draftAt?.getTime(),
    // One time snapshot for this render.
    // eslint-disable-next-line react-hooks/purity
    Date.now(),
  );
  // A designated captain, before the auction: they get one line of their own
  // (see CaptainLine) wherever the hero stands for the draft.
  const captaining =
    !!user && snapshot.teams.some((team) => team.captainId === user.id);
  // The draft-night confirmation a signed-up player still owes, if any. It is
  // asked in the hero's panel (SignupsAside), so it follows that panel's
  // window: on draft night the panel gives way to the draft room and /me keeps
  // the button.
  const owedConfirmation =
    season.status === "SIGNUPS" && !draftRoomSoon
      ? owedDraftConfirmation({
          seasonStatus: season.status,
          draftStatus: snapshot.draftStatus,
          draftAt: season.draftAt,
          draftRevision: season.draftRevision,
          registration: snapshot.myReg,
        })
      : null;
  if (season.status === "SIGNUPS") {
    // How it works rides along during signups: the draft, match nights and
    // who can join, on one screen, for visitors deciding whether to sign up.
    // On draft night the draft room takes its place.
    const sideLink = draftRoomSoon ? (
      <Link href="/draft" className={buttonClasses("accent", "lg")}>
        Enter the draft room <LinkArrow />
      </Link>
    ) : (
      <Link href="/how-it-works" className={buttonClasses("secondary", "lg")}>
        How it works
      </Link>
    );
    heroAction = !user ? (
      <>
        {/* next=/me: signing in "to join" should land on the signup form. */}
        <SteamSignInButton next="/me">
          Sign in with Steam to join <LinkArrow />
        </SteamSignInButton>
        {sideLink}
        {steamNote}
      </>
    ) : isRemovedReg ? (
      <>
        <Link href="/me" className={buttonClasses("secondary", "lg")}>
          Signup removed — see details
        </Link>
        {sideLink}
      </>
    ) : !isActiveReg ? (
      <>
        <Link href="/me" className={buttonClasses("primary", "lg")}>
          Join the season <LinkArrow />
        </Link>
        {sideLink}
      </>
    ) : captaining ? (
      <>
        {sideLink}
        <CaptainLine />
      </>
    ) : (
      sideLink
    );
  } else if (season.status === "DRAFT") {
    // The viewer's own team, once they are on one: a player is rostered when
    // they are bought, a captain's roster is worth a line once it is final.
    const draftDone = snapshot.draftStatus === DRAFT_STATUS.COMPLETE;
    const myDraftTeam = user
      ? snapshot.teams.find((team) =>
          team.members.some((member) => member.userId === user.id),
        )
      : undefined;
    const teamLine =
      user && myDraftTeam && (myDraftTeam.captainId !== user.id || draftDone) ? (
        <YourTeamLine
          team={myDraftTeam}
          viewerId={user.id}
          teamSize={season.teamSize}
          captainContact={await captainContact(
            user,
            myDraftTeam.captainId,
            isActiveReg,
          )}
          fixturesSoon={draftDone}
        />
      ) : null;
    heroAction = (
      <>
        <Link href="/draft" className={buttonClasses("accent", "lg")}>
          {draftPresentation.action}
        </Link>
        {/* Before Start only: once the auction runs, the room is the
            captain's whole job and the pool is inside it. Nothing else on
            this view prints the draft time, so the line carries it. */}
        {captaining && draftSetupOpen(season.status, snapshot.draftStatus) ? (
          <CaptainLine draftAt={season.draftAt} />
        ) : null}
        {teamLine}
        {standinRegistrationOpen ? (
          user ? (
            standinRegistration("secondary")
          ) : (
            <>
              {signInButton("secondary")}
              {newcomerStandinLine}
              {steamNote}
            </>
          )
        ) : null}
      </>
    );
  } else if (standinRegistrationOpen) {
    // Someone without a team mid-season can still play tonight: the inhouse
    // queue has no season gate, and it was otherwise the last thing on the
    // page, below the news.
    const inhouse = (
      <Link href="/inhouse" className={buttonClasses("secondary", "lg")}>
        Play an inhouse <LinkArrow />
      </Link>
    );
    heroAction = !user ? (
      <>
        {signInButton("primary")}
        {inhouse}
        {newcomerStandinLine}
        {steamNote}
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
        {standinRegistration("primary")}
        {inhouse}
      </>
    );
  }

  // Past the draft, every view (and the hero itself) reads the season's
  // matches — fetch once here and hand them down.
  const showsMatches =
    season.status === "REGULAR_SEASON" ||
    season.status === "PLAYOFFS" ||
    season.status === "COMPLETE";
  const [matches, gamesOnRecord] = showsMatches
    ? await Promise.all([
        // Request-cached: the link preview reads it for the champion.
        getSeasonMatches(season.id),
        prisma.game.count({ where: { match: { seasonId: season.id } } }),
      ])
    : [[] as Match[], 0];
  const championPresentation = resolveChampionPresentation(season, matches);
  // Until this season crowns someone, Home keeps naming the last champion.
  // Signups and the draft only: from the regular season on, the dashboard is
  // about this season's race.
  const defending =
    season.status === "SIGNUPS" || season.status === "DRAFT"
      ? await getDefendingChampion(season.createdAt)
      : null;

  // Stable phase facts: league counts should be readable from the first paint.
  let heroMeta: ReactNode = null;
  if (season.status === "SIGNUPS") {
    const { playerCount, capacity } = snapshot;
    heroMeta = (
      <>
        <HeroStat
          value={playerCount}
          label={playerCount === 1 ? "player signed up" : "players signed up"}
        />
        {/* Both states carry an ASK, because signups never close on a count —
            minTeams is a floor (see capacity.ts). Past it the badge alone was
            the whole story, and "Player minimum met" answers only whether the
            pool floor is covered; it says nothing to the person still deciding
            whether to be in it. The ask keeps the same HeroStat shape as the
            under-minimum one so the marquee reads identically either side of
            the threshold — only what it's counting toward changes. Which team
            number it would be is left to the card below; up here it just has to
            be true forever, and "another team" can't go stale. */}
        {capacity.canDraft ? (
          <>
            <Badge tone="success">Player minimum met</Badge>
            <HeroStat
              value={capacity.toNextTeam}
              label="more for another team"
              tone="accent"
            />
          </>
        ) : (
          <HeroStat
            value={capacity.needed}
            label="more to reach the player minimum"
            tone="accent"
          />
        )}
        {season.draftAt && !owedConfirmation ? (
          // The page's one printing of the draft date: the signup card below
          // used to repeat it with a second countdown. A player who still
          // owes the draft-night confirmation reads it in the hero's panel
          // instead, printed beside the button that confirms it.
          <span className="text-sm text-muted">
            <span aria-hidden>🗓️</span> Draft{" "}
            <strong className="font-medium text-fg">
              <LocalTime
                ts={season.draftAt.getTime()}
                variant="short"
                initial={formatMatchTime(season.draftAt, "short")}
              />
            </strong>
            {/* passedLabel, because this chip owns the date it prints. Without
                it a slipped draft night read as a plan, since the countdown
                goes quiet 3h past. The season being in SIGNUPS is what makes
                the state reachable at all: the phase does not advance itself. */}
            <Countdown
              targetMs={season.draftAt.getTime()}
              eventLabel="Draft"
              passedLabel={DRAFT_PASSED_LABEL}
            />
          </span>
        ) : null}
      </>
    );
  } else if (season.status === "DRAFT") {
    heroMeta = (
      <HeroStat
        value={snapshot.teams.length}
        label={
          snapshot.teams.length === 1
            ? draftPresentation.teamLabelSingular
            : draftPresentation.teamLabel
        }
      />
    );
  } else if (season.status === "REGULAR_SEASON") {
    // This async server page takes one time snapshot for its progress labels.
    // eslint-disable-next-line react-hooks/purity
    const progressNow = Date.now();
    heroMeta = (
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
    heroMeta = (
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
  } else if (season.status === "COMPLETE") {
    // The champion card directly below is the page's one champion block (it
    // also carries the final's score and the "needs review" state), so the
    // hero names no team. Its button is the page's one way to the season's
    // page, where the recap lives; /recap redirects there too.
    heroAction = (
      <Link
        href={`/seasons/${season.id}`}
        className={buttonClasses("accent", "lg")}
      >
        Relive the season <LinkArrow />
      </Link>
    );
  }

  // The hero's control slot. Active participants get their next-match check-in;
  // newcomers get the late standin-registration CTA assembled above. Everything
  // else falls through to the phase's own CTA buttons.
  // During SIGNUPS the same reasoning applies to a player who has ALREADY
  // signed up: heroAction falls through to How it works (once the feature
  // tour, "See what you're joining"), so the biggest slot on the page greeted
  // 30 registered players with a pitch for what they had already joined.
  // What they uniquely can do is fill the rest of the league — and the ask
  // this page makes twice ("5 more for another team") had no control behind
  // it anywhere on the site.
  const heroAside =
    showsMatches && user && !heroAction ? (
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
          championTeamId={championPresentation.championTeamId}
          standin={
            isActiveReg &&
            snapshot.myReg?.type === REGISTRATION_TYPE.STANDIN
          }
        />
      </Suspense>
    ) : season.status === "SIGNUPS" && isActiveReg && !draftRoomSoon ? (
      // On draft night the aside gives way, so the hero's action column can
      // carry "Enter the draft room" to the players about to be drafted.
      <SignupsAside
        snapshot={snapshot}
        owed={owedConfirmation}
        captaining={captaining}
      />
    ) : null;

  // The admin's own line under the hero (AdminStrip); players never see it.
  const isAdmin = user?.role === "ADMIN";

  const hero = (
    <Hero
      phase={season.status}
      phaseLabel={seasonPhaseLabel(season.status, snapshot.draftStatus)}
      active={season.status === "DRAFT" ? draftPresentation.live : undefined}
      title={season.name}
      subtitle={
        signedOutSignups
          ? ""
          : phaseSubtitle(season.status, {
              canDraft: snapshot.capacity.canDraft,
              signedUp: isActiveReg,
              draftStatus: snapshot.draftStatus,
              hasChampion: championPresentation.championTeamId != null,
            })
      }
      pitch={
        signedOutSignups ? (
          // It takes the phase sentence's place: the badge, the counts and
          // the Steam button already say signups are open and what is
          // missing, and a newcomer first needs to know what this is.
          <LeaguePitch matchNight={announcedMatchNight(season, [])} />
        ) : undefined
      }
      action={heroAction}
      meta={heroMeta}
      aside={heroAside}
      rail={<SeasonTimeline phase={season.status} />}
    />
  );

  return (
    <div className="space-y-8">
      {defending || isAdmin ? (
        <div className="space-y-3">
          {hero}
          {defending ? <DefendingChampionLine champion={defending} /> : null}
          {isAdmin ? (
            <Suspense
              fallback={
                <div className="skeleton h-12 rounded-[var(--radius)]" />
              }
            >
              <AdminStrip snapshot={snapshot} />
            </Suspense>
          ) : null}
        </div>
      ) : (
        hero
      )}
      {/* Signed up but unreachable — the one cohort every Discord notification
          in the app silently skips. Renders nothing for everyone else, and runs
          through every phase that still has games on purpose: a player who
          signs up during SIGNUPS and links nothing is still unreachable in
          week 4. Once the season is complete nobody needs to reach them for
          it ("your captain has no way to reach you" was false by then), and
          signing up for the next season asks again. */}
      {user && season.status !== "COMPLETE" ? (
        <Suspense fallback={null}>
          <DiscordSetupPrompt userId={user.id} seasonId={season.id} />
        </Suspense>
      ) : null}
      {/* Below the hero everything streams: the shell (hero + timeline) paints
          immediately while each section resolves its own queries behind a
          Suspense boundary, instead of the whole page blocking on the slowest.
          Sections that can render NOTHING (no news, no upcoming match, no games
          yet) use fallback={null} so an empty state never flashes a phantom
          skeleton that then collapses — only guaranteed-content sections show a
          placeholder. */}
      <Suspense fallback={null}>
        <PinnedNotices />
      </Suspense>
      {season.status === "SIGNUPS" && (
        <SignupsView snapshot={snapshot} loggedIn={!!user} />
      )}
      {season.status === "DRAFT" && <DraftPhaseView snapshot={snapshot} />}
      {(season.status === "REGULAR_SEASON" || season.status === "PLAYOFFS") && (
        <>
          {/* MyNextMatch is NOT rendered here any more — it lives in the hero's
              control slot, which is the whole point: the RSVP a captain depends
              on used to be the lowest-contrast strip on the page. */}
          <Suspense fallback={<SeasonViewSkeleton />}>
            <SeasonView
              snapshot={snapshot}
              userId={user?.id}
              matches={matches}
              gamesOnRecord={gamesOnRecord}
              championTeamId={championPresentation.championTeamId}
              showCheckins={canViewAvailabilitySummary(
                user,
                hasActiveLeagueParticipation(
                  snapshot.myReg?.status === REGISTRATION_STATUS.ACTIVE,
                  !!user &&
                    snapshot.teams.some(
                      (team) =>
                        team.captain.id === user.id ||
                        team.members.some(
                          (member) => member.user.id === user.id,
                        ),
                    ),
                ),
              )}
            />
          </Suspense>
        </>
      )}
      {season.status === "COMPLETE" && (
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <CompleteView
            snapshot={snapshot}
            matches={matches}
            championPresentation={championPresentation}
          />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <LeagueNews />
      </Suspense>
      <Suspense
        fallback={<div className="skeleton h-12 rounded-[var(--radius)]" />}
      >
        <InhouseStrip />
      </Suspense>
    </div>
  );
}

// Fallback for the mid-season dashboard. It MUST mirror the real bands — This
// week, then the full-width standings (in the playoffs, the bracket), the
// team / Coming up / Recent results band, then the side games — or the page
// paints one layout and then visibly rearranges into another.
function SeasonViewSkeleton() {
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

// Admin announcements, in two parts: the pinned posts ride the strip under
// the hero, and the League news card lists the latest of the rest, so a pinned
// post is never shown twice. Each part is capped at three; /news has them all.
// News has no season, so the offseason view renders both too.
const loadHomeNews = cache(async () => {
  const newest = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const [pinned, latest] = await Promise.all([
    prisma.newsPost.findMany({
      where: { pinned: true },
      orderBy: newest,
      take: 3,
      select: { id: true, title: true },
    }),
    prisma.newsPost.findMany({
      where: { pinned: false },
      orderBy: newest,
      take: 3,
    }),
  ]);
  return { pinned, latest };
});

async function PinnedNotices({ className }: { className?: string }) {
  const { pinned: posts } = await loadHomeNews();
  if (!posts.length) return null;
  return (
    <aside
      aria-label="Pinned announcements"
      className={cn(
        "rounded-lg border border-accent/30 bg-accent/5 px-4 py-2 text-sm",
        className,
      )}
    >
      {posts.map((post) => (
        <Link
          key={post.id}
          href={`/news?${new URLSearchParams({ post: post.id })}`}
          className="block py-2 text-fg hover:text-info"
        >
          <span aria-hidden="true">📌</span> Pinned notice: {post.title}{" "}
          <LinkArrow />
        </Link>
      ))}
    </aside>
  );
}

async function LeagueNews({ className }: { className?: string }) {
  const { latest: posts } = await loadHomeNews();
  if (posts.length === 0) return null;

  return (
    <Card className={className}>
      <CardHeader
        headingLevel={2}
        title="League news"
        subtitle="The latest from the admins"
        action={
          <Link href="/news" className={textLink("text-sm")}>
            All news <LinkArrow />
          </Link>
        }
      />
      <CardBody className="space-y-4">
        {posts.map((p) => {
          // Render the GIF below the clamped text, not inside it — a block embed
          // inside a -webkit-line-clamp box breaks the clamp. Capped shorter than
          // /news so three previews stay tidy.
          const media = firstMedia(p.body);
          return (
            <div key={p.id} className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="min-w-0 truncate text-sm font-semibold">
                  <Link
                    href={`/news?${new URLSearchParams({ post: p.id })}#${p.id}`}
                    className="hover:text-info"
                  >
                    {p.title}
                  </Link>
                </h3>
                <span className="text-xs text-muted">
                  <LocalTime
                    ts={p.createdAt.getTime()}
                    variant="short"
                    initial={formatMatchTime(p.createdAt, "short")}
                  />
                </span>
              </div>
              <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted">
                <LinkifiedText text={p.body} images="hide" />
              </p>
              {media && (
                <NewsMedia
                  src={media.value}
                  kind={media.kind}
                  label={`Media attached to “${p.title}”`}
                  className="mt-2 block max-h-40 max-w-full rounded-lg border border-line"
                />
              )}
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

// The signed-in league member's panel in the hero mid-season: their next
// unplayed match with one-click check-in, the thing a rostered player most
// wants from the home page, and otherwise what is actually true for them.
async function MyNextMatch({
  seasonId,
  seasonStatus,
  viewer,
  viewerHasActiveRegistration,
  teamSize,
  matches,
  teams,
  championTeamId,
  standin,
}: {
  seasonId: string;
  seasonStatus: string;
  viewer: NonNullable<VisibilityViewer>;
  viewerHasActiveRegistration: boolean;
  teamSize: number;
  /** The season's matches, as Home already read them. */
  matches: Match[];
  teams: SeasonSnapshot["teams"];
  /** The confirmed champion (`resolveChampionPresentation`), if any. */
  championTeamId: string | null;
  /** The viewer has an ACTIVE standin registration. */
  standin: boolean;
}) {
  const userId = viewer.id;
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const rosterTeams = teams.filter((t) =>
    t.members.some((m) => m.userId === userId),
  );
  // Assigned standins are participants too: without their bookings they'd
  // get no check-in prompt anywhere but the match page itself. The covered
  // player's bookings say when someone else has their seat.
  const bookings = await prisma.standinAssignment.findMany({
    where: {
      match: { seasonId },
      OR: [{ standinUserId: userId }, { replacingUserId: userId }],
    },
    select: {
      matchId: true,
      teamId: true,
      standinUserId: true,
      replacingUserId: true,
      standin: { select: { name: true } },
    },
  });
  // Async server component: Date.now is request-time state, not render replay.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const { next, live, covered, idle, teamId } = myMatchPanel({
    userId,
    seasonStatus,
    rosterTeamIds: rosterTeams.map((t) => t.id),
    withdrawnTeamIds: new Set(
      rosterTeams.filter((t) => t.withdrawn).map((t) => t.id),
    ),
    standin,
    championTeamId,
    matches,
    bookings,
    nowMs,
  });
  const playoffRounds = playoffTotalRounds(matches);
  const teamNameOf = (id: string) => teamById.get(id)?.name ?? "?";
  // A team resting this week is told so before the match after it, instead
  // of the panel jumping silently to a fixture a week away.
  const byeWeek =
    teamId && seasonStatus === "REGULAR_SEASON"
      ? teamByeWeek(matches, teamId, nowMs)
      : null;
  const notes = (
    <>
      {byeWeek != null ? <ByeWeekNote week={byeWeek} who="Your team" /> : null}
      {live ? (
        // A series being played is not the check-in (the match page has its
        // own "ready for the next game"), so it is a link, above the prompt.
        <Link
          href={`/matches/${live.match.id}`}
          className="group flex items-center gap-3 rounded-[var(--radius)] border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
        >
          <span
            aria-hidden
            className="animate-live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
          />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="font-medium">Your series is live</span>{" "}
            <span className="text-muted">
              ·{" "}
              {live.teamId === live.match.homeTeamId
                ? `${live.match.homeScore}–${live.match.awayScore}`
                : `${live.match.awayScore}–${live.match.homeScore}`}{" "}
              vs{" "}
              {teamNameOf(
                live.teamId === live.match.homeTeamId
                  ? live.match.awayTeamId
                  : live.match.homeTeamId,
              )}
            </span>
          </span>
          <span className="shrink-0 text-info group-hover:underline">
            Match page <LinkArrow />
          </span>
        </Link>
      ) : null}
      {covered ? (
        <Link
          href={`/matches/${covered.match.id}`}
          className="group flex items-start gap-3 rounded-[var(--radius)] border border-line bg-surface-2/40 px-4 py-3 text-sm"
        >
          <span className="shrink-0 rounded bg-surface-2 px-2 py-0.5 text-xs font-semibold text-muted">
            Covered
          </span>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="font-medium">
              {matchRoundLabel(covered.match, playoffRounds)}:
            </span>{" "}
            <span className="text-muted">
              {covered.booking.standin.name} is standing in for you.
            </span>
          </span>
          <span className="shrink-0 text-info group-hover:underline">
            <LinkArrow />
          </span>
        </Link>
      ) : null}
    </>
  );

  // The hero's control slot must never be an empty 23rem column, so every
  // branch below renders something.
  if (!next && (live || covered)) {
    return <div className="space-y-2">{notes}</div>;
  }
  if (!next && byeWeek != null) {
    return (
      <div className="space-y-2">
        {notes}
        <Link
          href="/schedule#fixtures"
          className={buttonClasses("secondary", "sm", "w-full")}
        >
          See this week&apos;s schedule <LinkArrow />
        </Link>
      </div>
    );
  }
  const myTeam = teamId ? teamById.get(teamId) : undefined;
  if (!next && idle === "no-fixtures" && myTeam) {
    // Rostered, schedule not out yet: who they play for is the useful part.
    return (
      <YourTeamLine
        team={myTeam}
        viewerId={userId}
        teamSize={teamSize}
        captainContact={await captainContact(
          viewer,
          myTeam.captainId,
          viewerHasActiveRegistration,
        )}
        fixturesSoon
      />
    );
  }
  if (!next) {
    const onlyFinalLeft =
      matches.some((m) => m.phase === "FINAL" && m.status !== "COMPLETED") &&
      !matches.some((m) => m.phase === "PLAYOFF" && m.status !== "COMPLETED");
    const copy = idleCopy(idle, onlyFinalLeft);
    return (
      <Card className="p-4 text-sm">
        <div className="font-medium">{copy.title}</div>
        <p className="mt-1 text-muted">{copy.text}</p>
        <Link
          href={copy.href}
          className={buttonClasses("secondary", "sm", "mt-3 w-full")}
        >
          {copy.cta} <LinkArrow />
        </Link>
      </Card>
    );
  }

  const homeTeam = teamById.get(next.homeTeamId);
  const awayTeam = teamById.get(next.awayTeamId);
  const [myRsvp, pendingReschedule, side] = await Promise.all([
    prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: next.id, userId }, scheduleRevision: next.scheduleRevision },
      select: { status: true },
    }),
    prisma.rescheduleRequest.findFirst({
      where: { matchId: next.id, status: "PENDING" },
      include: { proposedBy: { select: { name: true } } },
    }),
    // Who the viewer is in this match and how their side stands. A captain
    // gets the names behind the count right under the buttons, so chasing
    // the no-replies starts here rather than on the match page.
    loadCheckinSide({ matchId: next.id, viewer }),
  ]);

  // A proposal awaiting THIS viewer's answer gets a strip right on the
  // dashboard — proposals used to rot on the match page unseen.
  const awaitingMyAnswer =
    !!pendingReschedule &&
    pendingReschedule.proposedById !== userId &&
    (homeTeam?.captainId === userId || awayTeam?.captainId === userId);

  return (
    <div className="space-y-2">
      {notes}
      <CheckinBanner
        variant="panel"
        eyebrow={`Your next match · ${matchRoundLabel(next, playoffRounds, { bestOf: true })}`}
        matchId={next.id}
        scheduleRevision={next.scheduleRevision}
        heading={`${teamNameOf(next.homeTeamId)} vs ${teamNameOf(next.awayTeamId)}`}
        when={fmtWhen(next.scheduledAt)}
        whenTs={next.scheduledAt?.getTime()}
        myRsvp={myRsvp?.status ?? null}
        viewerIsCaptain={
          homeTeam?.captainId === userId || awayTeam?.captainId === userId
        }
        side={side}
        detailsHref={`/matches/${next.id}`}
      />
      {awaitingMyAnswer ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm">
          <span aria-hidden>⏳</span>
          <span className="min-w-0 flex-1">
            <strong>{pendingReschedule.proposedBy.name}</strong> proposed moving
            this match to{" "}
            <strong>
              <LocalTime
                ts={pendingReschedule.proposedTime.getTime()}
                variant="full"
                initial={formatMatchTime(
                  pendingReschedule.proposedTime,
                  "full",
                )}
              />
            </strong>
          </span>
          <Link
            href={matchAnchorPath(next.id, MATCH_ANCHOR.reschedule)}
            className={textLink("shrink-0")}
          >
            Respond <LinkArrow />
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The captain's Discord handle for their teammate's team line: members only
 * (the league-wide contact rule), and never the viewer's own.
 */
async function captainContact(
  viewer: NonNullable<VisibilityViewer>,
  captainId: string,
  viewerHasActiveRegistration: boolean,
) {
  if (
    viewer.id === captainId ||
    !canViewLeagueContact(viewer, captainId, viewerHasActiveRegistration)
  ) {
    return null;
  }
  return prisma.user.findUnique({
    where: { id: captainId },
    select: { discordName: true, discordId: true },
  });
}

/**
 * The viewer's own team in the hero, from the moment they are drafted until
 * their first fixture exists: home listed every roster but never said "you're
 * on Team 3, your captain is ...". A player gets their captain (with the
 * captain's Discord handle, for members); a captain gets their roster count.
 */
function YourTeamLine({
  team,
  viewerId,
  teamSize,
  captainContact,
  fixturesSoon,
}: {
  team: SeasonSnapshot["teams"][number];
  viewerId: string;
  teamSize: number;
  captainContact: { discordName: string; discordId: string | null } | null;
  /** The auction is over and fixtures are what comes next. */
  fixturesSoon: boolean;
}) {
  const captaining = team.captainId === viewerId;
  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/70 p-4 text-sm backdrop-blur-sm">
      <p className="font-medium [overflow-wrap:anywhere]">
        {captaining ? "Your team: " : "You’re on "}
        <Link href={`/teams/${team.id}`} className={textLink("font-semibold")}>
          {team.name}
        </Link>
      </p>
      {captaining ? (
        <p className="mt-1 text-muted">
          Your roster: {team.members.length}/{teamSize}
          {fixturesSoon ? " · Fixtures coming soon" : ""}
        </p>
      ) : (
        <>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
            <span className="[overflow-wrap:anywhere]">
              Captain{" "}
              <PlayerLink userId={team.captainId} className="text-fg">
                {team.captain.name}
              </PlayerLink>
            </span>
            {captainContact?.discordName ? (
              <DiscordTag
                name={captainContact.discordName}
                verified={!!captainContact.discordId}
              />
            ) : null}
          </p>
          {fixturesSoon ? (
            <p className="mt-1 text-muted">Fixtures coming soon.</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** What the hero's panel says when there is nothing to check in for. */
function idleCopy(
  idle: PanelIdle,
  onlyFinalLeft: boolean,
): { title: string; text: string; href: string; cta: string } {
  const schedule = { href: "/schedule#fixtures", cta: "See the schedule" };
  const bracket = { href: "/schedule#playoff-bracket", cta: "See the bracket" };
  switch (idle) {
    case "no-fixtures":
      return {
        title: "Fixtures are coming soon",
        text: "Your team's schedule hasn't been published yet.",
        ...schedule,
      };
    case "games-played":
      return {
        title: "Your regular season is done",
        text: "Your team has played every regular-season fixture.",
        href: "/schedule#standings",
        cta: "See the standings",
      };
    case "no-upcoming":
      return {
        title: "Nothing to check in for yet",
        text: "Your team's next match has no kickoff time yet, or its result is still coming in.",
        ...schedule,
      };
    case "bracket-pending":
      return {
        title: "The playoff bracket is on its way",
        text: "Playoff fixtures show here once the bracket is drawn.",
        href: "/schedule#playoff-bracket",
        cta: "See the playoff schedule",
      };
    case "through":
      return {
        title: "You're through",
        text: "Your next round is drawn once the other series finish.",
        ...bracket,
      };
    case "champion":
      return {
        title: "Champions",
        text: "Your team won the final.",
        ...bracket,
      };
    case "final-review":
      return {
        title: "The final is under review",
        text: "Your team played the final. The champion is named once the league confirms the result.",
        ...bracket,
      };
    case "season-over":
      return {
        title: "Your season is over",
        text: "Thanks for playing. The playoffs go on without you.",
        href: "/schedule#playoff-bracket",
        cta: onlyFinalLeft ? "Follow the final" : "Follow the playoffs",
      };
    case "withdrawn":
      return {
        title: "Your team has withdrawn",
        text: "Its remaining fixtures were forfeited. The rest of the league is still worth watching.",
        ...schedule,
      };
    case "standin-list":
      return {
        title: "You're on the standin list",
        text: "No booking yet. Captains book standins from a match page when they need cover.",
        href: "/schedule#fixtures",
        cta: "See this week's schedule",
      };
    default:
      return {
        title: "No match of your own coming up",
        text: "You're not on a team this season. The week's games are still worth watching.",
        href: "/schedule#fixtures",
        cta: "See this week's schedule",
      };
  }
}

// ---------- Hero ----------

// A single animated hero figure — big count-up number + a muted label, with
// an optional word before the number ("Week 3 of 7").
function HeroStat({
  value,
  label,
  tone,
  prefix,
}: {
  value: number;
  label: string;
  tone?: "accent";
  prefix?: string;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      {prefix ? <span className="text-sm text-muted">{prefix}</span> : null}
      <span
        className={cn(
          "font-display text-2xl font-bold tabular-nums sm:text-3xl",
          tone === "accent" ? "text-accent" : "text-fg",
        )}
      >
        {value}
      </span>
      <span className="text-sm text-muted">{label}</span>
    </span>
  );
}

/**
 * The hero is a two-column marquee: the season's identity on the left, and ONE
 * control slot on the right holding whatever this viewer, in this phase, is
 * actually meant to do — the signup CTA, the draft-room door, or (mid-season,
 * where there used to be no call to action at all) their own match check-in.
 *
 * Three things it deliberately keeps from the old centred version: every
 * ambient layer, the phase Badge's exact text node, and the season name as the
 * page's only <h1>. What it drops is 60px of vertical padding and the
 * centre-alignment, which is what made ~250px of prime space carry no action.
 *
 * `aside` is optional — phases without a viewer action let the identity column
 * take the full width. Anything passed as `aside` MUST render something; that
 * is why MyNextMatch has a no-match branch.
 */
function Hero({
  phase,
  phaseLabel,
  active,
  title,
  subtitle,
  pitch,
  action,
  meta,
  aside,
  rail,
}: {
  phase: string | null;
  phaseLabel?: string;
  active?: boolean;
  title: string;
  /** The phase in one sentence; "" renders nothing. */
  subtitle: string;
  /** What the league is, for a signed-out visitor (see LeaguePitch). */
  pitch?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  rail?: ReactNode;
}) {
  const live = active ?? (!!phase && phase !== "COMPLETE");
  const leagueDashboard = phase === "REGULAR_SEASON";
  const control =
    aside ?? (action ? <HeroActions>{action}</HeroActions> : null);
  return (
    <section className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/70 to-surface/40">
      {/* Looping background video — fades in/out at the loop seam to hide the jump. */}
      <HeroVideo />
      {/* Themed tint over the video for contrast + palette cohesion. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-surface/40 via-bg/45 to-surface/75"
      />
      {/* Layered ambient background: masked grid + dual neon glows. Cropping
          them into a shorter box makes them read MORE, not less. */}
      <div
        aria-hidden
        className="hero-grid pointer-events-none absolute inset-0 opacity-20"
      />
      <div
        aria-hidden
        className="animate-hero-glow pointer-events-none absolute left-1/3 top-0 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/25 blur-3xl"
      />
      <div
        aria-hidden
        className="animate-hero-glow-alt pointer-events-none absolute -right-12 bottom-0 h-48 w-48 translate-y-1/3 rounded-full bg-accent/20 blur-3xl"
      />
      <div
        className={cn(
          "relative grid gap-6 p-5 sm:p-8",
          leagueDashboard
            ? "grid-cols-1 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-x-12"
            : control
              ? "lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-center lg:gap-10"
              : "text-center",
        )}
      >
        <div
          className={cn(
            "min-w-0",
            control || leagueDashboard ? "" : "mx-auto max-w-2xl",
          )}
        >
          <div
            className={cn(
              "flex flex-wrap items-center gap-2",
              control || leagueDashboard ? "" : "justify-center",
            )}
          >
            {phase ? (
              <Badge tone={seasonPhaseTone(phase)}>
                {live ? (
                  <span
                    aria-hidden
                    className="animate-live-pulse mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-current"
                  />
                ) : null}
                {phaseLabel ?? seasonPhaseLabel(phase)}
              </Badge>
            ) : null}
            {/* Persistent league fact: the Dota region every game is played on.
                It rode its own centred row before, costing a whole line for a
                value that never changes. */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs font-medium text-muted">
              <span aria-hidden>🌐</span>
              Game servers:{" "}
              <span className="font-semibold text-fg">
                {GAME_SERVER_REGION}
              </span>
            </span>
          </div>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            {title}
          </h1>
          {!leagueDashboard && subtitle ? (
            <p className="mt-2 max-w-xl text-muted sm:text-lg">{subtitle}</p>
          ) : null}
          {!leagueDashboard ? pitch : null}
          {leagueDashboard && action ? (
            <div className="mt-5 flex flex-wrap gap-2 [&>a]:min-h-11 [&>a]:px-4 [&>a]:py-2 [&>a]:text-sm">
              {action}
            </div>
          ) : null}
          {meta && !leagueDashboard ? (
            <div
              className={cn(
                "mt-5 flex flex-wrap items-center gap-x-6 gap-y-2",
                control ? "" : "justify-center",
              )}
            >
              {meta}
            </div>
          ) : null}
        </div>
        {leagueDashboard ? (
          <div className="min-w-0">{meta}</div>
        ) : control ? (
          <div className="min-w-0">{control}</div>
        ) : null}
        {leagueDashboard && aside ? (
          <div className="min-w-0 lg:col-span-2">{aside}</div>
        ) : null}
      </div>
      {/* The season stepper used to be its own full-width band restating the
          phase badge two rows above it. As the hero's footer rail it costs no
          extra band and reads as part of the same object. */}
      {rail ? (
        <div className="relative border-t border-line/70 bg-bg/30 px-4 py-3 sm:px-8">
          {rail}
        </div>
      ) : null}
    </section>
  );
}

/** CTA buttons in the control slot: full-width and stacked, so a two-button
 *  phase reads as a primary + a secondary rather than two equal halves. */
function HeroActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 [&>a]:w-full [&>a]:justify-center">
      {children}
    </div>
  );
}

// A slim stepper showing where the season is in its lifecycle. Real list
// semantics: a screen reader hears "Season progress, list, 5 items" and the
// active phase is announced via aria-current — the ticks/digits/connectors
// are purely visual (aria-hidden) with sr-only state text on each label.
function SeasonTimeline({ phase }: { phase: string }) {
  const current = PHASE_ORDER.findIndex((p) => p === phase);
  const next = current >= 0 ? PHASE_ORDER[current + 1] : undefined;
  return (
    // No frame of its own: it renders inside the hero's footer rail, which owns
    // the border and the background.
    <div>
      {/* Phones show the current step only: five steps across 390px pushed
          the page down for what the phase badge already says. The full list
          stays for screen readers, so this line is hidden from them. */}
      {current >= 0 ? (
        <p
          aria-hidden
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:hidden"
        >
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent bg-accent/15 text-[11px] font-semibold text-accent">
            {current + 1}
          </span>
          <span className="font-medium text-fg">{PHASE_STEP[phase]}</span>
          <span className="text-muted">
            Step {current + 1} of {PHASE_ORDER.length}
            {next ? ` · Next: ${PHASE_STEP[next]}` : ""}
          </span>
        </p>
      ) : null}
      <ol
        aria-label="Season progress"
        className={cn("flex items-start", current >= 0 && "max-sm:sr-only")}
      >
        {PHASE_ORDER.map((p, i) => {
          const done = current >= 0 && i < current;
          const isCurrent = i === current;
          return (
            <li
              key={p}
              aria-current={isCurrent ? "step" : undefined}
              className="flex flex-1 flex-col items-center gap-1.5"
            >
              <div aria-hidden className="flex w-full items-center">
                <div
                  className={cn(
                    "h-0.5 flex-1 rounded",
                    i === 0
                      ? "opacity-0"
                      : current >= 0 && i <= current
                        ? "bg-success/50"
                        : "bg-line",
                  )}
                />
                <div
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold",
                    isCurrent
                      ? "border-accent bg-accent/15 text-accent"
                      : done
                        ? "border-success/50 bg-success/10 text-success"
                        : "border-line bg-surface-2 text-muted",
                  )}
                >
                  {done ? "✓" : i + 1}
                </div>
                <div
                  className={cn(
                    "h-0.5 flex-1 rounded",
                    i === PHASE_ORDER.length - 1
                      ? "opacity-0"
                      : current >= 0 && i < current
                        ? "bg-success/50"
                        : "bg-line",
                  )}
                />
              </div>
              <span
                className={cn(
                  "text-center text-[11px] leading-tight",
                  isCurrent ? "font-medium text-fg" : "text-muted",
                )}
              >
                {PHASE_STEP[p]}
                {done ? (
                  <span className="sr-only"> (done)</span>
                ) : isCurrent ? (
                  <span className="sr-only"> (current)</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * For admins only, one line under the hero: the admin panel's next step and
 * how many open matches its Needs attention card lists, linking the panel.
 * Home otherwise showed Tim exactly what a visitor sees on match night.
 * Database reads only (request-cached matches plus one query for the open
 * matches' check-ins, covers and reschedules), never a Discord call.
 */
async function AdminStrip({ snapshot }: { snapshot: SeasonSnapshot }) {
  const { season } = snapshot;
  const [matches, open] = await Promise.all([
    getSeasonMatches(season.id),
    prisma.match.findMany({
      where: { seasonId: season.id, status: { not: MATCH_STATUS.COMPLETED } },
      select: {
        id: true,
        status: true,
        homeTeamId: true,
        awayTeamId: true,
        scheduledAt: true,
        scheduleRevision: true,
        availability: {
          select: { userId: true, status: true, scheduleRevision: true },
        },
        standins: { select: { replacingUserId: true, standinUserId: true } },
        reschedules: { select: { status: true } },
      },
    }),
  ]);
  // A server component renders once per request; the line is a snapshot.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  // Check-ins count for the fixture's current time only, and cover is counted
  // against the current rosters, both as on the panel.
  const attention = matchAttention(
    open.map((match) => ({
      ...match,
      availability: match.availability.filter(
        (rsvp) => rsvp.scheduleRevision === match.scheduleRevision,
      ),
    })),
    snapshot.teams,
    nowMs,
  );
  const { step, attention: attentionLine } = adminHomeLine({
    seasonStatus: season.status,
    draftStatus: snapshot.draftStatus,
    playerCount: snapshot.playerCount,
    minPlayers: snapshot.capacity.minPlayers,
    teams: snapshot.teams,
    matches,
    hasChampion:
      resolveChampionPresentation(season, matches).championTeamId != null,
    attentionCount: attention.length,
    nowMs,
  });
  return (
    <Link
      href="/admin"
      className="group flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm transition-colors hover:border-muted/60"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone="info">Admin</Badge>
        <span className="text-fg">{step}</span>
        {attentionLine ? (
          <span className="text-muted">
            <span aria-hidden>· </span>
            {attentionLine}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 font-medium text-accent group-hover:underline">
        Open admin <LinkArrow />
      </span>
    </Link>
  );
}

// The inhouse scene runs year-round but was invisible from the dashboard.
// A slim strip keeps it one click away in every phase. Read-only queries —
// lobby formation/resolution stays lazy on the /inhouse poll.
async function InhouseStrip() {
  const [queued, liveLobby] = await Promise.all([
    // Same presence rule as /inhouse: only recently-seen players count.
    prisma.inhouseQueueEntry.count({
      // eslint-disable-next-line react-hooks/purity -- async server component
      where: { lastSeenAt: { gte: queuePresentCutoff(Date.now()) } },
    }),
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    }),
  ]);

  const label = liveLobby
    ? queued > 0
      ? `An inhouse is live · ${queued} / ${INHOUSE.LOBBY_SIZE} queued next`
      : "An inhouse is live — the next-game queue is open"
    : queued > 0
      ? `${queued} / ${INHOUSE.LOBBY_SIZE} queued for the next inhouse`
      : "The inhouse queue is open";
  const cta = liveLobby
    ? "Watch or queue"
    : queued > 0
      ? "Jump in"
      : "Start the queue";

  return (
    <Link
      href="/inhouse"
      className="group flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm transition-colors hover:border-muted/60"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden>⚔️</span>
        {liveLobby ? (
          <span
            aria-hidden
            className="animate-live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success"
          />
        ) : null}
        {/* Two lines on a phone rather than "The inhouse queue i…": the
            sentence is the strip's whole message. */}
        <span className="line-clamp-2 text-muted">{label}</span>
      </span>
      <span className="shrink-0 font-medium text-accent group-hover:underline">
        {cta} <LinkArrow />
      </span>
    </Link>
  );
}

// ---------- SIGNUPS ----------

/**
 * "Defending champions: Radiant Raccoons (Season 9) →", one line under the
 * hero from the offseason until the next season crowns someone. The link goes
 * to that season's page, where the final and the rosters are.
 */
function DefendingChampionLine({
  champion,
  className,
}: {
  champion: DefendingChampion;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted",
        className,
      )}
    >
      <TeamCrest
        name={champion.teamName}
        seed={champion.teamId}
        logoUrl={champion.logoUrl}
        size={20}
        className="rounded"
      />
      <span>Defending champions:</span>
      <Link
        href={`/seasons/${champion.seasonId}`}
        className={cn(textLink(), "min-w-0 font-medium [overflow-wrap:anywhere]")}
      >
        {champion.teamName} ({champion.seasonName}) <LinkArrow />
      </Link>
    </p>
  );
}

/**
 * The league in one sentence plus who can join and when games are, for a
 * signed-out visitor on Home (signups and the offseason). Nothing else above
 * the fold said what the league is. No step strip: the hero's season
 * timeline already shows the steps.
 */
function LeaguePitch({ matchNight }: { matchNight: string | null }) {
  return (
    <>
      <p className="mt-2 max-w-xl text-muted sm:text-lg">{leaguePitch()}</p>
      <p className="mt-2 max-w-xl text-sm text-muted">
        {leagueEligibilityLine(matchNight)}
      </p>
    </>
  );
}

/**
 * The hero's control slot for a player who has already signed up.
 *
 * MUST always render something — the Hero drops its identity column to full
 * width without an `aside`, so a branch that returns null here would leave a
 * 23rem hole (the rule `MyNextMatch`'s no-match branch exists for).
 *
 * It asks one thing at a time. A player who still owes the draft-night
 * confirmation gets it here as one tap, beside the draft time it confirms:
 * the only other way in was a link a screen further down that opened the top
 * of /me, with the real button far below that. It is the same action and
 * button name as /me, whose button stays; the hero's chip gives up the date
 * for this viewer, so the page still prints it once. Everyone else gets the
 * standing ask, filling the rest of the league, and its control. The numbers
 * behind that ask sit in the hero's own counts and phase line beside this
 * panel, so it states only the ask.
 */
function SignupsAside({
  snapshot,
  owed,
  captaining,
}: {
  snapshot: SeasonSnapshot;
  owed: ReturnType<typeof owedDraftConfirmation>;
  captaining: boolean;
}) {
  const { season } = snapshot;
  const { draftAt } = season;
  const stale = owed === DRAFT_READINESS.STALE;
  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/70 p-4 backdrop-blur-sm sm:p-5">
      {owed && draftAt ? (
        <>
          <p className="font-display text-lg font-semibold">
            {stale ? "The draft time changed" : "You're in"}
          </p>
          <p className="mt-1 text-sm text-muted">
            <span aria-hidden>🗓️</span> Draft night{" "}
            <strong className="font-medium text-fg">
              <LocalTime
                ts={draftAt.getTime()}
                variant="full"
                initial={formatMatchTime(draftAt, "full")}
              />
            </strong>
            <Countdown
              targetMs={draftAt.getTime()}
              eventLabel="Draft"
              passedLabel={DRAFT_PASSED_LABEL}
            />
          </p>
          <p className="mt-1 text-sm text-muted">
            {stale
              ? "Confirm the new time so the admins know you can still make it."
              : "Confirm you’ve seen the time and still plan to play this season."}
          </p>
          <ActionForm
            action={confirmDraftReadiness}
            className="mt-3"
            hidden={{
              expectedActiveSeasonId: season.id,
              draftRevision: String(season.draftRevision),
              draftAtTs: String(draftAt.getTime()),
            }}
          >
            <SubmitButton
              variant={stale ? "accent" : "primary"}
              className="w-full"
            >
              {stale ? "Confirm updated draft time" : "Confirm I’m ready for draft"}
            </SubmitButton>
          </ActionForm>
        </>
      ) : (
        <>
          <p className="font-display text-lg font-semibold">You&apos;re in</p>
          <p className="mt-1 text-sm text-muted">Know anyone who&apos;d fit?</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <InviteLink />
            <Link href="/how-it-works" className={textLink("text-sm")}>
              How it works <LinkArrow />
            </Link>
          </div>
          <p className="mt-2 text-xs text-muted">
            Copies this season&apos;s link — it unfurls with the details in
            Discord.
          </p>
        </>
      )}
      {captaining ? (
        <CaptainLine className="mt-3 border-t border-line-soft pt-3" />
      ) : null}
    </div>
  );
}

/**
 * The one captain-only line on home before the auction: what a captain can do
 * that week is scout the pool. It deliberately carries no budget or
 * nomination slot. Start sets the MMR-weighted budgets from the final captain
 * pool, and the order can be re-randomised until then, so any figure shown
 * earlier is a guess that can still change. Once the auction runs, the draft
 * room shows the real budget, live.
 *
 * `draftAt` only where nothing else on the page prints the draft time; it then
 * owns saying the time has passed, like every surface that prints it.
 */
function CaptainLine({
  draftAt,
  className,
}: {
  draftAt?: Date | null;
  className?: string;
}) {
  return (
    <p className={cn("text-sm text-muted", className)}>
      <span className="font-medium text-fg">You’re captaining</span>
      {draftAt ? (
        <>
          {" · "}Draft{" "}
          <LocalTime
            ts={draftAt.getTime()}
            variant="short"
            initial={formatMatchTime(draftAt, "short")}
          />
          <Countdown
            targetMs={draftAt.getTime()}
            eventLabel="Draft"
            passedLabel={DRAFT_PASSED_LABEL}
          />
        </>
      ) : null}
      {" · "}
      <Link href="/players" className={textLink()}>
        Scout the pool <LinkArrow />
      </Link>
    </p>
  );
}

/**
 * What the draft-night confirmation says about the viewer, as one plain status
 * line. A badge and a link used to say "Confirm draft night" twice here, and
 * the link only opened the top of /me.
 */
function draftReadinessStatus(readiness: DraftReadiness): string {
  switch (readiness) {
    case DRAFT_READINESS.READY:
      return "Draft night confirmed ✓";
    case DRAFT_READINESS.STALE:
      return "Draft time changed — not confirmed yet";
    default:
      return "Draft night not confirmed yet";
  }
}

/**
 * Everything below the hero during signups. The counts, the minimum and the
 * draft date live in the hero ONCE: this view used to restate them in a signup
 * card heading, a progress sentence and four stat tiles (whose figures are
 * /players' own strip), so "37 signed up" printed three times and "3 more for
 * another team" three ways. What is left here is what the hero can't carry:
 * the viewer's own signup, and who is in.
 */
function SignupsView({
  snapshot,
  loggedIn,
}: {
  snapshot: SeasonSnapshot;
  loggedIn: boolean;
}) {
  const { season, capacity, myReg } = snapshot;
  const isActivePlayer = myReg?.status === "ACTIVE" && myReg.type === "PLAYER";
  const isStandin = myReg?.status === "ACTIVE" && myReg.type === "STANDIN";
  const isRemoved = myReg?.status === REGISTRATION_STATUS.REMOVED;
  const myDraftReadiness =
    isActivePlayer &&
    season.draftAt &&
    draftSetupOpen(season.status, snapshot.draftStatus)
      ? draftReadiness(myReg, season.draftRevision)
      : null;

  return (
    <div className="space-y-6">
      {/* Signed out, the hero's pitch already names the match night. */}
      {loggedIn ? <ScheduleCallout label={season.matchSchedule} /> : null}
      {/* The viewer's own signup, as a status line. Joining is the hero's
          button (a second "Sign in with Steam to join" sat a screen below
          it), and a removed signup is the hero's "Signup removed" button. */}
      {isActivePlayer || isStandin ? (
        <Card>
          <CardHeader
            headingLevel={2}
            className="border-b-0"
            title={
              isStandin
                ? "You’re registered as a standin"
                : "You’re signed up to play"
            }
            subtitle={
              <>
                Teams of {season.teamSize}
                {season.maxMmr > 0 ? ` · ${season.maxMmr} MMR soft limit` : ""}
                {myDraftReadiness
                  ? ` · ${draftReadinessStatus(myDraftReadiness)}`
                  : ""}
              </>
            }
            action={
              <Link
                href={
                  myDraftReadiness && myDraftReadiness !== DRAFT_READINESS.READY
                    ? "/me#draft-commitment"
                    : "/me"
                }
                className={buttonClasses("secondary")}
              >
                {isStandin ? "Switch to full player" : "Review your signup"}
              </Link>
            }
          />
        </Card>
      ) : null}
      {/* One Discord CTA in <main> at a time. A signed-up player who hasn't
          linked gets <DiscordSetupPrompt> above, which sequences the SAME
          invite as "1. Join the server" and a link step after it, so this
          row is for everyone that prompt can't cover. */}
      {!isActivePlayer && !isStandin && !isRemoved && DISCORD_INVITE_URL ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm">
          <p className="min-w-[min(14rem,100%)] flex-1 text-muted">
            {loggedIn
              ? "Questions before you join? Ask in the league Discord."
              : "Questions before you sign up? Ask in the league Discord."}
          </p>
          <DiscordButton />
        </div>
      ) : null}

      <Suspense fallback={<CardSkeleton rows={2} />}>
        <WhoIsIn
          seasonId={season.id}
          playerCount={snapshot.playerCount}
          teamsNeeded={Math.max(season.minTeams, capacity.teamsFormable)}
          captains={snapshot.teams.map((team) => team.captain)}
        />
      </Suspense>
    </div>
  );
}

type SignupChipPlayer = {
  userId: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  roles: string;
  mmr: number;
};

/** The latest signups shown beside the captains, however many captains. */
const WHO_IS_IN_LATEST = 12;

/**
 * "Who's in": the captains first (they used to have a card of their own,
 * "Captains so far", repeating half this list), then the latest signups, and
 * one line on the positions the pool is short of. That line replaces a whole
 * card of role and MMR bars whose buckets were mostly empty; /players keeps
 * the scouting detail.
 */
async function WhoIsIn({
  seasonId,
  playerCount,
  teamsNeeded,
  captains,
}: {
  seasonId: string;
  playerCount: number;
  teamsNeeded: number;
  captains: SeasonSnapshot["teams"][number]["captain"][];
}) {
  const captainIds = captains.map((captain) => captain.id);
  const [pool, latest] = await Promise.all([
    prisma.registration.findMany({
      where: { seasonId, status: "ACTIVE", type: "PLAYER" },
      select: { userId: true, roles: true, mmr: true },
    }),
    prisma.registration.findMany({
      where: {
        seasonId,
        status: "ACTIVE",
        type: "PLAYER",
        userId: { notIn: captainIds },
      },
      // Only the fields the chips render — this list serializes into the page.
      select: {
        userId: true,
        roles: true,
        mmr: true,
        user: { select: { name: true, avatar: true, rankTier: true } },
      },
      orderBy: { createdAt: "desc" },
      take: WHO_IS_IN_LATEST,
    }),
  ]);
  const signupOf = new Map(pool.map((reg) => [reg.userId, reg]));
  // A captain is in the pool through their own signup; one without an active
  // player signup isn't "in" as a player, so the chip would be a claim the
  // count beside it doesn't make.
  const captainChips: SignupChipPlayer[] = captains.flatMap((captain) => {
    const reg = signupOf.get(captain.id);
    return reg
      ? [
          {
            userId: captain.id,
            name: captain.name,
            avatar: captain.avatar,
            rankTier: captain.rankTier,
            roles: reg.roles,
            mmr: reg.mmr,
          },
        ]
      : [];
  });
  const latestChips: SignupChipPlayer[] = latest.map((reg) => ({
    userId: reg.userId,
    name: reg.user.name,
    avatar: reg.user.avatar,
    rankTier: reg.user.rankTier,
    roles: reg.roles,
    mmr: reg.mmr,
  }));
  const shown = captainChips.length + latestChips.length;
  const shortage = shortRolesLine(roleCoverage(pool), teamsNeeded, pool.length);

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Who's in"
        /* Names the cap: the list stops at the latest few, so a 30-player
           season silently hid 18 people behind a "View all →" that gave no
           reason to click. */
        subtitle={
          captainChips.length > 0
            ? `Captains first, then the latest signups${shown < playerCount ? ` · ${shown} of ${playerCount} players` : ""}`
            : shown < playerCount
              ? `Latest ${shown} of ${playerCount} players`
              : "Latest players to sign up"
        }
        action={
          <Link href="/players" className={textLink("text-sm")}>
            View all <LinkArrow />
          </Link>
        }
      />
      <CardBody className="space-y-3">
        {shown === 0 ? (
          <EmptyState
            title="No signups yet"
            description="Be the first to join this season."
          />
        ) : (
          <>
            {shortage ? <p className="text-sm text-muted">{shortage}</p> : null}
            {/* Compact on phones: name, captain mark and MMR only, so the
                chips wrap two to a row instead of stacking twelve tall rows
                of medals and bare role digits. */}
            <div className="flex flex-wrap gap-2">
              {captainChips.map((player) => (
                <SignupChip key={player.userId} player={player} captain />
              ))}
              {latestChips.map((player) => (
                <SignupChip key={player.userId} player={player} />
              ))}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SignupChip({
  player,
  captain = false,
}: {
  player: SignupChipPlayer;
  captain?: boolean;
}) {
  return (
    <PlayerLink
      userId={player.userId}
      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2/50 py-1 pl-1 pr-2.5 hover:border-muted/60 hover:no-underline sm:gap-2 sm:pr-3"
    >
      <Avatar name={player.name} src={player.avatar} size={22} />
      <span className="min-w-0 truncate text-sm">{player.name}</span>
      {captain ? (
        <span
          title="Captain"
          className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-accent/40 bg-accent/15 px-1 text-[11px] font-semibold text-accent"
        >
          <span aria-hidden>C</span>
          <span className="sr-only">captain</span>
        </span>
      ) : null}
      <RankBadge rankTier={player.rankTier} className="hidden sm:inline-flex" />
      <RoleBadges roles={player.roles} className="hidden sm:inline-flex" />
      {player.mmr > 0 ? (
        <span className="shrink-0 text-xs text-muted">{player.mmr} MMR</span>
      ) : null}
    </PlayerLink>
  );
}

// ---------- DRAFT ----------

/**
 * Everything below the hero in the Draft phase: while the auction runs, one
 * line pointing at the draft room, then every roster as one compact table.
 *
 * Home used to show the lot on the block, the pool count and the latest
 * sales, read once when the page loaded. The auction moves every few seconds
 * and this page never refreshes, so the lot was stale almost at once; the
 * draft room is the live view. The rosters were six tall cards of "Empty
 * slot" rows (about 390px each on a phone), with the $0 captain listed last.
 */
function DraftPhaseView({ snapshot }: { snapshot: SeasonSnapshot }) {
  const { teams, season, draftStatus } = snapshot;
  // Budgets are real only once the auction starts: Start replaces every
  // team's placeholder with its MMR-weighted budget from the final captain
  // pool. Before that every team showed the same flat figure, one no captain
  // would actually get.
  const budgetsSet = !draftSetupOpen(season.status, draftStatus);
  const running =
    draftStatus === DRAFT_STATUS.IN_PROGRESS ||
    draftStatus === DRAFT_STATUS.PAUSED;
  return (
    <div className="space-y-6">
      {running ? (
        <Link
          href="/draft"
          className="group flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm transition-colors hover:border-muted/60"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {draftStatus === DRAFT_STATUS.IN_PROGRESS ? (
              <span
                aria-hidden
                className="animate-live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
              />
            ) : null}
            <span className="font-medium">
              {draftStatus === DRAFT_STATUS.PAUSED
                ? "The draft is paused"
                : "The draft is live"}
            </span>
          </span>
          <span className="shrink-0 font-medium text-accent group-hover:underline">
            Watch <LinkArrow />
          </span>
        </Link>
      ) : null}
      <Card className="overflow-hidden">
        <CardHeader
          headingLevel={2}
          title="Rosters"
          subtitle={`${teams.length} ${teams.length === 1 ? "team" : "teams"} · ${season.teamSize} players each`}
        />
        <CardBody className="p-0">
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">
              {budgetsSet
                ? "Each team's players, captain first, with seats filled and budget left"
                : "Each team's captain and seats filled"}
            </caption>
            <colgroup>
              <col />
              <col className="w-16" />
              {budgetsSet ? <col className="w-20 sm:w-24" /> : null}
            </colgroup>
            <thead className="text-xs text-muted">
              <tr className="border-b border-line">
                <th
                  scope="col"
                  id="draft-roster-col-team"
                  className="px-4 py-2 text-left font-medium"
                >
                  Team
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Seats
                </th>
                {budgetsSet ? (
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Budget left
                  </th>
                ) : null}
              </tr>
            </thead>
            {/* One row group per team. The row header is the team alone: the
                roster sits in its own cell below it (Seats and Budget span
                both rows), so a screen reader names each cell by the team,
                not by the whole roster. The roster cell points back at the
                team and the Team column with `headers`. */}
            {teams.map((t, i) => (
              <tbody
                key={t.id}
                className={i > 0 ? "border-t border-line-soft" : undefined}
              >
                <tr className="align-top">
                  <th
                    scope="row"
                    id={`draft-roster-${t.id}`}
                    className="min-w-0 px-4 pt-3 text-left font-normal"
                  >
                    <Link
                      href={`/teams/${t.id}`}
                      className="flex min-w-0 items-center gap-2 font-semibold hover:text-info"
                    >
                      <TeamCrest
                        name={t.name}
                        seed={t.id}
                        logoUrl={t.logoUrl}
                        size={22}
                        className="shrink-0 rounded"
                      />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {t.name}
                      </span>
                    </Link>
                  </th>
                  <td rowSpan={2} className="px-2 py-3 text-right tabular-nums">
                    {t.members.length}/{season.teamSize}
                  </td>
                  {budgetsSet ? (
                    <td
                      rowSpan={2}
                      className="px-4 py-3 text-right tabular-nums"
                    >
                      ${t.budget}
                    </td>
                  ) : null}
                </tr>
                <tr className="align-top">
                  {/* leading-7: two wrapped lines of tap-safe links must not
                      overlap each other. */}
                  <td
                    headers={`draft-roster-col-team draft-roster-${t.id}`}
                    className="min-w-0 px-4 pt-1 pb-3 leading-7 text-muted [overflow-wrap:anywhere]"
                  >
                    {rosterOrder(t.members).map((m, j) => (
                      <Fragment key={m.id}>
                        {j > 0 ? ", " : null}
                        <PlayerLink userId={m.userId} className="text-fg">
                          {m.user.name}
                        </PlayerLink>
                        {m.isCaptain ? (
                          <span
                            title="Captain"
                            className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded border border-accent/40 bg-accent/15 px-1 align-middle text-[11px] font-semibold text-accent"
                          >
                            <span aria-hidden>C</span>
                            <span className="sr-only">captain</span>
                          </span>
                        ) : budgetsSet ? (
                          <span className="text-xs"> ${m.price}</span>
                        ) : null}
                      </Fragment>
                    ))}
                  </td>
                </tr>
              </tbody>
            ))}
          </table>
        </CardBody>
      </Card>
    </div>
  );
}

// ---------- REGULAR SEASON / PLAYOFFS ----------

async function SeasonView({
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
  // "Next up" must be the SAME match the stake line's "next series" is about
  // (the engine orders by kickoff when times exist) — falling back to
  // chronological order, like the MyNextMatch banner above.
  // Keep this compact team tile on the same freshness policy as the hero:
  // stale unreported fixtures are results debt, not the team's next opponent.
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
 * The matches everyone cares about right now — this week's slate during the
 * regular season, the open round during playoffs — with per-team check-in
 * counts and a stakes chip when the scenario engine says a game is dramatic.
 */
async function ThisWeek({
  season,
  matches,
  teams,
  teamName,
  teamLogoUrl,
  report,
  showCheckins,
  myPicks,
  pickemPlayable,
}: {
  season: SeasonSnapshot["season"];
  matches: Match[];
  teams: SeasonSnapshot["teams"];
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
  report: ScenarioReport | null;
  showCheckins: boolean;
  /** The viewer's picks on the slate, from SeasonView's one query; null when
   * signed out, which is what keeps the pick tray off the page for them. */
  myPicks: Map<string, string> | null;
  /** Active season with post-auction side games open (/pickem's canPlay). */
  pickemPlayable: boolean;
}) {
  // Same helper the "Coming up" card partitions against — see focusSlate.
  const { slate: focus, title } = focusSlate(season.status, matches);
  if (focus.length === 0) return null;
  const playoffRounds = playoffTotalRounds(matches);

  const [avail, standinRows] = await Promise.all([
    showCheckins
      ? prisma.matchAvailability.findMany({
          where: { matchId: { in: focus.map((m) => m.id) } },
          select: { matchId: true, userId: true, status: true, scheduleRevision: true },
        })
      : Promise.resolve([]),
    showCheckins
      ? prisma.standinAssignment.findMany({
          where: { matchId: { in: focus.map((m) => m.id) } },
          select: {
            matchId: true,
            teamId: true,
            standinUserId: true,
            replacingUserId: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const rosterOf = new Map(
    teams.map((t) => [t.id, t.members.map((m) => m.userId)]),
  );
  const checkins = (matchId: string, teamId: string) => {
    if (!showCheckins) return null;
    // Standin-aware, same helper as /schedule — a covered player's absence
    // isn't a gap, and the standin's own RSVP is the one that counts.
    const roster = matchNightRoster(
      rosterOf.get(teamId) ?? [],
      standinRows.filter((a) => a.matchId === matchId && a.teamId === teamId),
    );
    if (roster.length === 0) return null;
    const a = teamAvailability(
      roster,
      avail.filter((r) => r.matchId === matchId && r.scheduleRevision === focus.find((m) => m.id === matchId)?.scheduleRevision),
    );
    // Out of the SEASON's side size, not the roster we happen to have — a
    // 4-of-5 team used to render "4/4" in success green.
    return {
      confirmed: a.confirmed,
      size: expectedSideSize(season.teamSize, roster.length),
      short: Math.max(0, season.teamSize - roster.length),
    };
  };

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title={title}
        action={
          <Link href="/schedule#fixtures" className={textLink("text-sm")}>
            Full schedule <LinkArrow />
          </Link>
        }
      />
      {/* auto-fit, not sm:grid-cols-2: a league plays an ODD number of matches
          per week whenever it has a bye, and a fixed two-up left a permanently
          empty cell next to the last fixture. items-start: a LIVE card has no
          pick tray, and stretched to its neighbours' height it was mostly a
          blank block under the score. */}
      <CardBody className="grid items-start gap-3 p-3 [grid-template-columns:repeat(auto-fit,minmax(min(17rem,100%),1fr))] sm:p-4">
        {focus.map((m) => {
          const pick = pickemControlFor(m, {
            signedIn: myPicks != null,
            canPlay: pickemPlayable,
            pickedTeamId: myPicks?.get(m.id),
          });
          const pickSide = (teamId: string) => ({
            id: teamId,
            name: teamName.get(teamId) ?? "?",
            logoUrl: teamLogoUrl.get(teamId) ?? null,
          });
          // The card is a wrapper, not the link itself: the pick tray holds a
          // <form>, and interactive content inside an <a> is invalid HTML (a
          // tap on a pick button would also be a tap on the link). The link
          // keeps everything it held before, so a signed-out viewer, who never
          // gets a tray, sees the card exactly as it was.
          return (
            <div
              key={m.id}
              className={cn(
                "relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-gradient-to-br from-surface-2/70 to-surface text-sm transition-colors has-[>a:hover]:border-info/60",
                m.status === "LIVE" ? "border-danger/45" : "border-line",
              )}
            >
              <Link
                href={`/matches/${m.id}`}
                className="group/match flex min-w-0 flex-1 flex-col rounded-xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-muted">
                  <span className="uppercase tracking-wider">
                    {matchRoundLabel(m, playoffRounds, { bestOf: true })}
                  </span>
                  {m.status === "LIVE" ? (
                    <span
                      role="img"
                      aria-label={`Live — series at ${m.homeScore}–${m.awayScore}`}
                      className="inline-flex items-center gap-1.5 rounded-md bg-danger/10 px-1.5 py-0.5 font-mono text-xs tabular-nums text-danger-soft"
                    >
                      <span aria-hidden className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75 motion-reduce:animate-none" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-danger" />
                      </span>
                      <span aria-hidden>LIVE</span>
                    </span>
                  ) : m.scheduledAt ? (
                    <LocalTime
                      ts={m.scheduledAt.getTime()}
                      variant="full"
                      initial={fmtWhen(m.scheduledAt) ?? ""}
                    />
                  ) : (
                    <span>Kickoff time not set</span>
                  )}
                </div>
                <div className="my-4 flex-1 space-y-3">
                  {[m.homeTeamId, m.awayTeamId].map((teamId) => {
                    const c = checkins(m.id, teamId);
                    return (
                      <div
                        key={teamId}
                        className="flex min-w-0 items-center gap-2"
                      >
                        <TeamCrest
                          name={teamName.get(teamId) ?? "?"}
                          seed={teamId}
                          logoUrl={teamLogoUrl.get(teamId)}
                          size={34}
                          className="shrink-0 rounded-lg"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold leading-snug [overflow-wrap:anywhere]">
                            {teamName.get(teamId) ?? "?"}
                          </p>
                          {(() => {
                            const scenario = report?.teams.get(teamId);
                            if (!scenario || scenario.nextMatchId !== m.id) return null;
                            return (
                              <div className="mt-1">
                                <PlayoffOutlook scenario={scenario} teamNames={teamName} matchId={m.id} compact />
                              </div>
                            );
                          })()}
                        </div>
                        {c ? (
                          <span
                            role="img"
                            aria-label={
                              c.short
                                ? `${c.confirmed} of ${c.size} checked in — ${c.short} seat(s) unfilled`
                                : `${c.confirmed} of ${c.size} checked in`
                            }
                            className={cn(
                              "shrink-0 text-xs tabular-nums",
                              c.confirmed === c.size
                                ? "text-success"
                                : c.short
                                  ? "text-danger"
                                  : "text-muted",
                            )}
                            title={
                              c.short
                                ? `${c.confirmed} of ${c.size} checked in — ${c.short} roster seat(s) unfilled`
                                : `${c.confirmed} of ${c.size} checked in`
                            }
                          >
                            <span
                              aria-hidden
                              className="flex flex-col items-end gap-1"
                            >
                              <span className="flex gap-0.5">
                                {Array.from(
                                  { length: Math.min(c.size, 10) },
                                  (_, index) => (
                                    <i
                                      key={index}
                                      className={cn(
                                        "h-1.5 w-1.5 rounded-full",
                                        index < c.confirmed
                                          ? "bg-success"
                                          : "bg-line",
                                      )}
                                    />
                                  ),
                                )}
                              </span>
                              <span>
                                {c.confirmed}/{c.size}
                              </span>
                            </span>
                          </span>
                        ) : null}
                        {m.status === "LIVE" ? (
                          <span
                            aria-hidden
                            className="ml-1 font-display text-3xl tabular-nums text-fg"
                          >
                            {teamId === m.homeTeamId ? m.homeScore : m.awayScore}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <p className="flex items-center justify-between border-t border-line-soft pt-3 text-xs text-muted group-hover/match:text-info">
                  <span>Match details & check-in</span>
                  <span aria-hidden>→</span>
                </p>
              </Link>
              {pick ? (
                <PickemTray
                  control={pick}
                  matchId={m.id}
                  roundLabel={matchRoundLabel(m, playoffRounds)}
                  home={pickSide(m.homeTeamId)}
                  away={pickSide(m.awayTeamId)}
                  locksAt={m.scheduledAt?.getTime() ?? null}
                  className="border-t border-line-soft px-4 py-3"
                />
              ) : null}
            </div>
          );
        })}
      </CardBody>
    </Card>
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

// ---------- COMPLETE ----------

async function CompleteView({
  snapshot,
  matches,
  championPresentation,
}: {
  snapshot: SeasonSnapshot;
  matches: Match[];
  championPresentation: ChampionPresentation;
}) {
  const { teams, season } = snapshot;
  const champion = teams.find(
    (team) => team.id === championPresentation.championTeamId,
  );
  const hasPostseason = championPresentation.hasPostseason;
  const standings = computeStandings(
    teams.map((t) => t.id),
    matches,
  );
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const teamLogoUrl = new Map(teams.map((t) => [t.id, t.logoUrl]));
  const teamForm = formByTeam(
    teams.map((t) => t.id),
    matches,
  );
  const championRow = champion
    ? standings.find((s) => s.teamId === champion.id)
    : undefined;

  // The final's scoreline turns "champion: X" into a story.
  const finalMatch = championPresentation.authoritativeFinalId
    ? matches.find(
        (match) => match.id === championPresentation.authoritativeFinalId,
      )
    : undefined;
  const finalLine = finalMatch
    ? {
        score:
          finalMatch.winnerTeamId === finalMatch.homeTeamId
            ? `${finalMatch.homeScore}–${finalMatch.awayScore}`
            : `${finalMatch.awayScore}–${finalMatch.homeScore}`,
        loser: teamName.get(
          finalMatch.winnerTeamId === finalMatch.homeTeamId
            ? finalMatch.awayTeamId
            : finalMatch.homeTeamId,
        ),
      }
    : undefined;

  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400/15 blur-3xl"
        />
        <CardBody className="relative flex flex-col items-center gap-3 py-10 text-center">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-amber-300/90">
            {champion
              ? `${season.name} Champion`
              : `${season.name} · review needed`}
          </div>
          {champion ? (
            <div className="relative">
              <TeamCrest
                name={champion.name}
                seed={champion.id}
                logoUrl={champion.logoUrl}
                size={76}
                className="rounded-2xl shadow-lg ring-2 ring-amber-400/50"
              />
              <span
                aria-hidden
                className="absolute -bottom-2 -right-2 grid h-8 w-8 place-items-center rounded-full border border-amber-400/40 bg-surface text-lg shadow-md"
              >
                🏆
              </span>
            </div>
          ) : (
            <div aria-hidden className="text-4xl">
              ⚠️
            </div>
          )}
          <div className="text-2xl font-bold">
            {champion ? (
              <Link href={`/teams/${champion.id}`} className="hover:text-info">
                {champion.name}
              </Link>
            ) : (
              "Champion needs review"
            )}
          </div>
          {!champion ? (
            <p className="max-w-xl text-sm text-muted">
              This season is marked complete without an authoritative champion.
              {hasPostseason
                ? " League administrators need to return it to Playoffs and reconcile the existing grand final before a title is shown."
                : " No playoff bracket exists, so league administrators need to return it to Regular season, verify the table, and start a newly seeded bracket before a title is shown."}
            </p>
          ) : null}
          {finalLine ? (
            <div className="text-sm text-muted">
              Won the grand final{" "}
              <span className="font-medium text-fg">{finalLine.score}</span>
              {finalLine.loser ? ` over ${finalLine.loser}` : ""}
            </div>
          ) : null}
          {championRow ? (
            <div className="text-sm text-muted">
              <span className="font-medium text-fg">
                <SeriesRecord record={championRow} />
              </span>{" "}
              regular season · {championRow.points} pts
            </div>
          ) : null}
          {champion && champion.members.length > 0 ? (
            // my-0 on the chips below: the py-0.5 orphans TAP_SAFE's -my-1
            // through twMerge, so the chip reserves 8px less than it occupies
            // (see teams/page.tsx for the measurement). Centred chips for the
            // winning five wrap on every phone, and this is the champion card.
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

      <CompleteBracket
        matches={matches}
        teamName={teamName}
        teamLogoUrl={teamLogoUrl}
        championTeamId={championPresentation.championTeamId}
      />

      {/* items-start, not the default stretch: the "season lives on" card is a
          short list of links and the final table is the full league, so
          stretching the row drew a 1/3-width box of empty border beside it —
          the COMPLETE twin of the void the mid-season deck used to have. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Card>
            <CardHeader
              headingLevel={2}
              title="Final standings"
              action={
                <Link href="/schedule#fixtures" className={textLink("text-sm")}>
                  Full schedule <LinkArrow />
                </Link>
              }
            />
            <CardBody className="p-0">
              <StandingsTable
                standings={standings}
                teamName={teamName}
                teamLogoUrl={teamLogoUrl}
                withdrawnIds={
                  new Set(teams.filter((t) => t.withdrawn).map((t) => t.id))
                }
                formByTeam={teamForm}
              />
            </CardBody>
          </Card>
        </div>
        <div className="min-w-0">
          <Card>
            <CardHeader
              headingLevel={2}
              title={champion ? "The season lives on" : "Season record"}
            />
            <CardBody className="space-y-3 text-sm">
              {/* No season-page button here: the hero's "Relive the season" is
                  the page's one way there (it used to have a twin, "Season
                  recap", going to the same place). */}
              <p className="text-muted">
                {champion
                  ? "Its stat lines stay on the leaderboards, any record it set is in the record book, and every season is kept in the history."
                  : "Results remain available while administrators repair the championship state. No team is presented as champion until the grand final is authoritative."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href="/leaders" className={buttonClasses("secondary")}>
                  Leaderboards
                </Link>
                <Link href="/records" className={buttonClasses("secondary")}>
                  Record book
                </Link>
                <Link href="/seasons" className={buttonClasses("secondary")}>
                  Season history
                </Link>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

// The championship run, in the classic bracket shape — the story of how the
// trophy was won belongs on the season's front page.
function CompleteBracket({
  matches,
  teamName,
  teamLogoUrl,
  championTeamId,
}: {
  matches: Match[];
  teamName: Map<string, string>;
  teamLogoUrl: Map<string, string | null>;
  championTeamId: string | null;
}) {
  const playoffMatches = matches.filter(
    (m) => m.phase === "PLAYOFF" || m.phase === "FINAL",
  );
  const rounds = buildBracketRounds(
    playoffMatches,
    teamName,
    seedsFromFirstRound(playoffMatches),
    (d) => fmtWhen(d) ?? "",
    teamLogoUrl,
  );
  if (rounds.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader headingLevel={2} title="How it was won" />
      <CardBody className="p-0 pt-4">
        <Bracket rounds={rounds} championTeamId={championTeamId} />
      </CardBody>
    </Card>
  );
}
