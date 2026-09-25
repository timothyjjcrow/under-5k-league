import Link from "next/link";
import { decodeGamePlayers, trustedGamePlayers } from "@/lib/player-stats";
import { prisma } from "@/lib/prisma";
import { getPublicGameSnapshot } from "@/lib/public-game-snapshot";
import { careerGameCounts, topCounts, type HofRow } from "@/lib/hall-of-fame";
import { appearanceCareers } from "@/lib/appearance-careers";
import { pointsByPlayer } from "@/lib/fantasy";
import { pickemStandings } from "@/lib/pickem";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { shareMetadata } from "@/lib/share-metadata";
import {
  Avatar,
  Card,
  CardBody,
  EmptyState,
  PageTitle,
  PlayerLink,
  SectionTitle,
  TeamCrest,
  textLink,
} from "@/components/ui";

export const metadata = shareMetadata(
  "Hall of Fame",
  `The championship teams and career leaders across every ${LEAGUE_CONFIG.name} season.`,
  "/hall-of-fame",
);

type User = { id: string; name: string; avatar: string | null };
type Board = {
  id: string;
  title: string;
  subtitle: string;
  rows: HofRow[];
  format: (value: number) => string;
  detail: (userId: string) => string;
};

function BoardCard({ board, userOf }: { board: Board; userOf: Map<string, User> }) {
  return (
    <Card className="h-full">
      <CardBody className="h-full">
        <div className="mb-4">
          <h3 className="font-display text-xl font-bold">{board.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">{board.subtitle}</p>
        </div>
        {board.rows.length === 0 ? (
          <p className="rounded-lg bg-surface-2/50 p-4 text-sm text-muted">Nobody has qualified yet.</p>
        ) : (
          <ol className="space-y-2">
            {board.rows.map((row, index) => {
              const user = userOf.get(row.userId);
              return (
                <li key={row.userId} className={`flex min-w-0 items-center gap-3 rounded-lg px-3 py-3 ${index === 0 ? "border border-accent/30 bg-accent/10" : "bg-surface-2/50"}`}>
                  <span className={`w-5 shrink-0 text-center font-mono text-sm font-bold tabular-nums ${index === 0 ? "text-accent" : "text-muted"}`}>{index + 1}</span>
                  <Avatar name={user?.name ?? "Former player"} src={user?.avatar} size={32} />
                  <div className="min-w-0 flex-1">
                    {user ? (
                      <PlayerLink userId={row.userId} className="block truncate text-sm font-semibold">{user.name}</PlayerLink>
                    ) : <span className="block truncate text-sm font-semibold text-muted">Former player</span>}
                    <p className="truncate text-xs text-muted">{board.detail(row.userId)}</p>
                  </div>
                  <strong className="shrink-0 font-display text-xl tabular-nums">{board.format(row.value)}</strong>
                </li>
              );
            })}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

export default async function HallOfFamePage() {
  const [seasons, matches, games, predictions] = await Promise.all([
    prisma.season.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, status: true, championTeamId: true },
    }),
    prisma.match.findMany({
      select: {
        id: true, seasonId: true, phase: true, bracketSlot: true,
        status: true, winnerTeamId: true, homeTeamId: true,
        awayTeamId: true, scheduledAt: true,
      },
    }),
    getPublicGameSnapshot(null),
    prisma.prediction.findMany({ select: { matchId: true, userId: true, pickedTeamId: true } }),
  ]);
  const matchesBySeason = new Map<string, typeof matches>();
  for (const match of matches) {
    const seasonMatches = matchesBySeason.get(match.seasonId) ?? [];
    seasonMatches.push(match);
    matchesBySeason.set(match.seasonId, seasonMatches);
  }
  const champions = seasons
    .map((season) => ({
      season,
      teamId: resolveChampionPresentation(season, matchesBySeason.get(season.id) ?? []).championTeamId,
    }))
    .filter((row): row is { season: typeof seasons[number]; teamId: string } => Boolean(row.teamId));
  const championTeamIds = champions.map((row) => row.teamId);

  const careers = appearanceCareers(games, matches,
    champions.map(({ season, teamId }) => ({ seasonId: season.id, teamId })));
  const titles = careers.championshipContributions;
  const seriesWins = careers.seriesWins;
  const memberships = careers.rows.filter((row) => row.championshipContribution);
  const trustedGames = games.map((game) => ({
    radiantWin: game.radiantWin,
    players: trustedGamePlayers(decodeGamePlayers(game.players)),
  })).filter((game) => game.players.length === 10);
  const gameCounts = careerGameCounts(trustedGames);
  const gameWins = new Map([...gameCounts].map(([id, count]) => [id, count.wins]));
  const fantasy = pointsByPlayer(trustedGames);
  const winRate = [...gameCounts].filter(([, count]) => count.games >= 5)
    .map(([userId, count]) => ({ userId, value: count.wins / count.games * 100, games: count.games }))
    .sort((a, b) => b.value - a.value || b.games - a.games || a.userId.localeCompare(b.userId))
    .slice(0, 5);
  const fantasyPerGame = [...fantasy].flatMap(([userId, points]) => {
    const gameCount = gameCounts.get(userId)?.games ?? 0;
    return gameCount >= 5 ? [{ userId, value: points / gameCount, games: gameCount }] : [];
  }).filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || b.games - a.games || a.userId.localeCompare(b.userId))
    .slice(0, 5);
  const oracle = pickemStandings(predictions, matches)
    .filter((standing) => standing.graded >= 3)
    .sort((a, b) => b.accuracy - a.accuracy || b.graded - a.graded || a.userId.localeCompare(b.userId))
    .slice(0, 5);
  const oracleOf = new Map(oracle.map((standing) => [standing.userId, standing]));
  const number = new Intl.NumberFormat("en-US");
  const pointsNumber = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const careerBoards: Board[] = [
    {
      id: "titles", title: "🏆 Championship contributions", subtitle: "Appeared for a title-winning team during its championship season, including substitutes and former members.",
      rows: topCounts(titles), format: (value) => `${value}×`,
      detail: (id) => `${seriesWins.get(id) ?? 0} series wins with an appearance`,
    },
    {
      id: "series", title: "⚔️ Series wins", subtitle: "Completed victories with at least one recorded appearance for the winning team. Counted once per series.",
      rows: topCounts(seriesWins), format: (value) => number.format(value),
      detail: (id) => `${titles.get(id) ?? 0} championship contributions`,
    },
  ];
  const performanceBoards: Board[] = [
    {
      id: "game-wins", title: "🎮 Game wins", subtitle: "Actual Dota games played and won in trusted box scores.",
      rows: topCounts(gameWins), format: (value) => number.format(value),
      detail: (id) => `${gameCounts.get(id)?.wins ?? 0}/${gameCounts.get(id)?.games ?? 0} games won`,
    },
    {
      id: "win-rate", title: "📈 Game win rate", subtitle: "At least five imported games to qualify.",
      rows: winRate, format: (value) => `${Math.round(value)}%`,
      detail: (id) => `${gameCounts.get(id)?.wins ?? 0}/${gameCounts.get(id)?.games ?? 0} games won`,
    },
    {
      id: "fantasy-pace", title: "✨ Fantasy per game", subtitle: "Role-aware production with at least five games.",
      rows: fantasyPerGame, format: (value) => value.toFixed(1),
      detail: (id) => `${gameCounts.get(id)?.games ?? 0} games played`,
    },
    {
      id: "fantasy-total", title: "🎯 Fantasy total", subtitle: "Career points across every trusted imported game.",
      rows: topCounts(fantasy), format: (value) => pointsNumber.format(value),
      detail: (id) => `${gameCounts.get(id)?.games ?? 0} games played`,
    },
  ];
  const oracleBoard: Board = {
    id: "oracle", title: "🔮 Pick'em accuracy", subtitle: "Correct picks divided by graded picks; at least three to qualify.",
    rows: oracle.map((standing) => ({ userId: standing.userId, value: Math.round(standing.accuracy * 100) })),
    format: (value) => `${value}%`,
    detail: (id) => `${oracleOf.get(id)?.correct ?? 0}/${oracleOf.get(id)?.graded ?? 0} correct picks`,
  };
  const boards = [...careerBoards, ...performanceBoards, oracleBoard];

  const teams = championTeamIds.length
    ? await prisma.team.findMany({
        where: { id: { in: championTeamIds } },
        select: { id: true, name: true, logoUrl: true },
      })
    : [];
  const teamOf = new Map(teams.map((team) => [team.id, team]));
  const championRosterIds = memberships
    .filter((member) => championTeamIds.includes(member.teamId))
    .map((member) => member.userId);
  const everyUserId = [...new Set([
    ...boards.flatMap((board) => board.rows.map((row) => row.userId)),
    ...championRosterIds,
  ])];
  const users = everyUserId.length
    ? await prisma.user.findMany({
        where: { id: { in: everyUserId } },
        select: { id: true, name: true, avatar: true },
      })
    : [];
  const userOf = new Map(users.map((user) => [user.id, user]));
  const featuredChampion = champions[0];
  const featuredTeam = featuredChampion ? teamOf.get(featuredChampion.teamId) : null;
  const hasCareerRows = boards.some((board) => board.rows.length > 0);

  return (
    <div className="space-y-8">
      <PageTitle
        title="Hall of Fame"
        subtitle="The teams that lifted the trophy and the players who built lasting careers."
        action={
          <div className="flex flex-wrap gap-3">
            <Link href="/records" className={textLink("text-sm")}>Single-game records →</Link>
            <Link href="/seasons" className={textLink("text-sm")}>Season history →</Link>
          </div>
        }
      />

      <section className="overflow-hidden rounded-2xl border border-accent/30 bg-gradient-to-br from-surface-3 via-surface to-bg p-5 sm:p-7">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-accent">League legacy</p>
            <h2 className="mt-2 max-w-2xl font-display text-3xl font-bold leading-tight sm:text-4xl">
              {featuredChampion && featuredTeam
                ? `${featuredTeam.name} is the latest champion.`
                : "The next chapter is still being written."}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              Explore official team titles, recorded player contributions, imported game performances, and pick&apos;em results across the full archive.
            </p>
            {featuredChampion && featuredTeam ? (
              <Link href={`/seasons/${featuredChampion.season.id}`} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-info hover:underline">
                <TeamCrest name={featuredTeam.name} seed={featuredTeam.id} logoUrl={featuredTeam.logoUrl} size={30} />
                Relive {featuredChampion.season.name} →
              </Link>
            ) : null}
          </div>
          <div className="grid grid-cols-3 gap-3 text-center lg:min-w-72">
            {([[seasons.length, "seasons"], [champions.length, "champions"], [trustedGames.length, "games"]] as const).map(([value, label]) => (
              <div key={label} className="rounded-xl border border-line bg-bg/45 px-3 py-3">
                <div className="font-display text-2xl font-bold tabular-nums">{value}</div>
                <div className="text-xs text-muted">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <nav aria-label="Hall of Fame sections" className="flex flex-wrap gap-2">
        {[
          ["career", "Career honors"],
          ["performance", "Game performance"],
          ["prediction", "Pick'em"],
          ["champions", "Champions"],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-full border border-line bg-surface px-3 py-2 text-sm font-medium text-muted hover:border-accent/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{label} ↓</a>
        ))}
      </nav>

      {!hasCareerRows && champions.length === 0 ? (
        <EmptyState title="No legends yet" description="Careers and champions appear as completed matches and imported games build league history." />
      ) : null}

      <section id="career" className="scroll-mt-24 space-y-3">
        <SectionTitle aside="Team results across every season">Career honors</SectionTitle>
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          {careerBoards.map((board) => <BoardCard key={board.id} board={board} userOf={userOf} />)}
        </div>
      </section>

      <section id="performance" className="scroll-mt-24 space-y-3">
        <SectionTitle aside="Trusted imported box scores only">Game performance</SectionTitle>
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          {performanceBoards.map((board) => <BoardCard key={board.id} board={board} userOf={userOf} />)}
        </div>
      </section>

      <section id="prediction" className="scroll-mt-24 space-y-3">
        <SectionTitle aside="A rate with a visible sample">Pick&apos;em</SectionTitle>
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
          <BoardCard board={oracleBoard} userOf={userOf} />
          <Card tone="quiet">
            <CardBody>
              <h3 className="font-display text-xl font-bold">How this is ranked</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Pick&apos;em ranks by accuracy after three graded picks. Draws and unfinished matches are not graded. The correct/graded line shows exactly how much evidence sits behind each percentage.
              </p>
              <Link href="/pickem" className="mt-4 inline-block text-sm font-semibold text-info hover:underline">Make a pick →</Link>
            </CardBody>
          </Card>
        </div>
      </section>

      <section id="champions" className="scroll-mt-24 space-y-3">
        <SectionTitle aside="Only verified completed-season titles">Champion history</SectionTitle>
        {champions.length === 0 ? (
          <Card tone="quiet"><CardBody><p className="text-sm text-muted">No completed season has an official champion yet.</p></CardBody></Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {champions.map(({ season, teamId }) => {
              const team = teamOf.get(teamId);
              const roster = memberships.filter((member) => member.teamId === teamId);
              return (
                <Card key={season.id}>
                  <CardBody>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{season.name}</p>
                    <div className="mt-3 flex items-center gap-3">
                      <TeamCrest name={team?.name ?? "Champion"} seed={teamId} logoUrl={team?.logoUrl} size={48} />
                      <div className="min-w-0">
                        <h3 className="truncate font-display text-xl font-bold">{team?.name ?? "Archived champion"}</h3>
                        <Link href={`/seasons/${season.id}`} className="text-xs font-semibold text-info hover:underline">View season →</Link>
                      </div>
                    </div>
                    {roster.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line-soft pt-4">
                        <p className="w-full text-xs text-muted">Recorded contributors during this championship season</p>
                        {roster.map((member) => {
                          const user = userOf.get(member.userId);
                          return user ? (
                            <PlayerLink key={member.userId} userId={member.userId} className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium">{user.name}</PlayerLink>
                          ) : null;
                        })}
                      </div>
                    ) : <p className="mt-4 text-xs text-muted">The team title is recorded; individual appearances have not been recovered.</p>}
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <p className="border-t border-line-soft pt-4 text-xs leading-relaxed text-muted">
        Player contributions use {careers.coverage.trustedGames} trusted game{careers.coverage.trustedGames === 1 ? "" : "s"} of {careers.coverage.importedGames} imported.
        {careers.coverage.unattributedLines > 0 ? ` ${careers.coverage.unattributedLines} player lines lack a verified player/team pairing and cannot receive a team contribution.` : ""}
        {" "}Manual results without box scores still count for teams; they do not invent individual appearances. Historical totals change when a result is corrected. Fantasy uses the current role-aware scoring rules for every imported game.
      </p>
    </div>
  );
}
