import Link from "@/components/app-link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { getRecordBookView } from "@/lib/cached-queries";
import { getPublicLeagueContent } from "@/lib/public-navigation";
import {
  formatGameDuration,
  type GameRecord,
  type PlayerRecord,
} from "@/lib/records";
import { heroById } from "@/lib/heroes";
import { formatNetWorth } from "@/lib/utils";
import { getSessionUser } from "@/lib/auth";
import {
  Card,
  EmptyState,
  LinkArrow,
  PageTitle,
  SectionTitle,
  textLink,
} from "@/components/ui";
import {
  RecordList,
  type RecordListMark,
  type RecordListRow,
} from "@/components/record-list";
import { StatsDataNotice, StatsNav } from "@/components/stats-nav";
import { SeasonSwitcher } from "@/components/season-scope";
import { seasonSwitcherChoices } from "@/lib/season-choices";
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
export default async function RecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string | string[] }>;
}) {
  const [seasons, query, viewer, { hasChampion }] = await Promise.all([
    prisma.season.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, name: true, isActive: true },
    }),
    searchParams,
    getSessionUser(),
    // The Hall of Fame is linked once a season has an official champion (the
    // menus' rule, hasOfficialChampion); before that the page is one note.
    getPublicLeagueContent(null),
  ]);
  const seasonParam = singleSearchParam(query.season);
  if (seasonParam === null) notFound();
  const selectedSeason = seasons.find((season) => season.id === seasonParam);
  if (seasonParam && !selectedSeason) notFound();
  // The scope's book, cached small per result revision (cached-queries.ts):
  // read only once the season is known, so a made-up id never fills an entry.
  const view = await getRecordBookView(selectedSeason?.id ?? null);
  const { book, ladders } = view;
  // Every mark on a ladder names its player, not only the record's holder.
  const userIds = [
    ...new Set(
      ladders.players.flatMap((ladder) =>
        ladder.entries.map((record) => record.userId),
      ),
    ),
  ];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, avatar: true } })
    : [];
  const userOf = new Map(users.map((user) => [user.id, user]));
  const seasonName = new Map(seasons.map((season) => [season.id, season.name]));
  const matchupOf = new Map(view.matchups.map(({ matchId, home, away }) => [
    matchId,
    { home, away },
  ]));
  // The picker offers the seasons with games (and a picked one). With one
  // season of games there is no picker: "All seasons" and that season are
  // the same list. A picked season keeps it as the way back to the all-time
  // book.
  const seasonIdsWithGames = new Set(view.seasonIdsWithGames);
  const multiSeason = seasonIdsWithGames.size >= 2;
  const switcherSeasons = seasonSwitcherChoices(
    seasons.map((season) => ({
      ...season,
      hasData: seasonIdsWithGames.has(season.id),
    })),
    { selectedId: selectedSeason?.id, includeActive: false },
  );
  // Name each record's season only in the multi-season all-time view.
  const seasonLabel = (seasonId: string) =>
    !selectedSeason && multiSeason ? (seasonName.get(seasonId) ?? null) : null;
  const orderOf = (key: string) => {
    const index = PLAYER_ORDER.indexOf(key);
    return index === -1 ? PLAYER_ORDER.length : index;
  };
  const playerRecords = [...book.players].sort((a, b) => orderOf(a.key) - orderOf(b.key));
  // Each record's row: the record first, then the marks behind it (the
  // ladder's first entry IS the record: records.test.ts pins that).
  const playerMark = (record: PlayerRecord): RecordListMark => {
    const holder = userOf.get(record.userId);
    const hero = heroById(record.heroId);
    return {
      value: playerValue(record),
      matchId: record.matchId,
      player: {
        id: holder ? record.userId : null,
        name: holder?.name ?? "Former player",
        avatar: holder?.avatar ?? null,
        isViewer: viewer?.id === record.userId,
        hero,
        heroName: hero?.name ?? `Hero #${record.heroId}`,
      },
      season: seasonLabel(record.seasonId),
    };
  };
  const gameMark = (record: GameRecord): RecordListMark => ({
    value: gameValue(record),
    matchId: record.matchId,
    game: matchupOf.get(record.matchId) ?? { home: null, away: null },
    score: record.score,
    season: seasonLabel(record.seasonId),
  });
  const playerLadder = new Map(ladders.players.map((ladder) => [ladder.key, ladder.entries]));
  const gameLadder = new Map(ladders.games.map((ladder) => [ladder.key, ladder.entries]));
  const playerRows: RecordListRow[] = playerRecords.map((record) => ({
    key: record.key,
    title: record.title,
    emoji: record.emoji,
    marks: (playerLadder.get(record.key) ?? [record]).map(playerMark),
  }));
  const gameRows: RecordListRow[] = book.games.map((record) => ({
    key: record.key,
    title: record.title,
    emoji: record.emoji,
    marks: (gameLadder.get(record.key) ?? [record]).map(gameMark),
  }));
  const categoryCount = playerRecords.length + book.games.length;
  const { extendedGames, eligibleGames } = view;
  const showsExtended = playerRecords.some((record) => EXTENDED_KEYS.has(record.key));

  return (
    <div className="space-y-6">
      <PageTitle
        title="Record book"
        subtitle={selectedSeason
          ? `The best single-game performances of ${selectedSeason.name}.`
          : "The best single-game performances in league history."}
        action={hasChampion ? <Link href="/hall-of-fame" className={textLink("text-sm font-semibold")}>Career legends <LinkArrow /></Link> : undefined}
      />
      <StatsNav active="records" seasonId={selectedSeason?.id} />
      <StatsDataNotice {...view.diagnostics} />
      <SeasonSwitcher
        label="records"
        basePath="/records"
        seasons={switcherSeasons}
        selectedId={selectedSeason?.id ?? null}
        allSeasons
      />

      {categoryCount === 0 ? (
        <EmptyState
          title={selectedSeason ? `No ${selectedSeason.name} records yet` : "No records yet"}
          description={view.scopedGames > 0
            ? "Stored games need a complete, valid 5v5 box score before they enter the record book."
            : "Records appear after league games are imported."}
        />
      ) : (
        <>
          {playerRecords.length > 0 ? (
            <section aria-labelledby="player-records" className="space-y-3">
              <SectionTitle><span id="player-records">Player records</span></SectionTitle>
              <Card className="overflow-hidden">
                <RecordList rows={playerRows} />
              </Card>
            </section>
          ) : null}

          {book.games.length > 0 ? (
            <section aria-labelledby="match-records" className="space-y-3">
              <SectionTitle><span id="match-records">Match records</span></SectionTitle>
              <Card className="overflow-hidden">
                <RecordList rows={gameRows} />
              </Card>
            </section>
          ) : null}

          <p className="border-t border-line-soft pt-4 text-xs leading-relaxed text-muted">
            Only complete 5v5 box scores count, and a tie goes to whoever set the mark first. The closest finish needs 20 or more total kills. Open a record to see the marks that came next.
            {showsExtended && extendedGames < eligibleGames
              ? ` Damage, healing, XPM and denies come from the ${extendedGames} of ${eligibleGames} games that report them.`
              : ""}
          </p>
        </>
      )}
    </div>
  );
}
