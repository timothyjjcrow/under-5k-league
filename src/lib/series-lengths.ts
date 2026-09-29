import { MATCH_PHASE } from "./constants";

/**
 * The admin's three series-length settings and the fixtures each one governs.
 * TIEBREAKER fixtures are absent on purpose: their Bo1/Bo3 comes from the
 * tiebreaker format, never from these settings.
 */
export const SERIES_LENGTH_PHASES = [
  { phase: MATCH_PHASE.REGULAR, field: "regularBestOf" },
  { phase: MATCH_PHASE.PLAYOFF, field: "playoffBestOf" },
  { phase: MATCH_PHASE.FINAL, field: "finalBestOf" },
] as const;

export type SeriesLengthPhase = (typeof SERIES_LENGTH_PHASES)[number]["phase"];

export type SeriesLengths = Record<
  (typeof SERIES_LENGTH_PHASES)[number]["field"],
  number
>;

/** What saving the settings did to one phase's existing fixtures. */
export type SeriesLengthSync = {
  phase: SeriesLengthPhase;
  bestOf: number;
  /** Fixtures not yet started, now at `bestOf`. */
  updated: number;
  /** Fixtures under way (a game or score, no result yet) left at their old length. */
  underWay: number;
};

function fixtures(phase: SeriesLengthPhase, count: number): string {
  if (phase === MATCH_PHASE.FINAL) {
    return count === 1 ? "the grand final" : `${count} grand finals`;
  }
  const noun =
    phase === MATCH_PHASE.REGULAR ? "regular-season match" : "playoff match";
  return count === 1 ? `1 ${noun}` : `${count} ${noun}es`;
}

/**
 * The toast's report of existing fixtures: which ones the save moved to the
 * new length, and which it left because they are already being played.
 * Completed fixtures always keep their length and go unmentioned.
 */
export function seriesLengthSyncNote(syncs: SeriesLengthSync[]): string {
  const parts: string[] = [];
  for (const sync of syncs) {
    if (sync.updated > 0) {
      parts.push(
        `${fixtures(sync.phase, sync.updated)} ${sync.updated === 1 ? "is" : "are"} now Bo${sync.bestOf}`,
      );
    }
  }
  for (const sync of syncs) {
    if (sync.underWay > 0) {
      parts.push(
        sync.underWay === 1
          ? `${fixtures(sync.phase, 1)} is already under way and keeps its length`
          : `${fixtures(sync.phase, sync.underWay)} are already under way and keep their length`,
      );
    }
  }
  return parts.map((part) => ` · ${part}`).join("");
}
