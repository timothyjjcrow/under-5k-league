"use client";

import { buttonClasses } from "@/components/ui";
import { inhouseGameOverOpen, inhouseLobbyCode } from "@/lib/inhouse";
import type { InhouseState } from "@/lib/inhouse-service";
import type { RoomLobby } from "@/components/inhouse/shared";

/**
 * "Game over — queue again": the game is over in Dota, so its ten can queue
 * for the next one now instead of waiting for OpenDota to publish the result
 * (10 to 30 minutes after the game). The result still records itself later.
 *
 * Shown only where finishGame would accept it: a player in the game or an
 * admin (`me.canFinish`) once the result scan's window is open
 * (inhouseGameOverOpen, the service's own rule). A player's press also puts
 * them back in the queue; an admin watching someone else's game only marks it
 * over. The toast that follows comes from the room (gameMarkedOverToast), the
 * same one the other nine see.
 */
export function GameOverControl({
  lobby,
  me,
  serverNow,
  pending,
  act,
}: {
  lobby: RoomLobby;
  me: Pick<InhouseState["me"], "canFinish" | "inLobby">;
  serverNow: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  if (!me.canFinish) return null;
  if (!inhouseGameOverOpen(lobby.status, lobby.scanOpensAt, serverNow)) {
    return null;
  }
  const player = me.inLobby;
  const code = inhouseLobbyCode(lobby.id);
  return (
    <div className="mt-4 space-y-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            window.confirm(
              player
                ? `Is game #${code} over in Dota? You go back in the queue, everyone in it can queue again, and the result still records itself from OpenDota.`
                : `Mark game #${code} over? Its ten players can queue again, and the result still records itself from OpenDota.`,
            )
          ) {
            act({ action: "finish", requeue: player });
          }
        }}
        className={buttonClasses("accent", "lg")}
      >
        {player ? "Game over — queue again" : "Admin: mark game over"}
      </button>
      <p className="mx-auto max-w-sm text-xs text-muted">
        No need to wait for the result: it lands on its own once OpenDota has
        the game.
      </p>
    </div>
  );
}
