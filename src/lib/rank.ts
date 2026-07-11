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

/**
 * Approximate a `rank_tier` from an MMR number, using the common ladder of
 * ~154 MMR per star / ~770 per medal (Immortal above 5620). Dota's true
 * mapping shifts by patch — this is for demo/seed data and rough displays;
 * real accounts get their actual tier from OpenDota.
 */
export function approxRankTierFromMmr(mmr: number): number {
  if (mmr >= 5620) return 80;
  const clamped = Math.max(0, mmr);
  const medal = Math.min(7, Math.floor(clamped / 770) + 1);
  // Stars from the position inside the (clamped) medal's band, so the value
  // stays monotonic even where Divine stretches past the uniform band width.
  const withinBand = clamped - (medal - 1) * 770;
  const stars = Math.min(5, Math.floor(withinBand / 154) + 1);
  return medal * 10 + stars;
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
