import Link from "next/link";
import { Suspense } from "react";
import { LocalTime } from "@/components/local-time";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  FormStrip,
  HeroIcon,
  KDA,
  textLink,
} from "@/components/ui";
import { INHOUSE_STATUS } from "@/lib/constants";
import { heroById } from "@/lib/heroes";
import { parseInhouseBox } from "@/lib/inhouse-box";
import { inhousePlayedAt } from "@/lib/inhouse-history";
import { loadInhouseLadder } from "@/lib/inhouse-ladder";
import { PROVISIONAL_GAMES } from "@/lib/inhouse-stats";
import { formatMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";

/**
 * A player profile's inhouse card, streamed so the full-history ladder scan
 * never holds up the rest of the page. Render it only for a player with a
 * completed inhouse game, so league-only players never mount a skeleton that
 * immediately disappears.
 */
export function InhouseCareerCard({ userId }: { userId: string }) {
  return (
    <Suspense fallback={<CardSkeleton rows={3} />}>
      <InhouseCareer userId={userId} />
    </Suspense>
  );
}

// The player's ladder identity, surfaced where people actually look each
// other up. Rank comes from the FULL ladder (Elo accumulates globally); the
// recent-game rows come from a separate small query with box scores.
async function InhouseCareer({ userId }: { userId: string }) {
  const [ladder, recent] = await Promise.all([
    loadInhouseLadder(),
    prisma.inhouseLobby.findMany({
      where: {
        status: INHOUSE_STATUS.COMPLETED,
        players: { some: { userId } },
      },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: {
        id: true,
        winnerTeam: true,
        radiantTeam: true,
        radiantScore: true,
        direScore: true,
        boxScore: true,
        matchStartTime: true,
        startedAt: true,
        createdAt: true,
        players: { select: { userId: true, team: true } },
      },
    }),
  ]);
  if (recent.length === 0) return null;

  const me = [...ladder.ranked, ...ladder.provisional].find(
    (r) => r.userId === userId,
  );
  if (!me) return null;
  const rank = ladder.ranked.findIndex((r) => r.userId === userId);

  const games = recent.map((l) => {
    const mine = l.players.find((p) => p.userId === userId);
    const line = parseInhouseBox(l.boxScore).find((b) => b.userId === userId);
    const won = mine?.team != null && mine.team === l.winnerTeam;
    return { lobby: l, line, won, playedAt: inhousePlayedAt(l) };
  });

  return (
    <Card>
      <CardHeader
        title="Inhouse"
        subtitle="Pick-up ladder across every inhouse game"
        action={
          <Link href="/inhouse" className={textLink("text-sm")}>
            Ladder →
          </Link>
        }
      />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          <span className="tabular-nums">
            <span className="font-semibold">{me.rating}</span>
            <span className="text-muted"> Elo</span>
            <span className="ml-1 text-xs text-muted">(peak {me.peak})</span>
          </span>
          <span className="text-muted tabular-nums">
            {rank >= 0 ? `#${rank + 1} of ${ladder.ranked.length}` : "unranked"}
          </span>
          <span className="tabular-nums">
            <span className="text-success">{me.wins}W</span>
            <span className="text-muted">–</span>
            <span className="text-danger">{me.losses}L</span>
            <span className="ml-1 text-xs text-muted">
              {Math.round(me.winRate * 100)}%
            </span>
          </span>
          <FormStrip form={me.form} size={4} />
          {me.games < PROVISIONAL_GAMES ? (
            // Says what provisional MEANS, in the /inhouse strip's words: a
            // bare "provisional" beside "unranked" explained neither.
            <Badge tone="neutral">
              provisional · {PROVISIONAL_GAMES - me.games} more{" "}
              {PROVISIONAL_GAMES - me.games === 1 ? "game" : "games"} to rank
            </Badge>
          ) : null}
        </div>
        <div className="divide-y divide-line/60 border-t border-line/60">
          {games.map(({ lobby, line, won, playedAt }) => {
            const hero = line ? heroById(line.heroId) : null;
            return (
              <Link
                key={lobby.id}
                href={`/inhouse/history?game=${lobby.id}#result-${lobby.id}`}
                className="flex items-center gap-3 py-2 text-sm transition-colors hover:bg-surface-2/40"
              >
                <span className="w-24 shrink-0 text-xs text-muted">
                  <LocalTime
                    ts={playedAt.getTime()}
                    variant="short"
                    initial={formatMatchTime(playedAt, "short")}
                  />
                </span>
                <Badge tone={won ? "success" : "danger"}>
                  {won ? "Win" : "Loss"}
                </Badge>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {lobby.radiantScore ?? 0}–{lobby.direScore ?? 0}
                </span>
                <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
                  {hero ? (
                    <>
                      <HeroIcon hero={hero} size={24} />
                      <span className="hidden truncate text-xs text-muted sm:inline">
                        {hero.name}
                      </span>
                    </>
                  ) : null}
                  {line ? (
                    <KDA
                      kills={line.kills}
                      deaths={line.deaths}
                      assists={line.assists}
                      className="shrink-0 text-xs"
                    />
                  ) : null}
                </span>
              </Link>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}
