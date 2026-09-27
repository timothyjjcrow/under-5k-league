import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { getAllGamesForRecords } from "@/lib/cached-queries";
import { hasOfficialChampion } from "@/lib/official-champion";
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
  EmptyState,
  HeroIcon,
  PageTitle,
  PlayerLink,
  SectionTitle,
  textLink,
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
// Player records in reading order: fights and support first, then economy.
const PLAYER_ORDER = [
  "kills", "assists", "heroDamage", "towerDamage", "heroHealing",
  "netWorth", "gpm", "xpm", "lastHits", "denies",
];
// Stats only newer imports carry; the footnote says how many games have them.
const EXTENDED_KEYS = new Set(["heroDamage", "towerDamage", "heroHealing", "xpm", "denies"]);

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
function reportsExtendedStats(game: RecordGame): boolean {
  return game.lines.some((line) => line.userId != null && (
    line.xpm != null || line.denies != null || line.heroDamage != null ||
    line.towerDamage != null || line.heroHealing != null
  ));
}

// One grid for both lists. Phone: record and value on the first line, who
// and the match link on the second. sm and up: one line per record.
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[11rem_7rem_minmax(0,1fr)_auto]";
const TITLE = "min-w-0 truncate text-sm font-semibold";
const VALUE = "text-right font-display text-lg font-bold tabular-nums sm:text-left";
const WHO = "flex min-w-0 items-center gap-2 text-sm";
const MATCH_LINK = textLink("shrink-0 text-xs font-semibold");

type User = { id: string; name: string; avatar: string | null };

function PlayerRecordRow({ record, holder, season }: { record: PlayerRecord; holder?: User; season: string | null }) {
  const hero = heroById(record.heroId);
  return (
    <li className={ROW}>
      <span className={TITLE}><span aria-hidden="true">{record.emoji} </span>{record.title}</span>
      <span className={VALUE}>{playerValue(record)}</span>
      <span className={WHO}>
        <Avatar name={holder?.name ?? "Former player"} src={holder?.avatar} size={24} className="shrink-0" />
        {holder ? (
          <PlayerLink userId={record.userId} className="truncate font-medium">{holder.name}</PlayerLink>
        ) : <span className="truncate font-medium text-muted">Former player</span>}
        <span className="flex shrink-0 items-center gap-1.5 text-muted">
          {hero ? <span aria-hidden="true" className="flex"><HeroIcon hero={hero} size={20} /></span> : null}
          <span className="sr-only min-[400px]:not-sr-only">{hero?.name ?? `Hero #${record.heroId}`}</span>
        </span>
        {season ? <span className="hidden truncate text-xs text-muted md:inline">· {season}</span> : null}
      </span>
      <Link href={`/matches/${record.matchId}`} className={MATCH_LINK}>Match →</Link>
    </li>
  );
}

function GameRecordRow({ record, matchup, season }: { record: GameRecord; matchup: string; season: string | null }) {
  return (
    <li className={ROW}>
      <span className={TITLE}><span aria-hidden="true">{record.emoji} </span>{record.title}</span>
      <span className={VALUE}>{gameValue(record)}</span>
      <span className={`${WHO} text-muted`}>
        <span className="truncate text-fg">{matchup}</span>
        <span className="shrink-0 tabular-nums">· {record.score}</span>
        {season ? <span className="hidden truncate text-xs md:inline">· {season}</span> : null}
      </span>
      <Link href={`/matches/${record.matchId}`} className={MATCH_LINK}>Match →</Link>
    </li>
  );
}

