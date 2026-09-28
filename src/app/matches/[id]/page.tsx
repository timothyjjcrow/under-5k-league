import { LEAGUE_CONFIG } from "@/lib/league-config";
import { PlayoffOutlook } from "@/components/playoff-outlook";
import { Suspense } from "react";
import { LiveSeriesCheckin } from "@/components/live-series-checkin";
import { AutoOpenDetails } from "@/components/auto-open-details";
import { fetchGamesForScouting } from "@/lib/game-participants";
import { GameIdentityEditor } from "@/components/game-identity-editor";
import { AdminMatchTools } from "@/components/admin-match-tools";
import {
  decodeGamePlayers,
  parseGamePlayers,
  trustedGamePlayers,
} from "@/lib/player-stats";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { matchMetadata } from "@/lib/link-preview-metadata";
import {
  CHECKIN_NUDGE_THROTTLE_SECONDS,
  LEAGUE_GAME_MODE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
} from "@/lib/constants";
import {
  howToHostParts,
  leagueResultCopy,
  NO_TICKET_REPORT_SUBTITLE,
  NO_TICKET_RESULT_NOTE,
  waitingForResultNote,
} from "@/lib/match-hosting";
import { formatNetWorth, cn } from "@/lib/utils";
import { heroById } from "@/lib/heroes";
import { coverChoices, seatValue, standinPickerBlock } from "@/lib/standin";
import { roleShort } from "@/lib/roles";
import { recentForm, headToHead } from "@/lib/team-matches";
import { gameMvp } from "@/lib/achievements";
import { CheckinBanner } from "@/components/checkin-banner";
import { loadCheckinSide } from "@/lib/checkin-side-service";
import { signInHref } from "@/lib/sign-in";
import { ContextBackLink } from "@/components/context-back-link";
import { SectionNav } from "@/components/section-nav";
import { LocalTime } from "@/components/local-time";
import { formatMatchTime } from "@/lib/match-time";
import { matchNightRoster, teamAvailability } from "@/lib/availability";
import { checkinNudgeBlockedSince } from "@/lib/checkin-nudge-service";
import { remindUnansweredCheckins } from "@/app/actions/availability";
import { getWebhookUrl } from "@/lib/discord";
import {
  canViewLeagueContact,
  canViewNamedMatchAvailability,
} from "@/lib/visibility";
import { DiscordTag } from "@/components/discord-tag";
import {
  matchCheckinOpen,
  matchLogisticsOpen,
  matchResultsOpen,
  postAuctionWorkOpen,
  standinAssignmentOpen,
} from "@/lib/league-lifecycle";
import { calledItCount, pickemControlFor } from "@/lib/pickem";
import { PickemTray } from "@/components/pickem-pick-form";
import { groupPlayoffRounds, matchRoundLabel } from "@/lib/schedule";
import { loadRescheduleDeadline } from "@/lib/reschedule-service";
import { FIXTURE_CONFLICT_WINDOW_MS } from "@/lib/fixture-conflict";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  cancelReschedule,
  proposeReschedule,
  respondReschedule,
} from "@/app/actions/reschedule";
import {
  captainAutoDetect,
  captainImportGame,
} from "@/app/actions/match-report";
import {
  captainAssignStandin,
  captainRemoveStandin,
} from "@/app/actions/standins";
import { MatchImportControls } from "@/components/match-import-controls";
import { LeagueLobbyChecklist } from "@/components/league-lobby-checklist";
import { DotaLobbyControls } from "@/components/dota-lobby-controls";
import { lobbyBotKindEnabled } from "@/lib/dota-lobby-service";
import type { PlayerStat } from "@/lib/match-import";
import {
  cardAverage,
  gameReportCard,
  gradeFor,
  gradeTone,
  percentLabel,
  type Grade,
} from "@/lib/benchmarks";
import {
  comfortPicks,
  dossierEmpty,
  playerHeroPool,
  threatBoard,
  threatList,
  type ComfortPicks as ComfortPicksResult,
  type ScoutGame,
  type ScoutThreats,
} from "@/lib/scouting";
import { parsePubStats, pubCheckedAgo } from "@/lib/pub-stats";
import { roleCoverage, type RoleCount } from "@/lib/pool-stats";
import { seasonScenarioReport, type StakesMatchRow } from "@/lib/stakes";
import { projectPlayoffField } from "@/lib/playoff-field";
import { parseSingleTiebreakerSlot, parseTiebreakerStage } from "@/lib/tiebreaker-format";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import {
  playoffMatchContext,
  playoffMatchContextText,
} from "@/lib/playoff-match-context";
import { teamHueVar } from "@/lib/team-hues";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  FormStrip,
  HeroIcon,
  KDA,
  LinkArrow,
  PlayerLink,
  RankBadge,
  RoleBadges,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";

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

