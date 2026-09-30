import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { matchMetadata } from "@/lib/link-preview-metadata";
import { waitingForResultNote } from "@/lib/match-hosting";
import { matchResultsOpen } from "@/lib/league-lifecycle";
import { groupPlayoffRounds, matchRoundLabel } from "@/lib/schedule";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import { AdminMatchTools } from "@/components/admin-match-tools";
import { ContextBackLink } from "@/components/context-back-link";
import { ShareButton } from "@/components/share-button";
import { SectionNav } from "@/components/section-nav";
import { CardSkeleton, EmptyState, textLink } from "@/components/ui";
import { CaptainTodos } from "./captain-todos";
import { CaptainTools } from "./captain-tools";
import { LiveSeriesCheckin } from "./live-series-checkin";
import { loadMatch, loadPostseason, parseMatchGames } from "./load";
import { PlayerLobbyPanel } from "./lobby-panel";
import { MatchGames } from "./match-games";
import { MatchPreview } from "./match-preview";
import { RescheduleSection } from "./reschedule";
import { PlayoffContextLine, TiebreakerNote } from "./round-context";
import { MatchScoreboard } from "./scoreboard";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The round and teams, then the kickoff, live score or result.
  const metadata = await matchMetadata(id);
  // notFound() in metadata: crawlers wait for metadata, so they get a real
  // 404 status. Browsers get streamed metadata, so the not-found page
  // arrives with a 200 and Next's noindex tag (its documented streaming
  // behaviour).
  if (!metadata) notFound();
  return metadata;
}

/**
 * One fixture: the scoreboard, then the preview (before the first game) or
 * the box scores, then the captain's tools. The match, its season and the
 * viewer are loaded here once and passed to every card (./load.ts); each card
 * lives in its own file beside this one.
 */
