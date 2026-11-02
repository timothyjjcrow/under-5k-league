"use client";

import { buttonClasses } from "@/components/ui";
import { ConfirmButton } from "@/components/inhouse/confirm-button";
import { inhouseGameOverOpen, inhouseLobbyCode } from "@/lib/inhouse";
import type { InhouseState } from "@/lib/inhouse-service";
import type { RoomGameOver, RoomLobby } from "@/components/inhouse/shared";

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
 *
 * A player's press on a game the bot launched asks Dota first (finishGame).
 * While Dota has no result for it yet the room asks again on its own
 * (`waiting`, gameOverWaitStep), and this says so in the button's place.
 */
export function GameOverControl({
  lobby,
  me,
  serverNow,
  pending,
  gameOver,
}: {
  lobby: RoomLobby;
  me: Pick<InhouseState["me"], "canFinish" | "inLobby">;
  serverNow: number;
  pending: boolean;
  gameOver: RoomGameOver;
}) {
  if (!me.canFinish) return null;
  if (!inhouseGameOverOpen(lobby.status, lobby.scanOpensAt, serverNow)) {
    return null;
  }
  const player = me.inLobby;
  const code = inhouseLobbyCode(lobby.id);
  if (gameOver.waiting) {
    return (
      <p role="status" className="max-w-xs text-sm text-muted">
        Checking with Dota for game #{code}’s result…{" "}
        {player
          ? "You go back in the queue as soon as it’s posted."
          : "The game is marked over as soon as it’s posted."}
      </p>
    );
  }
  // Asks in place (ConfirmButton): the question carries what the press does,
  // so the card needs no second line explaining it.
  return (
    <ConfirmButton
      label={player ? "Game over — queue again" : "Admin: mark game over"}
      disabled={pending}
      className={buttonClasses("accent", "md", "font-semibold")}
      prompt={
        player
          ? `Is game #${code} over in Dota? The site checks with Dota, then you go back in the queue, everyone in it can queue again, and the result still records itself from OpenDota.`
          : `Mark game #${code} over? Its ten players can queue again, and the result still records itself from OpenDota.`
      }
      confirmLabel={player ? "Yes, it’s over" : "Mark it over"}
      cancelLabel="Not yet"
      focus="confirm"
      promptClassName="max-w-md"
      onConfirm={() => gameOver.press(player)}
    />
  );
}
