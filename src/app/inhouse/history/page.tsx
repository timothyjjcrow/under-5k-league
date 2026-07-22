import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { INHOUSE_STATUS } from "@/lib/constants";
import { parseInhouseBox } from "@/lib/inhouse-box";
import { gameMvp } from "@/lib/achievements";
import { heroById } from "@/lib/heroes";
import { formatMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Inhouse history",
  description: "Every completed inhouse game — scores, MVPs, and box-score links.",
};

const HISTORY_LIMIT = 100;

// The permanent archive behind /inhouse's four recent cards: one compact row
// per completed game, so the ladder's evidence never becomes unreachable.
export default async function InhouseHistoryPage() {
  const lobbies = await prisma.inhouseLobby.findMany({
    where: { status: INHOUSE_STATUS.COMPLETED },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: {
      id: true,
      winnerTeam: true,
      radiantTeam: true,
      dotaMatchId: true,
      durationSecs: true,
      radiantScore: true,
      direScore: true,
      boxScore: true,
      createdAt: true,
    },
  });

  const rows = lobbies.map((l) => {
    const players = parseInhouseBox(l.boxScore);
    const radiantWin = l.winnerTeam != null && l.winnerTeam === l.radiantTeam;
    const mvpId = players.length ? gameMvp(players, radiantWin) : null;
    const mvp = mvpId ? players.find((p) => p.userId === mvpId) : null;
    return { lobby: l, radiantWin, mvp };
  });

  return (
    <div className="space-y-6">
      <PageTitle
        title="Inhouse history"
        subtitle={`Every recorded inhouse game${
          lobbies.length === HISTORY_LIMIT ? ` (latest ${HISTORY_LIMIT})` : ""
        } — the ladder's paper trail.`}
        action={
          <Link href="/inhouse" className="text-sm text-info hover:underline">
            ← Back to the inhouse
          </Link>
        }
      />

      {/* overflow-hidden on the CARD so the table scroller can't leak page
          scroll on phones (CLAUDE.md mobile rule). */}
      <Card className="overflow-hidden">
        <CardHeader
          title="Completed games"
          subtitle={`${lobbies.length} on record, newest first`}
        />
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No games recorded yet"
                description="Finish an inhouse and it shows up here."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase text-muted">
                    <th className="px-5 py-2.5 font-medium">Played</th>
                    <th className="px-2 py-2.5 text-center font-medium">Score</th>
                    <th className="px-2 py-2.5 font-medium">Winner</th>
                    <th className="hidden px-2 py-2.5 font-medium md:table-cell">
                      MVP
                    </th>
                    <th className="hidden px-2 py-2.5 text-right font-medium sm:table-cell">
                      Length
                    </th>
                    <th className="px-5 py-2.5 text-right font-medium">Match</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ lobby, radiantWin, mvp }) => {
                    const dur = lobby.durationSecs ?? 0;
                    const durStr = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`;
                    const mvpHero = mvp ? heroById(mvp.heroId) : null;
                    return (
                      <tr
                        key={lobby.id}
                        className="border-b border-line/50 last:border-0"
                      >
                        <td className="whitespace-nowrap px-5 py-2.5 text-muted">
                          <LocalTime
                            ts={lobby.createdAt.getTime()}
                            variant="short"
                            initial={formatMatchTime(lobby.createdAt, "short")}
                          />
                        </td>
                        <td className="whitespace-nowrap px-2 py-2.5 text-center font-mono tabular-nums">
                          <span
                            className={cn(
                              radiantWin ? "text-success" : "text-muted",
                            )}
                          >
                            {lobby.radiantScore ?? 0}
                          </span>
                          <span className="px-1 text-muted">–</span>
                          <span
                            className={cn(
                              !radiantWin ? "text-danger" : "text-muted",
                            )}
                          >
                            {lobby.direScore ?? 0}
                          </span>
                        </td>
                        <td className="px-2 py-2.5">
                          <Badge tone={radiantWin ? "success" : "danger"}>
                            {radiantWin ? "Radiant" : "Dire"}
                          </Badge>
                        </td>
                        <td className="hidden max-w-[14rem] px-2 py-2.5 md:table-cell">
                          {mvp?.userId ? (
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span aria-hidden>🏅</span>
                              <PlayerLink
                                userId={mvp.userId}
                                className="min-w-0 truncate"
                              >
                                {mvp.name ?? "Unknown"}
                              </PlayerLink>
                              {mvpHero ? (
                                <span className="hidden truncate text-xs text-muted lg:inline">
                                  {mvpHero.name}
                                </span>
                              ) : null}
                            </span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="hidden px-2 py-2.5 text-right tabular-nums text-muted sm:table-cell">
                          {durStr}
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          {lobby.dotaMatchId ? (
                            <a
                              href={`https://www.opendota.com/matches/${lobby.dotaMatchId}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-info hover:underline"
                            >
                              OpenDota ↗
                            </a>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
