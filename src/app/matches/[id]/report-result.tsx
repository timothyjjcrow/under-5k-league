import { LEAGUE_CONFIG } from "@/lib/league-config";
import { LEAGUE_GAME_MODE } from "@/lib/constants";
import {
  howToHostParts,
  leagueResultCopy,
  NO_TICKET_REPORT_SUBTITLE,
  NO_TICKET_RESULT_NOTE,
} from "@/lib/match-hosting";
import { matchResultsOpen } from "@/lib/league-lifecycle";
import { lobbyBotKindEnabled } from "@/lib/dota-lobby-service";
import {
  captainAutoDetect,
  captainImportGame,
} from "@/app/actions/match-report";
import { MatchImportControls } from "@/components/match-import-controls";
import { LeagueLobbyChecklist } from "@/components/league-lobby-checklist";
import { DotaLobbyControls } from "@/components/dota-lobby-controls";
import { Card, CardBody, CardHeader } from "@/components/ui";
import type { MatchPageMatch, MatchViewer } from "./load";

// The two captains can pull their finished game straight from OpenDota —
// results (and standings, bracket, fantasy, pick'em, honors downstream) stop
// bottlenecking on an admin. Guards live in match-report-service.ts.
export function ReportResultSection({
  match,
  viewer,
  renderedAt,
}: {
  match: MatchPageMatch;
  viewer: MatchViewer;
  renderedAt: number;
}) {
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  // Captain tools only. A final series gets the page's one-line correction
  // note instead.
  if (!isCaptain) return null;
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
