"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PlayerLink,
  buttonClasses,
} from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { INHOUSE_QUEUE_INVITE_PATH } from "@/lib/inhouse-queue-invite";
import { signInHref } from "@/lib/sign-in";
import {
  DUEL_CARD_INTRO,
  duelJoinRow,
  duelResultLanded,
  duelResultLine,
  duelStageLabel,
  type DuelState,
} from "@/lib/inhouse-duel";
import { cn } from "@/lib/utils";
import { DuelGameCard } from "@/components/inhouse/duel-game-card";
import { DuelAdminTools } from "@/components/inhouse/duel-admin-tools";

const count = new Intl.NumberFormat("en-US");

/**
 * The 1v1 mid card (docs/features/inhouse-duels.md): its own section under
 * every 5v5 card in the room, never above or inside the 5v5 queue card.
 * Join 1v1 pairs the viewer with the oldest present waiter, or queues them;
 * a pair's lobby is the bot's (bot only). The viewer's own 1v1, their last
 * result for 10 minutes, the waiters, the other live 1v1s one line each,
 * and an admin's rows. Every action goes through the room's act(), and the
 * card's rules are the pure helpers in inhouse-duel.ts.
 */
export function DuelSection({
  duel,
  viewerId,
  joinRefusal,
  offset,
  pending,
  act,
}: {
  duel: DuelState;
  viewerId: string | null;
  /** The page's MMR-cap refusal (the 5v5 queue's rule; joinDuelQueue's too). */
  joinRefusal: string | null;
  offset: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const router = useRouter();
  const me = duel.me;
  const row = duelJoinRow(me, joinRefusal);
  const myGame =
    me?.duelId != null ? (duel.games.find((g) => g.id === me.duelId) ?? null) : null;
  const others = duel.games.filter((g) => g.id !== myGame?.id);
  const waiting = duel.queue.players;

  // A 1v1 result landing refreshes the server-rendered 1v1 leaderboard
  // below the room (the first reply is never news).
  const resultsKey = duel.results.map((r) => r.id).join(",");
  const prevResults = useRef<string[] | null>(null);
  useEffect(() => {
    const cur = resultsKey ? resultsKey.split(",") : [];
    if (duelResultLanded(prevResults.current, cur)) router.refresh();
    prevResults.current = cur;
  }, [resultsKey, router]);

  return (
    <section id="inhouse-1v1-room" aria-label="1v1 mid" className="scroll-mt-28">
      <Card className="overflow-hidden">
        <CardHeader
          headingLevel={2}
          title="1v1 mid"
          subtitle={DUEL_CARD_INTRO}
          action={
            waiting.length > 0 ? (
              <Badge tone="accent">{count.format(waiting.length)} waiting</Badge>
            ) : null
          }
        />
        <CardBody className="space-y-4">
          {me?.lastResult ? (
            <p
              role="status"
              className={cn(
                "rounded-lg border px-3 py-2 text-sm font-semibold",
                me.lastResult.won
                  ? "border-success/50 bg-success/10 text-success"
                  : "border-danger/40 bg-danger/10 text-danger-soft",
              )}
            >
              {duelResultLine(me.lastResult)}
            </p>
          ) : null}

          {myGame && me && viewerId ? (
            <DuelGameCard
              game={myGame}
              viewerId={viewerId}
              canCallOff={me.canCallOff}
              canOver={me.canOver}
              canRecord={me.canRecord}
              offset={offset}
              pending={pending}
              act={act}
            />
          ) : null}

          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            {row.kind === "sign-in" ? (
              <a
                href={signInHref(INHOUSE_QUEUE_INVITE_PATH)}
                className={buttonClasses("secondary", "md")}
              >
                Sign in to play 1v1
              </a>
            ) : row.kind === "join" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => act({ action: "duelJoin" })}
                className={buttonClasses("accent", "md")}
              >
                Join 1v1
              </button>
            ) : row.kind === "leave" ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => act({ action: "duelLeave" })}
                  className={buttonClasses("secondary", "md")}
                >
                  Leave 1v1
                </button>
                <p className="min-w-0 text-sm text-muted">
                  Waiting for an opponent: the next player to join plays you.
                  {me?.queueExpiresAt ? (
                    <>
                      {" Your spot holds until "}
                      <LocalTime
                        ts={me.queueExpiresAt}
                        variant="short"
                        initial={formatLeagueMatchTime(
                          new Date(me.queueExpiresAt),
                          "short",
                        )}
                      />
                      .
                    </>
                  ) : null}
                </p>
              </>
            ) : row.kind === "refused" ? (
              <p className="min-w-0 text-sm text-muted">{row.reason}</p>
            ) : null}
            {row.kind === "join" && waiting.length === 0 ? (
              <p className="min-w-0 text-sm text-muted">
                Nobody is waiting yet. Join and the next player in plays you.
              </p>
            ) : null}
          </div>

          {waiting.length > 0 ? (
            <div className="min-w-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Waiting for a 1v1
              </h3>
              <ul className="mt-2 space-y-3">
                {waiting.map((p) => (
                  <li key={p.userId} className="flex min-w-0 items-center gap-2 text-sm">
                    <Avatar name={p.name} src={p.avatar} size={24} />
                    <PlayerLink userId={p.userId} className="min-w-6 truncate">
                      {p.name}
                    </PlayerLink>
                    {p.userId === viewerId ? (
                      <span className="shrink-0 text-xs text-muted">(you)</span>
                    ) : null}
                    {p.present ? null : (
                      <span className="shrink-0 text-xs text-muted">· away</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {others.length > 0 ? (
            <div className="min-w-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Other 1v1s
              </h3>
              <ul className="mt-2 space-y-3">
                {others.map((g) => (
                  <li key={g.id} className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm">
                    <span className="min-w-0 truncate">
                      {g.radiant.name} vs {g.dire.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      · {duelStageLabel(g.status)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <DuelAdminTools
            duel={duel}
            pending={pending}
            act={act}
            onVoided={() => router.refresh()}
          />
        </CardBody>
      </Card>
    </section>
  );
}
