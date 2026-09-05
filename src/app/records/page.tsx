import { LEAGUE_CONFIG } from "@/lib/league-config";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAllGamesForRecords } from "@/lib/cached-queries";
import {
  formatGameDuration,
  analyzeRecordGames,
  leagueRecords,
  type GameRecord,
  type PlayerRecord,
} from "@/lib/records";
import { heroById } from "@/lib/heroes";
import { formatNetWorth } from "@/lib/utils";
import {
  Avatar,
  Card,
  CardBody,
  EmptyState,
  HeroIcon,
  PageTitle,
  PlayerLink,
  SectionTitle,
} from "@/components/ui";
import { StatsDataNotice, StatsNav } from "@/components/stats-nav";
import { shareMetadata } from "@/lib/share-metadata";

export const metadata = shareMetadata(
  "Record book",
  `${LEAGUE_CONFIG.name}'s all-time single-game player and match records across every retained season.`,
  "/records",
);

/** Big display value per record key. */
function playerValue(r: PlayerRecord): string {
  switch (r.key) {
    case "netWorth":
      return formatNetWorth(r.value);
    case "gpm":
      return `${r.value} GPM`;
    default:
      return String(r.value);
  }
}

function gameValue(r: GameRecord): string {
  switch (r.key) {
    case "longest":
    case "shortest":
      return formatGameDuration(r.value);
    case "stomp":
      return `+${r.value}`;
    default:
      return String(r.value);
  }
}

const PLAYER_BLURB: Record<string, string> = {
  kills: "kills in a single game",
  assists: "assists in a single game",
  netWorth: "net worth at the horn",
  gpm: "gold per minute",
  lastHits: "last hits farmed",
  deaths: "deaths in a single game",
};

const GAME_BLURB: Record<string, string> = {
  longest: "the marathon",
  shortest: "over before it started",
  bloodiest: "combined kills",
  stomp: "kill-score margin",
};

export default async function RecordsPage() {
  const games = await getAllGamesForRecords();
  const recordAnalysis = analyzeRecordGames(games);
  const {
    invalidLines,
    malformedGames,
    unusableGames,
    unknownHeroLines,
    unmappedLines,
    invalidGameMetrics,
  } = recordAnalysis.diagnostics;

  // Game records name the matchup. Home/away come off the match — radiant/dire
  // sides can swap between games of a series, so the kill score stays
  // side-agnostic ("final score") rather than claiming an orientation.
  const matchupOf = new Map(
    games.map((g) => [
      g.matchId,
      `${g.match.homeTeam.name} vs ${g.match.awayTeam.name}`,
    ]),
  );

  // Shared with the profile page's record-holder chips — one mapping, no drift.
  const book = leagueRecords(recordAnalysis.games);
  if (book.players.length === 0 && book.games.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle title="Record book" />
        <StatsNav active="records" />
        <StatsDataNotice
          invalidLines={invalidLines}
          malformedGames={malformedGames}
          unusableGames={unusableGames}
          unknownHeroLines={unknownHeroLines}
          unmappedLines={unmappedLines}
          invalidGameMetrics={invalidGameMetrics}
        />
        <EmptyState
          title="No records yet"
          description={
            games.length > 0
              ? "Games are stored, but none has a complete, valid 5v5 box score that can enter the record book. Use the data notice above to repair the imports."
              : "All-time records appear once match games are imported."
          }
        />
      </div>
    );
  }

  const [users, seasons] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: [...new Set(book.players.map((r) => r.userId))] } },
      select: { id: true, name: true, avatar: true },
    }),
    prisma.season.findMany({ select: { id: true, name: true } }),
  ]);
  const userOf = new Map(users.map((u) => [u.id, u]));
  const seasonName = new Map(seasons.map((s) => [s.id, s.name]));

  return (
    <div className="space-y-6">
      <PageTitle
        title="Record book"
        subtitle="All-time single-game records — every season counts"
      />
      <StatsNav active="records" />
      <StatsDataNotice
        invalidLines={invalidLines}
        malformedGames={malformedGames}
        unusableGames={unusableGames}
        unknownHeroLines={unknownHeroLines}
        unmappedLines={unmappedLines}
        invalidGameMetrics={invalidGameMetrics}
      />
      <p className="text-xs text-muted">
        A tied record stays with the first player or game to set it; legacy
        imports without a start time sort after known chronology.
      </p>

      {book.players.length > 0 && (
        <section className="space-y-3">
          <SectionTitle>Player records</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {book.players.map((r) => {
              const holder = userOf.get(r.userId);
              const hero = heroById(r.heroId);
              return (
                <Card key={r.key}>
                  <CardBody>
                    <h3 className="text-xs uppercase tracking-wide text-muted">
                      {r.emoji} {r.title}
                    </h3>
                    <div className="mt-1 font-display text-3xl font-bold tabular-nums">
                      {playerValue(r)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {PLAYER_BLURB[r.key]}
                    </div>
                    <div className="mt-3 flex min-w-0 items-center gap-2">
                      {holder && (
                        <Avatar
                          name={holder.name}
                          src={holder.avatar}
                          size={24}
                        />
                      )}
                      {holder ? (
                        <PlayerLink
                          userId={r.userId}
                          className="min-w-0 truncate text-sm font-medium"
                        >
                          {holder.name}
                        </PlayerLink>
                      ) : (
                        <span className="min-w-0 truncate text-sm font-medium text-muted">
                          Former player
                        </span>
                      )}
                      {hero ? (
                        <HeroIcon hero={hero} size={22} />
                      ) : (
                        <span className="shrink-0 text-xs text-muted">
                          Hero #{r.heroId}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-xs text-muted">
                      {seasonName.get(r.seasonId) ?? "—"} ·{" "}
                      <Link
                        href={`/matches/${r.matchId}`}
                        className="underline-offset-2 hover:text-info hover:underline"
                      >
                        {r.won ? "won it, too" : "lost the game anyway"}
                      </Link>
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {book.games.length > 0 && (
        <section className="space-y-3">
          <SectionTitle>Game records</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {book.games.map((r) => (
              <Card key={r.key}>
                <CardBody>
                  <h3 className="text-xs uppercase tracking-wide text-muted">
                    {r.emoji} {r.title}
                  </h3>
                  <div className="mt-1 font-display text-3xl font-bold tabular-nums">
                    {gameValue(r)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {GAME_BLURB[r.key]}
                  </div>
                  {matchupOf.has(r.matchId) && (
                    <div className="mt-3 text-sm font-medium">
                      {matchupOf.get(r.matchId)}
                    </div>
                  )}
                  <div className="mt-2 text-xs text-muted">
                    {seasonName.get(r.seasonId) ?? "—"} ·{" "}
                    <Link
                      href={`/matches/${r.matchId}`}
                      className="underline-offset-2 hover:text-info hover:underline"
                    >
                      kill score {r.score}
                    </Link>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
