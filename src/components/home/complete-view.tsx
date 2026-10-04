import type { Match } from "@prisma/client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Bracket } from "@/components/bracket";
import { ChampionMoment } from "@/components/champion-moment";
import { Countdown } from "@/components/countdown";
import { LocalTime } from "@/components/local-time";
import { StandingsTable } from "@/components/standings-table-server";
import {
  Card,
  CardBody,
  CardHeader,
  DiscordButton,
  LinkArrow,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { buildBracketRounds, seedsFromFirstRound } from "@/lib/bracket-view";
import { championFinalLine } from "@/lib/champion-moment";
import type { ChampionPresentation } from "@/lib/champion-presentation";
import { DISCORD_INVITE_URL } from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";
import type { SeasonSnapshot } from "@/lib/queries";
import { NEXT_SEASON_PASSED_LABEL } from "@/lib/season-copy";
import { computeStandings } from "@/lib/standings";
import { formByTeam } from "@/lib/team-matches";
import type { HeroParts } from "./hero";
import { fmtWhen } from "./when";

/**
 * The hero once the season is complete. The champion banner directly below
 * is the page's one champion block (the review card stands in for it while
 * the title needs review), so the hero names no team. Its first button is the
 * page's one way to the season's page, where the recap lives (/recap
 * redirects there too); the second is where the next season gets announced:
 * the league Discord, or League news in a region without an invite. Its meta
 * line says when the next season's signups open, once an admin has set the
 * date on /admin's Season handoff card, and "coming soon" until then.
 */
export function completeHero(
  seasonId: string,
  nextSignupsAtMs: number | null,
): HeroParts {
  return {
    action: (
      <>
        <Link
          href={`/seasons/${seasonId}`}
          className={buttonClasses("accent", "lg")}
        >
          Relive the season <LinkArrow />
        </Link>
        {DISCORD_INVITE_URL ? (
          <DiscordButton size="lg" />
        ) : (
          <Link href="/news" className={buttonClasses("secondary", "lg")}>
            League news <LinkArrow />
          </Link>
        )}
      </>
    ),
    meta: <NextSeasonLine signupsAtMs={nextSignupsAtMs} />,
  };
}

/**
 * "Next season: signups open Sat, Oct 17, 6:00 PM" with a countdown, or
 * "Next season: coming soon". The date is display-only (phases never advance
 * themselves), so the countdown owns saying when it has slipped: past the
 * date, Home is still in Season complete and the chip reads
 * NEXT_SEASON_PASSED_LABEL, decided on the client like every countdown.
 */
function NextSeasonLine({ signupsAtMs }: { signupsAtMs: number | null }) {
  if (signupsAtMs == null) {
    return (
      <span className="text-sm text-muted">
        <span aria-hidden>🗓️</span> Next season:{" "}
        <strong className="font-medium text-fg">coming soon</strong>
      </span>
    );
  }
  return (
    <span className="text-sm text-muted">
      <span aria-hidden>🗓️</span> Next season: signups open{" "}
      <strong className="font-medium text-fg">
        <LocalTime
          ts={signupsAtMs}
          variant="full"
          initial={formatLeagueMatchTime(new Date(signupsAtMs), "full")}
        />
      </strong>
      <Countdown
        targetMs={signupsAtMs}
        eventLabel="Signups"
        futureVerb="open"
        passedLabel={NEXT_SEASON_PASSED_LABEL}
        passesAtTarget
      />
    </span>
  );
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
  const finalLine = champion
    ? championFinalLine(finalMatch, champion.id)
    : null;

  return (
    <div className="space-y-5">
      {champion ? (
        <ChampionMoment
          seasonName={season.name}
          team={champion}
          final={finalLine}
          opponentName={
            finalLine ? (teamName.get(finalLine.opponentTeamId) ?? null) : null
          }
          record={championRow ?? null}
          roster={champion.members}
        />
      ) : (
        // No authoritative champion: this card says why and what fixes it,
        // where the banner would stand.
        <Card>
          <CardBody className="flex flex-col items-center gap-3 py-6 text-center sm:flex-row sm:items-center sm:gap-6 sm:px-6 sm:text-left">
            <div aria-hidden className="shrink-0 text-4xl">
              ⚠️
            </div>
            <div className="flex min-w-0 flex-col items-center gap-1.5 sm:items-start">
              <div className="max-w-full text-xs font-medium uppercase tracking-[0.2em] text-amber-300/90 [overflow-wrap:anywhere]">
                {season.name} · review needed
              </div>
              <div className="text-2xl font-bold">Champion needs review</div>
              <p className="max-w-xl text-sm text-muted">
                This season is marked complete without an authoritative champion.
                {hasPostseason
                  ? " League administrators need to return it to Playoffs and reconcile the existing grand final before a title is shown."
                  : " No playoff bracket exists, so league administrators need to return it to Regular season, verify the table, and start a newly seeded bracket before a title is shown."}
              </p>
            </div>
          </CardBody>
        </Card>
      )}

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
