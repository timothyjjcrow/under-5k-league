import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { matchResultsOpen } from "@/lib/league-lifecycle";
import { calledItCount, pickemControlFor } from "@/lib/pickem";
import type { ChampionPresentation } from "@/lib/champion-presentation";
import { teamHueVar } from "@/lib/team-hues";
import { teamTint } from "@/lib/team-tint";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import { KickoffCountdown } from "@/components/kickoff-countdown";
import { LocalTime } from "@/components/local-time";
import { PickemTray } from "@/components/pickem-pick-form";
import {
  Badge,
  Card,
  CardBody,
  LinkArrow,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";
import type { MatchPageGame, MatchPageMatch, MatchViewer } from "./load";

/**
 * The page's visible title: both teams, the series score (or VS), the
 * round and state badges, the kickoff, a finished match's pick'em verdict,
 * the captain's jump to their tools, and a chip per played game.
 */
export async function MatchScoreboard({
  match,
  games,
  viewer,
  roundLabel,
  championPresentation,
  resultPending,
  showCaptainTools,
}: {
  match: MatchPageMatch;
  games: MatchPageGame[];
  viewer: MatchViewer;
  /** matchRoundLabel of this fixture ("Week 3", "Semifinal"). */
  roundLabel: string;
  championPresentation: ChampionPresentation;
  /** Kickoff has passed and the series isn't complete. */
  resultPending: boolean;
  showCaptainTools: boolean;
}) {
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
  // Everyone gets the ticking clock before kickoff, not only the two teams'
  // players (their check-in banner has its own chip). An archived season's
  // unplayed fixture never ticks.
  const kickoffAt =
    match.scheduledAt &&
    match.season.isActive &&
    !hasSeriesScore &&
    !resultPending
      ? match.scheduledAt.getTime()
      : null;

  return (
    <Card className="relative overflow-hidden">
      {/* Each half washed faintly in its team's colour, clearing before the
          score in the middle. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-1/2"
        {...teamTint(match.homeTeamId, "to right")}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-1/2"
        {...teamTint(match.awayTeamId, "to left")}
      />
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
      <CardBody className="relative space-y-4 px-3 py-5 sm:space-y-5 sm:px-6 sm:py-6">
        {/* The page's h1 names the fixture, like its tab title and link
            preview, so someone moving by headings knows which match this
            is. On screen the team names right below say the same. */}
        <h1 className="sr-only">
          {match.homeTeam.name} vs {match.awayTeam.name}
        </h1>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Badge>{roundLabel}</Badge>
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
            side="home"
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
            side="away"
            name={match.awayTeam.name}
            teamId={match.awayTeamId}
            logoUrl={match.awayTeam.logoUrl}
            win={match.winnerTeamId === match.awayTeamId}
          />
        </div>
        {kickoffAt != null ? (
          <KickoffCountdown
            targetMs={kickoffAt}
            tone={match.phase === "FINAL" ? "final" : "default"}
            nowText={
              match.phase === "FINAL"
                ? "The grand final is on"
                : "It's kickoff time"
            }
          />
        ) : null}
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3 border-t border-line/60 pt-4 text-center text-sm text-muted">
          {match.scheduledAt ? (
            <LocalTime
              ts={match.scheduledAt.getTime()}
              variant="full"
              initial={formatLeagueMatchTime(match.scheduledAt, "full")}
            />
          ) : (
            <span>Kickoff time TBD</span>
          )}
          {pickVerdict ? (
            <PickemTray
              control={pickVerdict}
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
  );
}

/**
 * A team's crest and name. Stacked (crest over name) up to lg; from lg they
 * sit side by side with the crest next to the score, mirrored for the away
 * side, so the scoreboard is one row of name, crest, score, crest, name.
 */
function TeamSide({
  side,
  name,
  teamId,
  logoUrl,
  win,
}: {
  side: "home" | "away";
  name: string;
  teamId: string;
  logoUrl: string | null;
  win: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-center gap-3 self-stretch text-center lg:gap-4 lg:self-center",
        side === "home"
          ? "lg:flex-row-reverse lg:text-right"
          : "lg:flex-row lg:text-left",
      )}
    >
      <div
        className={cn(
          "shrink-0 rounded-2xl border p-2 shadow-lg shadow-black/15",
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
        className="min-h-11 min-w-0 max-w-full content-center font-display text-base font-semibold leading-tight text-fg [overflow-wrap:anywhere] hover:text-info sm:text-2xl"
      >
        {name}
      </Link>
    </div>
  );
}
