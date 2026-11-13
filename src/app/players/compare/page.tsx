import { LEAGUE_CONFIG } from "@/lib/league-config";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import type { Metadata } from "next";
import { getAllGameScores } from "@/lib/cached-queries";
import {
  summarizePlayerGames,
  type PlayerGameLine,
  decodeGamePlayers,
  trustedGamePlayers,
} from "@/lib/player-stats";
import {
  compareDefaults,
  meetings,
  sharedSeries,
  tapeRow,
  tapeTally,
  type Meetings,
  type TapeRow,
} from "@/lib/compare";
import { fantasyPoints } from "@/lib/fantasy";
import { killParticipationByPlayer } from "@/lib/leader-ranking";
import { ComparePicker } from "@/components/compare-picker";
import { getPlayerGameFacts } from "@/lib/player-game-history";
import { loadPlayoffRoundsBySeason } from "@/lib/playoff-rounds";
import { matchRoundLabel } from "@/lib/schedule";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import Link from "@/components/app-link";
import { heroById } from "@/lib/heroes";
import { cn, formatNetWorth } from "@/lib/utils";
import {
  Avatar,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  HeroIcon,
  PageTitle,
  PlayerLink,
  RankBadge,
  textLink,
} from "@/components/ui";
import { StatsDataNotice, StatsNav } from "@/components/stats-nav";
import { shareMetadata } from "@/lib/share-metadata";
import { singleSearchParam } from "@/lib/search-params";

type CompareSearchParams = {
  a?: string | string[];
  b?: string | string[];
};

