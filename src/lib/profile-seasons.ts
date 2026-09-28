// The profile's "Seasons" card: one plain-language row per season and team,
// merged from three separate records the database keeps apart on purpose
// (docs/HISTORICAL-PARTICIPATION.md): recorded appearances (games and series
// actually played), roster tenures (how they joined the team) and standin
// bookings on completed matches. Presentation only: nothing here writes, and
// the detailed membership dates stay in the admin season export.

import { seriesRecordText } from "./team-matches";

/** Tenures ended by these never made a real season with that team: the sale
 *  was undone, the draft was aborted and re-run, or the team was dissolved
 *  before the draft. Shown only if the player somehow also played for it. */
const VOID_TENURE_ENDS = new Set([
  "DRAFT_UNDO",
  "DRAFT_ABORT",
  "PRE_DRAFT_TEAM_REMOVED",
]);

export type ProfileSeasonRole =
  | { kind: "captain" }
  | { kind: "drafted"; price: number }
  | { kind: "free-agent" };

export type ProfileSeasonRow = {
  key: string;
  seasonId: string;
  seasonName: string;
  /** null when the team no longer exists (only its name was kept). */
  teamId: string | null;
  teamName: string;
  /** How they joined the team; null when it isn't known (older records, or
   *  someone who only stood in). */
  role: ProfileSeasonRole | null;
  /** Imported games they played for this team. */
  games: number;
  /** Completed series they played in for this team; null when none. */
  series: { wins: number; losses: number; draws: number } | null;
  /** Completed matches they were booked to cover for this team. */
  stoodIn: number;
  /** This team won the title, and the player was part of it (played, stood
   *  in, or was still on the roster). */
  champion: boolean;
};

type SeasonInfo = { name: string; createdAt: Date };

