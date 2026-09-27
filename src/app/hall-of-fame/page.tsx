import Link from "next/link";
import { decodeGamePlayers, trustedGamePlayers } from "@/lib/player-stats";
import { prisma } from "@/lib/prisma";
import { getPublicGameSnapshot } from "@/lib/public-game-snapshot";
import {
  careerGameCounts,
  rankCounts,
  topPlaces,
  type HofBoardRows,
} from "@/lib/hall-of-fame";
import { appearanceCareers } from "@/lib/appearance-careers";
import { impactPointsRule, pointsByPlayer } from "@/lib/fantasy";
import { pickemStandings } from "@/lib/pickem";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { shareMetadata } from "@/lib/share-metadata";
import {
  Avatar,
  Card,
  CardBody,
  EmptyState,
  buttonClasses,
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
  top: HofBoardRows;
  format: (value: number) => string;
  /** A supporting line under the name; null when it would only say "0". */
  detail: (userId: string) => string | null;
};

/** Board values rounded to the one decimal they are shown with. */
const tenths = (value: number) => Math.round(value * 10);

/** "3 series wins with an appearance"; null for zero, which says nothing. */
function countLine(count: number | undefined, one: string, many: string): string | null {
  if (!count) return null;
  return `${count} ${count === 1 ? one : many}`;
}

