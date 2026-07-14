import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAllGameScores } from "@/lib/cached-queries";
import { careerCounts, topCounts, type HofRow } from "@/lib/hall-of-fame";
import { pointsByPlayer, type FantasyGame } from "@/lib/fantasy";
import { pickemStandings } from "@/lib/pickem";
import {
  Avatar,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
} from "@/components/ui";

export const metadata = { title: "Hall of Fame" };

function safeParse(json: string): FantasyGame["players"] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default async function HallOfFamePage() {
  const [seasons, memberships, matches, games, predictions] =
    await Promise.all([
      prisma.season.findMany({ select: { id: true, championTeamId: true } }),
      prisma.teamMember.findMany({ select: { userId: true, teamId: true } }),
      prisma.match.findMany({
        select: {
          id: true,
          status: true,
          winnerTeamId: true,
          scheduledAt: true,
        },
      }),
      getAllGameScores(),
      prisma.prediction.findMany({
        select: { matchId: true, userId: true, pickedTeamId: true },
      }),
    ]);

  // Careers from the archive: titles + series wins.
  const titles = careerCounts(
    memberships,
    seasons.map((s) => s.championTeamId),
  );
  const seriesWins = careerCounts(
    memberships,
    matches
      .filter((m) => m.status === "COMPLETED")
      .map((m) => m.winnerTeamId),
  );

  // Career fantasy points from every imported game, ever.
  const fantasy = pointsByPlayer(
    games.map((g) => ({ radiantWin: g.radiantWin, players: safeParse(g.players) })),
  );
  const fantasyCounts = new Map(
    [...fantasy.entries()].map(([id, pts]) => [id, Math.round(pts)]),
  );

  // All-time oracle record (min 3 graded picks to qualify).
  const oracle = pickemStandings(predictions, matches).filter(
    (s) => s.graded >= 3,
  );

  const boards: {
    title: string;
    subtitle: string;
    rows: HofRow[];
    format: (v: number) => string;
  }[] = [
    {
      title: "🏆 Titles",
      subtitle: "Championships won",
      rows: topCounts(titles),
      format: (v) => `${v}×`,
    },
    {
      title: "⚔️ Series wins",
      subtitle: "Career completed-series victories",
      rows: topCounts(seriesWins),
      format: (v) => `${v}`,
    },
    {
      title: "🎯 Fantasy points scored",
      subtitle: "Career points produced across every imported game",
      rows: topCounts(fantasyCounts),
      format: (v) => `${v}`,
    },
    {
      title: "🔮 Oracle record",
      subtitle: "All-time pick'em (min 3 graded picks)",
      rows: oracle
        .slice(0, 5)
        .map((s) => ({ userId: s.userId, value: s.correct })),
      format: (v) => `${v} ✓`,
    },
  ];

  const everyUserId = [
    ...new Set(boards.flatMap((b) => b.rows.map((r) => r.userId))),
  ];
  if (everyUserId.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle title="Hall of Fame" />
        <EmptyState
          title="No legends yet"
          description="Careers are written here — titles, series wins, fantasy production, and oracle records across every season."
        />
      </div>
    );
  }
  const users = await prisma.user.findMany({
    where: { id: { in: everyUserId } },
    select: { id: true, name: true, avatar: true },
  });
  const userOf = new Map(users.map((u) => [u.id, u]));
  const oracleAcc = new Map(
    oracle.map((s) => [s.userId, Math.round(s.accuracy * 100)]),
  );
  // "8/11" reads better than a bare correct-count — same format as /pickem.
  const oracleLine = new Map(
    oracle.map((s) => [s.userId, `${s.correct}/${s.graded}`]),
  );

  return (
    <div className="space-y-8">
      <PageTitle
        title="Hall of Fame"
        subtitle={`Careers across ${seasons.length} season${seasons.length === 1 ? "" : "s"} — titles, wins, production, prophecy`}
        action={
          <span className="flex items-center gap-3">
            <Link href="/records" className="text-sm text-info hover:underline">
              Record book →
            </Link>
            <Link href="/seasons" className="text-sm text-info hover:underline">
              Season history →
            </Link>
          </span>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {boards.map((b) => (
          <Card key={b.title}>
            <CardHeader title={b.title} subtitle={b.subtitle} />
            <CardBody className="divide-y divide-line/60 p-0">
              {b.rows.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">
                  Nobody has qualified yet.
                </p>
              ) : (
                b.rows.map((r, i) => {
                  const u = userOf.get(r.userId);
                  return (
                    <div
                      key={r.userId}
                      className="flex items-center gap-3 px-5 py-2.5 text-sm"
                    >
                      <span className="w-6 text-center text-muted">
                        {i === 0 ? "👑" : i + 1}
                      </span>
                      <Avatar name={u?.name ?? "?"} src={u?.avatar} size={24} />
                      <PlayerLink
                        userId={r.userId}
                        className="min-w-0 flex-1 truncate font-medium"
                      >
                        {u?.name ?? "?"}
                      </PlayerLink>
                      {b.title.startsWith("🔮") ? (
                        <span className="font-mono text-xs tabular-nums text-muted">
                          {oracleAcc.get(r.userId) ?? 0}%
                        </span>
                      ) : null}
                      <span className="shrink-0 font-mono text-base font-semibold tabular-nums">
                        {b.title.startsWith("🔮")
                          ? (oracleLine.get(r.userId) ?? b.format(r.value))
                          : b.format(r.value)}
                      </span>
                    </div>
                  );
                })
              )}
            </CardBody>
          </Card>
        ))}
      </div>

      <p className="text-center text-xs text-muted">
        Every season counts — records here survive season resets.
      </p>
    </div>
  );
}
