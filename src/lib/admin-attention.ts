import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";
import { heroById } from "./heroes";
import { MATCH_STATUS, SEASON_STATUS } from "./constants";
import { standinConflict, type StandinSlot } from "./standin";
import { matchCoverIssues } from "./admin-sections";
import { seriesEstimateMinutes } from "./series-lengths";

type AttentionMatch = {
  id: string;
  status: string;
  /** The series length; absent reads as a Bo2. */
  bestOf?: number;
  homeTeamId: string | null;
  awayTeamId: string | null;
  scheduledAt: Date | null;
  availability: { userId: string; status: string }[];
  standins: { replacingUserId: string | null; standinUserId: string }[];
  reschedules: { status: string }[];
};

/**
 * How long after kickoff an open series counts as overdue: the league's own
 * series estimate (seriesEstimateMinutes), doubled once a game is in, the
 * same window the site keeps "Live now" up for (matchWatchWindow). A flat two
 * hours flagged Bo2s and Bo3s still being played while Tonight showed them
 * as Live.
 */
function overdueAfterMs(match: { status: string; bestOf?: number }): number {
  const estimates = match.status === MATCH_STATUS.LIVE ? 2 : 1;
  return estimates * seriesEstimateMinutes(match.bestOf ?? 2) * 60_000;
}

/**
 * Read-only triage. Future fixtures are never labeled as awaiting results.
 * `uncovered` counts the players out with no cover, exactly as the Standins
 * card does (matchCoverIssues): only current roster members, so a released
 * player's old "can't make it" raises nothing, and a booked standin's own
 * OUT is left to outStandins (the cover that quit, not a seat missing it).
 */
export function matchAttention(
  matches: AttentionMatch[],
  teams: readonly { id: string; members: readonly { userId: string }[] }[],
  now = Date.now(),
): { id: string; reasons: string[]; uncovered: number }[] {
  return matches
    .filter((match) => match.status !== "COMPLETED")
    .flatMap((match) => {
      const reasons: string[] = [];
      if (!match.scheduledAt) reasons.push("Kickoff not set");
      else if (match.scheduledAt.getTime() + overdueAfterMs(match) < now)
        reasons.push("Past its expected finish; result still open");
      if (match.reschedules.some((request) => request.status === "PENDING"))
        reasons.push("Reschedule awaiting a response");
      const uncovered = matchCoverIssues(
        match,
        teams,
        match.standins.map((cover) => ({ ...cover, matchId: match.id })),
        match.availability
          .filter((rsvp) => rsvp.status === "OUT")
          .map((rsvp) => ({ ...rsvp, matchId: match.id })),
      ).uncovered.length;
      if (uncovered)
        reasons.push(
          `${uncovered} declared absence${uncovered === 1 ? "" : "s"} without assigned cover`,
        );
      return reasons.length ? [{ id: match.id, reasons, uncovered }] : [];
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

/**
 * The people match-night pings are for who haven't linked Discord, by name:
 * players on teams still in the season, then standins booked on an unplayed
 * match. A withdrawn team plays no more fixtures, and a played booking needs
 * no ping. Anyone listed twice (a released player now booked as cover) is
 * listed once. Needs attention counts this list and the Discord reach card
 * names it, so the two always agree.
 */
export function unlinkedRoster(
  teams: readonly {
    withdrawn: boolean;
    members: readonly {
      userId: string;
      user: { discordId: string | null; name: string };
    }[];
  }[],
  assignments: readonly {
    matchId: string;
    standinUserId: string;
    standin: { discordId: string | null; name: string };
  }[],
  openMatchIds: ReadonlySet<string>,
): string[] {
  const names = new Map<string, string>();
  for (const team of teams) {
    if (team.withdrawn) continue;
    for (const member of team.members) {
      if (member.user.discordId == null) names.set(member.userId, member.user.name);
    }
  }
  for (const booking of assignments) {
    if (openMatchIds.has(booking.matchId) && booking.standin.discordId == null) {
      if (!names.has(booking.standinUserId))
        names.set(booking.standinUserId, booking.standin.name);
    }
  }
  return [...names.values()];
}

/**
 * Whether match-night pings go to rosters: the auction has finished and the
 * season still has games to play. Before that, pings reach signups; once the
 * season is complete, nobody needs chasing.
 */
export function rosterPingsLive(
  seasonStatus: string,
  draftComplete: boolean,
): boolean {
  return (
    draftComplete &&
    (seasonStatus === SEASON_STATUS.DRAFT ||
      seasonStatus === SEASON_STATUS.REGULAR_SEASON ||
      seasonStatus === SEASON_STATUS.PLAYOFFS)
  );
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
  const rostersLive = rosterPingsLive(input.seasonStatus, input.draftComplete);
  if (rostersLive) {
    input.shortTeams.forEach((team, index) => {
      items.push({
        key: `short-${index}`,
        text: `${team.name} ${team.missing === 1 ? "is a player" : `is ${team.missing} players`} short. Sign a free agent, or book a standin for the empty seat.`,
        href: "#adm-roster",
      });
    });
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
