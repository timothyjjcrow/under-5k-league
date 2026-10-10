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
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-info/40 bg-info/10 px-6 py-5 text-center">
        <h2 className="flex flex-wrap items-center justify-center gap-3 font-display text-2xl font-semibold sm:text-3xl">
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
          <p className="mt-1 text-sm text-muted">
            Started by {lobby.startedByName}
          </p>
        ) : null}
        <GameOverControl
          lobby={lobby}
          me={me}
          serverNow={serverNow}
          pending={pending}
          act={act}
        />
        {me.canRecord ? (
          <ResultControls scan={scan} pending={pending} act={act} />
        ) : (
          <p className="mt-3 text-sm text-muted">
            {scan.live
              ? "The result is pulled from OpenDota automatically once the game ends."
              : `The result is pulled from OpenDota automatically. ${scanStatusText(scan)}`}
          </p>
        )}
      </div>

      {me.inLobby || me.isAdmin ? <GameSetupCard lobby={lobby} me={me} /> : null}

      <MatchupGrid lobby={lobby} />
    </div>
  );
}
