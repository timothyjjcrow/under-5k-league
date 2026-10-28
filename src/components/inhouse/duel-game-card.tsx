"use client";

import { useId, useState } from "react";
import { Avatar, Badge, PlayerLink, RankMedal, buttonClasses } from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import { pushToast } from "@/components/toaster";
import { useSecondsLeft } from "@/components/room-clock";
import {
  DotaLobbyControls,
  type LobbyBotAvailability,
} from "@/components/dota-lobby-controls";
import { DUEL_BOT_WAITING_NOTE } from "@/lib/dota-lobby";
import { INHOUSE_DUEL_STATUS } from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { DUEL_BOT_OFF_NOTE, duelStageLabel, type DuelGameView } from "@/lib/inhouse-duel";
import { cn } from "@/lib/utils";
import { sideMeta } from "@/components/inhouse/shared";

/** "12:05" — minutes and seconds left on a 1v1 clock. */
function fmtLeft(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A 1v1 countdown leaf: only this text re-renders each second. */
function DuelCountdown({
  endsAtMs,
  offsetMs,
  label,
}: {
  endsAtMs: number;
  offsetMs: number;
  label: string;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <span
      role="timer"
      aria-label={`${label}: ${fmtLeft(seconds)} left`}
      className="font-mono text-sm font-semibold tabular-nums text-accent"
    >
      {fmtLeft(seconds)}
    </span>
  );
}

/**
 * The viewer's own 1v1 (READY, PLAYING or AWAITING_RESULT): the opponent
 * with their medal, the side each plays, the lobby bot's panel (kind
 * "duel": either player can create, start, re-invite or release, as 5v5
 * captains do) or, while the bot can't answer, the waiting note (1v1s are
 * bot only, never hosted by hand; a bot that can't host here at all says
 * so), then the stage's own controls: "Call it
 * off" while it hasn't started, "1v1 over" for a bot game whose end the bot
 * missed, and recording the result by its match ID.
 */
export function DuelGameCard({
  game,
  viewerId,
  canCallOff,
  canOver,
  canRecord,
  offset,
  pending,
  act,
}: {
  game: DuelGameView;
  viewerId: string;
  canCallOff: boolean;
  canOver: boolean;
  canRecord: boolean;
  offset: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [availability, setAvailability] =
    useState<LobbyBotAvailability>("checking");
  const [matchId, setMatchId] = useState("");
  const inputId = useId();
  const iAmRadiant = game.radiant.id === viewerId;
  const opponent = iAmRadiant ? game.dire : game.radiant;
  const mine = sideMeta(iAmRadiant);
  const theirs = sideMeta(!iAmRadiant);
  const live =
    game.status === INHOUSE_DUEL_STATUS.READY ||
    game.status === INHOUSE_DUEL_STATUS.PLAYING;
  // The bot's panel once it answers with a lobby (or names the game it is
  // busy with); otherwise the waiting note, never by-hand steps.
  const showPanel = availability === "on" || availability === "busy";
  const actOn = (body: Record<string, unknown>) =>
    act({ ...body, duelId: game.id });

  return (
    <div className="min-w-0 space-y-3 rounded-xl border border-accent/30 bg-surface-2/40 p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="min-w-0 text-sm font-semibold text-fg">Your 1v1</h3>
        <Badge tone={game.status === INHOUSE_DUEL_STATUS.READY ? "accent" : "info"}>
          {duelStageLabel(game.status)}
        </Badge>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={opponent.name} src={opponent.avatar} size={36} />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-sm">
            <span className="shrink-0 text-muted">vs</span>
            <PlayerLink userId={opponent.id} className="min-w-6 truncate font-semibold">
              {opponent.name}
            </PlayerLink>
            <RankMedal rankTier={opponent.rankTier} size={22} />
          </p>
          <p className="mt-0.5 text-xs text-muted">
            You play{" "}
            <span className={cn("font-semibold", iAmRadiant ? "text-success" : "text-danger-soft")}>
              {mine.name}
            </span>
            {", they play "}
            <span className={cn("font-semibold", iAmRadiant ? "text-danger-soft" : "text-success")}>
              {theirs.name}
            </span>
            .
          </p>
        </div>
      </div>

      {live ? (
        <>
          {/* Always mounted, so it keeps reporting whether the bot answers. */}
          <div className={showPanel ? "" : "hidden"}>
            <DotaLobbyControls
              key={game.id}
              kind="duel"
              id={game.id}
              onAvailability={setAvailability}
            />
          </div>
          {showPanel ? null : (
            <p role="status" className="text-sm text-muted">
              {availability === "checking"
                ? "Checking the lobby bot…"
                : availability === "off"
                  ? DUEL_BOT_OFF_NOTE
                  : DUEL_BOT_WAITING_NOTE}
            </p>
          )}
        </>
      ) : null}

      {game.status === INHOUSE_DUEL_STATUS.READY && game.setupEndsAt !== null ? (
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span>Called off if it hasn&apos;t started in</span>
          <DuelCountdown
            endsAtMs={game.setupEndsAt}
            offsetMs={offset}
            label="1v1 setup time"
          />
        </p>
      ) : null}
      {game.status === INHOUSE_DUEL_STATUS.PLAYING ? (
        <p className="text-xs text-muted">
          Game on. The result records itself from OpenDota after the game.
        </p>
      ) : null}
      {game.status === INHOUSE_DUEL_STATUS.AWAITING_RESULT ? (
        <p className="text-xs text-muted">
          Played. The result comes from OpenDota, usually 10 to 30 minutes
          after the game. You can join the 1v1 queue again meanwhile.
        </p>
      ) : null}
      {game.giveUpAt !== null ? (
        <p className="text-xs text-muted">
          Dropped if no result shows by{" "}
          <LocalTime
            ts={game.giveUpAt}
            variant="short"
            initial={formatLeagueMatchTime(new Date(game.giveUpAt), "short")}
          />
          .
        </p>
      ) : null}

      {canCallOff || canOver ? (
        <div className="flex flex-wrap gap-2">
          {canCallOff ? (
            <button
              type="button"
              disabled={pending}
              onClick={async () => {
                if (
                  !window.confirm(
                    `Call off your 1v1 with ${opponent.name}? It ends without a result, and the bot lets its lobby go.`,
                  )
                ) {
                  return;
                }
                if (await actOn({ action: "duelCallOff" })) {
                  pushToast("success", "1v1 called off");
                }
              }}
              className={buttonClasses("secondary", "sm")}
            >
              Call it off
            </button>
          ) : null}
          {canOver ? (
            <button
              type="button"
              disabled={pending}
              onClick={async () => {
                if (
                  !window.confirm(
                    "Has your 1v1 ended? Press this only if the game is over and the bot missed it. The result still comes from OpenDota.",
                  )
                ) {
                  return;
                }
                if (await actOn({ action: "duelOver" })) {
                  pushToast("success", "1v1 marked over — its result comes from OpenDota");
                }
              }}
              className={buttonClasses("ghost", "sm")}
            >
              1v1 over
            </button>
          ) : null}
        </div>
      ) : null}

      {canRecord ? (
        <details className="border-t border-line pt-2">
          <summary className="flex min-h-10 cursor-pointer items-center rounded text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            Record the 1v1 by match ID
          </summary>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const id = matchId.trim();
              if (pending || !id) return;
              if (await actOn({ action: "duelRecord", matchId: id })) {
                pushToast("success", "1v1 result recorded");
                setMatchId("");
              }
            }}
            className="mt-2 flex flex-wrap items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <label htmlFor={inputId} className="mb-1 block text-xs text-muted">
                1v1 match ID
              </label>
              <input
                id={inputId}
                type="text"
                inputMode="numeric"
                enterKeyHint="done"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={matchId}
                onChange={(e) => setMatchId(e.target.value)}
                placeholder="e.g. 7891234567"
                className="h-11 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
            </div>
            <button
              type="submit"
              disabled={pending || !matchId.trim()}
              className={buttonClasses("secondary", "md", "min-h-11")}
            >
              Record 1v1
            </button>
          </form>
        </details>
      ) : null}
    </div>
  );
}
