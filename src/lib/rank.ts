// Decode OpenDota's `rank_tier` (tens digit = medal, ones digit = stars) into a
// Dota 2 ranked medal. Pure so it can be unit-tested and used on the client.

export const RANK_MEDALS = [
  "Unranked",
  "Herald",
  "Guardian",
  "Crusader",
  "Archon",
  "Legend",
  "Ancient",
  "Divine",
  "Immortal",
] as const;

// The common MMR ladder: ~154 per star, 5 stars (~770) per medal, Immortal
// above 5620. Shared by approxRankTierFromMmr and its inverse
// (mmrRangeForRankTier) so the two mappings can never drift apart.
export const STAR_MMR = 154;
export const MEDAL_MMR = STAR_MMR * 5; // 770
export const IMMORTAL_MMR_FLOOR = 5620;

// How far outside a medal's exact star band a claimed MMR may sit before we
// stop believing it: a full medal each way. Medals lag behind live MMR and
// the star→MMR ladder shifts by patch, so the "possible" range must stay
// generous — the clamp exists to catch gross misclaims, not honest drift.
export const MMR_MEDAL_TOLERANCE = MEDAL_MMR;

/**
 * Approximate a `rank_tier` from an MMR number, using the common ladder of
 * ~154 MMR per star / ~770 per medal (Immortal above 5620). Dota's true
 * mapping shifts by patch — this is for demo/seed data and rough displays;
 * real accounts get their actual tier from OpenDota.
 */
export function approxRankTierFromMmr(mmr: number): number {
  if (mmr >= IMMORTAL_MMR_FLOOR) return 80;
  const clamped = Math.max(0, mmr);
  const medal = Math.min(7, Math.floor(clamped / MEDAL_MMR) + 1);
  // Stars from the position inside the (clamped) medal's band, so the value
  // stays monotonic even where Divine stretches past the uniform band width.
  const withinBand = clamped - (medal - 1) * MEDAL_MMR;
  const stars = Math.min(5, Math.floor(withinBand / STAR_MMR) + 1);
  return medal * 10 + stars;
}

/** Plausible MMR window for a medal; `max: null` = open-ended (Immortal). */
export type MmrRange = { min: number; max: number | null };

/**
 * The wide range of MMRs a player holding this OpenDota medal could
 * plausibly have: the medal's exact star band (the inverse of
 * `approxRankTierFromMmr`) widened by `MMR_MEDAL_TOLERANCE` on both sides.
 * Returns null when the tier is missing/unranked — no medal, no opinion.
 */
export function mmrRangeForRankTier(
  rankTier: number | null | undefined,
): MmrRange | null {
  const medal = rankMedalTier(rankTier);
  if (medal === 0) return null;
  if (medal === 8) {
    return { min: Math.max(0, IMMORTAL_MMR_FLOOR - MMR_MEDAL_TOLERANCE), max: null };
  }
  const stars = rankStars(rankTier);
  // A starless tier (malformed, e.g. 46) still names a medal — fall back to
  // the whole medal's band rather than refusing to validate.
  const bandMin = (medal - 1) * MEDAL_MMR + (stars ? (stars - 1) * STAR_MMR : 0);
  // Divine's band stretches to the Immortal floor (wider than 5 uniform
  // stars); everywhere else a star is exactly STAR_MMR wide.
  const bandMax =
    medal === 7 && (stars === 5 || stars === 0)
      ? IMMORTAL_MMR_FLOOR - 1
      : stars
        ? bandMin + STAR_MMR - 1
        : medal * MEDAL_MMR - 1;
  return {
    min: Math.max(0, bandMin - MMR_MEDAL_TOLERANCE),
    max: bandMax + MMR_MEDAL_TOLERANCE,
  };
}

/**
 * The EXACT star-band floor for a medal — no tolerance. This is the least
 * MMR the medal can honestly represent, used to judge eligibility (a Divine 5
 * is a 5K+ player no matter what they type); the tolerance-widened range
 * above is for validating claims, not for eligibility. Null without a medal.
 */
export function rankTierExactMinMmr(
  rankTier: number | null | undefined,
): number | null {
  const medal = rankMedalTier(rankTier);
  if (medal === 0) return null;
  if (medal === 8) return IMMORTAL_MMR_FLOOR;
  const stars = rankStars(rankTier);
  return (medal - 1) * MEDAL_MMR + (stars ? (stars - 1) * STAR_MMR : 0);
}

export type MmrClampResult = {
  /** The MMR to store: unchanged when plausible, the range floor when not. */
  mmr: number;
  /** True when the claimed value was replaced. */
  adjusted: boolean;
  /** The medal's plausible window, null when the player has no medal. */
  range: MmrRange | null;
};

/**
 * Validate a claimed MMR against the player's OpenDota medal: anything
 * outside the medal's plausible window — a blank/0 claim included, since the
 * medal proves they're ranked — snaps to the LOWEST point of the range, a
 * conservative estimate that can never inflate anyone. No medal = no clamp:
 * the typed value stands.
 */
export function clampMmrToRank(
  mmr: number,
  rankTier: number | null | undefined,
): MmrClampResult {
  const range = mmrRangeForRankTier(rankTier);
  if (!range) return { mmr, adjusted: false, range: null };
  const within = mmr >= range.min && (range.max === null || mmr <= range.max);
  if (within) return { mmr, adjusted: false, range };
  return { mmr: range.min, adjusted: true, range };
}

/** Hint copy for an MmrRange: "2772–4465", or "4850+" when open-ended. */
export function formatMmrRange(range: MmrRange): string {
  return range.max === null ? `${range.min}+` : `${range.min}–${range.max}`;
}

/** Medal index 0–8 (0 = Unranked/unknown). */
export function rankMedalTier(rankTier: number | null | undefined): number {
  if (!rankTier || rankTier < 10) return 0;
  const medal = Math.floor(rankTier / 10);
  return medal >= 1 && medal <= 8 ? medal : 0;
}

/** Star count 0–5 within a medal (Immortal has none). */
export function rankStars(rankTier: number | null | undefined): number {
  if (!rankTier) return 0;
  const stars = rankTier % 10;
  return stars >= 1 && stars <= 5 ? stars : 0;
}

/** Human medal name, e.g. 55 -> "Legend 5", 80 -> "Immortal", null -> "Unranked". */
export function rankMedalName(rankTier: number | null | undefined): string {
  const tier = rankMedalTier(rankTier);
  if (tier === 0) return "Unranked";
  if (tier === 8) return "Immortal";
  const stars = rankStars(rankTier);
  return stars ? `${RANK_MEDALS[tier]} ${stars}` : RANK_MEDALS[tier];
}