export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const match = await prisma.match.findUnique({
    where: { id },
    include: {
      homeTeam: true,
      awayTeam: true,
      games: { orderBy: { startTime: "asc" } },
      standins: { include: { standin: true, replaced: true } },
      season: {
        select: {
          isActive: true,
          status: true,
          name: true,
          championTeamId: true,
          dotaLeagueId: true,
        },
      },
    },
  });
  if (!match) notFound();

  // Hero names are only rendered by the box-score branch — don't make the
  // preview/empty-state paths wait on an OpenDota round trip they never use.
  const games = match.games.map((g) => ({
    ...g,
    parsed: parseGamePlayers(g.players),
  }));

  const userIds = [
    ...new Set(
      games.flatMap((g) => g.parsed.map((p) => p.userId).filter(Boolean)),
    ),
  ] as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } } })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userAvatar = new Map(users.map((u) => [u.id, u.avatar]));
  const teamName = new Map([
    [match.homeTeamId, match.homeTeam.name],
    [match.awayTeamId, match.awayTeam.name],
  ]);
  // Async server component: capture request time once for the overdue-result
  // explanation; this is not client render state.
  // eslint-disable-next-line react-hooks/purity
  const renderedAt = Date.now();
  const postseason =
    match.phase !== "PLAYOFF" && match.phase !== "FINAL"
      ? []
      : await prisma.match.findMany({
          where: {
            seasonId: match.seasonId,
            phase: { in: ["PLAYOFF", "FINAL"] },
          },
          select: {
            id: true,
            week: true,
            phase: true,
            bracketSlot: true,
            status: true,
            winnerTeamId: true,
            homeTeamId: true,
            awayTeamId: true,
            // Names for the playoff context line's next opponent.
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
          },
        });
  const championPresentation = resolveChampionPresentation(
    match.season,
    postseason,
  );
  const postseasonLabel = matchRoundLabel(
    match,
    groupPlayoffRounds(postseason).totalRounds,
  );
  // What this knockout series decides: where the winner goes and that the
  // loser is out. Tiebreakers keep their own banner.
  const playoffContext = playoffMatchContext(match, postseason);
  const bracketTeamName = new Map(
    postseason.flatMap((m): [string, string][] => [
      [m.homeTeamId, m.homeTeam.name],
      [m.awayTeamId, m.awayTeam.name],
    ]),
  );
  const tiebreakerStage = parseTiebreakerStage(match.bracketSlot)?.stage;
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
  // A finished match tells a signed-in picker how their pick'em call went,
  // so nobody has to go back to /pickem to find out.
  const pickemCalls =
    viewer && match.status === "COMPLETED"
      ? await prisma.prediction.findMany({
          where: { matchId: match.id },
          select: { matchId: true, userId: true, pickedTeamId: true },
        })
      : [];
  const myCall = pickemCalls.find((call) => call.userId === viewer?.id);
  const pickVerdict = myCall
    ? pickemControlFor(match, {
        signedIn: true,
        canPlay: false,
        pickedTeamId: myCall.pickedTeamId,
      })
    : null;
  const hasSeriesScore =
    match.status === "COMPLETED" ||
    match.status === "LIVE" ||
    games.length > 0 ||
    match.homeScore + match.awayScore > 0;
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
    <div className="space-y-6">
      {/* A small back link, not a title block: the scoreboard below is the
          page's visible title, so a phone reaches it without scrolling past
          the team names printed twice. The destination still follows how
          the viewer arrived (schedule, bracket or a season's archive). */}
      <p>
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
      </p>

      {match.phase === "TIEBREAKER" ? (
        <div className="space-y-2 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-sm">
          <p><strong>Playoff tiebreaker · Best of {match.bestOf}.</strong>{" "}
            {parseSingleTiebreakerSlot(match.bracketSlot) ? "Win to advance; lose and your run ends. Up to three games per team. The next game starts when both opponents are ready." : tiebreakerStage ? `Game ${tiebreakerStage} of a three-team bracket: four games, or five if the final needs a reset.` : "This series helps settle playoff qualification or seeding."}
          </p>
          {tiebreakerStage ? <p className="text-xs text-muted">{
            tiebreakerStage === 1 ? "Winner plays the team with the bye in Game 2. Loser plays in Game 3."
              : tiebreakerStage === 2 ? "Winner advances to Game 4. Loser plays the loser of Game 1 in Game 3."
                : tiebreakerStage === 3 ? "Winner advances to Game 4. Loser finishes third in the tiebreaker."
                  : tiebreakerStage === 4 ? "If the team from Game 2 wins, the bracket is complete. If the team from Game 3 wins, both teams play Game 5."
                    : "Deciding final: winner finishes first, loser finishes second in the tiebreaker."
          }</p> : null}
          <Link href={match.season.isActive ? "/schedule#tiebreakers" : `/seasons/${match.seasonId}`} className="inline-block py-1 text-info hover:underline">{match.season.isActive ? "View full tiebreaker bracket" : "View tiebreaker results"} <LinkArrow /></Link>
        </div>
      ) : null}

      {playoffContext ? (
        <p className="rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-sm [overflow-wrap:anywhere]">
          {playoffMatchContextText(
            playoffContext,
            (teamId) => bracketTeamName.get(teamId) ?? "TBD",
            LEAGUE_CONFIG.name,
          )}
          {playoffContext.kind === "decided" ? (
            <>
              {" "}
              <Link
                href={
                  playoffContext.nextMatchId
                    ? `/matches/${playoffContext.nextMatchId}`
                    : match.season.isActive
                      ? "/schedule#playoff-bracket"
                      : `/seasons/${match.seasonId}`
                }
                className={textLink("whitespace-nowrap")}
              >
                {playoffContext.nextMatchId ? "Next match" : "Bracket"} <LinkArrow />
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      <Card className="relative overflow-hidden">
        <div
          aria-hidden
          className="hero-grid pointer-events-none absolute inset-0 opacity-40"
        />
        {/* Each side glows with its team's own color identity (home left, away right). */}
        <div
          aria-hidden
          className="animate-hero-glow pointer-events-none absolute -left-10 top-0 h-40 w-40 -translate-y-1/3 rounded-full blur-3xl"
          data-team-hue={match.homeTeamId}
          style={{
            backgroundColor: `hsl(${teamHueVar(match.homeTeamId)} 70% 50% / 0.24)`,
          }}
        />
        <div
          aria-hidden
          className="animate-hero-glow-alt pointer-events-none absolute -right-10 bottom-0 h-40 w-40 translate-y-1/3 rounded-full blur-3xl"
          data-team-hue={match.awayTeamId}
          style={{
            backgroundColor: `hsl(${teamHueVar(match.awayTeamId)} 70% 50% / 0.24)`,
          }}
        />
        <CardBody className="relative space-y-6 px-3 py-6 sm:px-6 sm:py-8">
          {/* The page's h1 names the fixture, like its tab title and link
              preview, so someone moving by headings knows which match this
              is. On screen the team names right below say the same. */}
          <h1 className="sr-only">
            {match.homeTeam.name} vs {match.awayTeam.name}
          </h1>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Badge>{postseasonLabel}</Badge>
            <Badge>Bo{match.bestOf}</Badge>
            {match.status === "COMPLETED" ? (
              <>
                <Badge tone="success">Series complete</Badge>
                {match.phase === "FINAL" &&
                match.id === championPresentation.authoritativeFinalId &&
                match.winnerTeamId === championPresentation.championTeamId ? (
                  <Badge tone="accent">🏆 League champion crowned</Badge>
                ) : null}
                {!match.winnerTeamId ? <Badge tone="accent">Draw</Badge> : null}
                {match.forfeit ? (
                  <Badge
                    tone="accent"
                    title="This score includes an admin ruling (forfeit / default); its recorded score counts in the standings and game-diff tiebreak."
                  >
                    forfeit
                  </Badge>
                ) : null}
              </>
            ) : match.status === "LIVE" || games.length > 0 ? (
              <Badge tone="danger">LIVE</Badge>
            ) : resultPending ? (
              <Badge tone="accent">Awaiting result</Badge>
            ) : (
              <Badge tone="info">
                {match.scheduledAt ? "Upcoming" : "Time TBD"}
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-8">
            <TeamSide
              name={match.homeTeam.name}
              teamId={match.homeTeamId}
              logoUrl={match.homeTeam.logoUrl}
              win={match.winnerTeamId === match.homeTeamId}
            />
            <div className="text-center">
              <div
                role="img"
                aria-label={
                  hasSeriesScore
                    ? `${match.homeTeam.name} ${match.homeScore}, ${match.awayTeam.name} ${match.awayScore}`
                    : "Series score not recorded"
                }
                className="flex items-center justify-center gap-2 font-display text-4xl font-bold tabular-nums tracking-tight sm:gap-4 sm:text-7xl"
              >
                {hasSeriesScore ? (
                  <>
                    <span
                      className={
                        match.winnerTeamId === match.homeTeamId
                          ? "text-accent"
                          : "text-fg"
                      }
                    >
                      {match.homeScore}
                    </span>
                    <span
                      aria-hidden
                      className="text-xl font-normal text-muted/50 sm:text-3xl"
                    >
                      –
                    </span>
                    <span
                      className={
                        match.winnerTeamId === match.awayTeamId
                          ? "text-accent"
                          : "text-fg"
                      }
                    >
                      {match.awayScore}
                    </span>
                  </>
                ) : (
                  <span className="text-2xl font-medium text-muted sm:text-4xl">
                    VS
                  </span>
                )}
              </div>
              <span className="mt-2 block text-[10px] font-medium uppercase tracking-[0.2em] text-muted">
                series
              </span>
            </div>
            <TeamSide
              name={match.awayTeam.name}
              teamId={match.awayTeamId}
              logoUrl={match.awayTeam.logoUrl}
              win={match.winnerTeamId === match.awayTeamId}
            />
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3 border-t border-line/60 pt-4 text-center text-sm text-muted">
            {match.scheduledAt ? (
              <LocalTime
                ts={match.scheduledAt.getTime()}
                variant="full"
                initial={formatMatchTime(match.scheduledAt, "full")}
              />
            ) : (
              <span>Kickoff time TBD</span>
            )}
            {pickVerdict ? (
              <PickemTray
                control={pickVerdict}
                matchId={match.id}
                roundLabel={postseasonLabel}
                home={{
                  id: match.homeTeamId,
                  name: match.homeTeam.name,
                  logoUrl: match.homeTeam.logoUrl,
                }}
                away={{
                  id: match.awayTeamId,
                  name: match.awayTeam.name,
                  logoUrl: match.awayTeam.logoUrl,
                }}
                locksAt={null}
                called={calledItCount(pickemCalls, match)}
              />
            ) : null}
            {showCaptainTools ? (
              // Lands on lobby setup and reporting, which now follow the
              // reschedule and standin cards; anything waiting on the
              // captain there gets its own line under the scoreboard.
              <a
                href={`#${
                  matchResultsOpen(match.season.status, match.phase)
                    ? MATCH_ANCHOR.report
                    : MATCH_ANCHOR.tools
                }`}
                className={buttonClasses("primary", "sm")}
              >
                {!matchResultsOpen(match.season.status, match.phase)
                  ? "Captain tools ↓"
                  : match.status === "LIVE" || games.length > 0
                    ? "Record next game ↓"
                    : "Set up & report ↓"}
              </a>
            ) : null}
          </div>
        </CardBody>
        {games.length > 0 ? (
          <div className="relative flex flex-wrap justify-center gap-2 border-t border-line bg-bg/30 px-3 py-3">
            {games.map((game, index) => {
              const winner =
                game.winnerTeamId === match.homeTeamId
                  ? match.homeTeam
                  : game.winnerTeamId === match.awayTeamId
                    ? match.awayTeam
                    : null;
              return (
                <a
                  key={game.id}
                  href={`#game-${game.id}`}
                  className="flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-line bg-surface/80 px-3 py-2 text-xs transition-colors hover:border-muted hover:bg-surface-2"
                >
                  <span className="shrink-0 font-semibold">
                    Game {index + 1}
                  </span>
                  {winner ? (
                    <>
                      <TeamCrest
                        name={winner.name}
                        seed={winner.id}
                        logoUrl={winner.logoUrl}
                        size={20}
                      />
                      <span className="min-w-0 text-muted [overflow-wrap:anywhere]">
                        {winner.name} won
                      </span>
                    </>
                  ) : (
                    <span className="text-muted">
                      Box score <LinkArrow />
                    </span>
                  )}
                </a>
              );
            })}
          </div>
        ) : null}
      </Card>

      {/* Between games, being ready for the next one is the only thing a
          player has to do here, so it sits right under the scoreboard, not
          after every box score. It renders only for players on either side. */}
      {match.status === "LIVE" && match.season.isActive ? (
        <Suspense fallback={null}>
          <LiveSeriesCheckin matchId={match.id} names={!hasPreview} />
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
        <RescheduleSection match={match} />
      ) : null}

      <section
        id="match-games"
        className="scroll-mt-24 space-y-6"
        aria-label={hasPreview ? "Match preview" : "Match games"}
      >
        {games.length === 0 && match.status !== "COMPLETED" ? (
          <Suspense fallback={<CardSkeleton rows={5} />}>
            {/* Rosters, scouting (scans all seasons' box scores) and the stakes
              banner stream in so the header + check-in paint immediately. */}
            <MatchPreview match={match} roundLabel={postseasonLabel} />
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
          games.map((g, i) => {
            const radiant = g.parsed.filter((p) => p.isRadiant);
            const dire = g.parsed.filter((p) => !p.isRadiant);
            const winnerName = g.winnerTeamId
              ? teamName.get(g.winnerTeamId)
              : null;
            const radiantName = g.radiantTeamId
              ? (teamName.get(g.radiantTeamId) ?? "Radiant")
              : "Radiant";
            const direName = g.direTeamId
              ? (teamName.get(g.direTeamId) ?? "Dire")
              : "Dire";
            const maxNet = Math.max(1, ...g.parsed.map((p) => p.netWorth ?? 0));
            const mvpId = gameMvp(g.parsed, g.radiantWin);
            const radiantNet = radiant.reduce(
              (s, p) => s + (p.netWorth ?? 0),
              0,
            );
            const direNet = dire.reduce((s, p) => s + (p.netWorth ?? 0), 0);
            // 0s / 0-0 means the header stats never got reported — showing
            // "0m 0s · 0-0 kills" reads as a real (absurd) game.
            const gameLine =
              [
                g.durationSecs > 0
                  ? `${Math.floor(g.durationSecs / 60)}m ${g.durationSecs % 60}s`
                  : null,
                g.radiantScore + g.direScore > 0
                  ? `${g.radiantScore}-${g.direScore} kills`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined;
            const openDota = (
              <a
                href={`https://www.opendota.com/matches/${g.dotaMatchId}`}
                target="_blank"
                rel="noreferrer"
                className={textLink("whitespace-nowrap text-xs")}
              >
                OpenDota <LinkArrow out />
              </a>
            );
            const boxScore = (
              <>
                <CardBody className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
                  <NetWorthAdvantage
                    radiantName={radiantName}
                    direName={direName}
                    radiantNet={radiantNet}
                    direNet={direNet}
                  />
                  <SidePlayers
                    label={radiantName}
                    win={g.radiantWin}
                    mvpId={mvpId}
                    players={radiant}
                    userName={userName}
                    userAvatar={userAvatar}
                    maxNet={maxNet}
                  />
                  <SidePlayers
                    label={direName}
                    win={!g.radiantWin}
                    mvpId={mvpId}
                    players={dire}
                    userName={userName}
                    userAvatar={userAvatar}
                    maxNet={maxNet}
                  />
                </CardBody>
                {viewer?.role === "ADMIN" ? <GameIdentityEditor gameId={g.id} /> : null}
              </>
            );
            if (i === 0) {
              return (
                <Card
                  key={g.id}
                  id={`game-${g.id}`}
                  className="scroll-mt-24 overflow-hidden"
                >
                  <CardHeader
                    title={`Game ${i + 1}`}
                    headingLevel={2}
                    subtitle={gameLine}
                    action={
                      <div className="flex items-center gap-2">
                        {winnerName ? (
                          <Badge tone="success">{winnerName} won</Badge>
                        ) : null}
                        {openDota}
                      </div>
                    }
                  />
                  {boxScore}
                </Card>
              );
            }
            // Later games fold to their result line, as /inhouse does: a
            // full box score is about 1,760px on a phone, so an open Bo3 was
            // 7,000px. The id stays on the <details>, and a jump from the
            // scoreboard's Game chips (or a shared #game- link) opens it.
            return (
              <Card key={g.id} className="overflow-hidden">
                <AutoOpenDetails
                  id={`game-${g.id}`}
                  className="group/game scroll-mt-24"
                >
                  <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-4 transition-colors hover:bg-surface-2/40 [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1 basis-48">
                      <h2 className="text-base font-semibold leading-snug text-fg">
                        Game {i + 1}
                      </h2>
                      {gameLine ? (
                        <p className="mt-1.5 text-sm text-muted">{gameLine}</p>
                      ) : null}
                    </div>
                    <span className="flex min-w-0 items-center gap-3">
                      {winnerName ? (
                        <Badge tone="success">{winnerName} won</Badge>
                      ) : null}
                      <span
                        aria-hidden
                        className="text-muted transition-transform group-open/game:rotate-180 motion-reduce:transition-none"
                      >
                        ▾
                      </span>
                    </span>
                  </summary>
                  <div className="border-t border-line-soft">
                    <p className="flex justify-end px-5 pt-4">{openDota}</p>
                    {boxScore}
                  </div>
                </AutoOpenDetails>
              </Card>
            );
          })
        )}
      </section>

      {showCorrectionNote ? (
        <p className="text-sm text-muted">
          Result wrong? Send an admin this page and the Dota match ID.
        </p>
      ) : null}
      {showCaptainTools ? (
        <section
          id={MATCH_ANCHOR.tools}
          className="scroll-mt-24 space-y-4"
          aria-labelledby="match-tools-title"
        >
          <div className="flex items-center gap-3 border-t border-line pt-6">
            <span
              aria-hidden
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent"
            >
              ◇
            </span>
            <h2
              id="match-tools-title"
              className="font-display text-2xl font-semibold"
            >
              Captain tools
            </h2>
            <Badge className="ml-auto">Your match</Badge>
          </div>
          <OpposingCaptain
            captainId={
              match.homeTeam.captainId === viewer!.id
                ? match.awayTeam.captainId
                : match.homeTeam.captainId
            }
            showContact={canViewLeagueContact(
              viewer,
              match.homeTeam.captainId === viewer!.id
                ? match.awayTeam.captainId
                : match.homeTeam.captainId,
              // A captain of this match in the active season: agreeing the
              // lobby and any new time with the other captain is their job.
              isCaptain,
            )}
          />
          {/* These components keep their own write-time capability gates,
              including locked reporting and stranded-proposal cleanup. The
              cards that may need an answer (a proposed time, a player who
              can't make it) come first; lobby setup and reporting follow,
              with their own anchor for the scoreboard's jump. */}
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <div className="min-w-0 empty:hidden">
              <RescheduleSection match={match} />
            </div>
            <div className="min-w-0 empty:hidden">
              <StandinSection
                match={match}
                seriesStarted={games.length > 0}
              />
            </div>
          </div>
          <div id={MATCH_ANCHOR.report} className="scroll-mt-24">
            <ReportResultSection match={match} renderedAt={renderedAt} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * One line per thing waiting on this captain, each linking to the card that
 * answers it: a player on their roster who can't make it and has no cover, and
 * a time the other captain proposed. Both cards sit inside Captain tools,
 * below the scoreboard and any box scores; without this a captain arriving
 * from a Discord ping had to scroll a phone-height or more to learn anything
 * was waiting. Each line uses the same capability gate as its card, so it
 * never points at a card that isn't there.
 */
async function CaptainTodos({
  match,
  viewerId,
}: {
  match: {
    id: string;
    seasonId: string;
    status: string;
    scheduleRevision: number;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { captainId: string };
    awayTeam: { captainId: string };
    season: { isActive: boolean; status: string };
    standins: { replaced: { id: string } | null }[];
  };
  viewerId: string;
}) {
  const myTeamId =
    match.homeTeam.captainId === viewerId
      ? match.homeTeamId
      : match.awayTeam.captainId === viewerId
        ? match.awayTeamId
        : null;
  if (!myTeamId || !match.season.isActive) return null;
  const [draft, roster, outRows, pending] = await Promise.all([
    prisma.draft.findUnique({
      where: { seasonId: match.seasonId },
      select: { status: true },
    }),
    prisma.teamMember.findMany({
      where: { seasonId: match.seasonId, teamId: myTeamId },
      select: { userId: true, user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.matchAvailability.findMany({
      where: {
        matchId: match.id,
        status: "OUT",
        scheduleRevision: match.scheduleRevision,
      },
      select: { userId: true },
    }),
    prisma.rescheduleRequest.findFirst({
      where: {
        matchId: match.id,
        status: "PENDING",
        proposedById: { not: viewerId },
      },
      select: { proposedTime: true, proposedBy: { select: { name: true } } },
    }),
  ]);
  const uncoveredOut = standinAssignmentOpen(
    match.season.status,
    draft?.status,
    match.status,
  )
    ? coverChoices(
        roster,
        new Set(outRows.map((r) => r.userId)),
        new Set(
          match.standins.flatMap((s) => (s.replaced ? [s.replaced.id] : [])),
        ),
      )
        .choices.filter((c) => c.out)
        .map((c) => c.member.user.name)
    : [];
  const answer =
    pending &&
    matchLogisticsOpen(match.season.status, draft?.status, match.status)
      ? pending
      : null;
  if (uncoveredOut.length === 0 && !answer) return null;
  return (
    <ul
      aria-label="Waiting on you"
      className="space-y-2 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-4 py-3 text-sm"
    >
      {uncoveredOut.length > 0 ? (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
            <span aria-hidden>✗ </span>
            <strong>{uncoveredOut.join(", ")}</strong>{" "}
            {uncoveredOut.length === 1
              ? "can't make it and has no cover yet."
              : "can't make it and have no cover yet."}
          </span>
          <a
            href={`#${MATCH_ANCHOR.standins}`}
            className={textLink("shrink-0 font-medium")}
          >
            Find a standin <span aria-hidden>↓</span>
          </a>
        </li>
      ) : null}
      {answer ? (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
            <span aria-hidden>⏳ </span>
            <strong>{answer.proposedBy.name}</strong> proposed moving this
            match to{" "}
            <strong>
              <LocalTime
                ts={answer.proposedTime.getTime()}
                variant="full"
                initial={formatMatchTime(answer.proposedTime, "full")}
              />
            </strong>
            .
          </span>
          <a
            href={`#${MATCH_ANCHOR.reschedule}`}
            className={textLink("shrink-0 font-medium")}
          >
            Answer <span aria-hidden>↓</span>
          </a>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * "Opposing captain: <name> <copyable Discord handle>" at the top of Captain
 * tools. Captains agree lobby times, hosting and reschedules with each other,
 * and the handle used to be a team page or profile away.
 */
async function OpposingCaptain({
  captainId,
  showContact,
}: {
  captainId: string;
  /** canViewLeagueContact's answer for this viewer and captain. */
  showContact: boolean;
}) {
  const captain = await prisma.user.findUnique({
    where: { id: captainId },
    select: { id: true, name: true, discordName: true, discordId: true },
  });
  if (!captain) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
      <span>Opposing captain:</span>
      <PlayerLink
        userId={captain.id}
        className="font-medium text-fg [overflow-wrap:anywhere]"
      >
        {captain.name}
      </PlayerLink>
      {showContact ? (
        captain.discordName ? (
          <DiscordTag
            name={captain.discordName}
            verified={!!captain.discordId}
          />
        ) : (
          <span className="text-xs">(no Discord on file)</span>
        )
      ) : null}
    </p>
  );
}

// Pre-match scouting: rosters, recent form, prior meetings, and who's
// confirmed for match night — shown until the first game is recorded.
async function MatchPreview({
  match,
  roundLabel,
}: {
  /** matchRoundLabel of this fixture, for the pick'em tray's legend. */
  roundLabel: string;
  match: {
    id: string;
    seasonId: string;
    week: number;
    phase: string;
    status: string;
    winnerTeamId: string | null;
    scheduledAt: Date | null;
    scheduleRevision: number;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { name: string; logoUrl: string | null; captainId: string };
    awayTeam: { name: string; logoUrl: string | null; captainId: string };
    standins: {
      id: string;
      teamId: string;
      standin: { id: string; name: string };
      replaced: { id: string; name: string } | null;
    }[];
  };
}) {
  const viewer = await getSessionUser();
  const canSeeNamedAvailability = canViewNamedMatchAvailability(
    viewer,
    match.homeTeam.captainId,
    match.awayTeam.captainId,
  );
  const [members, seasonMatches, rsvps] = await Promise.all([
    prisma.teamMember.findMany({
      where: {
        seasonId: match.seasonId,
        teamId: { in: [match.homeTeamId, match.awayTeamId] },
      },
      include: { user: true },
      orderBy: { price: "desc" },
    }),
    prisma.match.findMany({
      where: { seasonId: match.seasonId },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    viewer
      ? prisma.matchAvailability.findMany({
          where: {
            matchId: match.id,
            scheduleRevision: match.scheduleRevision,
            ...(canSeeNamedAvailability ? {} : { userId: viewer.id }),
          },
          select: { userId: true, status: true },
        })
      : Promise.resolve([]),
  ]);
  const regs = await prisma.registration.findMany({
    where: {
      seasonId: match.seasonId,
      userId: { in: members.map((m) => m.userId) },
    },
    select: { userId: true, roles: true, mmr: true },
  });
  const regByUser = new Map(regs.map((r) => [r.userId, r]));
  const rsvpByUser = new Map(rsvps.map((r) => [r.userId, r.status]));

  // Mirror setAvailability's decisive capability gate: an RSVP is about one
  // published, upcoming match night. LIVE readiness is its own banner
  // (LiveSeriesCheckin), including after the first game's import.
  const [previewSeason, previewDraft, myPrediction, viewerRegistration] =
    await Promise.all([
      prisma.season.findUnique({
        where: { id: match.seasonId },
        select: { isActive: true, status: true },
      }),
      prisma.draft.findUnique({
        where: { seasonId: match.seasonId },
        select: { status: true },
      }),
      // Signed-in only: the Matchup card's pick tray (pickemControlFor below).
      viewer
        ? prisma.prediction.findUnique({
            where: { matchId_userId: { matchId: match.id, userId: viewer.id } },
            select: { pickedTeamId: true },
          })
        : Promise.resolve(null),
      // The Matchup card's captain contact chips (canViewLeagueContact below).
      viewer
        ? prisma.registration.findUnique({
            where: {
              seasonId_userId: { seasonId: match.seasonId, userId: viewer.id },
            },
            select: { status: true },
          })
        : Promise.resolve(null),
    ]);
  // Each captain's Discord handle, for the people allowed league contact:
  // admins, active registrants (standins included, who need to reach the
  // captain they cover for) and the two captains of this match.
  const viewerIsMatchCaptain =
    !!viewer &&
    (viewer.id === match.homeTeam.captainId ||
      viewer.id === match.awayTeam.captainId);
  const captainContact = (captainId: string) =>
    canViewLeagueContact(
      viewer,
      captainId,
      !!previewSeason?.isActive &&
        (viewerRegistration?.status === REGISTRATION_STATUS.ACTIVE ||
          viewerIsMatchCaptain),
    );
  const nightRoster = (teamId: string) =>
    matchNightRoster(
      members.filter((m) => m.teamId === teamId).map((m) => m.userId),
      match.standins
        .filter((s) => s.teamId === teamId)
        .map((s) => ({
          standinUserId: s.standin.id,
          replacingUserId: s.replaced?.id ?? null,
        })),
    );
  const activeNightRoster = new Set(
    [match.homeTeamId, match.awayTeamId].flatMap(nightRoster),
  );
  // Async server component: this captures request time once for the stale-
  // fixture guard; it is not client render state.
  // eslint-disable-next-line react-hooks/purity
  const previewNow = Date.now();
  const checkinOpen =
    match.status !== "LIVE" &&
    !!previewSeason?.isActive &&
    matchCheckinOpen(
      previewSeason.status,
      previewDraft?.status,
      match.status,
      match.scheduledAt,
      previewNow,
    );
  const isParticipant =
    !!viewer && checkinOpen && activeNightRoster.has(viewer.id);
  // The banner's side line (counts only: the Matchup card below already
  // names each answer for the captains who may see them).
  const checkinSideView =
    isParticipant && viewer
      ? await loadCheckinSide({ matchId: match.id, viewer, names: false })
      : null;
  const myRsvp = viewer ? (rsvpByUser.get(viewer.id) ?? null) : null;
  // A captain's optional "Remind the N who haven't answered" under their own
  // side: shown only while check-in is open, someone else on their side owes
  // an answer, and the league has a Discord channel. Once sent, it says when
  // the next one is allowed instead (sendCheckinNudge's throttle).
  const nudgeTeamId =
    viewer?.id === match.homeTeam.captainId
      ? match.homeTeamId
      : viewer?.id === match.awayTeam.captainId
        ? match.awayTeamId
        : null;
  const nudgeWaiting =
    nudgeTeamId && checkinOpen
      ? teamAvailability(
          nightRoster(nudgeTeamId),
          rsvps,
        ).unansweredUserIds.filter((id) => id !== viewer!.id).length
      : 0;
  const nudge =
    nudgeTeamId && nudgeWaiting > 0 && (await getWebhookUrl())
      ? {
          teamId: nudgeTeamId,
          waiting: nudgeWaiting,
          sentAt: await checkinNudgeBlockedSince(
            match.id,
            nudgeTeamId,
            match.scheduleRevision,
            previewNow,
          ),
        }
      : null;
  // Same rule as the dashboard's This-week cards. The season gate mirrors
  // /pickem's canPlay: savePrediction only ever writes to the ACTIVE season,
  // so an archived fixture must never render live buttons.
  const pick = pickemControlFor(
    match,
    {
      signedIn: !!viewer,
      canPlay:
        !!previewSeason?.isActive &&
        postAuctionWorkOpen(previewSeason.status, previewDraft?.status),
      pickedTeamId: myPrediction?.pickedTeamId,
    },
    new Date(previewNow),
  );

  const h2hRow = headToHead(match.homeTeamId, seasonMatches).find(
    (h) => h.opponentId === match.awayTeamId,
  );

  const side = (
    teamId: string,
    name: string,
    logoUrl: string | null,
    captainId: string,
  ) => {
    const roster = members.filter((m) => m.teamId === teamId);
    const captainRow = roster.find((m) => m.userId === captainId);
    const captain =
      captainRow?.user.discordName && captainContact(captainId)
        ? captainRow.user
        : null;
    const subs = match.standins.filter((s) => s.teamId === teamId);
    const replacedIds = new Set(
      subs.map((s) => s.replaced?.id).filter(Boolean),
    );
    const form = recentForm(
      teamId,
      seasonMatches.filter(
        (m) => m.homeTeamId === teamId || m.awayTeamId === teamId,
      ),
    );
    return { teamId, name, logoUrl, roster, subs, replacedIds, form, captain };
  };
  const sides = [
    side(
      match.homeTeamId,
      match.homeTeam.name,
      match.homeTeam.logoUrl,
      match.homeTeam.captainId,
    ),
    side(
      match.awayTeamId,
      match.awayTeam.name,
      match.awayTeam.logoUrl,
      match.awayTeam.captainId,
    ),
  ];

  return (
    <div className="space-y-6">
      {isParticipant ? (
        <CheckinBanner
          matchId={match.id}
          scheduleRevision={match.scheduleRevision}
          remainingGames={match.status === "LIVE"}
          heading="You're playing in this match"
          viewerIsCaptain={
            viewer?.id === match.homeTeam.captainId ||
            viewer?.id === match.awayTeam.captainId
          }
          when={
            match.scheduledAt
              ? formatMatchTime(match.scheduledAt, "full")
              : undefined
          }
          whenTs={match.scheduledAt?.getTime()}
          myRsvp={myRsvp}
          side={checkinSideView}
        />
      ) : !viewer && checkinOpen ? (
        // Signed out, nothing above tells a player they can check in here.
        // Sign-in returns to this page, where the banner then appears.
        <p className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm text-muted">
          Playing in this match?{" "}
          <Link href={signInHref(`/matches/${match.id}`)} className={textLink()}>
            Sign in to check in
          </Link>
        </p>
      ) : null}

      <StakesBanner match={match} seasonMatches={seasonMatches} />

      <Card id="match-matchup" className="scroll-mt-24 overflow-hidden">
        <CardHeader
          title="Matchup"
          headingLevel={2}
          subtitle={
            h2hRow && h2hRow.wins + h2hRow.losses + h2hRow.draws > 0
              ? `Prior meetings: ${
                  h2hRow.wins > h2hRow.losses
                    ? `${match.homeTeam.name} lead ${h2hRow.wins}–${h2hRow.losses}`
                    : h2hRow.losses > h2hRow.wins
                      ? `${match.awayTeam.name} lead ${h2hRow.losses}–${h2hRow.wins}`
                      : `tied ${h2hRow.wins}–${h2hRow.losses}`
                }${h2hRow.draws ? ` (${h2hRow.draws} drawn)` : ""}`
              : "First meeting this season"
          }
        />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {sides.map((s) => (
            <div key={s.teamId} className="rounded-lg border border-line p-3">
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <Link
                  href={`/teams/${s.teamId}`}
                  className="flex min-w-0 items-center gap-2 font-display text-base font-semibold hover:text-info"
                >
                  <TeamCrest
                    name={s.name}
                    seed={s.teamId}
                    logoUrl={s.logoUrl}
                    size={24}
                    className="rounded-md"
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {s.name}
                  </span>
                </Link>
                {s.form.length > 0 ? <FormStrip form={s.form} /> : null}
              </div>
              {/* Its own line, not squeezed into the captain's roster row,
                  which already truncates the name on a phone. */}
              {s.captain ? (
                <p className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span>Captain&apos;s Discord</span>
                  <DiscordTag
                    name={s.captain.discordName}
                    verified={!!s.captain.discordId}
                  />
                </p>
              ) : null}
              <ul className="space-y-1">
                {s.roster.map((m) => {
                  const reg = regByUser.get(m.userId);
                  const rsvp = rsvpByUser.get(m.userId);
                  const replaced = s.replacedIds.has(m.userId);
                  return (
                    <li
                      key={m.id}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm",
                        replaced && "opacity-50",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar
                          name={m.user.name}
                          src={m.user.avatar}
                          size={22}
                        />
                        <PlayerLink userId={m.userId} className="truncate">
                          {m.user.name}
                        </PlayerLink>
                        {m.isCaptain ? <Badge tone="accent">C</Badge> : null}
                        <RankBadge rankTier={m.user.rankTier} />
                        <RoleBadges roles={reg?.roles ?? ""} />
                      </span>
                      {replaced || canSeeNamedAvailability ? (
                        <span className="shrink-0 text-xs">
                          {replaced ? (
                            <span className="text-muted">standin covers</span>
                          ) : rsvp === "IN" ? (
                            <span className="text-success">✓ in</span>
                          ) : rsvp === "OUT" ? (
                            <span className="text-danger">✗ out</span>
                          ) : (
                            <span className="text-muted">no reply</span>
                          )}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
                {s.subs.map((sub) => {
                  // Standins RSVP like everyone else — captains need to see
                  // whether the cover actually confirmed for match night.
                  const subRsvp = rsvpByUser.get(sub.standin.id);
                  return (
                    <li
                      key={sub.id}
                      className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="text-xs">🔁</span>
                        <PlayerLink
                          userId={sub.standin.id}
                          className="truncate"
                        >
                          {sub.standin.name}
                        </PlayerLink>
                        <span className="truncate text-xs text-muted">
                          {sub.replaced
                            ? `in for ${sub.replaced.name}`
                            : "filling an open seat"}
                        </span>
                      </span>
                      {canSeeNamedAvailability ? (
                        <span className="shrink-0 text-xs">
                          {subRsvp === "IN" ? (
                            <span className="text-success">✓ in</span>
                          ) : subRsvp === "OUT" ? (
                            <span className="text-danger">✗ out</span>
                          ) : (
                            <span className="text-muted">no reply</span>
                          )}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {nudge && s.teamId === nudge.teamId ? (
                nudge.sentAt ? (
                  <p className="mt-3 border-t border-line-soft pt-2 text-xs text-muted">
                    Check-in reminder sent{" "}
                    <LocalTime
                      ts={nudge.sentAt.getTime()}
                      variant="short"
                      initial={formatMatchTime(nudge.sentAt, "short")}
                    />
                    . You can send another from{" "}
                    <LocalTime
                      ts={
                        nudge.sentAt.getTime() +
                        CHECKIN_NUDGE_THROTTLE_SECONDS * 1000
                      }
                      variant="short"
                      initial={formatMatchTime(
                        new Date(
                          nudge.sentAt.getTime() +
                            CHECKIN_NUDGE_THROTTLE_SECONDS * 1000,
                        ),
                        "short",
                      )}
                    />
                    .
                  </p>
                ) : (
                  <ActionForm
                    action={remindUnansweredCheckins}
                    hidden={{ matchId: match.id }}
                    className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-soft pt-3"
                  >
                    <SubmitButton variant="secondary" size="sm">
                      {nudge.waiting === 1
                        ? "Remind the 1 who hasn't answered"
                        : `Remind the ${nudge.waiting} who haven't answered`}
                    </SubmitButton>
                    <span className="text-xs text-muted">
                      One Discord post that pings only them.
                    </span>
                  </ActionForm>
                )
              ) : null}
            </div>
          ))}
        </CardBody>
        {pick ? (
          <PickemTray
            control={pick}
            matchId={match.id}
            roundLabel={roundLabel}
            home={{
              id: match.homeTeamId,
              name: match.homeTeam.name,
              logoUrl: match.homeTeam.logoUrl,
            }}
            away={{
              id: match.awayTeamId,
              name: match.awayTeam.name,
              logoUrl: match.awayTeam.logoUrl,
            }}
            locksAt={match.scheduledAt?.getTime() ?? null}
            className="border-t border-line-soft px-5 py-4"
          />
        ) : null}
      </Card>

      <ScoutingReport
        sides={sides.map((s) => ({
          teamId: s.teamId,
          name: s.name,
          logoUrl: s.logoUrl,
          roster: s.roster.map((m) => ({
            userId: m.userId,
            name: m.user.name,
            roles: regByUser.get(m.userId)?.roles ?? "",
            pubStats: m.user.pubStats,
            pubStatsAt: m.user.pubStatsAt,
          })),
        }))}
      />
    </div>
  );
}

/**
 * "Tonight's stakes": what this match means for the playoff race, from the
 * exact scenario engine. Renders only when the night actually decides
 * something (win-and-in / lose-and-out / magic number 1) or a side's fate is
 * already sealed — early-season "everyone's in the hunt" stays silent.
 */
async function StakesBanner({
  match,
  seasonMatches,
}: {
  match: {
    id: string;
    seasonId: string;
    phase: string;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { name: string; logoUrl: string | null };
    awayTeam: { name: string; logoUrl: string | null };
  };
  // Passed down from MatchPreview, which already loaded the season's matches.
  seasonMatches: (StakesMatchRow & {
    homeScore: number;
    awayScore: number;
    winnerTeamId: string | null;
  })[];
}) {
  if (match.phase !== "REGULAR") return null;
  const season = await prisma.season.findUnique({
    where: { id: match.seasonId },
    select: { status: true },
  });
  if (season?.status !== "REGULAR_SEASON") return null;

  const teams = await prisma.team.findMany({
    where: { seasonId: match.seasonId },
    select: { id: true, name: true, withdrawn: true },
  });
  const playoffField = projectPlayoffField(teams, seasonMatches);
  const report = seasonScenarioReport(
    playoffField.eligibleStandings,
    seasonMatches,
    playoffField.eligibleTeamIds.length,
    playoffField,
  );
  if (!report) return null;

  const sides = [match.homeTeamId, match.awayTeamId].flatMap((teamId) => {
    const scenario = report.teams.get(teamId);
    return scenario ? [{ teamId, scenario }] : [];
  });
  if (!sides.some(({ scenario }) => scenario.paths || scenario.status || scenario.outlook)) return null;
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));

  const nameOf = new Map([
    [match.homeTeamId, match.homeTeam.name],
    [match.awayTeamId, match.awayTeam.name],
  ]);
  const logoOf = new Map([
    [match.homeTeamId, match.homeTeam.logoUrl],
    [match.awayTeamId, match.awayTeam.logoUrl],
  ]);
  return (
    <Card className="border-accent/30">
      <CardHeader
        title="Tonight's stakes"
        headingLevel={2}
        subtitle="How each feasible result changes playoff qualification"
      />
      <CardBody className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {sides.map((s) => {
          const status = report.teams.get(s.teamId)?.status ?? null;
          return (
            <div
              key={s.teamId}
              className={cn(
                "flex min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-sm",
                status === "CLINCHED"
                  ? "border-success/30 bg-success/5"
                  : status === "ELIMINATED"
                    ? "border-line bg-surface-2/40 text-muted"
                    : "border-accent/30 bg-accent/5",
              )}
            >
              <TeamCrest
                name={nameOf.get(s.teamId) ?? "?"}
                seed={s.teamId}
                logoUrl={logoOf.get(s.teamId)}
                size={22}
                className="shrink-0 rounded-md"
              />
              <div className="min-w-0 flex-1">
                <p className="mb-2 font-medium">
                  {nameOf.get(s.teamId) ?? "?"}
                </p>
                <PlayoffOutlook scenario={s.scenario} teamNames={teamNames} matchId={match.id} />
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

/**
 * The pre-match dossier: each player's comfort heroes and the team's heroes to
 * ban, from every box score the league has ever stored (both teams visible to
 * everyone; it's all public data). A hero shows only with SCOUT_MIN_GAMES
 * games behind it: at this league's size one game is noise. A player with no
 * such hero shows their stored pub heroes instead, labelled as pubs.
 *
 * Starts folded on phones, where it was about 1,000px, and opens by itself
 * on a wide screen or when the Scouting jump lands on it.
 */
async function ScoutingReport({
  sides,
}: {
  sides: {
    teamId: string;
    name: string;
    logoUrl: string | null;
    roster: {
      userId: string;
      name: string;
      roles: string;
      pubStats: string | null;
      pubStatsAt: Date | null;
    }[];
  }[];
}) {
  // Uncached on purpose — see fetchAllGamesForScouting in cached-queries.ts:
  // the unstable_cache wrapper hangs inside this nested Suspense boundary.
  const allGames = await fetchGamesForScouting(sides.flatMap((side) => side.roster.map((player) => player.userId)));
  const scoutGames: ScoutGame[] = allGames.map((g) => ({
    radiantWin: g.radiantWin,
    durationSecs: g.durationSecs,
    startTime: g.startTime,
    lines: trustedGamePlayers(decodeGamePlayers(g.players)).map((p) => ({
      userId: p.userId,
      heroId: p.heroId,
      isRadiant: p.isRadiant,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
    })),
  }));
  // Async server component: request time once, for the pub snapshots' age.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  const dossiers = sides.map((side) => {
    const ids = side.roster.map((r) => r.userId);
    const board = threatBoard(ids, scoutGames);
    const pools = side.roster.map((r) => playerHeroPool(r.userId, scoutGames));
    const comfort = side.roster.flatMap((r, i) => {
      const picks = comfortPicks(
        pools[i],
        parsePubStats(r.pubStats)?.topHeroes,
      );
      return picks
        ? [
            {
              userId: r.userId,
              name: r.name,
              picks,
              checked: pubCheckedAgo(r.pubStatsAt?.getTime() ?? null, nowMs),
            },
          ]
        : [];
    });
    return {
      ...side,
      threats: threatList(board),
      threatsFloor: board.minPicks,
      comfort,
      coverage: roleCoverage(side.roster),
      empty: dossierEmpty(pools, board),
    };
  });
  const anyPubs = dossiers.some((d) =>
    d.comfort.some((c) => c.picks.source === "pubs"),
  );

  return (
    <Card className="overflow-hidden">
      <AutoOpenDetails
        id="match-scouting"
        openFromWidth="64rem"
        className="group/scouting scroll-mt-24"
      >
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-2/40 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold leading-snug text-fg">
              Scouting report
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              Heroes played twice or more in league games
            </p>
          </div>
          <span
            aria-hidden
            className="mt-0.5 text-muted transition-transform group-open/scouting:rotate-180 motion-reduce:transition-none"
          >
            ▾
          </span>
        </summary>
        <CardBody className="grid grid-cols-1 gap-4 border-t border-line-soft lg:grid-cols-2">
          {dossiers.map((d) => (
            <div
              key={d.teamId}
              className="min-w-0 rounded-lg border border-line p-3"
            >
              <div className="mb-2.5 flex min-w-0 items-center gap-2">
                <TeamCrest
                  name={d.name}
                  seed={d.teamId}
                  logoUrl={d.logoUrl}
                  size={22}
                  className="rounded-md"
                />
                <span className="min-w-0 font-display text-base font-semibold [overflow-wrap:anywhere]">
                  {d.name}
                </span>
              </div>
              {d.threats.rows.length === 0 && d.comfort.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted">
                  {d.empty
                    ? "No league history yet — they're a mystery."
                    : "No hero played twice in league games yet."}
                </p>
              ) : (
                <div className="space-y-3">
                  <ThreatList threats={d.threats} minPicks={d.threatsFloor} />
                  <ComfortPicks players={d.comfort} />
                </div>
              )}
              <RoleGaps coverage={d.coverage} />
            </div>
          ))}
          {anyPubs ? (
            <p className="text-xs text-muted lg:col-span-2">
              <span className="font-medium">pubs</span>: no hero played twice
              in league games yet, so these are the player&apos;s most-played
              heroes in public games, from their last profile sync.
            </p>
          ) : null}
        </CardBody>
      </AutoOpenDetails>
    </Card>
  );
}

function ThreatList({
  threats,
  minPicks,
}: {
  threats: ScoutThreats;
  minPicks: number;
}) {
  if (threats.rows.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        {threats.ranked ? `Ban board (${minPicks}+ picks)` : "Most picked"}
      </div>
      <ul className="space-y-1">
        {threats.rows.map((r) => {
          const hero = heroById(r.heroId);
          return (
            <li key={r.heroId} className="flex items-center gap-2 text-sm">
              {hero ? (
                <HeroIcon hero={hero} size={22} />
              ) : (
                <span className="h-[22px] w-[22px] shrink-0 rounded border border-line/70 bg-surface-2" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {hero?.name ?? `Hero ${r.heroId}`}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {r.wins}–{r.picks - r.wins}
                <span
                  className={cn(
                    "ml-2 font-medium",
                    r.winRate >= 60
                      ? "text-success"
                      : r.winRate < 40
                        ? "text-danger"
                        : "text-fg/80",
                  )}
                >
                  {r.winRate}%
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ComfortPicks({
  players,
}: {
  players: {
    userId: string;
    name: string;
    picks: ComfortPicksResult;
    /** How old the player's pub snapshot is ("3d ago"), when known. */
    checked: string | null;
  }[];
}) {
  if (players.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        Comfort picks
      </div>
      <ul className="space-y-1">
        {players.map((p) => {
          const pubs = p.picks.source === "pubs";
          return (
            <li key={p.userId} className="flex items-center gap-2 text-sm">
              <PlayerLink
                userId={p.userId}
                className="w-28 shrink-0 truncate text-xs"
              >
                {p.name}
              </PlayerLink>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {p.picks.heroes.map((h) => {
                  const hero = heroById(h.heroId);
                  const name = hero?.name ?? `Hero ${h.heroId}`;
                  const winRate = Math.round((h.wins / h.games) * 100);
                  const where = pubs ? "pub games" : "league games";
                  return (
                    <span
                      key={h.heroId}
                      role="img"
                      aria-label={`${name}: ${h.games} ${where}, ${winRate}% wins`}
                      title={`${name} — ${h.wins}–${h.games - h.wins} in ${where} (${winRate}%)${pubs && p.checked ? `, checked ${p.checked}` : ""}`}
                      className="inline-flex items-center gap-1 rounded border border-line bg-surface-2/50 px-1 py-px text-[11px]"
                    >
                      {hero ? <HeroIcon hero={hero} size={16} /> : null}
                      <span aria-hidden className="tabular-nums text-muted">
                        ×{h.games}
                      </span>
                    </span>
                  );
                })}
                {pubs ? (
                  <span className="text-xs text-muted">
                    pubs
                    {p.checked ? (
                      <span className="sr-only">, checked {p.checked}</span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Roles nobody on the roster declared, from their signups. */
function RoleGaps({ coverage }: { coverage: RoleCount[] }) {
  const gaps = coverage.filter((c) => c.count === 0);
  if (gaps.length === 0 || gaps.length >= 5) return null;
  return (
    <p className="mt-3 border-t border-line/70 pt-2 text-xs text-muted">
      No declared{" "}
      {gaps.map((g) => `${g.label.toLowerCase()} (${g.key})`).join(", ")} —
      somebody&apos;s flexing.
    </p>
  );
}

function TeamSide({
  name,
  teamId,
  logoUrl,
  win,
}: {
  name: string;
  teamId: string;
  logoUrl: string | null;
  win: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-3 self-stretch text-center">
      <div
        className={cn(
          "rounded-2xl border p-2 shadow-lg shadow-black/15",
          win ? "border-accent/40 bg-accent/5" : "border-line/60 bg-surface/60",
        )}
      >
        <TeamCrest
          name={name}
          seed={teamId}
          logoUrl={logoUrl}
          size={64}
          imageFit="cover"
          className="rounded-xl"
        />
      </div>
      <Link
        href={`/teams/${teamId}`}
        className="min-h-11 max-w-full content-center font-display text-base font-semibold leading-tight text-fg [overflow-wrap:anywhere] hover:text-info sm:text-2xl"
      >
        {name}
      </Link>
    </div>
  );
}

// The recorded team net-worth split from this game's box score, with an
// explicit gold lead. These totals are not a live net-worth timeline.
function NetWorthAdvantage({
  radiantName,
  direName,
  radiantNet,
  direNet,
}: {
  radiantName: string;
  direName: string;
  radiantNet: number;
  direNet: number;
}) {
  const total = radiantNet + direNet;
  if (total <= 0) return null;
  const radPct = Math.round((radiantNet / total) * 100);
  const lead = radiantNet - direNet;
  const leaderName = lead > 0 ? radiantName : direName;
  return (
    <div className="min-w-0 rounded-xl border border-line bg-bg/35 p-4 md:col-span-2">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-muted">Recorded net worth</span>
        <span className="min-w-0 text-fg [overflow-wrap:anywhere]">
          {lead === 0 ? (
            "Even"
          ) : (
            <>
              {leaderName}{" "}
              <strong className="font-mono text-accent">
                +{formatNetWorth(Math.abs(lead))}
              </strong>
            </>
          )}
        </span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-4">
        <div className="flex min-w-0 flex-col">
          <p className="text-xs text-emerald-300 [overflow-wrap:anywhere]">
            {radiantName}
          </p>
          <p className="mt-auto pt-1 font-display text-2xl font-semibold tabular-nums">
            {formatNetWorth(radiantNet)}
          </p>
        </div>
        <div className="flex min-w-0 flex-col text-right">
          <p className="text-xs text-rose-300 [overflow-wrap:anywhere]">
            {direName}
          </p>
          <p className="mt-auto pt-1 font-display text-2xl font-semibold tabular-nums">
            {formatNetWorth(direNet)}
          </p>
        </div>
      </div>
      <div
        role="img"
        aria-label={`${radiantName}: ${radiantNet.toLocaleString()} gold. ${direName}: ${direNet.toLocaleString()} gold.`}
        className="relative flex h-3 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div className="bg-emerald-400/80" style={{ width: `${radPct}%` }} />
        <div className="flex-1 bg-rose-400/80" />
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px bg-bg/70"
        />
      </div>
      <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>Radiant</span>
        <span>Dire</span>
      </div>
    </div>
  );
}

function SidePlayers({
  label,
  win,
  players,
  userName,
  userAvatar,
  maxNet,
  mvpId,
}: {
  label: string;
  win: boolean;
  players: PlayerStat[];
  userName: Map<string, string>;
  userAvatar: Map<string, string | null>;
  maxNet: number;
  mvpId?: string | null;
}) {
  const hasNet = players.some((p) => p.netWorth != null);
  const hasGpm = players.some((p) => p.gpm != null);
  const hasLh = players.some((p) => p.lastHits != null);
  // Order by farm so the net-worth bars descend, like Dota's post-game screen.
  const ordered = [...players].sort(
    (a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0) || b.kills - a.kills,
  );
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border p-3",
        win ? "border-success/40 bg-success/5" : "border-line",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 font-display text-base font-semibold [overflow-wrap:anywhere]">
            {label}
          </span>
          {win ? (
            <Badge tone="success" className="shrink-0">
              Win
            </Badge>
          ) : (
            <Badge className="shrink-0">Loss</Badge>
          )}
        </span>
        {/* No team net-worth total here: the Recorded net worth panel above
            both sides already prints it. */}
      </div>
      <ul className="space-y-0.5">
        {ordered.map((p, idx) => {
          const displayName = p.userId
            ? (userName.get(p.userId) ?? p.personaname ?? "Unknown")
            : (p.personaname ?? "Unknown");
          const hero = heroById(p.heroId);
          const heroName = hero?.name ?? `Hero ${p.heroId}`;
          const nwPct =
            p.netWorth != null ? Math.round((p.netWorth / maxNet) * 100) : 0;
          return (
            <li
              key={idx}
              className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-2/50"
            >
              <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2">
                {hero ? (
                  <HeroIcon hero={hero} size={30} />
                ) : (
                  <span className="text-xs text-muted">#{p.heroId}</span>
                )}
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                    {p.userId ? (
                      <span className="hidden sm:inline-flex">
                        <Avatar
                          name={displayName}
                          src={userAvatar.get(p.userId) ?? null}
                          size={18}
                        />
                      </span>
                    ) : null}
                    {p.userId ? (
                      <PlayerLink
                        userId={p.userId}
                        className="min-w-0 text-sm [overflow-wrap:anywhere]"
                      >
                        {displayName}
                      </PlayerLink>
                    ) : (
                      <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                        {displayName}
                      </span>
                    )}
                    {p.userId && p.userId === mvpId ? (
                      <Badge tone="accent" title="Best line of the game">
                        MVP
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-muted [overflow-wrap:anywhere]">
                    {heroName}
                  </div>
                </div>
                <KDA
                  kills={p.kills}
                  deaths={p.deaths}
                  assists={p.assists}
                  className="shrink-0 text-right text-xs"
                />
              </div>
              {hasNet || hasGpm || hasLh ? (
                // Fixed-width gpm, lh and net-worth cells (the has* flags are
                // per side, so every row has the same cells): the bars then
                // start at the same x and share one track width down the
                // side, which is the comparison they exist for.
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-10 text-[11px] tabular-nums text-muted">
                  {hasGpm ? (
                    <span className="w-14" title="Gold per minute">{p.gpm ?? "—"} gpm</span>
                  ) : null}
                  {hasLh ? (
                    <span className="w-10" title="Last hits">{p.lastHits ?? "—"} lh</span>
                  ) : null}
                  {hasNet ? (
                    <span
                      className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2"
                      title="Net worth at game end"
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-full max-w-24 overflow-hidden rounded-full bg-surface-2"
                      >
                        <span
                          className="block h-full rounded-full bg-accent/80"
                          style={{ width: `${nwPct}%` }}
                        />
                      </span>
                      <span className="w-11 shrink-0 text-right font-mono text-accent">
                        {formatNetWorth(p.netWorth)}
                      </span>
                    </span>
                  ) : null}
                </div>
              ) : null}
              <ReportCardStrip line={p} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const GRADE_CHIP: Record<ReturnType<typeof gradeTone>, string> = {
  success: "border-success/40 text-success",
  accent: "border-accent/40 text-accent",
  default: "border-line text-fg/80",
  muted: "border-line text-muted",
};

const GRADE_TEXT: Record<ReturnType<typeof gradeTone>, string> = {
  success: "text-success",
  accent: "text-accent",
  default: "text-fg/80",
  muted: "text-muted",
};

/**
 * The hero report card (per-metric worldwide percentile grades from OpenDota's
 * benchmarks) as ONE overall chip under a player's line; tapping it opens the
 * metrics by name. Seven chips per player was up to 80 per game, with
 * abbreviations like "HD/min" and "TD" explained nowhere, beside the raw
 * numbers they graded. Absent for games imported before benchmarks were
 * stored.
 */
function ReportCardStrip({ line }: { line: PlayerStat }) {
  const rows = gameReportCard(line);
  const avg = cardAverage(rows);
  if (avg == null) return null;
  const overall: Grade = gradeFor(avg);
  return (
    <details className="group/report mt-1.5 pl-10">
      <summary
        title={`vs the world on this hero: ${percentLabel(avg)}`}
        className={cn(
          "inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded border px-1.5 text-xs font-semibold uppercase tracking-wide [&::-webkit-details-marker]:hidden",
          GRADE_CHIP[gradeTone(overall)],
        )}
      >
        Report {overall}
        <span className="sr-only">
          , {percentLabel(avg)} vs the world on this hero
        </span>
        <span
          aria-hidden
          className="text-[10px] transition-transform group-open/report:rotate-180 motion-reduce:transition-none"
        >
          ▾
        </span>
      </summary>
      <ul className="mt-1.5 max-w-xs space-y-0.5 text-xs">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline justify-between gap-3">
            <span className="text-muted">{r.label}</span>
            <span className="shrink-0 tabular-nums">
              {percentLabel(r.pct)}{" "}
              <b className={cn("font-semibold", GRADE_TEXT[gradeTone(r.grade)])}>
                {r.grade}
              </b>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted">
        Percentiles against everyone playing this hero worldwide.
      </p>
    </details>
  );
}

// Captain-to-captain rescheduling: propose a time, the other captain accepts
// (retimes the match) or declines. Only the two captains ever see this card.
/**
 * Captain-only wrapper so the reschedule card renders on every unplayed OR
 * live match — not just the pre-import preview (a proposal made before game 1
 * must stay answerable after the game is imported).
 */
// The two captains can pull their finished game straight from OpenDota —
// results (and standings, bracket, fantasy, pick'em, honors downstream) stop
// bottlenecking on an admin. Guards live in match-report-service.ts.
async function ReportResultSection({
  match,
  renderedAt,
}: {
  match: {
    id: string;
    seasonId: string;
    phase: string;
    status: string;
    bestOf: number;
    scheduledAt: Date | null;
    homeScore: number;
    awayScore: number;
    season: {
      isActive: boolean;
      status: string;
      dotaLeagueId: string | null;
    };
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
  renderedAt: number;
}) {
  const viewer = await getSessionUser();
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  if (!isCaptain) {
    if (
      !lobbyBotKindEnabled("season") ||
      !viewer ||
      !match.season.isActive ||
      match.status === "COMPLETED" ||
      !matchResultsOpen(match.season.status, match.phase)
    ) return null;
    const participant = viewer.role === "ADMIN" || await prisma.match.count({
      where: {
        id: match.id,
        OR: [
          { homeTeam: { members: { some: { userId: viewer.id } } } },
          { awayTeam: { members: { some: { userId: viewer.id } } } },
          { standins: { some: { standinUserId: viewer.id } } },
        ],
      },
    });
    return participant ? (
      <DotaLobbyControls
        key={`${match.id}:${match.homeScore}:${match.awayScore}`}
        kind="season"
        id={match.id}
      />
    ) : null;
  }
  // A final series gets the page's one-line correction note instead.
  if (!match.season.isActive || match.status === "COMPLETED") return null;
  if (!matchResultsOpen(match.season.status, match.phase)) {
    return (
      <Card>
        <CardHeader
          title="Result reporting locked"
          subtitle={
            match.phase === "TIEBREAKER"
              ? `Tiebreaker games can be reported while the league is in Regular season. Complete this best-of-${match.bestOf} match to settle playoff qualification and seeding.`
              : match.phase === "REGULAR"
                ? "Regular-season games can be reported only while the league is in the Regular season phase. Ask an admin to correct the phase or fixture."
                : "Playoff games can be reported only while the league is in the Playoffs phase. Ask an admin to reopen the postseason before reporting."
          }
        />
      </Card>
    );
  }
  const afterScheduledTime =
    match.scheduledAt != null && match.scheduledAt.getTime() <= renderedAt;
  const gamesRecorded = match.homeScore + match.awayScore;
  const live = match.status === "LIVE";
  const leagueTitle = live
    ? `Game ${gamesRecorded} recorded — series ${match.homeScore}–${match.awayScore}`
    : afterScheduledTime
      ? "Waiting for league result"
      : "Result recording";
  // One sentence on when games show up, and the wrong-ticket advice said
  // once, both from AUTO_SYNC (leagueResultCopy).
  const leagueCopy = leagueResultCopy({ live });
  // Before kickoff (or with no time set) nobody has played yet, so the import
  // form stays one tap away under a disclosure instead of leading the card.
  const foldImport =
    !!match.season.dotaLeagueId && !live && !afterScheduledTime;
  const hostParts = howToHostParts({
    homeTeamName: match.homeTeam.name,
    bestOf: match.bestOf,
    region: LEAGUE_CONFIG.gameServerRegion,
    mode: LEAGUE_GAME_MODE.name,
  });
  return (
    <div className="space-y-6">
      {/* A ticketed season gets the same line as the checklist's first line
          instead, so the host and lobby count are never said twice. */}
      {match.season.dotaLeagueId ? null : (
        <HowToHost parts={hostParts} note={NO_TICKET_RESULT_NOTE} />
      )}
      {lobbyBotKindEnabled("season") ? (
        <DotaLobbyControls
          key={`${match.id}:${match.homeScore}:${match.awayScore}`}
          kind="season"
          id={match.id}
        />
      ) : null}
      {match.season.dotaLeagueId ? (
        <LeagueLobbyChecklist
          leagueId={match.season.dotaLeagueId}
          hostParts={hostParts}
        />
      ) : null}
      <Card>
        <CardHeader
          title={match.season.dotaLeagueId ? leagueTitle : "Report your result"}
          subtitle={
            match.season.dotaLeagueId
              ? leagueCopy.lead
              : NO_TICKET_REPORT_SUBTITLE
          }
        />
        <CardBody className="space-y-3">
          {foldImport ? (
            <details>
              <summary className="cursor-pointer py-2 text-sm font-medium text-fg">
                Result didn&apos;t show up?
              </summary>
              <div className="mt-2 space-y-3">
                <p className="text-xs text-muted">{leagueCopy.recovery}</p>
                <MatchImportControls
                  matchId={match.id}
                  importAction={captainImportGame}
                  detectAction={captainAutoDetect}
                />
              </div>
            </details>
          ) : (
            <>
              {match.season.dotaLeagueId ? (
                <p className="text-xs text-muted">{leagueCopy.recovery}</p>
              ) : null}
              <MatchImportControls
                matchId={match.id}
                importAction={captainImportGame}
                detectAction={captainAutoDetect}
              />
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * The one-line hosting summary both captains always get — who hosts, which
 * server, which mode, how many lobbies. Built from LEAGUE_CONFIG,
 * LEAGUE_GAME_MODE and the match's own bestOf (howToHostParts), so it can't
 * drift from the rules. This box is the ticketless season's version, with the
 * note on why the result may not import by itself; a ticketed season shows the
 * same line at the top of LeagueLobbyChecklist, beside the league id.
 */
function HowToHost({ parts, note }: { parts: string[]; note: string }) {
  return (
    <section
      aria-label="How to host"
      className="rounded-lg border border-line bg-surface-2/40 px-4 py-3 text-sm [overflow-wrap:anywhere]"
    >
      <p>
        <b className="text-fg">How to host:</b>{" "}
        <span className="text-muted">{parts.join(" · ")}</span>
      </p>
      <p className="mt-1 text-xs text-muted">{note}</p>
    </section>
  );
}

// Captain-facing standin management (guards in standin-service): current
// cover for both sides, remove for your own team, and an assign form scoped
// to your roster + the season's unrostered ACTIVE signups.
async function StandinSection({
  match,
  seriesStarted,
}: {
  /** A game is imported: removeStandinGuarded refuses every removal now. */
  seriesStarted: boolean;
  match: {
    id: string;
    seasonId: string;
    status: string;
    week: number;
    scheduledAt: Date | null;
    scheduleRevision: number;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
}) {
  const viewer = await getSessionUser();
  if (!viewer) return null;
  const isAdmin = viewer.role === "ADMIN";
  const myTeamId =
    match.homeTeam.captainId === viewer.id
      ? match.homeTeamId
      : match.awayTeam.captainId === viewer.id
        ? match.awayTeamId
        : null;
  if (!myTeamId && !isAdmin) return null;
  // An admin passing by uses the Admin tools card near the top (any team's
  // cover); this card is the captain's tool. An admin who IS a captain still
  // gets their own team's view here.
  if (!myTeamId) return null;

  // The service refuses archived-season matches (its guards key on the
  // active season) — don't render a form that can only error.
  const season = await prisma.season.findUnique({
    where: { id: match.seasonId },
    select: { isActive: true, teamSize: true, status: true },
  });
  if (!season?.isActive) return null;
  // Mirror the service's PHASE GATE (render/guard pairing, the roster-moves
  // rule): assignment is open in REGULAR_SEASON/PLAYOFFS, and in DRAFT only
  // once the auction is COMPLETE (pool-dry short rosters arranging week-1
  // cover). Existing assignments still render — removal is legal cleanup in
  // every phase — but a form that can only error never should.
  const draftRow =
    season.status === "DRAFT"
      ? await prisma.draft.findUnique({
          where: { seasonId: match.seasonId },
          select: { status: true },
        })
      : null;
  const assignOpen = standinAssignmentOpen(
    season.status,
    draftRow?.status,
    match.status,
  );

  const [assignments, roster, registrations, rostered, outRows] =
    await Promise.all([
      prisma.standinAssignment.findMany({
        where: { matchId: match.id },
        include: {
          standin: { select: { id: true, name: true } },
          replaced: { select: { id: true, name: true } },
        },
      }),
      prisma.teamMember.findMany({
        where: { seasonId: match.seasonId, teamId: myTeamId },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.registration.findMany({
        where: { seasonId: match.seasonId, status: "ACTIVE" },
        // roles + Discord fields feed the picker's option text: a captain
        // choosing cover at 9pm needs "who fits the seat AND will answer a
        // ping" without opening five profiles. Contact-adjacent, but this
        // card only renders for the two captains (and admins), so the
        // signed-in gate contact info requires is already satisfied.
        include: {
          user: {
            select: {
              id: true,
              name: true,
              discordId: true,
              discordName: true,
            },
          },
        },
        orderBy: { mmr: "desc" },
      }),
      prisma.teamMember.findMany({
        where: { seasonId: match.seasonId },
        select: { userId: true },
      }),
      // OUT RSVPs on this match — the captain-facing uncovered-OUT alert.
      // The admin panel has always had this list; the captain, who owns the
      // fix (the assign form right below), had to notice a small ✗ in the
      // preview grid instead.
      prisma.matchAvailability.findMany({
        where: { matchId: match.id, status: "OUT", scheduleRevision: match.scheduleRevision },
        select: { userId: true },
      }),
    ]);
  const rosteredIds = new Set(rostered.map((m) => m.userId));
  const pool = registrations.filter((r) => !rosteredIds.has(r.userId));
  // The pool's bookings on unplayed fixtures (this one included): the server
  // refuses a standin already booked in this match or on another fixture the
  // same night, so those are listed last, disabled, with the reason.
  const bookings =
    assignOpen && pool.length > 0
      ? await prisma.standinAssignment.findMany({
          where: {
            standinUserId: { in: pool.map((r) => r.userId) },
            match: {
              seasonId: match.seasonId,
              status: { not: MATCH_STATUS.COMPLETED },
            },
          },
          select: {
            standinUserId: true,
            matchId: true,
            replaced: { select: { name: true } },
            match: {
              select: {
                scheduledAt: true,
                week: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        })
      : [];
  const pickerTarget = {
    matchId: match.id,
    scheduledAt: match.scheduledAt,
    week: match.week,
  };
  const bookingRows = bookings.map((b) => ({
    standinUserId: b.standinUserId,
    matchId: b.matchId,
    replacedName: b.replaced?.name ?? null,
    homeName: b.match.homeTeam.name,
    awayName: b.match.awayTeam.name,
    scheduledAt: b.match.scheduledAt,
    week: b.match.week,
  }));
  const poolChoices = pool.map((r) => ({
    reg: r,
    blocked: standinPickerBlock(r.userId, pickerTarget, bookingRows),
  }));
  const pickerOptions = [
    ...poolChoices.filter((c) => !c.blocked),
    ...poolChoices.filter((c) => c.blocked),
  ];
  // One seat, one standin — players already covered leave the Covers list.
  const coveredIds = new Set(
    assignments.flatMap((a) => (a.replaced ? [a.replaced.id] : [])),
  );
  // OPEN SEATS on this captain's own roster. A team that lost a player
  // mid-season is short, and a standin filling that seat replaces nobody — the
  // case that previously had no UI anywhere, so a 4-of-5 side could not be
  // covered at all. Already-filled open seats are subtracted.
  const openSeatsFilled = assignments.filter(
    (a) => a.teamId === myTeamId && a.replaced == null,
  ).length;
  const openSeats = Math.max(
    0,
    season.teamSize - roster.length - openSeatsFilled,
  );
  const teamNameOf = (teamId: string) =>
    teamId === match.homeTeamId ? match.homeTeam.name : match.awayTeam.name;
  // OUT-and-uncovered on MY roster: the admin card has always alerted on
  // this; the captain — who owns the assign form below — saw only the small
  // ✗ in the preview grid. They also lead the Covers list, pre-selected when
  // there is exactly one, so covering them stays one pick and one tap.
  const cover = coverChoices(
    roster,
    new Set(outRows.map((r) => r.userId)),
    coveredIds,
  );
  const uncoveredOut = cover.choices
    .filter((c) => c.out)
    .map((c) => c.member);

  // A phase where assignment is closed and nothing is booked has nothing to
  // say — don't render an empty card with a disabled story.
  if (!assignOpen && assignments.length === 0) return null;

  return (
    <Card id={MATCH_ANCHOR.standins} className="scroll-mt-24">
      <CardHeader
        title="Standins"
        subtitle="Someone can't make it? Line up cover from the standin pool yourself — the assignment announces to Discord."
      />
      <CardBody className="space-y-3">
        {uncoveredOut.length > 0 ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            ✗ Out and uncovered:{" "}
            <strong>{uncoveredOut.map((m) => m.user.name).join(", ")}</strong>
            {assignOpen ? " — line up cover below." : "."}
          </p>
        ) : null}
        {assignments.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {assignments.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-surface-2/40 px-3 py-1.5"
              >
                <span className="min-w-0">
                  <strong>{a.standin.name}</strong>{" "}
                  {/* A null `replaced` is an EMPTY-SEAT cover on a short
                      roster, not missing data — it rendered as "in for ?". */}
                  {a.replaced ? (
                    <>
                      <span className="text-muted">in for</span>{" "}
                      {a.replaced.name}{" "}
                    </>
                  ) : (
                    <span className="text-muted">filling an open seat </span>
                  )}
                  <span className="text-muted">· {teamNameOf(a.teamId)}</span>
                </span>
                {a.teamId !== myTeamId ? null : seriesStarted ? (
                  // Removing cover mid-series would drop the standin from the
                  // remaining games, so the server refuses it. Say so rather
                  // than offer a button that can only fail.
                  <span className="ml-auto text-xs text-muted">
                    Locked: series already started
                  </span>
                ) : (
                  <ActionForm
                    action={captainRemoveStandin}
                    hidden={{ assignmentId: a.id }}
                    className="ml-auto"
                  >
                    <SubmitButton
                      variant="ghost"
                      size="sm"
                      className="text-danger-soft"
                      confirm={`Remove ${a.standin.name} as standin? Discord is told to stand down.`}
                    >
                      Remove
                    </SubmitButton>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No standins assigned yet.</p>
        )}
        {!assignOpen ? (
          <p className="text-sm text-muted">
            {season.status === "COMPLETE"
              ? "The season is over — standins no longer apply."
              : "Standins can be assigned once the draft has run and rosters are settled."}
          </p>
        ) : pool.length === 0 ? (
          <p className="text-sm text-muted">
            Nobody is in the standin pool right now — ask around the Discord;
            late joiners can still sign up as standins.
          </p>
        ) : poolChoices.every((c) => c.blocked) ? (
          <p className="text-sm text-muted">
            Everyone in the standin pool is already booked for this match or
            another one that night — ask around the Discord; late joiners can
            still sign up as standins.
          </p>
        ) : (
          <ActionForm
            action={captainAssignStandin}
            hidden={{ matchId: match.id }}
            className="flex flex-wrap items-end gap-2"
          >
            <select
              name="standinUserId"
              required
              aria-label="Standin to bring in"
              className="h-10 min-w-0 max-w-full rounded-lg border border-line bg-surface-2/50 px-2 text-sm"
              defaultValue=""
            >
              <option value="" disabled>
                Standin…
              </option>
              {/* Option text carries what the 9pm decision needs: seat fit
                  (roles) and whether a ping can reach them at all. "no
                  Discord" = neither a verified link nor a typed handle. */}
              {/* Someone the server would refuse (already in this match, or
                  booked the same night) stays listed but can't be picked,
                  and says why. */}
              {pickerOptions.map(({ reg: r, blocked }) => {
                const roles = roleShort(r.roles).join("/");
                const unreachable = !r.user.discordId && !r.user.discordName;
                return (
                  <option key={r.userId} value={r.userId} disabled={!!blocked}>
                    {blocked
                      ? `${r.user.name} (${blocked})`
                      : `${r.user.name} (${r.mmr} MMR${roles ? ` · ${roles}` : ""}${unreachable ? " · no Discord" : ""})`}
                  </option>
                );
              })}
            </select>
            {/* Keyed on the pre-selection: an uncontrolled select keeps its
                first defaultValue, so a new "can't make it" needs a remount. */}
            <select
              key={cover.preselect ?? ""}
              name="replacingUserId"
              required
              aria-label="Player they cover"
              className="h-10 min-w-0 max-w-full rounded-lg border border-line bg-surface-2/50 px-2 text-sm"
              defaultValue={cover.preselect ?? ""}
            >
              <option value="" disabled>
                Covers…
              </option>
              {cover.choices
                .filter((c) => c.out)
                .map(({ member: m }) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user.name} (can&apos;t make it)
                  </option>
                ))}
              {openSeats > 0 ? (
                <option value={seatValue(myTeamId)}>
                  an empty roster seat ({openSeats} unfilled)
                </option>
              ) : null}
              {cover.choices
                .filter((c) => !c.out)
                .map(({ member: m }) => (
                  <option key={m.userId} value={m.userId}>
                    {m.user.name}
                  </option>
                ))}
            </select>
            <SubmitButton variant="secondary" size="sm">
              Assign standin
            </SubmitButton>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}

async function RescheduleSection({
  match,
}: {
  match: {
    id: string;
    seasonId: string;
    phase: string;
    status: string;
    scheduledAt: Date | null;
    scheduleRevision: number;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
}) {
  const [viewer, season, draft, pending] = await Promise.all([
    getSessionUser(),
    prisma.season.findUnique({
      where: { id: match.seasonId },
      select: { isActive: true, status: true, firstMatchNight: true },
    }),
    prisma.draft.findUnique({
      where: { seasonId: match.seasonId },
      select: { status: true },
    }),
    prisma.rescheduleRequest.findFirst({
      where: { matchId: match.id, status: "PENDING" },
      include: { proposedBy: { select: { name: true } } },
    }),
  ]);
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  const canRetime =
    !!season?.isActive &&
    matchLogisticsOpen(season.status, draft?.status, match.status);

  if (isCaptain && canRetime) {
    // Async server component: request time, once, for the form's earliest
    // allowed time and the deadline read (not client render state).
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();
    // The same deadline the service enforces, shown under the form.
    const deadline = pending
      ? null
      : await loadRescheduleDeadline(
          prisma,
          match,
          season.firstMatchNight,
          nowMs,
        );
    return (
      <RescheduleCard
        match={match}
        viewerId={viewer!.id}
        pending={pending}
        deadline={deadline}
        nowMs={nowMs}
      />
    );
  }
  if (isCaptain && pending) {
    const mine = pending.proposedById === viewer!.id;
    return (
      <Card id={MATCH_ANCHOR.reschedule} className="scroll-mt-24">
        <CardHeader
          title="Reschedule locked"
          subtitle="This match can no longer be moved. You can close the stranded proposal so it does not look actionable."
        />
        <CardBody className="flex flex-wrap items-center gap-3 text-sm">
          <span className="min-w-[14rem] flex-1 text-muted">
            {mine ? "You" : <strong>{pending.proposedBy.name}</strong>} proposed{" "}
            <strong className="text-fg">
              <LocalTime
                ts={pending.proposedTime.getTime()}
                variant="full"
                initial={formatMatchTime(pending.proposedTime, "full")}
              />
            </strong>
            .
          </span>
          <ActionForm
            action={mine ? cancelReschedule : respondReschedule}
            hidden={
              mine
                ? { requestId: pending.id }
                : { requestId: pending.id, response: "decline" }
            }
          >
            <SubmitButton variant="secondary" size="sm">
              {mine ? "Withdraw proposal" : "Decline proposal"}
            </SubmitButton>
          </ActionForm>
        </CardBody>
      </Card>
    );
  }
  // Everyone else gets a read-only heads-up that a time change is pending, so
  // spectators/scouts aren't blindsided by a moved match.
  if (!pending) return null;
  return (
    <div
      id={MATCH_ANCHOR.reschedule}
      className="flex scroll-mt-24 flex-wrap items-center gap-2 rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm text-muted"
    >
      <span aria-hidden>⏳</span>
      <span>
        Reschedule proposed —{" "}
        <strong className="text-fg">
          <LocalTime
            ts={pending.proposedTime.getTime()}
            variant="full"
            initial={formatMatchTime(pending.proposedTime, "full")}
          />
        </strong>{" "}
        pending the captains&apos; agreement.
      </span>
    </div>
  );
}

async function RescheduleCard({
  match,
  viewerId,
  pending,
  deadline,
  nowMs,
}: {
  match: {
    id: string;
    status: string;
    scheduledAt: Date | null;
    scheduleRevision: number;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
  viewerId: string;
  pending: {
    id: string;
    proposedById: string;
    proposedTime: Date;
    proposedBy: { name: string };
  } | null;
  /** A new time must be before this (the playoffs); null = no limit. */
  deadline: Date | null;
  nowMs: number;
}) {
  if (match.status === "COMPLETED") return null;
  const checkinCount = pending
    ? await prisma.matchAvailability.count({ where: { matchId: match.id, scheduleRevision: match.scheduleRevision } })
    : 0;
  const mine = pending?.proposedById === viewerId;
  const clashHours = Math.round(FIXTURE_CONFLICT_WINDOW_MS / 3_600_000);
  const hintId = `proposed-time-hint-${match.id}`;

  return (
    <Card id={MATCH_ANCHOR.reschedule} className="scroll-mt-24">
      <CardHeader
        title="Reschedule"
        subtitle={
          match.scheduledAt
            ? "Agree a new time with the other captain. A real time change resets every player's check-in."
            : "No time set yet — propose one to the other captain."
        }
      />
      <CardBody className="space-y-3 text-sm">
        {pending ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-[14rem] flex-1">
              {mine ? "You" : <strong>{pending.proposedBy.name}</strong>}{" "}
              proposed{" "}
              {/* Old and new side by side, so the answer doesn't need the
                  current kickoff looked up elsewhere. */}
              {match.scheduledAt ? (
                <>
                  moving it from{" "}
                  <LocalTime
                    ts={match.scheduledAt.getTime()}
                    variant="full"
                    initial={formatMatchTime(match.scheduledAt, "full")}
                  />{" "}
                  to{" "}
                </>
              ) : null}
              <strong>
                <LocalTime
                  ts={pending.proposedTime.getTime()}
                  variant="full"
                  initial={formatMatchTime(pending.proposedTime, "full")}
                />
              </strong>
              {mine ? " — waiting on the other captain." : "."}
              {!mine && checkinCount > 0 ? (
                <span className="mt-1 block text-xs text-accent">
                  Accepting will clear {checkinCount} check-in
                  {checkinCount === 1 ? "" : "s"}; every player must answer
                  again for the new night.
                </span>
              ) : null}
            </span>
            {mine ? (
              <ActionForm
                action={cancelReschedule}
                hidden={{ requestId: pending.id }}
              >
                <SubmitButton variant="secondary" size="sm">
                  Withdraw
                </SubmitButton>
              </ActionForm>
            ) : (
              <div className="flex shrink-0 gap-2">
                <ActionForm
                  action={respondReschedule}
                  hidden={{ requestId: pending.id, response: "accept" }}
                >
                  <SubmitButton
                    variant="primary"
                    size="sm"
                    confirm={`Accept this new kickoff? ${checkinCount} check-in${checkinCount === 1 ? "" : "s"} will be cleared and every player must answer again.`}
                  >
                    ✓ Accept time
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={respondReschedule}
                  hidden={{ requestId: pending.id, response: "decline" }}
                >
                  <SubmitButton variant="secondary" size="sm">
                    ✗ Decline
                  </SubmitButton>
                </ActionForm>
              </div>
            )}
          </div>
        ) : (
          <ActionForm
            action={proposeReschedule}
            hidden={{ matchId: match.id }}
            className="flex flex-wrap items-center gap-2"
          >
            <label htmlFor={`proposed-time-${match.id}`} className="sr-only">
              Proposed new kickoff, in your time
            </label>
            {/* The two captains may sit in different zones, so each proposes
                on their own clock; the admin boxes use the league's. Say
                which one this is. Starts on the current kickoff, and the
                browser keeps it between now and the deadline; the server
                still checks every rule. */}
            <span className="inline-flex max-w-full flex-wrap items-center gap-2">
              <LocalDatetimeField
                id={`proposed-time-${match.id}`}
                name="proposedTime"
                tsName="proposedTs"
                required
                defaultTs={match.scheduledAt?.getTime() ?? null}
                minTs={nowMs}
                maxTs={deadline ? deadline.getTime() - 60_000 : null}
                describedBy={hintId}
                className="h-9 rounded-md border border-line bg-surface-2/50 px-2 text-sm text-fg"
              />
              <span aria-hidden="true" className="text-xs text-muted">
                your time
              </span>
            </span>
            <SubmitButton variant="secondary" size="sm">
              Propose new time
            </SubmitButton>
            <p id={hintId} className="basis-full text-xs text-muted">
              {deadline ? (
                <>
                  Must be before{" "}
                  <LocalTime
                    ts={deadline.getTime()}
                    variant="full"
                    initial={formatMatchTime(deadline, "full")}
                  />
                  , when the playoffs start, and not within {clashHours}{" "}
                  hours of another match or scrim for either team.
                </>
              ) : (
                `Must not be within ${clashHours} hours of another match or scrim for either team.`
              )}
            </p>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
