import Link from "@/components/app-link";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import { parseTiebreakerStage } from "@/lib/tiebreaker-format";
import { TiebreakerBracket } from "@/components/tiebreaker-bracket";
import { buildTiebreakerBrackets } from "@/components/tiebreaker-bracket-view";
import { schedulableAdminTiebreakerGroups } from "@/components/admin-tiebreaker-view";
import { projectPlayoffField } from "@/lib/playoff-field";
import {
  matchCorrectionContext,
  matchResultsOpen,
} from "@/lib/league-lifecycle";
import { regularSeasonStatus } from "@/lib/schedule-status";
import {
  MatchResultRow,
  MatchRowsHelp,
  resultsLockNote,
} from "@/components/admin-match-tools";
import { adminMatchRowId } from "@/lib/match-anchors";
import { Card, CardBody, CardHeader, textLink } from "@/components/ui";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

export function TiebreakerControls({
  season,
  data,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  nowMs: number;
}) {
  const projection = projectPlayoffField(data.teams, data.matches, season);
  const brackets = buildTiebreakerBrackets({ projection, teams: data.teams, matches: data.matches });
  const tiebreakerMatches = data.matches.filter((match) => match.phase === MATCH_PHASE.TIEBREAKER);
  const hasBo1Bracket = brackets.groups.some((bracket) => bracket.format === "BO1_DOUBLE_ELIMINATION");
  const hasSingle = brackets.groups.some((bracket) => bracket.format === "BO1_SINGLE_ELIMINATION");
  const postseasonStarted = season.status !== SEASON_STATUS.REGULAR_SEASON ||
    data.matches.some((match) => match.phase === MATCH_PHASE.PLAYOFF || match.phase === MATCH_PHASE.FINAL);
  const canSchedule = !postseasonStarted && regularSeasonStatus(data.matches).allComplete &&
    schedulableAdminTiebreakerGroups(projection.tiebreakers).length > 0;
  const pending = tiebreakerMatches.filter((match) => match.status !== MATCH_STATUS.COMPLETED);
  const names = new Map(data.teams.map((team) => [team.id, team.name]));
  return (
    <Card>
      <CardHeader headingLevel={2} title="Tiebreakers" subtitle="Full bracket, match times and results — before playoffs." action={
        <Link href="/schedule#tiebreakers" className={textLink("text-sm")}>Player view →</Link>
      } />
      <CardBody className="space-y-5">
        <div className="space-y-2 rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm">
          {hasSingle ? <p>Record or import each BO1 result below. Ready opponents get their next match automatically, in the same week, with no scheduled break. Independent brackets continue in parallel.</p> : hasBo1Bracket ? (
            <p>Only games with decided opponents have match controls. Finalizing or importing a result creates the next game automatically. Games 2–5 stay in the same tiebreaker week; Game 5 is only created if needed.</p>
          ) : (
            <p>Manage each created tiebreaker match below. Finish all required tiebreakers before starting playoffs.</p>
          )}
          {hasBo1Bracket && !postseasonStarted ? (
            <p className="text-xs text-muted">Keep the season in Regular season. Check the next game’s kickoff after each result; if the opening game has no time, set each new game’s time below.</p>
          ) : null}
          {canSchedule ? (
            <a href="#adm-playoffs" className={textLink("inline-block py-1")}>
              {tiebreakerMatches.length > 0 ? "Next match is ready to create — open tiebreaker controls →" : "Schedule the opening matches in Playoffs controls →"}
            </a>
          ) : null}
          {pending.length > 0 && !postseasonStarted ? (
            <div className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Current tiebreaker matches">
              {pending.map((match) => (
                <a key={match.id} href={`#admin-tiebreaker-match-${match.id}`} className={textLink("py-1")}>
                  Manage {match.bestOf === 1 ? "game" : "series"}: {names.get(match.homeTeamId ?? "")} vs {names.get(match.awayTeamId ?? "")} →
                </a>
              ))}
            </div>
          ) : null}
          {projection.tiebreakers.resolved && tiebreakerMatches.length > 0 && !postseasonStarted ? (
            <p>Tiebreakers complete. <a href="#adm-playoffs" className={textLink()}>Review the seeds and start playoffs →</a></p>
          ) : null}
          {postseasonStarted ? <p className="text-xs text-muted">Tiebreaker results are read-only once playoffs begin.</p> : null}
        </div>
        {brackets.error ? <p role="alert" className="text-sm text-danger">{brackets.error} Review the recorded matches below and the recovery controls in Playoffs.</p> : null}
        {brackets.groups.map((bracket) => (
          <TiebreakerBracket key={bracket.key} bracket={bracket} teams={data.teams} postseasonStarted={postseasonStarted} admin />
        ))}
        {tiebreakerMatches.length > 0 ? (
          <>
            <h3 className="font-medium">Match controls</h3>
            <MatchRowsHelp
              id="adm-import-help-tiebreaker"
              seasonStatus={season.status}
              draftStatus={data.draft?.status ?? null}
              canImport={
                matchResultsOpen(season.status, MATCH_PHASE.TIEBREAKER) &&
                pending.length > 0
              }
              hasScheduled={tiebreakerMatches.some(
                (m) => m.status === MATCH_STATUS.SCHEDULED,
              )}
              notes={[resultsLockNote(season.status, MATCH_PHASE.TIEBREAKER)]}
            />
          </>
        ) : null}
        {[...new Set(tiebreakerMatches.map((m) => m.week))].map((week) => {
          const weekMatches = tiebreakerMatches.filter(
            (m) => m.week === week,
          );
          const pending = weekMatches.filter(
            (m) => m.status !== "COMPLETED",
          ).length;
          return (
            <details
              key={`tb${week}`}
              open
              className="rounded-lg border border-accent/40"
            >
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                Tiebreaker week · Week {week} · {weekMatches.every((match) => match.bestOf === 1) ? "Best of 1" : weekMatches.every((match) => match.bestOf === 3) ? "Best of 3" : "Best of 1 / Best of 3"}
                <span className="ml-2 text-xs font-normal text-muted">
                  {weekMatches.length - pending}/{weekMatches.length}{" "}
                  created matches entered
                </span>
              </summary>
              <div className="space-y-2 px-3 pb-3">
                {weekMatches.map((m) => (
                  <div key={m.id} id={`admin-tiebreaker-match-${m.id}`} data-testid="admin-tiebreaker-match" className="scroll-mt-40 lg:scroll-mt-56">
                    <MatchResultRow
                      id={adminMatchRowId(m.id)}
                      m={m}
                      teams={data.teams}
                      expectedActiveSeasonId={season.id}
                      seasonStatus={season.status}
                      leagueId={season.dotaLeagueId}
                      nowMs={nowMs}
                      draftStatus={data.draft?.status ?? null}
                      championTeamId={season.championTeamId}
                      {...matchCorrectionContext(m, data.matches)}
                      importHelpId="adm-import-help-tiebreaker"
                      label={
                        <Link
                          href={`/matches/${m.id}`}
                          className={textLink("shrink-0 text-xs")}
                        >
                          TB · {parseTiebreakerStage(m.bracketSlot) ? `Game ${parseTiebreakerStage(m.bracketSlot)!.stage}` : `Wk ${m.week}`} · BO{m.bestOf}
                        </Link>
                      }
                    />
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </CardBody>
    </Card>
  );
}
