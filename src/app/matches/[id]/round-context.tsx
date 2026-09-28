import Link from "next/link";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  playoffMatchContext,
  playoffMatchContextText,
} from "@/lib/playoff-match-context";
import { parseSingleTiebreakerSlot, parseTiebreakerStage } from "@/lib/tiebreaker-format";
import { LinkArrow, textLink } from "@/components/ui";
import type { MatchPageMatch, MatchPostseason } from "./load";

/** A tiebreaker series' format and what this game decides, above the scoreboard. */
export function TiebreakerNote({ match }: { match: MatchPageMatch }) {
  if (match.phase !== "TIEBREAKER") return null;
  const tiebreakerStage = parseTiebreakerStage(match.bracketSlot)?.stage;
  return (
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
  );
}

/**
 * What this knockout series decides: where the winner goes and that the loser
 * is out. Tiebreakers keep their own note.
 */
export function PlayoffContextLine({
  match,
  postseason,
}: {
  match: MatchPageMatch;
  postseason: MatchPostseason;
}) {
  const playoffContext = playoffMatchContext(match, postseason);
  if (!playoffContext) return null;
  const bracketTeamName = new Map(
    postseason.flatMap((m): [string, string][] => [
      [m.homeTeamId, m.homeTeam.name],
      [m.awayTeamId, m.awayTeam.name],
    ]),
  );
  return (
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
  );
}