export function profileSeasonRows(input: {
  seasons: ReadonlyMap<string, SeasonInfo>;
  /** This player's appearanceCareers rows. */
  appearances: readonly {
    teamId: string;
    seasonId: string;
    games: number;
    seriesWins: number;
    seriesLosses: number;
    seriesDraws: number;
  }[];
  /** This player's roster tenures (getRosterHistory). */
  tenures: readonly {
    seasonId: string;
    teamId: string | null;
    teamName: string;
    joinedAt: Date;
    /** The membership still exists (they were on the roster at the end). */
    active: boolean;
    acquisitionKind: string;
    price: number;
    /** Captain status: the live roster row when it still exists, else what
     *  was recorded at joining; null when never known. */
    captain: boolean | null;
    endReason: string | null;
  }[];
  /** One entry per completed match they were booked to cover. */
  covers: readonly { seasonId: string; teamId: string; matchId: string }[];
  teamNames: ReadonlyMap<string, string>;
  /** seasonId → resolved champion team id. */
  champions: ReadonlyMap<string, string>;
}): ProfileSeasonRow[] {
  type Acc = {
    seasonId: string;
    teamId: string | null;
    teamName: string | undefined;
    tenures: (typeof input.tenures)[number][];
    games: number;
    wins: number;
    losses: number;
    draws: number;
    covers: Set<string>;
  };
  const rows = new Map<string, Acc>();
  const slot = (seasonId: string, teamId: string | null, teamName?: string) => {
    const key = JSON.stringify([seasonId, teamId ?? `name:${teamName}`]);
    let row = rows.get(key);
    if (!row) {
      row = {
        seasonId,
        teamId,
        teamName,
        tenures: [],
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        covers: new Set(),
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const a of input.appearances) {
    if (a.games <= 0) continue;
    const row = slot(a.seasonId, a.teamId);
    row.games += a.games;
    row.wins += a.seriesWins;
    row.losses += a.seriesLosses;
    row.draws += a.seriesDraws;
  }
  for (const c of input.covers) {
    slot(c.seasonId, c.teamId).covers.add(c.matchId);
  }
  for (const t of input.tenures) {
    const key = JSON.stringify([t.seasonId, t.teamId ?? `name:${t.teamName}`]);
    const voided =
      (t.endReason !== null && VOID_TENURE_ENDS.has(t.endReason)) ||
      t.teamId === null;
    // A voided tenure only adds detail to a row that exists for another
    // reason; it never creates one.
    if (voided && !rows.has(key)) continue;
    const row = slot(t.seasonId, t.teamId, t.teamName);
    row.teamName ??= t.teamName;
    row.tenures.push(t);
  }

  const out: { row: ProfileSeasonRow; order: number; createdAt: number }[] =
    [];
  for (const [key, row] of rows) {
    const season = input.seasons.get(row.seasonId);
    const teamName =
      (row.teamId ? input.teamNames.get(row.teamId) : undefined) ??
      row.teamName;
    if (!season || teamName === undefined) continue;
    const tenures = [...row.tenures].sort(
      (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
    );
    const onRosterAtEnd = tenures.some((t) => t.active);
    const champion =
      row.teamId !== null &&
      input.champions.get(row.seasonId) === row.teamId &&
      (row.games > 0 || row.covers.size > 0 || onRosterAtEnd);
    out.push({
      row: {
        key,
        seasonId: row.seasonId,
        seasonName: season.name,
        teamId: row.teamId,
        teamName,
        role: roleOf(tenures),
        games: row.games,
        series:
          row.wins + row.losses + row.draws > 0
            ? { wins: row.wins, losses: row.losses, draws: row.draws }
            : null,
        stoodIn: row.covers.size,
        champion,
      },
      // Within a season: the roster team first, then most games played.
      order: onRosterAtEnd ? 0 : tenures.length > 0 ? 1 : 2,
      createdAt: season.createdAt.getTime(),
    });
  }
  return out
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        a.row.seasonId.localeCompare(b.row.seasonId) ||
        a.order - b.order ||
        b.row.games - a.row.games ||
        a.row.teamName.localeCompare(b.row.teamName),
    )
    .map(({ row }) => row);
}

/**
 * How they joined, in a player's words. A captain is "Captain"; otherwise the
 * original arrival decides: an auction purchase is "Drafted for $X", a signing
 * is a free agent. Older (captured) records only prove today's roster price,
 * which for a non-captain above $0 can only be an auction price; a $0 older
 * record stays unlabelled rather than guessed.
 */
function roleOf(
  tenures: readonly {
    acquisitionKind: string;
    price: number;
    captain: boolean | null;
  }[],
): ProfileSeasonRole | null {
  if (tenures.length === 0) return null;
  if (tenures.some((t) => t.captain === true)) return { kind: "captain" };
  const first = tenures[0];
  switch (first.acquisitionKind) {
    case "CAPTAIN_DESIGNATION":
      // Designated captain, later handed the armband to someone else.
      return first.captain === false ? null : { kind: "captain" };
    case "AUCTION":
      return { kind: "drafted", price: first.price };
    case "FREE_AGENT":
      return { kind: "free-agent" };
    default:
      return first.price > 0 ? { kind: "drafted", price: first.price } : null;
  }
}

/** "Drafted for $12", "Signed as a free agent", "Stood in for 2 matches".
 *  A captain's row carries a Captain badge instead, so it isn't repeated. */
export function profileSeasonNote(row: ProfileSeasonRow): string | null {
  const parts: string[] = [];
  if (row.role?.kind === "drafted")
    parts.push(`Drafted for $${row.role.price}`);
  else if (row.role?.kind === "free-agent") parts.push("Signed as a free agent");
  if (row.stoodIn > 0) {
    parts.push(
      `Stood in for ${row.stoodIn} match${row.stoodIn === 1 ? "" : "es"}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * "2W 0D 1L series · 5 games" (either half omitted when there is none). The
 * record is written the way the standings and team pages write it
 * (seriesRecordText), so a bare middle number never means losses here and
 * draws there.
 */
export function profileSeasonRecord(row: ProfileSeasonRow): string | null {
  const parts: string[] = [];
  if (row.series) parts.push(`${seriesRecordText(row.series)} series`);
  if (row.games > 0) parts.push(`${row.games} game${row.games === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
