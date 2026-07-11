import Link from "next/link";
import { prisma } from "@/lib/prisma";
import {
  formatGameDuration,
  leagueRecords,
  type GameRecord,
  type PlayerRecord,
  type RecordGame,
} from "@/lib/records";
import type { PlayerStat } from "@/lib/match-import";
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

export const metadata = { title: "Record book" };

function safeParse(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

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
  deaths: "deaths — a true frontliner",
};

const GAME_BLURB: Record<string, string> = {
  longest: "the marathon",
  shortest: "over before it started",
  bloodiest: "combined kills",
  stomp: "kill-score margin",
};

export default async function RecordsPage() {
  const games = await prisma.game.findMany({
    orderBy: [{ startTime: "asc" }, { fetchedAt: "asc" }],
    select: {
      matchId: true,
      radiantWin: true,
      durationSecs: true,
      radiantScore: true,
      direScore: true,
      players: true,
      match: { select: { seasonId: true } },
    },
  });

  const recordGames: RecordGame[] = games.map((g) => ({
    matchId: g.matchId,
    seasonId: g.match.seasonId,
    radiantWin: g.radiantWin,
    durationSecs: g.durationSecs,
    radiantScore: g.radiantScore,
    direScore: g.direScore,
    lines: safeParse(g.players).map((p) => ({
      userId: p.userId,
      heroId: p.heroId,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      netWorth: p.netWorth,
      gpm: p.gpm,
      lastHits: p.lastHits,
      isRadiant: p.isRadiant,
    })),
  }));

  const book = leagueRecords(recordGames);
  if (book.players.length === 0 && book.games.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle title="Record book" />
        <EmptyState
          title="No records yet"
          description="All-time records appear once match games are imported."
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
                  <div className="text-xs uppercase tracking-wide text-muted">
                    {r.emoji} {r.title}
                  </div>
                  <div className="mt-1 font-display text-3xl font-bold tabular-nums">
                    {playerValue(r)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {PLAYER_BLURB[r.key]}
                  </div>
                  <div className="mt-3 flex min-w-0 items-center gap-2">
                    {holder && (
                      <Avatar name={holder.name} src={holder.avatar} size={24} />
                    )}
                    <PlayerLink
                      userId={r.userId}
                      className="min-w-0 truncate text-sm font-medium"
                    >
                      {holder?.name ?? "Unknown"}
                    </PlayerLink>
                    {hero && <HeroIcon hero={hero} size={22} />}
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
                <div className="text-xs uppercase tracking-wide text-muted">
                  {r.emoji} {r.title}
                </div>
                <div className="mt-1 font-display text-3xl font-bold tabular-nums">
                  {gameValue(r)}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {GAME_BLURB[r.key]}
                </div>
                <div className="mt-2 text-xs text-muted">
                  {seasonName.get(r.seasonId) ?? "—"} ·{" "}
                  <Link
                    href={`/matches/${r.matchId}`}
                    className="underline-offset-2 hover:text-info hover:underline"
                  >
                    final score {r.score}
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
