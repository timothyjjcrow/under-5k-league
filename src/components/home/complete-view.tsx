import type { Match } from "@prisma/client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Bracket } from "@/components/bracket";
import { SeriesRecord } from "@/components/series-record";
import { StandingsTable } from "@/components/standings-table-server";
import {
  Avatar,
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  PlayerLink,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import type { ChampionPresentation } from "@/lib/champion-presentation";
import type { SeasonSnapshot } from "@/lib/queries";
import { computeStandings } from "@/lib/standings";
import { formByTeam } from "@/lib/team-matches";
import type { HeroParts } from "./hero";
import { fmtWhen } from "./when";

/**
 * The hero once the season is complete. The champion card directly below is
 * the page's one champion block (it also carries the final's score and the
 * "needs review" state), so the hero names no team. Its button is the page's
 * one way to the season's page, where the recap lives; /recap redirects there
 * too.
 */
export function completeHero(seasonId: string): HeroParts {
  return {
    action: (
      <Link
        href={`/seasons/${seasonId}`}
        className={buttonClasses("accent", "lg")}
      >
        Relive the season <LinkArrow />
      </Link>
    ),
  };
}

export async function CompleteView({
  snapshot,
  matches,
  championPresentation,
  rail,
}: {
  snapshot: SeasonSnapshot;
  matches: Match[];
  championPresentation: ChampionPresentation;
  /** Home's own sections that end the rail (news, the inhouse queue). */
  rail?: ReactNode;
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
    <div className="space-y-5">
      {/* The champion as a banner: the crest beside the story rather than
          stacked over it, which stood about 310px tall on a desktop. */}
      <Card className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400/15 blur-3xl sm:left-16 sm:translate-x-0"
        />
        <CardBody className="relative flex flex-col items-center gap-3 py-6 text-center sm:flex-row sm:items-center sm:gap-6 sm:px-6 sm:text-left">
          {champion ? (
            <div className="relative shrink-0">
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
            <div aria-hidden className="shrink-0 text-4xl">
              ⚠️
            </div>
          )}
          <div className="flex min-w-0 flex-col items-center gap-1.5 sm:items-start">
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-amber-300/90">
              {champion
                ? `${season.name} Champion`
                : `${season.name} · review needed`}
            </div>
            <div className="text-2xl font-bold [overflow-wrap:anywhere]">
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
            {finalLine || championRow ? (
              <p className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-sm text-muted sm:justify-start">
                {finalLine ? (
                  <span>
                    Won the grand final{" "}
                    <span className="font-medium text-fg">{finalLine.score}</span>
                    {finalLine.loser ? ` over ${finalLine.loser}` : ""}
                  </span>
                ) : null}
                {finalLine && championRow ? (
                  <span aria-hidden className="text-line">
                    •
                  </span>
                ) : null}
                {championRow ? (
                  <span>
                    <span className="font-medium text-fg">
                      <SeriesRecord record={championRow} />
                    </span>{" "}
                    regular season · {championRow.points} pts
                  </span>
                ) : null}
              </p>
            ) : null}
            {champion && champion.members.length > 0 ? (
              // my-0 on the chips below: the py-0.5 orphans TAP_SAFE's -my-1
              // through twMerge, so the chip reserves 8px less than it occupies
              // (see teams/page.tsx for the measurement). The winning five's
              // chips wrap on every phone, and this is the champion card.
              <div className="mt-1 flex flex-wrap justify-center gap-1.5 sm:justify-start">
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
          </div>
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
          the COMPLETE twin of the void the mid-season deck used to have. The
          rail matches the mid-season dashboard's, and carries Home's news
          and the inhouse queue. */}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0">
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
        <div className="min-w-0 space-y-5">
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
          {rail}
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
