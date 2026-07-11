import { prisma } from "@/lib/prisma";
import {
  summarizePlayerGames,
  type PlayerGameLine,
} from "@/lib/player-stats";
import { meetings, type MeetingGame } from "@/lib/compare";
import type { PlayerStat } from "@/lib/match-import";
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

export const metadata = { title: "Compare players" };

function safeParse(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
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
  opts: { lowerBetter?: boolean; fmt?: (n: number) => string } = {},
): StatRow {
  const fmt = opts.fmt ?? ((n: number) => String(n));
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
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { a: aId, b: bId } = await searchParams;

  const users = await prisma.user.findMany({
    select: { id: true, name: true, avatar: true, rankTier: true },
    orderBy: { name: "asc" },
  });
  const userOf = new Map(users.map((u) => [u.id, u]));
  const a = aId ? userOf.get(aId) : undefined;
  const b = bId ? userOf.get(bId) : undefined;

  // Career = every imported game ever, both league seasons and past ones.
  const games =
    a && b
      ? await prisma.game.findMany({
          orderBy: { startTime: "asc" },
          select: { players: true, radiantWin: true },
        })
      : [];

  const linesOf = (id: string): PlayerGameLine[] =>
    games.flatMap((g) =>
      safeParse(g.players)
        .filter((p) => p.userId === id)
        .map((p) => ({
          isRadiant: p.isRadiant,
          radiantWin: g.radiantWin,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          heroId: p.heroId,
          netWorth: p.netWorth,
          gpm: p.gpm,
        })),
    );

  const sumA = a && b ? summarizePlayerGames(linesOf(a.id)) : null;
  const sumB = a && b ? summarizePlayerGames(linesOf(b.id)) : null;
  const met =
    a && b
      ? meetings(
          games.map(
            (g): MeetingGame => ({
              radiantWin: g.radiantWin,
              lines: safeParse(g.players).map((p) => ({
                userId: p.userId,
                isRadiant: p.isRadiant,
              })),
            }),
          ),
          a.id,
          b.id,
        )
      : null;

  const rows: StatRow[] =
    sumA && sumB
      ? [
          // Games played is context, not a contest — never highlighted.
          { label: "Games", a: String(sumA.games), b: String(sumB.games), edge: 0 },
          row("Wins", sumA.wins, sumB.wins),
          row("Win rate", sumA.winRate, sumB.winRate, {
            fmt: (n) => `${n}%`,
          }),
          row("KDA", sumA.kda, sumB.kda),
          row("Avg kills", sumA.avgKills, sumB.avgKills),
          row("Avg deaths", sumA.avgDeaths, sumB.avgDeaths, {
            lowerBetter: true,
          }),
          row("Avg assists", sumA.avgAssists, sumB.avgAssists),
          row("Avg GPM", sumA.avgGpm, sumB.avgGpm),
          row("Avg net worth", sumA.avgNetWorth, sumB.avgNetWorth, {
            fmt: formatNetWorth,
          }),
        ]
      : [];

  return (
    <div className="space-y-6">
      <PageTitle
        title="Compare players"
        subtitle="Pick two players — careers, heroes, and their head-to-head"
      />

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
                defaultValue={aId ?? ""}
                className="mt-1 block h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm text-fg outline-none focus:border-accent/60"
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
                defaultValue={bId ?? ""}
                className="mt-1 block h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm text-fg outline-none focus:border-accent/60"
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
        </CardBody>
      </Card>

      {!a || !b ? (
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
              <CardHeader title="Head-to-head" />
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
                    🤝 As teammates: <b>{met.together.wins}–{met.together.losses}</b>{" "}
                    in {met.together.games} game
                    {met.together.games === 1 ? "" : "s"} together.
                  </p>
                )}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Career numbers" subtitle="All seasons, every imported game" />
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
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label} className="border-b border-line/40">
                      <td
                        className={`w-1/3 py-2 text-left tabular-nums ${r.edge > 0 ? "font-semibold text-success" : "text-fg"}`}
                      >
                        {r.a}
                      </td>
                      <td className="w-1/3 py-2 text-center text-xs uppercase tracking-wide text-muted">
                        {r.label}
                      </td>
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
                <CardHeader title={`${u.name}'s heroes`} />
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
                            {hero ? (
                              <HeroIcon hero={hero} size={24} />
                            ) : null}
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