const decodedCareerGames = cache(async () =>
  (await getAllGameScores()).map((game) => ({
    game,
    decoded: decodeGamePlayers(game.players),
  })),
);

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<CompareSearchParams>;
}): Promise<Metadata> {
  const query = await searchParams;
  const a = singleSearchParam(query.a);
  const b = singleSearchParam(query.b);
  if (a && b && a !== b) {
    const participantIds = new Set(
      (await decodedCareerGames()).flatMap(({ decoded }) =>
        trustedGamePlayers(decoded).flatMap((line) =>
          line.userId ? [line.userId] : [],
        ),
      ),
    );
    if (!participantIds.has(a) || !participantIds.has(b)) {
      return shareMetadata(
        "Compare players",
        `Compare two ${LEAGUE_CONFIG.name} players across every imported league game, including careers, heroes, and shared results.`,
        "/players/compare",
      );
    }
    const users = await prisma.user.findMany({
      where: { id: { in: [a, b] } },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((user) => [user.id, user.name]));
    if (names.has(a) && names.has(b)) {
      const title = `${names.get(a)} vs ${names.get(b)}`;
      return shareMetadata(
        title,
        `${title} — all-time ${LEAGUE_CONFIG.name} careers, heroes, and head-to-head results.`,
        `/players/compare?${new URLSearchParams({ a, b })}`,
      );
    }
  }
  return shareMetadata(
    "Compare players",
    `Compare two ${LEAGUE_CONFIG.name} players across every imported league game, including careers, heroes, and shared results.`,
    "/players/compare",
  );
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<CompareSearchParams>;
}) {
  const query = await searchParams;
  const aParam = singleSearchParam(query.a);
  const bParam = singleSearchParam(query.b);
  const malformedSelection = aParam === null || bParam === null;
  const aId = aParam ?? undefined;
  const bId = bParam ?? undefined;

  // The selector represents league careers, not site accounts. Parse the
  // cached all-time scan once, retain only mapped participants with at least
  // one valid line, and reuse that same representation for both summaries and
  // meetings below.
  const decodedGames = await decodedCareerGames();
  const invalidLines = decodedGames.reduce(
    (total, row) => total + row.decoded.invalidLines,
    0,
  );
  const malformedGames = decodedGames.filter(
    (row) => row.decoded.malformed,
  ).length;
  const unusableGames = decodedGames.filter(
    (row) => !row.decoded.malformed && !row.decoded.completeRoster,
  ).length;
  const unmappedLines = decodedGames.reduce(
    (total, row) =>
      total + row.decoded.players.filter((player) => !player.userId).length,
    0,
  );
  const games: {
    radiantWin: boolean;
    lines: ReturnType<typeof decodeGamePlayers>["players"];
  }[] = decodedGames.map(({ game, decoded }) => ({
    radiantWin: game.radiantWin,
    lines: trustedGamePlayers(decoded),
  }));
  const participantIds = new Set(
    games.flatMap((game) =>
      game.lines.flatMap((line) => (line.userId ? [line.userId] : [])),
    ),
  );
  const users = await prisma.user.findMany({
    where: { id: { in: [...participantIds] } },
    select: { id: true, name: true, avatar: true, rankTier: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const userOf = new Map(users.map((u) => [u.id, u]));
  const a = aId ? userOf.get(aId) : undefined;
  const b = bId ? userOf.get(bId) : undefined;
  // Only the selects' starting value changes; nothing runs until Compare.
  const viewer = await getSessionUser();
  const { a: defaultA, b: defaultB } = compareDefaults({
    aParam: aId,
    bParam: bId,
    aId: a?.id,
    bId: b?.id,
    // A repeated query key is a broken link, not an empty slot.
    viewerId:
      !malformedSelection && viewer && userOf.has(viewer.id) ? viewer.id : null,
  });
  const invalidSelection = malformedSelection || (!!aId && !a) || (!!bId && !b);
  const comparable = !!a && !!b && a.id !== b.id;
  const linesByUser = new Map<string, PlayerGameLine[]>();
  for (const game of games) {
    for (const player of game.lines) {
      if (!player.userId) continue;
      const lines = linesByUser.get(player.userId) ?? [];
      lines.push({
        isRadiant: player.isRadiant,
        radiantWin: game.radiantWin,
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        heroId: player.heroId,
        netWorth: player.netWorth,
        gpm: player.gpm,
      });
      linesByUser.set(player.userId, lines);
    }
  }

  const sumA = comparable
    ? summarizePlayerGames(linesByUser.get(a!.id) ?? [])
    : null;
  const sumB = comparable
    ? summarizePlayerGames(linesByUser.get(b!.id) ?? [])
    : null;
  const met = comparable ? meetings(games, a!.id, b!.id) : null;

  // The series they shared, so the head-to-head can link each match page.
  // Read from A's indexed game history (the profile's read), not the all-games
  // scan, which carries no match ids.
  const shared =
    met && (met.opposite.games > 0 || met.together.games > 0)
      ? sharedSeries(
          (await getPlayerGameFacts(a!.id)).map((game) => ({
            matchId: game.matchId,
            startTime: game.startTime,
            radiantWin: game.radiantWin,
            lines: trustedGamePlayers(decodeGamePlayers(game.players)),
          })),
          a!.id,
          b!.id,
        )
      : [];
  const sharedMatches = shared.length
    ? await prisma.match.findMany({
        where: { id: { in: shared.map((series) => series.matchId) } },
        select: {
          id: true,
          seasonId: true,
          week: true,
          phase: true,
          bracketSlot: true,
          scheduledAt: true,
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      })
    : [];
  const sharedRounds = await loadPlayoffRoundsBySeason(
    sharedMatches.map((match) => match.seasonId),
  );
  const sharedMatchById = new Map(sharedMatches.map((m) => [m.id, m]));
  const sharedLinks: SeriesLinkView[] = shared.flatMap((series) => {
    const match = sharedMatchById.get(series.matchId);
    if (!match) return [];
    return [
      {
        matchId: series.matchId,
        label: `${matchRoundLabel(match, sharedRounds.get(match.seasonId) ?? 0)} · ${match.homeTeam.name} vs ${match.awayTeam.name}`,
        playedAt:
          series.startTime > 0
            ? new Date(series.startTime * 1000)
            : match.scheduledAt,
        meetings: series.meetings,
      },
    ];
  });
  const rivalSeries = sharedLinks.filter((s) => s.meetings.opposite.games > 0);
  const teammateSeries = sharedLinks.filter(
    (s) => s.meetings.together.games > 0,
  );

  // Only compare when BOTH sides actually have games on record.
  const contested = !!sumA && !!sumB && sumA.games > 0 && sumB.games > 0;
  // Impact points per game (the Player of the Week score) and the share of
  // their team's kills each was in on: the two numbers /leaders ranks that a
  // plain K/D/A line doesn't show.
  const impactOf = (userId: string) => {
    let tenths = 0;
    let played = 0;
    for (const game of games) {
      const line = game.lines.find((candidate) => candidate.userId === userId);
      if (!line) continue;
      played += 1;
      tenths += Math.round(
        fantasyPoints(line, line.isRadiant === game.radiantWin) * 10,
      );
    }
    return played > 0 ? Math.round(tenths / played) / 10 : null;
  };
  const involvement = comparable ? killParticipationByPlayer(games) : null;
  const involvementOf = (userId: string) => {
    const stat = involvement?.get(userId);
    return stat ? Math.round(stat.rate) : null;
  };
  const oneDecimal = (n: number) => n.toFixed(1);
  const rows: TapeRow[] =
    sumA && sumB
      ? [
          // Games played is context, not a contest: never highlighted. Nor
          // are wins: more games means more wins, and win rate below already
          // makes the comparison.
          tapeRow("Games", sumA.games, sumB.games, { contested: false }),
          tapeRow("Wins", sumA.wins, sumB.wins, { contested: false }),
          tapeRow("Win rate", sumA.winRate, sumB.winRate, {
            format: (n) => `${n}%`,
            contested,
          }),
          tapeRow("Impact / game", impactOf(a!.id), impactOf(b!.id), {
            format: oneDecimal,
            contested,
          }),
          tapeRow("KDA", sumA.kda, sumB.kda, { format: oneDecimal, contested }),
          tapeRow("Avg kills", sumA.avgKills, sumB.avgKills, { format: oneDecimal, contested }),
          tapeRow("Avg deaths", sumA.avgDeaths, sumB.avgDeaths, {
            lowerBetter: true,
            format: oneDecimal,
            contested,
          }),
          tapeRow("Avg assists", sumA.avgAssists, sumB.avgAssists, { format: oneDecimal, contested }),
          tapeRow("Kill share", involvementOf(a!.id), involvementOf(b!.id), {
            format: (n) => `${n}%`,
            contested,
          }),
          tapeRow("Avg GPM", sumA.avgGpm, sumB.avgGpm, { contested }),
          tapeRow("Avg net worth", sumA.avgNetWorth, sumB.avgNetWorth, {
            format: formatNetWorth,
            contested,
          }),
        ]
      : [];
  const tally = tapeTally(rows);
  // Heroes both have played, marked in each pool below.
  const sharedHeroes = new Set(
    sumA && sumB
      ? sumA.topHeroes
          .map((hero) => hero.heroId)
          .filter((heroId) =>
            sumB.topHeroes.some((hero) => hero.heroId === heroId),
          )
      : [],
  );

  return (
    <div className="space-y-5">
      <PageTitle
        title="Compare players"
        subtitle="Pick two players — careers, heroes, and their head-to-head"
      />
      <StatsNav active="compare" />
      <StatsDataNotice
        invalidLines={invalidLines}
        malformedGames={malformedGames}
        unusableGames={unusableGames}
        unmappedLines={unmappedLines}
      />

      {users.length > 0 ? (
        <Card>
          <CardBody>
            <ComparePicker
              players={users.map((u) => ({ id: u.id, name: u.name }))}
              defaultA={defaultA}
              defaultB={defaultB}
            />
            <p className="mt-2 text-xs text-muted">
              Only players with at least one imported league game are listed.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {users.length === 0 ? (
        <EmptyState
          title="No player careers yet"
          description="Player comparison opens once league games are imported and attributed."
        />
      ) : invalidSelection ? (
        <EmptyState
          title="Player unavailable"
          description="One of those players has no imported league career or no longer exists. Choose another player."
        />
      ) : !a || !b ? (
        <EmptyState
          title="Pick two players"
          description="Choose both players above to see the matchup."
        />
      ) : a.id === b.id ? (
        <EmptyState
          title="That's the same player twice"
          description="A player is exactly even with themselves. Pick a rival."
        />
      ) : (
        // From lg the career numbers take the left column and the
        // head-to-head and hero cards stack on the right, so the two players'
        // figures sit half a page apart instead of a full one. The DOM (and a
        // phone) keeps head-to-head, numbers, heroes; `auto_1fr` rows let the
        // taller numbers card grow the heroes' row, not the head-to-head's.
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2 lg:grid-rows-[auto_1fr]">
          {met && (met.opposite.games > 0 || met.together.games > 0) && (
            <Card className="min-w-0 lg:col-start-2 lg:row-start-1">
              <CardHeader headingLevel={2} title="Head-to-head" />
              <CardBody className="space-y-1 text-sm">
                {met.opposite.games > 0 && (
                  <p>
                    ⚔️ As rivals:{" "}
                    <b>
                      {met.opposite.aWins > met.opposite.bWins
                        ? `${a.name} leads ${met.opposite.aWins}–${met.opposite.bWins}`
                        : met.opposite.bWins > met.opposite.aWins
                          ? `${b.name} leads ${met.opposite.bWins}–${met.opposite.aWins}`
                          : `dead even ${met.opposite.aWins}–${met.opposite.bWins}`}
                    </b>{" "}
                    across {met.opposite.games} game
                    {met.opposite.games === 1 ? "" : "s"}.
                  </p>
                )}
                {rivalSeries.length > 0 ? (
                  <SeriesLinks series={rivalSeries} label="as rivals" />
                ) : null}
                {met.together.games > 0 && (
                  <p>
                    🤝 As teammates:{" "}
                    <b>
                      {met.together.wins}–{met.together.losses}
                    </b>{" "}
                    in {met.together.games} game
                    {met.together.games === 1 ? "" : "s"} together.
                  </p>
                )}
                {teammateSeries.length > 0 ? (
                  <SeriesLinks series={teammateSeries} label="as teammates" />
                ) : null}
              </CardBody>
            </Card>
          )}

          {met && met.opposite.games === 0 && met.together.games === 0 ? (
            <Card className="min-w-0 lg:col-start-2 lg:row-start-1">
              <CardHeader headingLevel={2} title="Head-to-head" />
              <CardBody>
                <p className="text-sm text-muted">
                  No shared games yet — they have not played together or against
                  each other in an imported league game.
                </p>
              </CardBody>
            </Card>
          ) : null}

          <Card className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1">
            <CardHeader
              headingLevel={2}
              title="Career numbers"
              subtitle="All seasons, every imported game"
            />
            <CardBody>
              {/* Each name heads its own column of figures: A's at the left
                  edge, B's mirrored to the right edge, and between them how
                  many of the lines below each one leads. */}
              <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
                {[a, b].map((u, i) => (
                  <div
                    key={u.id}
                    className={cn(
                      "flex min-w-0 items-center gap-2.5",
                      i === 1 && "col-start-3 flex-row-reverse text-right",
                    )}
                  >
                    <Avatar name={u.name} src={u.avatar} size={36} />
                    <span className="min-w-0">
                      {/* Two lines before a cut: two-up on a phone, one
                          line left "Roshan's …" beside "The Playe…". */}
                      <PlayerLink
                        userId={u.id}
                        className="block font-semibold"
                      >
                        <span className="line-clamp-2 [overflow-wrap:anywhere]">
                          {u.name}
                        </span>
                      </PlayerLink>
                      <RankBadge rankTier={u.rankTier} />
                    </span>
                  </div>
                ))}
                {contested ? (
                  <p className="col-start-2 row-start-1 text-center">
                    <span className="block font-display text-2xl font-semibold leading-none tabular-nums">
                      <span className={cn(tally.a > tally.b && "text-success")}>
                        {tally.a}
                      </span>
                      <span className="px-1 text-muted">–</span>
                      <span className={cn(tally.b > tally.a && "text-success")}>
                        {tally.b}
                      </span>
                    </span>
                    <span className="mt-1 block text-[11px] uppercase tracking-wide text-muted">
                      stats led
                    </span>
                  </p>
                ) : null}
              </div>
              <table className="w-full table-fixed text-sm">
                <caption className="sr-only">
                  Career comparison between {a.name} and {b.name}
                </caption>
                <colgroup>
                  <col className="w-[22%]" />
                  <col />
                  <col className="w-[22%]" />
                </colgroup>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">{a.name}</th>
                    <th scope="col">Statistic</th>
                    <th scope="col">{b.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label} className="border-b border-line/40">
                      <td
                        className={`py-2 text-left tabular-nums ${r.edge > 0 ? "font-semibold text-success" : "text-fg"}`}
                      >
                        {r.a}
                      </td>
                      <th scope="row" className="px-1 py-2 font-normal">
                        <span className="block text-center text-xs uppercase tracking-wide text-muted">
                          {r.label}
                        </span>
                        {/* The two figures as bars from the middle outwards,
                            the leader's in green. Decoration: the figures
                            beside them are the values. */}
                        <span aria-hidden="true" className="mt-1 flex gap-0.5">
                          <span className="flex h-1.5 flex-1 justify-end overflow-hidden rounded-l-full bg-surface-3/65">
                            <span
                              className={cn(
                                "h-full rounded-l-full",
                                r.edge > 0 ? "bg-success/80" : "bg-muted/45",
                              )}
                              style={{ width: `${r.aShare * 100}%` }}
                            />
                          </span>
                          <span className="flex h-1.5 flex-1 overflow-hidden rounded-r-full bg-surface-3/65">
                            <span
                              className={cn(
                                "h-full rounded-r-full",
                                r.edge < 0 ? "bg-success/80" : "bg-muted/45",
                              )}
                              style={{ width: `${r.bShare * 100}%` }}
                            />
                          </span>
                        </span>
                      </th>
                      <td
                        className={`py-2 text-right tabular-nums ${r.edge < 0 ? "font-semibold text-success" : "text-fg"}`}
                      >
                        {r.b}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                Green marks the better figure; games and wins are context and
                never count. Impact is the Player of the Week score per game.
              </p>
            </CardBody>
          </Card>

          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:col-start-2 lg:row-start-2">
            {[
              { u: a, s: sumA! },
              { u: b, s: sumB! },
            ].map(({ u, s }) => (
              <Card key={u.id}>
                <CardHeader headingLevel={2} title={`${u.name}'s heroes`} />
                <CardBody>
                  {s.topHeroes.length === 0 ? (
                    <p className="text-sm text-muted">No games imported yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {s.topHeroes.slice(0, 5).map((h) => {
                        const hero = heroById(h.heroId);
                        return (
                          <li
                            key={h.heroId}
                            className="flex items-center gap-2 text-sm"
                          >
                            {hero ? <HeroIcon hero={hero} size={24} /> : null}
                            <span className="min-w-0 flex-1 truncate">
                              {hero?.name ?? `Hero #${h.heroId}`}
                            </span>
                            {sharedHeroes.has(h.heroId) ? (
                              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-xs font-medium text-accent">
                                Both
                              </span>
                            ) : null}
                            <span className="tabular-nums text-muted">
                              {h.wins}–{h.games - h.wins}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type SeriesLinkView = {
  matchId: string;
  label: string;
  playedAt: Date | null;
  meetings: Meetings;
};

/** Series shown before the rest fold behind "Show N more". */
const SERIES_PREVIEW = 5;

/**
 * One link per shared series (newest first) under its head-to-head line. A
 * plain <details> for the tail keeps this page free of client JS.
 */
function SeriesLinks({
  series,
  label,
}: {
  series: SeriesLinkView[];
  /** "as rivals" / "as teammates", for the list's spoken name. */
  label: string;
}) {
  const item = (s: SeriesLinkView) => (
    <li key={s.matchId} className="min-w-0 [overflow-wrap:anywhere]">
      <Link href={`/matches/${s.matchId}`} className={textLink()}>
        {s.label}
      </Link>
      {s.playedAt ? (
        <span className="text-muted">
          {" · "}
          <LocalTime
            ts={s.playedAt.getTime()}
            variant="date"
            initial={formatLeagueMatchTime(s.playedAt, "date")}
          />
        </span>
      ) : null}
    </li>
  );
  // space-y-2: every link carries TAP_SAFE, and stacked hit boxes need 8px
  // between rows so they touch without overlapping.
  return (
    <div className="pb-2 pl-6 text-xs">
      <ul aria-label={`Series ${label}`} className="space-y-2">
        {series.slice(0, SERIES_PREVIEW).map(item)}
      </ul>
      {series.length > SERIES_PREVIEW ? (
        <details className="mt-2">
          <summary className={textLink("cursor-pointer text-xs")}>
            Show {series.length - SERIES_PREVIEW} more
          </summary>
          <ul className="mt-2 space-y-2">
            {series.slice(SERIES_PREVIEW).map(item)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
