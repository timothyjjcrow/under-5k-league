import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";
import { heroById } from "./heroes";

type AttentionMatch = {
  id: string;
  status: string;
  scheduledAt: Date | null;
  availability: { userId: string; status: string }[];
  standins: { replacingUserId: string | null }[];
  reschedules: { status: string }[];
};

/** Read-only triage. Future fixtures are never labeled as awaiting results. */
export function matchAttention(matches: AttentionMatch[], now = Date.now()) {
  return matches
    .filter((match) => match.status !== "COMPLETED")
    .flatMap((match) => {
      const reasons: string[] = [];
      if (!match.scheduledAt) reasons.push("Kickoff not set");
      else if (match.scheduledAt.getTime() + 2 * 60 * 60 * 1000 < now)
        reasons.push("Started over 2 hours ago; result still open");
      if (match.reschedules.some((request) => request.status === "PENDING"))
        reasons.push("Reschedule awaiting a response");
      const uncovered = match.availability.filter(
        (rsvp) =>
          rsvp.status === "OUT" &&
          !match.standins.some(
            (cover) => cover.replacingUserId === rsvp.userId,
          ),
      ).length;
      if (uncovered)
        reasons.push(
          `${uncovered} declared absence${uncovered === 1 ? "" : "s"} without assigned cover`,
        );
      return reasons.length ? [{ id: match.id, reasons }] : [];
    });
}

/** Report exclusions without changing or deleting any stored score. */
export function gameQualityReasons(players: string): string[] {
  const decoded = decodeGamePlayers(players);
  if (decoded.malformed)
    return ["Box score is not a valid player array; inspect the import."];
  const reasons: string[] = [];
  if (decoded.invalidLines)
    reasons.push(`${decoded.invalidLines} invalid player row(s).`);
  if (!decoded.completeRoster)
    reasons.push(
      "Not a complete trusted 5v5 roster; excluded from trusted-game analysis.",
    );
  const unknown = [
    ...new Set(
      trustedGamePlayers(decoded)
        .filter((player) => !heroById(player.heroId))
        .map((player) => player.heroId),
    ),
  ];
  if (unknown.length)
    reasons.push(
      `Unknown hero IDs: ${unknown.join(", ")}. Update the hero catalogue; do not remove otherwise valid games.`,
    );
  const unmapped = decoded.players.filter((player) => !player.userId).length;
  if (unmapped)
    reasons.push(
      `${unmapped} player row(s) not linked to a league player; individual attribution may be incomplete.`,
    );
  return reasons;
}
