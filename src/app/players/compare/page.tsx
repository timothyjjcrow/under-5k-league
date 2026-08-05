import { prisma } from "@/lib/prisma";
import type { Metadata } from "next";
import { getAllGameScores } from "@/lib/cached-queries";
import {
  summarizePlayerGames,
  type PlayerGameLine,
  decodeGamePlayers,
  trustedGamePlayers,
} from "@/lib/player-stats";
import { meetings } from "@/lib/compare";
import { heroById } from "@/lib/heroes";
import { formatNetWorth } from "@/lib/utils";
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
  buttonClasses,
} from "@/components/ui";
import { StatsDataNotice, StatsNav } from "@/components/stats-nav";
import { shareMetadata } from "@/lib/share-metadata";
import { singleSearchParam } from "@/lib/search-params";

type CompareSearchParams = {
  a?: string | string[];
  b?: string | string[];
};

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
      (await getAllGameScores()).flatMap((game) =>
        trustedGamePlayers(decodeGamePlayers(game.players)).flatMap((line) =>
          line.userId ? [line.userId] : [],
        ),
      ),
    );
    if (!participantIds.has(a) || !participantIds.has(b)) {
      return shareMetadata(
        "Compare players",
        "Compare two GGD2L players across every imported league game, including careers, heroes, and shared results.",
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
        `${title} — all-time GGD2L careers, heroes, and head-to-head results.`,
        `/players/compare?${new URLSearchParams({ a, b })}`,
      );
    }
  }
  return shareMetadata(
    "Compare players",
    "Compare two GGD2L players across every imported league game, including careers, heroes, and shared results.",
    "/players/compare",
  );
}

type StatRow = {
  label: string;
  a: string;
  b: string;
  /** 1 = A better, -1 = B better, 0 = tie/no call. */
  edge: number;
};

function row(
  label: string,
  a: number | null,
  b: number | null,
  opts: {
    lowerBetter?: boolean;
    fmt?: (n: number) => string;
    /** Both players' game counts — a side with none has no record to compare. */
    contested?: boolean;
  } = {},
): StatRow {
  const fmt = opts.fmt ?? ((n: number) => String(n));
  // A player with zero games isn't "better" at anything. Left unguarded, an
  // unplayed comparison highlighted 0 avg deaths as the winning side and
  // 0% win rate as the losing one — both meaningless.
  if (opts.contested === false) {
    return {
      label,
      a: a == null ? "—" : fmt(a),
      b: b == null ? "—" : fmt(b),
      edge: 0,
    };
  }
  if (a == null || b == null) {
    return {
      label,
      a: a == null ? "—" : fmt(a),
      b: b == null ? "—" : fmt(b),
      edge: 0,
    };
  }
  const sign = Math.sign(a - b) * (opts.lowerBetter ? -1 : 1);
  return { label, a: fmt(a), b: fmt(b), edge: sign };
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
  const storedGames = await getAllGameScores();
  const decodedGames = storedGames.map((game) => ({
    game,
    decoded: decodeGamePlayers(game.players),
  }));
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

  // Only compare when BOTH sides actually have games on record.
  const contested = !!sumA && !!sumB && sumA.games > 0 && sumB.games > 0;
  const rows: StatRow[] =
    sumA && sumB
      ? [
          // Games played is context, not a contest — never highlighted.
          {
            label: "Games",
            a: String(sumA.games),
            b: String(sumB.games),
            edge: 0,
          },
          row("Wins", sumA.wins, sumB.wins, { contested }),
          row("Win rate", sumA.winRate, sumB.winRate, {
            fmt: (n) => `${n}%`,
            contested,
          }),
          row("KDA", sumA.kda, sumB.kda, { contested }),
          row("Avg kills", sumA.avgKills, sumB.avgKills, { contested }),
          row("Avg deaths", sumA.avgDeaths, sumB.avgDeaths, {
            lowerBetter: true,
            contested,
          }),
          row("Avg assists", sumA.avgAssists, sumB.avgAssists, { contested }),
          row("Avg GPM", sumA.avgGpm, sumB.avgGpm, { contested }),
          row("Avg net worth", sumA.avgNetWorth, sumB.avgNetWorth, {
            fmt: formatNetWorth,
            contested,
          }),
        ]
      : [];

  return (
    <div className="space-y-6">
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
            <form
              method="get"
              className="flex flex-wrap items-end gap-3"
              action="/players/compare"
            >
              <label className="min-w-[12rem] flex-1 text-xs text-muted">
                Player A
                <select
                  name="a"
                  defaultValue={a?.id ?? ""}
                  className="mt-1 block h-11 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm text-fg outline-none focus:border-accent/60 sm:h-10"
                >
                  <option value="" disabled>
                    Pick a player…
                  </option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-[12rem] flex-1 text-xs text-muted">
                Player B
                <select
                  name="b"
                  defaultValue={b?.id ?? ""}
                  className="mt-1 block h-11 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm text-fg outline-none focus:border-accent/60 sm:h-10"
                >
                  <option value="" disabled>
                    Pick a player…
                  </option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={buttonClasses("accent")}>
                Compare
              </button>
            </form>
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
        <>
          {met && (met.opposite.games > 0 || met.together.games > 0) && (
            <Card>
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
              </CardBody>
            </Card>
          )}

          {met && met.opposite.games === 0 && met.together.games === 0 ? (
            <Card>
              <CardHeader headingLevel={2} title="Head-to-head" />
              <CardBody>
                <p className="text-sm text-muted">
                  No shared games yet — they have not played together or against
                  each other in an imported league game.
                </p>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              headingLevel={2}
              title="Career numbers"
              subtitle="All seasons, every imported game"
            />
            <CardBody>
              <div className="mb-4 grid grid-cols-2 gap-4">
                {[a, b].map((u) => (
                  <div key={u.id} className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={u.name} src={u.avatar} size={36} />
                    <span className="min-w-0">
                      <PlayerLink
                        userId={u.id}
                        className="block truncate font-semibold"
                      >
                        {u.name}
                      </PlayerLink>
                      <RankBadge rankTier={u.rankTier} />
                    </span>
                  </div>
                ))}
              </div>
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Career comparison between {a.name} and {b.name}
                </caption>
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
                        className={`w-1/3 py-2 text-left tabular-nums ${r.edge > 0 ? "font-semibold text-success" : "text-fg"}`}
                      >
                        {r.a}
                      </td>
                      <th
                        scope="row"
                        className="w-1/3 py-2 text-center text-xs font-normal uppercase tracking-wide text-muted"
                      >
                        {r.label}
                      </th>
                      <td
                        className={`w-1/3 py-2 text-right tabular-nums ${r.edge < 0 ? "font-semibold text-success" : "text-fg"}`}
                      >
                        {r.b}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        </>
      )}
    </div>
  );
}
