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

// The accepted MMR ladder (Dota 2 wiki / rank guides, stable for years):
// 154 per star and 770 per medal from Herald through Ancient, then Divine's
// five stars are 200 each (4620/4820/5020/5220/5420), and Immortal starts at
// 5620. Shared by approxRankTierFromMmr and its inverse (mmrRangeForRankTier)
// so the two mappings can never drift apart.
export const STAR_MMR = 154;
export const MEDAL_MMR = STAR_MMR * 5; // 770
export const DIVINE_STAR_MMR = 200;
export const IMMORTAL_MMR_FLOOR = 5620;

// The widest a medal's plausible-MMR window may ever be. Each star's exact
// band is padded symmetrically up to this cap — enough slack for medals that
// lag behind live MMR, tight enough that a claim a whole medal away from the
// badge is called out.
export const MMR_WINDOW_MAX = 1000;

/** Symmetric padding that grows a band of `width` MMR to MMR_WINDOW_MAX. */
function windowPad(width: number): number {
  return Math.max(0, Math.floor((MMR_WINDOW_MAX - width) / 2));
}

/** Width of one star's exact band inside a medal. */
function starWidth(medal: number): number {
  return medal === 7 ? DIVINE_STAR_MMR : STAR_MMR;
}

/**
 * Approximate a `rank_tier` from an MMR number using the ladder above.
 * Dota's true mapping shifts by patch — this is for demo/seed data and rough
 * displays; real accounts get their actual tier from OpenDota.
 */
export function approxRankTierFromMmr(mmr: number): number {
  if (mmr >= IMMORTAL_MMR_FLOOR) return 80;
  const clamped = Math.max(0, mmr);
  const medal = Math.min(7, Math.floor(clamped / MEDAL_MMR) + 1);
  // Stars from the position inside the (clamped) medal's band — Divine's
  // band runs to the Immortal floor with wider (200) stars.
  const withinBand = clamped - (medal - 1) * MEDAL_MMR;
  const stars = Math.min(5, Math.floor(withinBand / starWidth(medal)) + 1);
  return medal * 10 + stars;
}

/** Plausible MMR window for a medal; `max: null` = open-ended (Immortal). */
export type MmrRange = { min: number; max: number | null };

/**
 * The range of MMRs a player holding this OpenDota medal could plausibly
 * have: the medal's exact star band (the inverse of `approxRankTierFromMmr`)
 * padded symmetrically up to `MMR_WINDOW_MAX` — never wider than 1000 MMR.
 * Returns null when the tier is missing/unranked — no medal, no opinion.
 */
export function mmrRangeForRankTier(
  rankTier: number | null | undefined,
): MmrRange | null {
  const medal = rankMedalTier(rankTier);
  if (medal === 0) return null;
  if (medal === 8) {
    // Open-ended above; below the floor, allow the same slack a Divine star
    // gets — an Immortal claiming less than that is sandbagging.
    return {
      min: Math.max(0, IMMORTAL_MMR_FLOOR - windowPad(DIVINE_STAR_MMR)),
      max: null,
    };
  }
  const stars = rankStars(rankTier);
  // A starless tier (malformed, e.g. 46) still names a medal — fall back to
  // the whole medal's band rather than refusing to validate. Divine's medal
  // band runs to the Immortal floor.
  const bandMin =
    (medal - 1) * MEDAL_MMR + (stars ? (stars - 1) * starWidth(medal) : 0);
  const bandMax = stars
    ? bandMin + starWidth(medal) - 1
    : (medal === 7 ? IMMORTAL_MMR_FLOOR : medal * MEDAL_MMR) - 1;
  const pad = windowPad(bandMax - bandMin + 1);
  return {
    min: Math.max(0, bandMin - pad),
    max: bandMax + pad,
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
  return (medal - 1) * MEDAL_MMR + (stars ? (stars - 1) * starWidth(medal) : 0);
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

/** Hint copy for an MmrRange: "3119–4118", or "5220+" when open-ended. */
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
