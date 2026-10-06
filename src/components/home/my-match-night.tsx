import Link from "next/link";
import type { Match } from "@prisma/client";
import { HeroIcon } from "@/components/hero-icon";
import { Badge, Card, CardBody, CardHeader, LinkArrow, textLink } from "@/components/ui";
import { MATCH_STATUS } from "@/lib/constants";
import { heroById } from "@/lib/heroes";
import { myMatchNight } from "@/lib/my-match-night";
import { getPlayerGameFacts } from "@/lib/player-game-history";
import { matchRoundLabel, playoffTotalRounds } from "@/lib/schedule";
import { cn } from "@/lib/utils";

/**
 * "Your match night": the viewer's own recap of their latest series for
 * MY_MATCH_NIGHT_HOURS after it (myMatchNight): their line in each game, the
 * impact points and Match MVPs, and any badge the night earned for the first
 * time. The moment a series was final, the player's own night vanished from
 * Home; this is the reason to come back the next day. Renders nothing outside
 * its window, so Home streams it with a null fallback. Database reads only:
 * the viewer's own games, which their profile reads the same way.
 */
export async function MyMatchNightCard({
  userId,
  matches,
  teamName,
}: {
  userId: string;
  matches: Match[];
  teamName: Map<string, string>;
}) {
  const completed = new Map(
    matches
      .filter((match) => match.status === MATCH_STATUS.COMPLETED)
      .map((match) => [match.id, match]),
  );
  if (completed.size === 0) return null;
  const games = await getPlayerGameFacts(userId);
  const recap = myMatchNight({
    userId,
    games,
    completedMatchIds: new Set(completed.keys()),
    // Async server component: rendered once per request.
    // eslint-disable-next-line react-hooks/purity
    nowMs: Date.now(),
  });
  if (!recap) return null;
  const match = completed.get(recap.matchId);
  if (!match) return null;

  const home = teamName.get(match.homeTeamId) ?? "Home";
  const away = teamName.get(match.awayTeamId) ?? "Away";
  const result =
    match.winnerTeamId == null
      ? "Draw"
      : match.winnerTeamId === recap.teamId
        ? "Won"
        : "Lost";
  const label = matchRoundLabel(match, playoffTotalRounds(matches));

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Your match night"
        subtitle={`${label} · ${home} ${match.homeScore}–${match.awayScore} ${away}`}
        action={
          <Badge tone={result === "Won" ? "success" : result === "Lost" ? "danger" : undefined}>
            {result}
          </Badge>
        }
      />
      <CardBody className="space-y-3">
        <ul className="divide-y divide-line-soft rounded-lg border border-line">
          {recap.games.map((game) => {
            const hero = heroById(game.heroId);
            return (
              <li
                key={game.gameNumber}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
              >
                <span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">
                  Game {game.gameNumber}
                </span>
                {hero ? <HeroIcon hero={hero} size={26} /> : null}
                <span className="min-w-0 truncate font-medium">
                  {hero?.name ?? "Unknown hero"}
                </span>
                <span className="tabular-nums text-muted">
                  {game.kills}/{game.deaths}/{game.assists}
                </span>
                <span className="tabular-nums">
                  {game.impact} <span className="text-muted">impact</span>
                </span>
                {game.mvp ? (
                  <span className="text-accent">
                    <span aria-hidden>🏅 </span>Match MVP
                  </span>
                ) : null}
                <span
                  className={cn(
                    "ml-auto shrink-0 text-xs font-semibold",
                    game.won ? "text-success" : "text-danger-soft",
                  )}
                >
                  {game.won ? "Win" : "Loss"}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="text-sm text-muted">
          <span className="font-medium text-fg tabular-nums">
            {recap.totalImpact} impact points
          </span>{" "}
          over {recap.games.length} game{recap.games.length === 1 ? "" : "s"}
          {recap.mvps > 0
            ? ` · Match MVP ×${recap.mvps}`
            : ""}
        </p>
        {recap.newBadges.length > 0 ? (
          <p className="text-sm">
            <span className="text-muted">New on your profile: </span>
            {recap.newBadges.map((badge, index) => (
              <span key={badge.key} title={badge.desc}>
                {index > 0 ? ", " : ""}
                <span aria-hidden>{badge.emoji} </span>
                {badge.label}
              </span>
            ))}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <Link href={`/matches/${match.id}`} className={textLink("text-sm")}>
            Match page <LinkArrow />
          </Link>
          <Link href={`/players/${userId}`} className={textLink("text-sm")}>
            Your profile <LinkArrow />
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
