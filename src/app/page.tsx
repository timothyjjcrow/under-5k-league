import type { Match } from "@prisma/client";
import { Suspense, type ReactNode } from "react";
import { DiscordSetupPrompt } from "@/components/discord-setup";
import { AdminStrip } from "@/components/home/admin-strip";
import { CompleteView, completeHero } from "@/components/home/complete-view";
import { DraftPhaseView, draftHero } from "@/components/home/draft-view";
import {
  DefendingChampionLine,
  Hero,
  LeaguePitch,
  SeasonTimeline,
  type HeroParts,
  type HomeViewer,
} from "@/components/home/hero";
import { InhouseStrip } from "@/components/home/inhouse-strip";
import { LeagueNews, PinnedNotices } from "@/components/home/news";
import { OffseasonView } from "@/components/home/offseason-view";
import {
  SeasonView,
  SeasonViewSkeleton,
  seasonHero,
} from "@/components/home/season-view";
import { SignupsView, signupsHero } from "@/components/home/signups-view";
import { CardSkeleton } from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { REGISTRATION_STATUS } from "@/lib/constants";
import { homeMetadata } from "@/lib/link-preview-metadata";
import { announcedMatchNight } from "@/lib/match-night";
import { parseNextSeasonPlan } from "@/lib/next-season";
import { getDefendingChampion } from "@/lib/official-champion";
import { prisma } from "@/lib/prisma";
import { getSeasonMatches, getSeasonSnapshot } from "@/lib/queries";
import {
  draftPhasePresentation,
  phaseSubtitle,
  seasonPhaseLabel,
} from "@/lib/season-copy";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import {
  canViewAvailabilitySummary,
  hasActiveLeagueParticipation,
} from "@/lib/visibility";

// "Copy invite link" shares this page, so its link preview carries the
// season, its phase and what a visitor can do now.
export function generateMetadata() {
  return homeMetadata();
}

/**
 * Home. This file loads the data and picks the phase. The shared hero is
 * src/components/home/hero.tsx; each phase's view file there (offseason,
 * signups, draft, season, complete) fills the hero's slots and draws what is
 * below it.
 */
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
      <OffseasonView
        user={user}
        latestSeason={latestSeason}
        defending={defending}
      />
    );
  }

  const { season } = snapshot;
  const signedOutSignups = !user && season.status === "SIGNUPS";

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
  const viewer: HomeViewer = {
    user,
    isActiveReg,
    isRemovedReg,
    // A designated captain, before the auction: they get one line of their
    // own (see CaptainLine) wherever the hero stands for the draft.
    captaining:
      !!user && snapshot.teams.some((team) => team.captainId === user.id),
    standinRegistrationOpen:
      (season.status === "DRAFT" ||
        season.status === "REGULAR_SEASON" ||
        season.status === "PLAYOFFS") &&
      !isActiveReg &&
      !isRemovedReg &&
      !isRostered,
  };

  // Past the draft, every view (and the hero itself) reads the season's
  // matches — fetch once here and hand them down.
  const showsMatches =
    season.status === "REGULAR_SEASON" ||
    season.status === "PLAYOFFS" ||
    season.status === "COMPLETE";
  const [matches, gamesOnRecord, nextSeasonRaw] = showsMatches
    ? await Promise.all([
        // Request-cached: the link preview reads it for the champion.
        getSeasonMatches(season.id),
        prisma.game.count({ where: { match: { seasonId: season.id } } }),
        // The next season's signup date, for the COMPLETE hero (set on
        // /admin's Season handoff card).
        season.status === "COMPLETE"
          ? getSetting(SETTING_KEYS.NEXT_SEASON_PLAN)
          : Promise.resolve(null),
      ])
    : [[] as Match[], 0, null];
  const championPresentation = resolveChampionPresentation(season, matches);
  // Until this season crowns someone, Home keeps naming the last champion.
  // Signups and the draft only: from the regular season on, the dashboard is
  // about this season's race.
  const defending =
    season.status === "SIGNUPS" || season.status === "DRAFT"
      ? await getDefendingChampion(season.createdAt)
      : null;

  // The phase switch: what the phase puts in the hero, and its view below.
  let heroParts: HeroParts = {};
  let view: ReactNode = null;
  switch (season.status) {
    case "SIGNUPS":
      heroParts = signupsHero(snapshot, viewer);
      view = <SignupsView snapshot={snapshot} loggedIn={!!user} />;
      break;
    case "DRAFT":
      heroParts = await draftHero(snapshot, viewer);
      view = <DraftPhaseView snapshot={snapshot} />;
      break;
    case "REGULAR_SEASON":
    case "PLAYOFFS":
      heroParts = seasonHero(
        snapshot,
        viewer,
        matches,
        championPresentation.championTeamId,
      );
      // The viewer's next match is not in this view: it is the hero's panel
      // (see seasonHero).
      view = (
        <Suspense
          fallback={
            <SeasonViewSkeleton playoffs={season.status === "PLAYOFFS"} />
          }
        >
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
            // The news ends the dashboard's second column, and the inhouse
            // queue is one of its side-game tiles, so neither follows the
            // view below.
            rail={
              <Suspense fallback={null}>
                <LeagueNews />
              </Suspense>
            }
          />
        </Suspense>
      );
      break;
    case "COMPLETE":
      heroParts = completeHero(
        season.id,
        parseNextSeasonPlan(nextSeasonRaw, season.id)?.signupsAtMs ?? null,
      );
      view = (
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <CompleteView
            snapshot={snapshot}
            matches={matches}
            championPresentation={championPresentation}
            rail={
              <>
                <Suspense
                  fallback={
                    <div className="skeleton h-16 rounded-[var(--radius)]" />
                  }
                >
                  <InhouseStrip variant="tile" />
                </Suspense>
                <Suspense fallback={null}>
                  <LeagueNews />
                </Suspense>
              </>
            }
          />
        </Suspense>
      );
      break;
  }

  // The admin's own line under the hero (AdminStrip); players never see it.
  const isAdmin = user?.role === "ADMIN";

  const hero = (
    <Hero
      phase={season.status}
      phaseLabel={seasonPhaseLabel(season.status, snapshot.draftStatus)}
      active={
        season.status === "DRAFT"
          ? draftPhasePresentation(snapshot.draftStatus).live
          : undefined
      }
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
      action={heroParts.action}
      meta={heroParts.meta}
      aside={heroParts.aside}
      rail={<SeasonTimeline phase={season.status} />}
    />
  );

  // From the regular season on, the phase's view draws the news and the
  // inhouse queue itself (in its rail).
  const seasonDashboard =
    season.status === "REGULAR_SEASON" ||
    season.status === "PLAYOFFS" ||
    season.status === "COMPLETE";

  return (
    <div className="space-y-5">
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
      {view}
      {seasonDashboard ? null : (
        <>
          <Suspense fallback={null}>
            <LeagueNews />
          </Suspense>
          <Suspense
            fallback={
              <div className="skeleton h-12 rounded-[var(--radius)]" />
            }
          >
            <InhouseStrip />
          </Suspense>
        </>
      )}
    </div>
  );
}