function BoardCard({ board, userOf }: { board: Board; userOf: Map<string, User> }) {
  return (
    <Card className="h-full">
      <CardBody className="h-full">
        <div className="mb-4">
          <h3 className="font-display text-xl font-bold">{board.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">{board.subtitle}</p>
        </div>
        {board.top.rows.length === 0 ? (
          <p className="rounded-lg bg-surface-2/50 p-4 text-sm text-muted">Nobody has qualified yet.</p>
        ) : (
          <>
            <ol className="space-y-2">
              {board.top.rows.map((row) => {
                const user = userOf.get(row.userId);
                const detail = board.detail(row.userId);
                const first = row.place === 1;
                return (
                  <li key={row.userId} className={`flex min-w-0 items-center gap-3 rounded-lg px-3 py-3 ${first ? "border border-accent/30 bg-accent/10" : "bg-surface-2/50"}`}>
                    <span className={`w-5 shrink-0 text-center font-mono text-sm font-bold tabular-nums ${first ? "text-accent" : "text-muted"}`}>{row.place}</span>
                    <Avatar name={user?.name ?? "Former player"} src={user?.avatar} size={32} />
                    <div className="min-w-0 flex-1">
                      {user ? (
                        <PlayerLink userId={row.userId} className="block truncate text-sm font-semibold">{user.name}</PlayerLink>
                      ) : <span className="block truncate text-sm font-semibold text-muted">Former player</span>}
                      {detail ? <p className="truncate text-xs text-muted">{detail}</p> : null}
                    </div>
                    <strong className="shrink-0 font-display text-xl tabular-nums">{board.format(row.value)}</strong>
                  </li>
                );
              })}
            </ol>
            {board.top.moreTied > 0 ? (
              <p className="mt-2 px-3 text-xs text-muted">
                +{board.top.moreTied} more tied at {board.format(board.top.rows[board.top.rows.length - 1].value)}
              </p>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}

export default async function HallOfFamePage() {
  const [seasons, matches] = await Promise.all([
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

  // A hall of fame starts with a champion. Before one exists every board
  // would be empty or repeat this season's Leaders, so the page is just
  // this one note.
  if (champions.length === 0) {
    return (
      <div>
        <PageTitle
          title="Hall of Fame"
          subtitle="The teams that lifted the trophy and the players who built lasting careers."
        />
        <EmptyState
          title="No champion yet"
          description="The Hall of Fame opens when a season crowns its champion. Until then, Leaders and the Record book follow the season."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/leaders" className={buttonClasses("secondary", "sm")}>Leaders →</Link>
              <Link href="/records" className={buttonClasses("secondary", "sm")}>Record book →</Link>
            </div>
          }
        />
      </div>
    );
  }

  const [games, predictions] = await Promise.all([
    getPublicGameSnapshot(null),
    prisma.prediction.findMany({ select: { matchId: true, userId: true, pickedTeamId: true } }),
  ]);
  const championTeamIds = champions.map((row) => row.teamId);
  const careers = appearanceCareers(games, matches,
    champions.map(({ season, teamId }) => ({ seasonId: season.id, teamId })));
  const titles = careers.championshipContributions;
  const seriesWins = careers.seriesWins;
  const memberships = careers.rows.filter((row) => row.championshipContribution);
  const seasonOfMatch = new Map(matches.map((match) => [match.id, match.seasonId]));
  const trustedGames = games.map((game) => ({
    seasonId: seasonOfMatch.get(game.matchId),
    radiantWin: game.radiantWin,
    players: trustedGamePlayers(decodeGamePlayers(game.players)),
  })).filter((game) => game.players.length === 10);
  // With one season of games the career game boards are that season's
  // Leaders again, so they wait for a second season.
  const seasonsWithGames = new Set(
    trustedGames.flatMap((game) => (game.seasonId ? [game.seasonId] : [])),
  ).size;
  const gameCounts = careerGameCounts(trustedGames);
  const gameWins = new Map([...gameCounts].map(([id, count]) => [id, count.wins]));
  // Impact points: the per-game score behind Player of the Week and match
  // MVPs (fantasy scores the same way, but most readers never play it).
  const impact = pointsByPlayer(trustedGames);
  const winRate = [...gameCounts].filter(([, count]) => count.games >= 5)
    .map(([userId, count]) => ({ userId, value: count.wins / count.games * 100, games: count.games }))
    .sort((a, b) => b.value - a.value || b.games - a.games || a.userId.localeCompare(b.userId));
  const impactPerGame = [...impact].flatMap(([userId, points]) => {
    const gameCount = gameCounts.get(userId)?.games ?? 0;
    return gameCount >= 5 ? [{ userId, value: points / gameCount, games: gameCount }] : [];
  }).filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || b.games - a.games || a.userId.localeCompare(b.userId));
  const oracle = pickemStandings(predictions, matches)
    .filter((standing) => standing.graded >= 3)
    .sort((a, b) => b.accuracy - a.accuracy || b.graded - a.graded || a.userId.localeCompare(b.userId));
  const oracleOf = new Map(oracle.map((standing) => [standing.userId, standing]));
  const number = new Intl.NumberFormat("en-US");
  const pointsNumber = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const careerBoards: Board[] = [
    {
      id: "titles", title: "🏆 Championship contributions", subtitle: "Appeared for a title-winning team during its championship season, including substitutes and former members.",
      top: topPlaces(rankCounts(titles)), format: (value) => `${value}×`,
      detail: (id) => countLine(seriesWins.get(id), "series win with an appearance", "series wins with an appearance"),
    },
    {
      id: "series", title: "⚔️ Series wins", subtitle: "Completed victories with at least one recorded appearance for the winning team. Counted once per series.",
      top: topPlaces(rankCounts(seriesWins)), format: (value) => number.format(value),
      detail: (id) => countLine(titles.get(id), "championship contribution", "championship contributions"),
    },
  ];
  const performanceBoards: Board[] = seasonsWithGames >= 2 ? [
    {
      id: "game-wins", title: "🎮 Game wins", subtitle: "Actual Dota games played and won in trusted box scores.",
      top: topPlaces(rankCounts(gameWins)), format: (value) => number.format(value),
      detail: (id) => `${gameCounts.get(id)?.wins ?? 0}/${gameCounts.get(id)?.games ?? 0} games won`,
    },
    {
      id: "win-rate", title: "📈 Game win rate", subtitle: "At least five imported games to qualify.",
      top: topPlaces(winRate, { placeKey: Math.round }), format: (value) => `${Math.round(value)}%`,
      detail: (id) => `${gameCounts.get(id)?.wins ?? 0}/${gameCounts.get(id)?.games ?? 0} games won`,
    },
    {
      id: "impact-pace", title: "✨ Impact points per game", subtitle: "Career average, with at least five imported games to qualify.",
      top: topPlaces(impactPerGame, { placeKey: tenths }), format: (value) => value.toFixed(1),
      detail: (id) => `${gameCounts.get(id)?.games ?? 0} games played`,
    },
    {
      id: "impact-total", title: "🎯 Career impact points", subtitle: "Every trusted imported game added together.",
      top: topPlaces(rankCounts(impact), { placeKey: tenths }), format: (value) => pointsNumber.format(value),
      detail: (id) => `${gameCounts.get(id)?.games ?? 0} games played`,
    },
  ] : [];
  const oracleBoard: Board = {
    id: "oracle", title: "🔮 Pick'em accuracy", subtitle: "Correct picks divided by graded picks; at least three to qualify.",
    top: topPlaces(oracle.map((standing) => ({ userId: standing.userId, value: Math.round(standing.accuracy * 100) }))),
    format: (value) => `${value}%`,
    detail: (id) => `${oracleOf.get(id)?.correct ?? 0}/${oracleOf.get(id)?.graded ?? 0} correct picks`,
  };
  const hasRows = (list: Board[]) => list.some((board) => board.top.rows.length > 0);
  // Sections with nothing on any board are left out rather than shown empty.
  const showCareer = hasRows(careerBoards);
  const showPerformance = hasRows(performanceBoards);
  const showPickem = hasRows([oracleBoard]);
  const boards = [...careerBoards, ...performanceBoards, oracleBoard];

  const teams = await prisma.team.findMany({
    where: { id: { in: championTeamIds } },
    select: { id: true, name: true, logoUrl: true },
  });
  const teamOf = new Map(teams.map((team) => [team.id, team]));
  const championRosterIds = memberships
    .filter((member) => championTeamIds.includes(member.teamId))
    .map((member) => member.userId);
  const everyUserId = [...new Set([
    ...boards.flatMap((board) => board.top.rows.map((row) => row.userId)),
    ...championRosterIds,
  ])];
  const users = everyUserId.length
    ? await prisma.user.findMany({
        where: { id: { in: everyUserId } },
        select: { id: true, name: true, avatar: true },
      })
    : [];
  const userOf = new Map(users.map((user) => [user.id, user]));
  const sections = [
    ["champions", "Champions", true],
    ["career", "Career honors", showCareer],
    ["performance", "Game performance", showPerformance],
    ["prediction", "Pick'em", showPickem],
  ] as const;
  const shownSections = sections.filter(([, , shown]) => shown);

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

      {shownSections.length > 1 ? (
        <nav aria-label="Hall of Fame sections" className="flex flex-wrap gap-2">
          {shownSections.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-full border border-line bg-surface px-3 py-2 text-sm font-medium text-muted hover:border-accent/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{label} ↓</a>
          ))}
        </nav>
      ) : null}

      <section id="champions" className="scroll-mt-24 space-y-3">
        <SectionTitle aside="Only verified completed-season titles">Champion history</SectionTitle>
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
      </section>

      {showCareer ? (
        <section id="career" className="scroll-mt-24 space-y-3">
          <SectionTitle aside="Team results across every season">Career honors</SectionTitle>
          <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
            {careerBoards.map((board) => <BoardCard key={board.id} board={board} userOf={userOf} />)}
          </div>
        </section>
      ) : null}

      {showPerformance ? (
        <section id="performance" className="scroll-mt-24 space-y-3">
          <SectionTitle aside="Trusted imported box scores only">Game performance</SectionTitle>
          <p className="text-sm leading-relaxed text-muted">
            Impact points are the Player of the Week score: {impactPointsRule()}.
          </p>
          <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
            {performanceBoards.map((board) => <BoardCard key={board.id} board={board} userOf={userOf} />)}
          </div>
        </section>
      ) : null}

      {showPickem ? (
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
      ) : null}

      {showCareer || showPerformance ? (
        <p className="border-t border-line-soft pt-4 text-xs leading-relaxed text-muted">
          Player contributions use {careers.coverage.trustedGames} trusted game{careers.coverage.trustedGames === 1 ? "" : "s"} of {careers.coverage.importedGames} imported.
          {careers.coverage.unattributedLines > 0 ? ` ${careers.coverage.unattributedLines} player lines lack a verified player/team pairing and cannot receive a team contribution.` : ""}
          {" "}Manual results without box scores still count for teams; they do not invent individual appearances. Historical totals change when a result is corrected.
          {showPerformance ? " Impact points use the current scoring rules for every imported game." : ""}
        </p>
      ) : null}
    </div>
  );
}
