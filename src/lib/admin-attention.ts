import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";
import { heroById } from "./heroes";
import { MATCH_STATUS, SEASON_STATUS } from "./constants";
import { standinConflict, type StandinSlot } from "./standin";

type AttentionMatch = {
  id: string;
  status: string;
  scheduledAt: Date | null;
  availability: { userId: string; status: string }[];
  standins: { replacingUserId: string | null; standinUserId?: string }[];
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
      // A booked standin's own OUT is reported once, by outStandins: they are
      // the cover that quit, not a player missing cover.
      const uncovered = match.availability.filter(
        (rsvp) =>
          rsvp.status === "OUT" &&
          !match.standins.some(
            (cover) =>
              cover.replacingUserId === rsvp.userId ||
              cover.standinUserId === rsvp.userId,
          ),
      ).length;
      if (uncovered)
        reasons.push(
          `${uncovered} declared absence${uncovered === 1 ? "" : "s"} without assigned cover`,
        );
      return reasons.length ? [{ id: match.id, reasons }] : [];
    });
}

/**
 * Pairs of unplayed fixtures one standin is booked for on the same night.
 * standinConflict runs when cover is arranged, but every retime path can move
 * a fixture onto a night that check already approved, so the admin page
 * recomputes this from live bookings.
 */
export function standinClashes<M extends StandinSlot & { id: string; status: string }>(
  assignments: readonly { matchId: string; standinUserId: string }[],
  matches: readonly M[],
): { standinUserId: string; first: M; second: M }[] {
  const open = new Map(
    matches
      .filter((match) => match.status !== MATCH_STATUS.COMPLETED)
      .map((match) => [match.id, match]),
  );
  const byStandin = new Map<string, M[]>();
  for (const booking of assignments) {
    const match = open.get(booking.matchId);
    if (!match) continue;
    const covered = byStandin.get(booking.standinUserId) ?? [];
    if (!covered.includes(match)) covered.push(match);
    byStandin.set(booking.standinUserId, covered);
  }
  const clashes: { standinUserId: string; first: M; second: M }[] = [];
  for (const [standinUserId, covered] of byStandin) {
    for (let i = 0; i < covered.length; i++) {
      for (let j = i + 1; j < covered.length; j++) {
        if (standinConflict(covered[i], covered[j])) {
          clashes.push({ standinUserId, first: covered[i], second: covered[j] });
        }
      }
    }
  }
  return clashes;
}

/**
 * Booked standins who have said they can't play the unplayed match they
 * cover: the seat reads as covered while the cover has quit.
 */
export function outStandins(
  assignments: readonly { matchId: string; standinUserId: string }[],
  outRsvps: readonly { matchId: string; userId: string }[],
  openMatchIds: ReadonlySet<string>,
): { matchId: string; userId: string }[] {
  return outRsvps.filter(
    (rsvp) =>
      openMatchIds.has(rsvp.matchId) &&
      assignments.some(
        (booking) =>
          booking.matchId === rsvp.matchId &&
          booking.standinUserId === rsvp.userId,
      ),
  );
}

/** Teams still in the season with fewer rostered players than the side size. */
export function shortTeams<T extends { withdrawn: boolean; members: readonly unknown[] }>(
  teams: readonly T[],
  teamSize: number,
): { team: T; missing: number }[] {
  return teams
    .filter((team) => !team.withdrawn && team.members.length < teamSize)
    .map((team) => ({ team, missing: teamSize - team.members.length }));
}

/** One Needs attention line and the /admin section that fixes it. */
export type AttentionItem = { key: string; text: string; href: string };

export type AdminAttentionInput = {
  seasonStatus: string;
  /** The auction has finished, so rosters are real. */
  draftComplete: boolean;
  /** Plain lines from automationAttention. */
  automation: readonly string[];
  importsNeedingReview: number;
  shortTeams: readonly { name: string; missing: number }[];
  standinClashes: readonly { standin: string; first: string; second: string }[];
  outStandins: readonly { standin: string; fixture: string }[];
  championIssue: "missing" | "inconsistent" | null;
  /** Active signups with no linked Discord (before rosters exist). */
  unlinkedSignups: number;
  /** Rostered players and standins booked on unplayed matches with no linked Discord. */
  unlinkedRostered: number;
};

const plural = (count: number, one: string, many = `${one}s`) =>
  count === 1 ? one : many;

/**
 * Every alarm the admin page raises, as one list. Per-match problems
 * (matchAttention) render beside it; everything here is season-wide. The
 * input is DB-derived only, so the blocking page load never waits on Discord.
 */
export function adminAttention(input: AdminAttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  input.automation.forEach((text, index) =>
    items.push({ key: `automation-${index}`, text, href: "#adm-automation" }),
  );
  if (input.importsNeedingReview > 0) {
    const n = input.importsNeedingReview;
    items.push({
      key: "imports",
      text: `${n} imported ${plural(n, "game needs", "games need")} review before ${n === 1 ? "it counts" : "they count"}.`,
      href: "#adm-sync",
    });
  }
  const rostersLive =
    input.draftComplete &&
    (input.seasonStatus === SEASON_STATUS.DRAFT ||
      input.seasonStatus === SEASON_STATUS.REGULAR_SEASON ||
      input.seasonStatus === SEASON_STATUS.PLAYOFFS);
  if (rostersLive) {
    for (const team of input.shortTeams) {
      items.push({
        key: `short-${team.name}`,
        text: `${team.name} ${team.missing === 1 ? "is a player" : `is ${team.missing} players`} short. Sign a free agent, or book a standin for the empty seat.`,
        href: "#adm-roster",
      });
    }
  }
  input.standinClashes.forEach((clash, index) =>
    items.push({
      key: `clash-${index}`,
      text: `${clash.standin} is booked to stand in for ${clash.first} and ${clash.second} on the same night.`,
      href: "#adm-standins",
    }),
  );
  input.outStandins.forEach((out, index) =>
    items.push({
      key: `standin-out-${index}`,
      text: `${out.standin} is booked to stand in for ${out.fixture} but has said they can't play.`,
      href: "#adm-standins",
    }),
  );
  if (input.championIssue) {
    items.push({
      key: "champion",
      text:
        input.championIssue === "missing"
          ? "The season is complete but has no champion. Reconcile the grand final under Fix the bracket."
          : "The recorded champion doesn't match the grand final. Reconcile it under Fix the bracket.",
      href: "#adm-playoffs",
    });
  }
  if (input.seasonStatus !== SEASON_STATUS.COMPLETE) {
    const n = rostersLive ? input.unlinkedRostered : input.unlinkedSignups;
    if (n > 0) {
      items.push({
        key: "discord",
        text: rostersLive
          ? `${n} rostered ${plural(n, "player or standin", "players and standins")} ${n === 1 ? "hasn't" : "haven't"} linked Discord, so pings can't reach them.`
          : `${n} signed-up ${plural(n, "player hasn't", "players haven't")} linked Discord, so pings can't reach them.`,
        href: "#adm-reach",
      });
    }
  }
  return items;
}

/** "<Season>: all clear" or "<Season>: 3 things need attention". */
export function attentionTitle(seasonName: string, count: number): string {
  return count === 0
    ? `${seasonName}: all clear`
    : `${seasonName}: ${count} ${count === 1 ? "thing needs" : "things need"} attention`;
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
