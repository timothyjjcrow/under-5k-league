import { matchResultsOpen } from "@/lib/league-lifecycle";
import { lobbyBotKindEnabled } from "@/lib/dota-lobby-service";
import { DotaLobbyControls } from "@/components/dota-lobby-controls";
import { loadRosters, type MatchPageMatch, type MatchViewer } from "./load";
import { seesPlayerLobbyPanel } from "./lobby-access";

/**
 * The season lobby bot's panel for the other people who play this match: the
 * players on both rosters, any booked standin, and admins. Players join
 * through Dota's Custom Lobbies browser with the name and password it shows
 * (docs/DOTA-LOBBY-BOT.md), so without it a captain had to relay them by hand.
 * The captains' own panel, with the controls, is in the result card inside
 * Captain tools; this one opens in the same windows (season lobby bot on,
 * active season, series not final, results open for the match's phase).
 * It is the "player" audience: it shows only once the bot answers with a
 * lobby, because a missing bot connection or ticket is for an admin to fix
 * and the manual hosting steps sit in Captain tools, not on this viewer's page.
 */
export async function PlayerLobbyPanel({
  match,
  viewer,
}: {
  match: MatchPageMatch;
  viewer: MatchViewer;
}) {
  if (!viewer || !lobbyBotKindEnabled("season")) return null;
  if (
    !match.season.isActive ||
    match.status === "COMPLETED" ||
    !matchResultsOpen(match.season.status, match.phase)
  ) {
    return null;
  }
  const rosters = await loadRosters(match);
  if (
    !seesPlayerLobbyPanel(
      viewer,
      match,
      rosters.map((m) => m.userId),
    )
  ) {
    return null;
  }
  return (
    <DotaLobbyControls
      key={`${match.id}:${match.homeScore}:${match.awayScore}`}
      kind="season"
      id={match.id}
      audience="player"
    />
  );
}
