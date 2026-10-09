import type { InhouseState } from "@/lib/inhouse-service";

// Types and small helpers shared by the inhouse room shell
// (src/components/inhouse-room.tsx) and its stage views in this folder.

/** A live lobby: the viewer's own, or another game they watch. */
export type RoomLobby = NonNullable<InhouseState["lobby"]>;

export type LobbyTeam = RoomLobby["teams"][number];
export type Player = LobbyTeam["players"][number];
export type RoomMe = InhouseState["me"] & {
  /**
   * A UI capability, not an attention signal. Captains on the current turn and
   * administrators can both submit the service's `pick` action, but only the
   * captain should receive the chime and "Your pick" title driven by
   * `isOnClock`.
   */
  canPick: boolean;
};

export function scrollToRoomTop() {
  window.scrollTo({
    top: 0,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
}

// Radiant = green, Dire = red — matching the in-client colors so it reads fast.
export function sideMeta(isRadiant: boolean) {
  return isRadiant
    ? {
        name: "Radiant",
        badge: "success" as const,
        ring: "border-success/50",
        chip: "bg-success/10 text-success border-success/30",
        dot: "bg-success",
      }
    : {
        name: "Dire",
        badge: "danger" as const,
        ring: "border-danger/50",
        chip: "bg-danger/10 text-danger-soft border-danger/30",
        dot: "bg-danger",
      };
}
