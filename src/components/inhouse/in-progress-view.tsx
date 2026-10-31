"use client";

import { inhouseScanStatus } from "@/lib/inhouse";
import type { InhouseState } from "@/lib/inhouse-service";
import { ElapsedClock } from "@/components/inhouse/clocks";
import { GameOverControl } from "@/components/inhouse/game-over-control";
import { GameSetupCard } from "@/components/inhouse/game-setup-card";
import { MatchupGrid } from "@/components/inhouse/matchup-grid";
import {
  ResultControls,
  scanStatusText,
} from "@/components/inhouse/result-controls";
import type { RoomLobby } from "@/components/inhouse/shared";

export function InProgressView({
  lobby,
  me,
  offset,
  serverNow,
  pending,
  act,
}: {
  lobby: RoomLobby;
  me: InhouseState["me"];
  offset: number;
  /** The server clock from the last poll (see inhouseScanStatus). */
  serverNow: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  // Poll-driven (not ticking): it flips once, minutes in, and only gates the
  // scan note and the "Check now" button. The visible timer ticks in
  // <ElapsedClock>.
  const scan = inhouseScanStatus(lobby.scanOpensAt, serverNow);

  return (
    <div className="space-y-3">
      {/* One card: the game, its clock and who started it, the way out of it
          ("Game over") on the right, and the result's checks in one row. */}
      <section
        aria-label="Game in progress"
        className="rounded-2xl border border-info/40 bg-info/10 p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-x-3 gap-y-1 font-display text-xl font-semibold sm:text-2xl">
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info/70 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-info" />
              </span>
              Game in progress
              {lobby.startedAt != null ? (
                <ElapsedClock startedAtMs={lobby.startedAt} offsetMs={offset} />
              ) : null}
            </h2>
            {/* Whoever pressed Start, which is not necessarily who hosts the
                Dota lobby. */}
            {lobby.startedByName ? (
              <p className="mt-1 text-xs text-muted">
                Started by {lobby.startedByName}
              </p>
            ) : null}
            <p className="mt-1 text-sm text-muted">
              The result records automatically after the game.{" "}
              <span className="text-xs">{scanStatusText(scan)}</span>
            </p>
          </div>
          <GameOverControl
            lobby={lobby}
            me={me}
            serverNow={serverNow}
            pending={pending}
            act={act}
          />
        </div>
        {me.canRecord ? (
          <ResultControls
            className="mt-3 border-t border-info/20 pt-2"
            scan={scan}
            pending={pending}
            act={act}
          />
        ) : null}
      </section>

      {/* Mid-game the rosters matter more than the lobby's details, which
          fold under one line (the bot panel inside keeps reporting). */}
      <MatchupGrid lobby={lobby} myTeam={me.myTeam} />
      {me.inLobby || me.isAdmin ? (
        <GameSetupCard lobby={lobby} me={me} collapsed />
      ) : null}
    </div>
  );
}