export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const match = await loadMatch(id);
  if (!match) notFound();

  const games = parseMatchGames(match);
  // Async server component: capture request time once for the overdue-result
  // explanation; this is not client render state.
  // eslint-disable-next-line react-hooks/purity
  const renderedAt = Date.now();
  const postseason = await loadPostseason(match);
  const championPresentation = resolveChampionPresentation(
    match.season,
    postseason,
  );
  const postseasonLabel = matchRoundLabel(
    match,
    groupPlayoffRounds(postseason).totalRounds,
  );
  const viewer = await getSessionUser();
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  // A final series has nothing left for a captain to do here: corrections go
  // through an admin, so it gets one line under the games, not a tools jump.
  const showCaptainTools =
    isCaptain && match.season.isActive && match.status !== "COMPLETED";
  const showCorrectionNote =
    isCaptain && match.season.isActive && match.status === "COMPLETED";
  const hasPreview = games.length === 0 && match.status !== "COMPLETED";
  const resultPending =
    match.status !== "COMPLETED" &&
    match.scheduledAt != null &&
    match.scheduledAt.getTime() < renderedAt;
  // Each label names the card it jumps to. Played games get no entry: the
  // scoreboard's Game chips already jump to each box score.
  const sectionItems = [
    ...(hasPreview
      ? [
          { id: "match-matchup", label: "Matchup" },
          { id: "match-scouting", label: "Scouting" },
        ]
      : []),
    ...(showCaptainTools
      ? [{ id: MATCH_ANCHOR.tools, label: "Captain tools" }]
      : []),
  ];

  return (
    <div className="space-y-5">
      {/* A small back link, not a title block: the scoreboard below is the
          page's visible title, so a phone reaches it without scrolling past
          the team names printed twice. The destination still follows how
          the viewer arrived (schedule, bracket or a season's archive). */}
      {/* Share sits on the back link's line, so it costs no height. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ContextBackLink
          href={
            match.season.isActive
              ? match.phase === "REGULAR" || match.phase === "TIEBREAKER"
                ? match.phase === "TIEBREAKER"
                  ? "/schedule#tiebreakers"
                  : "/schedule#fixtures"
                : "/schedule#playoff-bracket"
              : `/seasons/${match.seasonId}`
          }
          className={textLink("text-sm")}
        >
          {match.season.isActive
            ? match.phase === "REGULAR" || match.phase === "TIEBREAKER"
              ? "← Schedule"
              : "← Playoff bracket"
            : `← ${match.season.name}`}
        </ContextBackLink>
        <ShareButton
          path={`/matches/${match.id}`}
          title={`${postseasonLabel} · ${match.homeTeam.name} vs ${match.awayTeam.name}`}
        />
      </div>

      <TiebreakerNote match={match} />

      <PlayoffContextLine match={match} postseason={postseason} />

      <MatchScoreboard
        match={match}
        games={games}
        viewer={viewer}
        roundLabel={postseasonLabel}
        championPresentation={championPresentation}
        resultPending={resultPending}
        showCaptainTools={showCaptainTools}
      />

      {/* Between games, being ready for the next one is the only thing a
          player has to do here, so it sits right under the scoreboard, not
          after every box score. It renders only for players on either side. */}
      {match.status === "LIVE" && match.season.isActive ? (
        <Suspense fallback={null}>
          <LiveSeriesCheckin
            match={match}
            viewer={viewer}
            names={!hasPreview}
          />
        </Suspense>
      ) : null}

      {/* The season lobby bot's name and password for the players, standins
          and admins who join it; the captains' copy, with the controls, is in
          Captain tools. Renders nothing unless the season lobby bot is on and
          answers with a lobby. */}
      {!showCaptainTools ? (
        <Suspense fallback={null}>
          <PlayerLobbyPanel match={match} viewer={viewer} />
        </Suspense>
      ) : null}

      {/* What is waiting on this captain, one line each, linking to the card
          that answers it: those cards sit below the scoreboard and every
          box score, about a phone-height or more down the page. */}
      {showCaptainTools ? (
        <Suspense fallback={null}>
          <CaptainTodos match={match} viewerId={viewer!.id} />
        </Suspense>
      ) : null}

      {/* Admins get this fixture's /admin controls here, folded shut.
          /admin's Needs attention items land on it (#match-admin), which
          opens it. Captains' own tools stay as they are below. */}
      {viewer?.role === "ADMIN" && match.season.isActive ? (
        <AdminMatchTools
          match={match}
          label={postseasonLabel}
          viewerHasCaptainTools={showCaptainTools}
        />
      ) : null}

      {/* A jump bar earns its space only with three places to go; with one
          or two it just points at what is already on screen. Never pinned
          here: a pinned bar sat over the box scores. A jump opens only its
          target (the Scouting fold is the target itself): opening the first
          disclosure inside Captain tools unfolded the lobby steps and the
          import form that are folded on purpose. */}
      {sectionItems.length >= 3 ? (
        <SectionNav
          items={sectionItems}
          label="Match sections"
          openNested="marked"
        />
      ) : null}

      {!match.season.isActive ? (
        <div className="rounded-[var(--radius)] border border-line bg-surface-2/40 px-4 py-3 text-sm text-muted">
          <strong className="text-fg">Archived result.</strong> This match is
          part of {match.season.name}; its schedule, reporting, and logistics
          are read-only.
        </div>
      ) : resultPending && match.status !== "LIVE" && games.length === 0 ? (
        // Once a game is in, the LIVE badge and the score say it all. Before
        // that, say where things stand without promising an import: forfeits
        // and private match data never arrive on their own.
        <div className="rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-3 text-sm text-muted">
          <strong className="text-fg">Waiting for the result.</strong> Kickoff
          has passed and no game is recorded yet.
          {!matchResultsOpen(match.season.status, match.phase)
            ? null
            : ` ${waitingForResultNote({
                hasLeagueTicket: !!match.season.dotaLeagueId,
                viewerIsCaptain: showCaptainTools,
              })}`}
        </div>
      ) : null}

      {/* Pending time changes stay visible to spectators. Captain controls
          live together below the match, with a primary jump in the scoreboard. */}
      {!showCaptainTools && match.status !== "COMPLETED" ? (
        <RescheduleSection match={match} viewer={viewer} />
      ) : null}

      <section
        id="match-games"
        className="scroll-mt-24 space-y-5"
        aria-label={hasPreview ? "Match preview" : "Match games"}
      >
        {games.length === 0 && match.status !== "COMPLETED" ? (
          <Suspense fallback={<CardSkeleton rows={5} />}>
            {/* Rosters, scouting (scans all seasons' box scores) and the stakes
              banner stream in so the header + check-in paint immediately. */}
            <MatchPreview
              match={match}
              viewer={viewer}
              roundLabel={postseasonLabel}
            />
          </Suspense>
        ) : games.length === 0 ? (
          <EmptyState
            title={
              match.forfeit
                ? "Series awarded by forfeit"
                : "Final score entered manually"
            }
            description={
              match.forfeit
                ? "This is an administrative ruling; no Dota game was recorded for this series."
                : "The final result is official, but detailed OpenDota box-score data is unavailable."
            }
          />
        ) : (
          <MatchGames match={match} games={games} viewer={viewer} />
        )}
      </section>

      {showCorrectionNote ? (
        <p className="text-sm text-muted">
          Result wrong? Send an admin this page and the Dota match ID.
        </p>
      ) : null}
      {showCaptainTools ? (
        <CaptainTools
          match={match}
          viewer={viewer!}
          seriesStarted={games.length > 0}
          renderedAt={renderedAt}
        />
      ) : null}
    </div>
  );
}