function SeasonSwitcher({
  seasons,
  selectedId,
}: {
  seasons: { id: string; name: string }[];
  selectedId: string | undefined;
}) {
  const options = [{ id: "", name: "All seasons" }, ...seasons];
  return (
    <nav
      aria-label="Choose a season for records"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface/55 px-4 py-3"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-muted">Season</span>
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
        {options.map((option) => {
          const current = option.id === (selectedId ?? "");
          return (
            <Link
              key={option.id || "all"}
              href={option.id ? `/records?season=${option.id}` : "/records"}
              aria-current={current ? "page" : undefined}
              className={
                current
                  ? "inline-flex min-h-10 shrink-0 items-center rounded-lg border border-accent/50 bg-accent/10 px-3 text-xs font-semibold text-fg"
                  : "inline-flex min-h-10 shrink-0 items-center rounded-lg border border-line px-3 text-xs text-muted transition-colors hover:border-info/50 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/60"
              }
            >
              {option.name}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default async function RecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string | string[] }>;
}) {
  const [games, seasons, query, champion] = await Promise.all([
    getAllGamesForRecords(),
    prisma.season.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true } }),
    searchParams,
    hasOfficialChampion(),
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
  // With one season of games there is no season picker: "All seasons" and
  // that season are the same list. A selected season keeps the picker so
  // there is always a way back to the all-time book.
  const seasonIdsWithGames = new Set(games.map((game) => game.match.seasonId));
  const multiSeason = seasonIdsWithGames.size >= 2;
  const switcherSeasons = seasons.filter((season) =>
    seasonIdsWithGames.has(season.id) || season.id === selectedSeason?.id);
  // Name each record's season only in the multi-season all-time view.
  const seasonLabel = (seasonId: string) =>
    !selectedSeason && multiSeason ? (seasonName.get(seasonId) ?? null) : null;
  const orderOf = (key: string) => {
    const index = PLAYER_ORDER.indexOf(key);
    return index === -1 ? PLAYER_ORDER.length : index;
  };
  const playerRecords = [...book.players].sort((a, b) => orderOf(a.key) - orderOf(b.key));
  const categoryCount = playerRecords.length + book.games.length;
  const extendedGames = eligibleGames.filter(reportsExtendedStats).length;
  const showsExtended = playerRecords.some((record) => EXTENDED_KEYS.has(record.key));

  return (
    <div className="space-y-6">
      <PageTitle
        title="Record book"
        subtitle={selectedSeason
          ? `The best single-game performances of ${selectedSeason.name}.`
          : "The best single-game performances in league history."}
        action={champion ? <Link href="/hall-of-fame" className={textLink("text-sm font-semibold")}>Career legends →</Link> : undefined}
      />
      <StatsNav active="records" seasonId={selectedSeason?.id} />
      <StatsDataNotice {...analysis.diagnostics} />
      {multiSeason || selectedSeason ? (
        <SeasonSwitcher seasons={switcherSeasons} selectedId={selectedSeason?.id} />
      ) : null}

      {categoryCount === 0 ? (
        <EmptyState
          title={selectedSeason ? `No ${selectedSeason.name} records yet` : "No records yet"}
          description={scopedGames.length > 0
            ? "Stored games need a complete, valid 5v5 box score before they enter the record book."
            : "Records appear after league games are imported."}
        />
      ) : (
        <>
          {playerRecords.length > 0 ? (
            <section aria-labelledby="player-records" className="space-y-3">
              <SectionTitle><span id="player-records">Player records</span></SectionTitle>
              <Card className="overflow-hidden">
                <ul className="divide-y divide-line-soft">
                  {playerRecords.map((record) => (
                    <PlayerRecordRow
                      key={record.key}
                      record={record}
                      holder={userOf.get(record.userId)}
                      season={seasonLabel(record.seasonId)}
                    />
                  ))}
                </ul>
              </Card>
            </section>
          ) : null}

          {book.games.length > 0 ? (
            <section aria-labelledby="match-records" className="space-y-3">
              <SectionTitle><span id="match-records">Match records</span></SectionTitle>
              <Card className="overflow-hidden">
                <ul className="divide-y divide-line-soft">
                  {book.games.map((record) => (
                    <GameRecordRow
                      key={record.key}
                      record={record}
                      matchup={matchupOf.get(record.matchId) ?? "League match"}
                      season={seasonLabel(record.seasonId)}
                    />
                  ))}
                </ul>
              </Card>
            </section>
          ) : null}

          <p className="border-t border-line-soft pt-4 text-xs leading-relaxed text-muted">
            Only complete 5v5 box scores count, and a tie goes to whoever set the mark first. The closest finish needs 20 or more total kills.
            {showsExtended && extendedGames < eligibleGames.length
              ? ` Damage, healing, XPM and denies come from the ${extendedGames} of ${eligibleGames.length} games that report them.`
              : ""}
          </p>
        </>
      )}
    </div>
  );
}
