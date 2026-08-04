import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import { slotRound } from "./schedule";

type ChampionSeason = {
  status: string;
  championTeamId: string | null;
};

type ChampionMatch = {
  id: string;
  phase: string;
  bracketSlot: string | null;
  status: string;
  winnerTeamId: string | null;
  homeTeamId: string;
  awayTeamId: string;
};

export type ChampionPresentation = {
  /** The only team public surfaces may label as champion. */
  championTeamId: string | null;
  /** Distinguishes a champion-only legacy archive from a broken saved bracket. */
  hasPostseason: boolean;
  /** Why a champion is visible, when one is authoritative. */
  source: "legacy" | "final" | null;
  /** The saved series that proved the title; null for champion-only archives. */
  authoritativeFinalId: string | null;
  /** COMPLETE-only integrity state for recovery messaging. */
  issue: "missing" | "inconsistent" | null;
};

/**
 * Resolve the champion that public pages may safely present.
 *
 * Older imported seasons can legitimately have a recorded champion without
 * saved playoff fixtures, so the season record remains authoritative there.
 * Once postseason rows exist, however, the bracket is the source of truth: its
 * sole latest series must be a completed grand final whose recorded winner is
 * one of its participants and matches Season.championTeamId.
 */
export function resolveChampionPresentation(
  season: ChampionSeason,
  matches: ChampionMatch[],
): ChampionPresentation {
  const postseason = matches.filter(
    (match) => match.phase !== MATCH_PHASE.REGULAR,
  );
  const hasPostseason = postseason.length > 0;

  // A title is an outcome of a completed season. A stale champion id must not
  // light up a bracket or badge while an earlier league phase is active.
  if (season.status !== SEASON_STATUS.COMPLETE) {
    return {
      championTeamId: null,
      hasPostseason,
      source: null,
      authoritativeFinalId: null,
      issue: null,
    };
  }

  if (!season.championTeamId) {
    return {
      championTeamId: null,
      hasPostseason,
      source: null,
      authoritativeFinalId: null,
      issue: "missing",
    };
  }

  if (!hasPostseason) {
    return {
      championTeamId: season.championTeamId,
      hasPostseason: false,
      source: "legacy",
      authoritativeFinalId: null,
      issue: null,
    };
  }

  const latestRound = Math.max(
    ...postseason.map((match) => slotRound(match.bracketSlot)),
  );
  const latest = postseason.filter(
    (match) => slotRound(match.bracketSlot) === latestRound,
  );
  const final =
    latest.length === 1 && latest[0]?.phase === MATCH_PHASE.FINAL
      ? latest[0]
      : null;
  if (
    !final ||
    final.status !== MATCH_STATUS.COMPLETED ||
    final.winnerTeamId !== season.championTeamId ||
    (season.championTeamId !== final.homeTeamId &&
      season.championTeamId !== final.awayTeamId)
  ) {
    return {
      championTeamId: null,
      hasPostseason: true,
      source: null,
      authoritativeFinalId: null,
      issue: "inconsistent",
    };
  }

  return {
    championTeamId: season.championTeamId,
    hasPostseason: true,
    source: "final",
    authoritativeFinalId: final.id,
    issue: null,
  };
}
