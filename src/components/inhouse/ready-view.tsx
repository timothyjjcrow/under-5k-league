"use client";

import { buttonClasses } from "@/components/ui";
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
  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-6 py-5 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
          Draft complete
        </p>
        <h2 className="mt-1 font-display text-3xl font-semibold">
          Teams are set!
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          Join the Dota lobby and your team’s voice channel, then play. The
          result records itself from OpenDota after the game, and once it
          ends anyone in it can press “Game over — queue again”.
        </p>
        {/* A game hosted by hand stays READY for its whole length, so once it
            is plausibly being played the way out of it lives here too. */}
        {inhouseReadyInPlay(lobby.status, lobby.scanOpensAt, serverNow) ? (
          <GameOverControl
            lobby={lobby}
            me={me}
            serverNow={serverNow}
            pending={pending}
            act={act}
          />
        ) : null}
        {me.canRecord ? (
          <ResultControls
            folded
            scan={inhouseScanStatus(lobby.scanOpensAt, serverNow)}
            pending={pending}
            act={act}
          />
        ) : null}
      </div>

      {/* Setup comes straight after "Teams are set": getting ten people into
          one Dota lobby is the next thing everyone has to do. */}
      {me.inLobby || me.isAdmin ? (
        <GameSetupCard
          lobby={lobby}
          me={me}
          manualStart={
            me.canStart ? (
              // Optional since results record from here too: it only starts
              // the game clock for the room and the Discord board. No confirm
              // — an early tap costs nothing.
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-5 py-4">
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

      <MatchupGrid lobby={lobby} />
    </div>
  );
}
