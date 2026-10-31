"use client";

import { buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";
import { inhouseReadyInPlay, inhouseScanStatus } from "@/lib/inhouse";
import type { InhouseState } from "@/lib/inhouse-service";
import { GameOverControl } from "@/components/inhouse/game-over-control";
import { GameSetupCard } from "@/components/inhouse/game-setup-card";
import { MatchupGrid } from "@/components/inhouse/matchup-grid";
import { ResultControls } from "@/components/inhouse/result-controls";
import type { RoomLobby } from "@/components/inhouse/shared";

export function ReadyView({
  lobby,
  me,
  serverNow,
  pending,
  act,
}: {
  lobby: RoomLobby;
  me: InhouseState["me"];
  /** The server clock from the last poll (see inhouseScanStatus). */
  serverNow: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const inPlay = inhouseReadyInPlay(lobby.status, lobby.scanOpensAt, serverNow);
  const setup = me.inLobby || me.isAdmin;
  return (
    <div className="space-y-3">
      {/* One short card: teams are locked, what to do, and (once the game is
          plausibly being played) the way out of it. */}
      <section
        aria-label="Teams are set"
        className="rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/10 via-surface to-surface p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
              Draft complete
            </p>
            <h2 className="mt-1 font-display text-xl font-semibold sm:text-2xl">
              Teams are set!
            </h2>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Get into the Dota lobby and your team’s voice channel, then play.
              The result records itself from OpenDota.
            </p>
          </div>
          {/* A game hosted by hand stays READY for its whole length, so once
              it is plausibly being played the way out of it lives here too. */}
          {inPlay ? (
            <GameOverControl
              lobby={lobby}
              me={me}
              serverNow={serverNow}
              pending={pending}
              act={act}
            />
          ) : null}
        </div>
        {me.canRecord ? (
          <ResultControls
            folded
            className="mt-2 border-t border-accent/20 pt-1"
            scan={inhouseScanStatus(lobby.scanOpensAt, serverNow)}
            pending={pending}
            act={act}
          />
        ) : null}
      </section>

      {/* Setup comes straight after "Teams are set": getting ten people into
          one Dota lobby is the next thing everyone has to do. From xl the
          rosters sit beside it instead of under it. */}
      <div
        className={cn(
          "grid grid-cols-1 items-start gap-3",
          setup && "xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]",
        )}
      >
        {setup ? (
          <GameSetupCard
            lobby={lobby}
            me={me}
            manualStart={
              me.canStart ? (
                // Optional since results record from here too: it only starts
                // the game clock for the room and the Discord board. No confirm
                // — an early tap costs nothing.
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3 sm:px-5">
                  <button
                    disabled={pending}
                    onClick={() => act({ action: "start" })}
                    className={buttonClasses("secondary", "md")}
                  >
                    Start the game clock
                  </button>
                  <p className="min-w-0 flex-1 text-xs text-muted">
                    Optional: once everyone is in the lobby, this shows the game
                    as live here and on Discord.
                  </p>
                </div>
              ) : null
            }
          />
        ) : null}
        <MatchupGrid lobby={lobby} rail={setup} myTeam={me.myTeam} />
      </div>
    </div>
  );
}
