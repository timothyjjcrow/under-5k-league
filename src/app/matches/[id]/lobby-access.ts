/**
 * Whether a viewer gets the season lobby bot's panel (lobby name, password,
 * both sides and status) outside Captain tools.
 *
 * It mirrors who resolveDotaLobby (src/lib/dota-lobby-service.ts) lets view a
 * season lobby: a player on either roster, a standin booked on this match, or
 * an admin. Anyone else would only get the server's refusal in the panel.
 * This match's captains are left out because their panel, with the Create and
 * Start buttons, is already in Captain tools; a second copy would put the same
 * controls on the page twice.
 */
export function seesPlayerLobbyPanel(
  viewer: { id: string; role: string },
  match: {
    homeTeam: { captainId: string };
    awayTeam: { captainId: string };
    standins: readonly { standinUserId: string }[];
  },
  rosterUserIds: readonly string[],
): boolean {
  if (
    viewer.id === match.homeTeam.captainId ||
    viewer.id === match.awayTeam.captainId
  ) {
    return false;
  }
  return (
    viewer.role === "ADMIN" ||
    rosterUserIds.includes(viewer.id) ||
    match.standins.some((s) => s.standinUserId === viewer.id)
  );
}
