import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { getAllGamesForRecords } from "@/lib/cached-queries";
import {
  analyzeRecordGames,
  formatGameDuration,
  leagueRecords,
  type GameRecord,
  type PlayerRecord,
  type RecordGame,
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
import { singleSearchParam } from "@/lib/search-params";

export const metadata = shareMetadata(
  "Record book",
  `${LEAGUE_CONFIG.name}'s all-time single-game player and match records across every retained season.`,
  "/records",
);

const number = new Intl.NumberFormat("en-US");
const PLAYER_GROUPS = [
  { id: "impact", title: "Impact & team play", description: "The biggest fight, support, and objective performances.", keys: ["kills", "assists", "heroDamage", "towerDamage", "heroHealing"] },
  { id: "economy", title: "Economy & lane", description: "Gold, experience, and lane control in one game.", keys: ["netWorth", "gpm", "xpm", "lastHits", "denies"] },
  { id: "wild-card", title: "Wild card", description: "Not every record is one you set out to break.", keys: ["deaths"] },
] as const;
const PLAYER_DESCRIPTION: Record<string, string> = {
  kills: "Finishing blows in a single game",
  assists: "Helped secure the most kills",
  heroDamage: "Damage dealt to enemy heroes",
  towerDamage: "Damage dealt to towers",
  heroHealing: "Healing delivered to heroes",
  netWorth: "Gold value at the final horn",
  gpm: "Gold earned per minute",
  xpm: "Experience earned per minute",
  lastHits: "Creeps and units last hit",
  denies: "Friendly units denied",
  deaths: "The roughest single outing",
};
const GAME_DESCRIPTION: Record<string, string> = {
  longest: "A true marathon",
  shortest: "Over in a flash",
  bloodiest: "Combined team kills",
  stomp: "Largest final kill margin",
  closest: "Smallest kill margin, with 20+ total kills",
  losingKills: "The losing side kept fighting",
};

function playerValue(record: PlayerRecord): string {
  if (record.key === "netWorth") return formatNetWorth(record.value);
  if (record.key === "gpm") return `${number.format(record.value)} GPM`;
  if (record.key === "xpm") return `${number.format(record.value)} XPM`;
  return number.format(record.value);
}
function gameValue(record: GameRecord): string {
  if (record.key === "longest" || record.key === "shortest") return formatGameDuration(record.value);
  if (record.key === "stomp") return `${record.value} kills`;
  if (record.key === "closest") return `${record.value} kill${record.value === 1 ? "" : "s"}`;
  return number.format(record.value);
}
function metricCoverage(games: RecordGame[], key: string): number | null {
  if (!["heroDamage", "towerDamage", "heroHealing", "xpm", "denies"].includes(key)) return null;
  return games.filter((game) => game.lines.some((line) => {
    if (!line.userId) return false;
    switch (key) {
      case "heroDamage": return line.heroDamage != null;
      case "towerDamage": return line.towerDamage != null;
      case "heroHealing": return line.heroHealing != null;
      case "xpm": return line.xpm != null;
      case "denies": return line.denies != null;
      default: return false;
    }
  })).length;
}

type User = { id: string; name: string; avatar: string | null };
function PlayerRecordCard({
  record, holder, season, coverage, totalGames,
}: {
  record: PlayerRecord;
  holder?: User;
  season: string;
  coverage: number | null;
  totalGames: number;
}) {
  const hero = heroById(record.heroId);
  return (
    <Card className="h-full overflow-hidden">
      <CardBody className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{record.emoji} {record.title}</h3>
            <p className="mt-2 font-display text-3xl font-bold leading-none tabular-nums text-fg sm:text-4xl">{playerValue(record)}</p>
          </div>
          <span
            aria-label={record.won ? "Won the game" : "Lost the game"}
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${record.won ? "bg-success/15 text-success" : "bg-surface-2 text-muted"}`}
          >{record.won ? "W" : "L"}</span>
        </div>
        <p className="mt-2 text-sm text-muted">{PLAYER_DESCRIPTION[record.key]}</p>
        <div className="mt-5 flex min-w-0 items-center gap-3 border-t border-line-soft pt-4">
          <Avatar name={holder?.name ?? "Former player"} src={holder?.avatar} size={32} />
          <div className="min-w-0 flex-1">
            {holder ? (
              <PlayerLink userId={record.userId} className="block truncate text-sm font-semibold">{holder.name}</PlayerLink>
            ) : <span className="block truncate text-sm font-semibold text-muted">Former player</span>}
            <p className="truncate text-xs text-muted">{season}</p>
          </div>
          {hero ? <HeroIcon hero={hero} size={32} /> : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs">
          <span className="text-muted">{hero?.name ?? `Hero #${record.heroId}`}{coverage != null ? ` · reported in ${coverage}/${totalGames} games` : ""}</span>
          <Link href={`/matches/${record.matchId}`} className="font-semibold text-info underline-offset-2 hover:underline focus-visible:underline">View match →</Link>
        </div>
      </CardBody>
    </Card>
  );
}

export default async function RecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string | string[] }>;
}) {
  const [games, seasons, query] = await Promise.all([
    getAllGamesForRecords(),
    prisma.season.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true } }),
    searchParams,
  ]);
  const seasonParam = singleSearchParam(query.season);
  if (seasonParam === null) notFound();
  const selectedSeason = seasons.find((season) => season.id === seasonParam);
  if (seasonParam && !selectedSeason) notFound();
  const scopedGames = selectedSeason
    ? games.filter((game) => game.match.seasonId === selectedSeason.id)
    : games;
  const analysis = analyzeRecordGames(scopedGames);
  const eligibleGames = analysis.games;
  const book = leagueRecords(eligibleGames);
  const userIds = [...new Set(book.players.map((record) => record.userId))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, avatar: true } })
    : [];
  const userOf = new Map(users.map((user) => [user.id, user]));
  const seasonName = new Map(seasons.map((season) => [season.id, season.name]));
  const matchupOf = new Map(games.map((game) => [
    game.matchId,
    `${game.match.homeTeam.name} vs ${game.match.awayTeam.name}`,
  ]));
  const featured = book.players.find((record) => record.key === "kills");
  const holderCount = new Set(book.players.map((record) => record.userId)).size;
  const categoryCount = book.players.length + book.games.length;

  return (
    <div className="space-y-7">
      <PageTitle
        title="Record book"
        subtitle="The biggest single-game performances and the matches that made league history."
        action={<Link href="/hall-of-fame" className="text-sm font-semibold text-info hover:underline">Career legends →</Link>}
      />
      <StatsNav active="records" seasonId={selectedSeason?.id} />
      <StatsDataNotice {...analysis.diagnostics} />

      <section className="overflow-hidden rounded-2xl border border-accent/30 bg-gradient-to-br from-surface-3 via-surface to-bg p-5 sm:p-7">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-accent">{selectedSeason ? `${selectedSeason.name} records` : "All-time archive"}</p>
            <h2 className="mt-2 max-w-2xl font-display text-3xl font-bold leading-tight sm:text-4xl">
              {featured
                ? `${userOf.get(featured.userId)?.name ?? "A former player"} set the kills mark at ${featured.value}.`
                : "Every record starts with one complete game."}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              Browse by play style, then open the match to see the performance in context. Only complete, validated 5v5 imports count.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center lg:min-w-72">
            {([[eligibleGames.length, "games"], [categoryCount, "marks"], [holderCount, "holders"]] as const).map(([value, label]) => (
              <div key={label} className="rounded-xl border border-line bg-bg/45 px-3 py-3">
                <div className="font-display text-2xl font-bold tabular-nums">{value}</div>
                <div className="text-xs text-muted">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-end sm:justify-between">
        <form method="get" action="/records" className="flex flex-wrap items-end gap-2">
          <label className="min-w-48 flex-1 text-xs font-semibold uppercase tracking-wide text-muted sm:flex-none">
            Season
            <select name="season" defaultValue={selectedSeason?.id ?? ""} className="mt-1.5 block h-11 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm font-medium normal-case tracking-normal text-fg sm:min-w-52">
              <option value="">All seasons</option>
              {seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}
            </select>
          </label>
          <button type="submit" className="h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-bg hover:bg-accent/90">View records</button>
        </form>
        <p className="text-xs leading-relaxed text-muted">Ties belong to the first achiever. Legacy games without a known start time sort last.</p>
      </div>

      {categoryCount === 0 ? (
        <EmptyState
          title={selectedSeason ? `No ${selectedSeason.name} records yet` : "No records yet"}
          description={scopedGames.length > 0
            ? "Stored games need a complete, valid 5v5 box score before they enter the record book."
            : "Records appear after league games are imported."}
        />
      ) : (
        <>
          <nav aria-label="Record categories" className="flex flex-wrap gap-2">
            {[
              ...PLAYER_GROUPS.filter((group) => book.players.some((record) => group.keys.some((key) => key === record.key))).map((group) => ({ id: group.id, label: group.title })),
              ...(book.games.length ? [{ id: "matches", label: "Match stories" }] : []),
            ].map((section) => (
              <a key={section.id} href={`#${section.id}`} className="rounded-full border border-line bg-surface px-3 py-2 text-sm font-medium text-muted hover:border-accent/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{section.label} ↓</a>
            ))}
          </nav>

          {PLAYER_GROUPS.map((group) => {
            const records = group.keys
              .map((key) => book.players.find((record) => record.key === key))
              .filter((record): record is PlayerRecord => Boolean(record));
            if (!records.length) return null;
            return (
              <section id={group.id} key={group.id} className="scroll-mt-24 space-y-3">
                <SectionTitle aside={group.description}>{group.title}</SectionTitle>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {records.map((record) => (
                    <PlayerRecordCard
                      key={record.key}
                      record={record}
                      holder={userOf.get(record.userId)}
                      season={seasonName.get(record.seasonId) ?? "Unknown season"}
                      coverage={metricCoverage(eligibleGames, record.key)}
                      totalGames={eligibleGames.length}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {book.games.length > 0 && (
            <section id="matches" className="scroll-mt-24 space-y-3">
              <SectionTitle aside="The games behind the numbers">Match stories</SectionTitle>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {book.games.map((record) => (
                  <Card key={record.key}>
                    <CardBody className="flex h-full flex-col gap-3 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{record.emoji} {record.title}</h3>
                        <p className="mt-1 text-sm text-muted">{GAME_DESCRIPTION[record.key]}</p>
                        <p className="mt-3 truncate text-sm font-semibold">{matchupOf.get(record.matchId) ?? "League match"}</p>
                        <p className="text-xs text-muted">{seasonName.get(record.seasonId) ?? "Unknown season"} · final score {record.score}</p>
                      </div>
                      <div className="flex shrink-0 items-center justify-between gap-4 sm:block sm:text-right">
                        <p className="font-display text-2xl font-bold tabular-nums sm:text-3xl">{gameValue(record)}</p>
                        <Link href={`/matches/${record.matchId}`} className="text-xs font-semibold text-info underline-offset-2 hover:underline focus-visible:underline">View match →</Link>
                      </div>
                    </CardBody>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
