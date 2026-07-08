import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { INHOUSE_STATUS } from "@/lib/constants";
import { summarizeInhouse, type FinishedLobby } from "@/lib/inhouse-stats";
import { InhouseRoom } from "@/components/inhouse-room";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";

export const metadata = { title: "Inhouse · Under 5k League" };

export default async function InhousePage() {
  const user = await getSessionUser();

  // Seed the MMR field from the player's most recent league signup, if any.
  const lastReg = user
    ? await prisma.registration.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        select: { mmr: true },
      })
    : null;

  const completed = await prisma.inhouseLobby.findMany({
    where: { status: INHOUSE_STATUS.COMPLETED },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { players: { include: { user: true } } },
  });

  const finished: FinishedLobby[] = completed.map((l) => ({
    id: l.id,
    winnerTeam: l.winnerTeam,
    createdAt: l.createdAt,
    players: l.players.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      avatar: p.user.avatar,
      team: p.team,
    })),
  }));
  const leaderboard = summarizeInhouse(finished);

  return (
    <div className="space-y-8">
      <PageTitle
        title="Inhouse"
        subtitle="Pick-up games, drafted live. Queue up, get captained, and play — no season required."
        action={<Badge tone="accent">Casual mode</Badge>}
      />

      <InhouseRoom defaultMmr={lastReg?.mmr ?? 0} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Inhouse leaderboard"
              subtitle="All-time records across completed inhouse games"
            />
            <CardBody className="p-0">
              <Leaderboard rows={leaderboard} meId={user?.id ?? null} />
            </CardBody>
          </Card>
        </div>
        <div>
          <Card>
            <CardHeader title="Recent games" />
            <CardBody className="p-0">
              <RecentGames lobbies={completed.slice(0, 8)} />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Leaderboard({
  rows,
  meId,
}: {
  rows: ReturnType<typeof summarizeInhouse>;
  meId: string | null;
}) {
  if (rows.length === 0) {
    return (
      <div className="p-5">
        <EmptyState
          title="No games played yet"
          description="Win some inhouses to climb the board."
        />
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs uppercase text-muted">
          <th className="px-5 py-2.5 font-medium">#</th>
          <th className="px-2 py-2.5 font-medium">Player</th>
          <th className="px-2 py-2.5 text-center font-medium">W</th>
          <th className="px-2 py-2.5 text-center font-medium">L</th>
          <th className="px-2 py-2.5 text-center font-medium">Win%</th>
          <th className="px-2 py-2.5 text-center font-medium">Streak</th>
          <th className="px-5 py-2.5 text-right font-medium">GP</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={r.userId}
            className={cn(
              "border-b border-line/50 last:border-0",
              r.userId === meId ? "bg-accent/5" : "",
            )}
          >
            <td className="px-5 py-2.5 text-muted tabular-nums">{i + 1}</td>
            <td className="px-2 py-2.5">
              <span className="flex items-center gap-2">
                <Avatar name={r.name} src={r.avatar} size={24} />
                <PlayerLink userId={r.userId} className="font-medium">
                  {r.name}
                </PlayerLink>
              </span>
            </td>
            <td className="px-2 py-2.5 text-center text-success">{r.wins}</td>
            <td className="px-2 py-2.5 text-center text-muted">{r.losses}</td>
            <td className="px-2 py-2.5 text-center tabular-nums">
              {Math.round(r.winRate * 100)}%
            </td>
            <td className="px-2 py-2.5 text-center">
              {r.streak !== 0 ? (
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    r.streak > 0 ? "text-success" : "text-danger",
                  )}
                >
                  {r.streak > 0 ? `W${r.streak}` : `L${-r.streak}`}
                </span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
            <td className="px-5 py-2.5 text-right tabular-nums">{r.games}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RecentGames({
  lobbies,
}: {
  lobbies: {
    id: string;
    winnerTeam: number | null;
    radiantTeam: number;
    createdAt: Date;
    players: { team: number | null; isCaptain: boolean; user: { name: string } }[];
  }[];
}) {
  if (lobbies.length === 0) {
    return <p className="p-5 text-sm text-muted">No completed games yet.</p>;
  }
  return (
    <ul className="divide-y divide-line/60">
      {lobbies.map((l) => {
        const cap = (team: number) =>
          l.players.find((p) => p.team === team && p.isCaptain)?.user.name ??
          `Team ${team}`;
        const radiantWon = l.winnerTeam === l.radiantTeam;
        return (
          <li key={l.id} className="flex items-center justify-between gap-2 px-4 py-3 text-sm">
            <span className="min-w-0 flex-1 truncate">
              <span className={cn(radiantWon ? "font-semibold text-success" : "text-muted")}>
                {cap(l.radiantTeam)}
              </span>
              <span className="text-muted"> vs </span>
              <span className={cn(!radiantWon ? "font-semibold text-danger" : "text-muted")}>
                {cap(l.radiantTeam === 1 ? 2 : 1)}
              </span>
            </span>
            <Badge tone={radiantWon ? "success" : "danger"}>
              {radiantWon ? "Radiant" : "Dire"}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}
