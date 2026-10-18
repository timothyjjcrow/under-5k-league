// An admin's inhouse MMR and medal for any player, signed up for the league
// or not (Tim, 2026-10-17). Pure: the form's rules and the words the admin
// sees. The write is saveInhouseRating (inhouse-rating-service.ts), the page
// /admin/inhouse-players, and the join that uses the MMR is joinQueue
// (inhouseFixedMmr in inhouse-mmr-cap.ts).

import { HARD_MMR_CEILING } from "./constants";
import { INHOUSE_ADMIN_MMR_MAX, inhouseFixedMmr } from "./inhouse-mmr-cap";
import { isEditableRankTier, rankMedalName } from "./rank";
import { medalProvesIneligible } from "./registration";

/** A player's inhouse rating as stored, or as the editor drew it. */
export type InhouseRating = {
  /** User.inhouseMmr: an admin's number, null = none. */
  mmr: number | null;
  /** User.rankTier: null = Unranked or unknown. */
  rankTier: number | null;
  /** User.rankTierManual: an admin's medal, kept over OpenDota's. */
  manual: boolean;
};

/** One save from the editor. */
export type InhouseRatingInput = {
  userId: string;
  /** The admin's inhouse MMR; null clears it. */
  mmr: number | null;
  /** An admin's medal (null = Unranked), or back to OpenDota's. */
  medal: { manual: true; rankTier: number | null } | { manual: false };
  /** What the editor showed, so a save over a newer change is refused. */
  expected: InhouseRating;
};

/** A fixed locale, so a message reads "5,000" on every server. */
const MMR_FORMAT = new Intl.NumberFormat("en-US");

const RELOAD = "Reload the page and try again.";

/** A whole decimal number from a form field, else NaN ("3e3", "3.5" too). */
function wholeNumber(raw: FormDataEntryValue | null): number {
  const text = typeof raw === "string" ? raw.trim() : "";
  return /^\d+$/.test(text) ? Number(text) : NaN;
}

/**
 * Read the editor's form. The MMR is blank (no admin number: the league
 * signup's, or what the player types, decides again) or a whole number from
 * 1 to INHOUSE_ADMIN_MMR_MAX. Over the inhouse cap is allowed on purpose:
 * it is how an admin says a player is too strong to queue, and joinQueue
 * refuses them by the cap's own words. The medal is a manual correction
 * (0 = Unranked) or OpenDota's.
 */
export function parseInhouseRatingForm(
  form: FormData,
): { ok: true; input: InhouseRatingInput } | { ok: false; error: string } {
  const userId = form.get("userId");
  if (typeof userId !== "string" || userId.trim() === "") {
    return { ok: false, error: "Choose a player." };
  }
  const rawMmr = form.get("mmr");
  let mmr: number | null = null;
  if (typeof rawMmr === "string" && rawMmr.trim() !== "") {
    const value = wholeNumber(rawMmr);
    if (!(value >= 1 && value <= INHOUSE_ADMIN_MMR_MAX)) {
      return {
        ok: false,
        error: `Enter a whole-number MMR from 1 to ${MMR_FORMAT.format(INHOUSE_ADMIN_MMR_MAX)}, or leave it blank.`,
      };
    }
    mmr = value;
  }
  const mode = form.get("medalMode");
  if (mode !== "manual" && mode !== "automatic") {
    return { ok: false, error: "Choose a medal source." };
  }
  let medal: InhouseRatingInput["medal"] = { manual: false };
  if (mode === "manual") {
    const rankTier = wholeNumber(form.get("rankTier"));
    if (!isEditableRankTier(rankTier)) {
      return { ok: false, error: "Choose a valid medal and star level." };
    }
    medal = { manual: true, rankTier: rankTier || null };
  }
  // The editor's hidden snapshot: the admin MMR ("" = none), the medal
  // (0 = none) and whether it was an admin's.
  const rawExpectedMmr = form.get("expectedMmr");
  const expectedMmr =
    rawExpectedMmr === "" ? null : wholeNumber(rawExpectedMmr);
  const expectedRankTier = wholeNumber(form.get("expectedRankTier"));
  const expectedManual = form.get("expectedRankTierManual");
  if (
    (expectedMmr !== null && !Number.isSafeInteger(expectedMmr)) ||
    !Number.isSafeInteger(expectedRankTier) ||
    (expectedManual !== "0" && expectedManual !== "1")
  ) {
    return { ok: false, error: RELOAD };
  }
  return {
    ok: true,
    input: {
      userId: userId.trim(),
      mmr,
      medal,
      expected: {
        mmr: expectedMmr,
        rankTier: expectedRankTier || null,
        manual: expectedManual === "1",
      },
    },
  };
}

/** The editor's snapshot still describes the stored rating. */
export function sameInhouseRating(
  stored: InhouseRating,
  expected: InhouseRating,
): boolean {
  return (
    stored.mmr === expected.mmr &&
    (stored.rankTier ?? 0) === (expected.rankTier ?? 0) &&
    stored.manual === expected.manual
  );
}

/** The refusal when the rating changed under an open editor. */
export const INHOUSE_RATING_CHANGED =
  "This player's medal or inhouse MMR just changed. Reload the page and try again.";

/** Whether the inhouse cap turns this rating away at the queue. */
export function overInhouseCap(rating: Pick<InhouseRating, "mmr" | "rankTier">): boolean {
  return (
    (rating.mmr !== null && rating.mmr > HARD_MMR_CEILING) ||
    medalProvesIneligible(rating.rankTier)
  );
}

function medalText({ rankTier, manual }: InhouseRating): string {
  return `${rankMedalName(rankTier)} medal (${manual ? "manual" : "from OpenDota"})`;
}

/**
 * The admin's toast after a save: what is stored now, and when it counts.
 * A set MMR rewrites the player's queue spot at once; a cleared one leaves
 * the spot as it is until their next join, which can't know what they would
 * have typed.
 */
export function inhouseRatingSavedMessage({
  name,
  before,
  after,
  queued,
}: {
  name: string;
  before: InhouseRating;
  after: InhouseRating;
  /** They are in the queue now (the save rewrote a set MMR into it). */
  queued: boolean;
}): string {
  const mmr =
    after.mmr !== null
      ? `inhouse MMR ${MMR_FORMAT.format(after.mmr)}${queued ? ", their queue spot too" : " from their next join"}`
      : before.mmr !== null
        ? "inhouse MMR cleared from their next join"
        : "no inhouse MMR set";
  const cap = overInhouseCap(after)
    ? queued
      ? ` Over the ${MMR_FORMAT.format(HARD_MMR_CEILING)} cap: they stay queued until you remove them, then can't join again.`
      : ` Over the ${MMR_FORMAT.format(HARD_MMR_CEILING)} cap: they can't join the queue.`
    : "";
  return `${name}: ${mmr} · ${medalText(after)}.${cap}`;
}

/** The admin log's line for a save. */
export function inhouseRatingLogSummary({
  name,
  before,
  after,
}: {
  name: string;
  before: InhouseRating;
  after: InhouseRating;
}): string {
  const mmr = (value: number | null) =>
    value === null ? "none" : MMR_FORMAT.format(value);
  return `Set ${name}'s inhouse MMR ${mmr(before.mmr)} → ${mmr(after.mmr)}; ${medalText(before)} → ${medalText(after)}`;
}

/**
 * What a player's next queue join uses, in words for the admin's list: the
 * admin's number, the league signup's, or whatever they type (with the last
 * game's number, when they played one, for scale).
 */
export function inhouseMmrStanding({
  adminMmr,
  signupMmr,
  lastGameMmr,
}: {
  adminMmr: number | null;
  /** The newest league signup's MMR, 0 = none. */
  signupMmr: number;
  /** Their latest inhouse game's MMR, null = none. */
  lastGameMmr: number | null;
}): { mmr: number | null; source: string } {
  const fixed = inhouseFixedMmr({ adminMmr, signupMmr });
  if (fixed) {
    return {
      mmr: fixed.mmr,
      source: fixed.source === "admin" ? "set by an admin" : "from their league signup",
    };
  }
  return {
    mmr: null,
    source:
      lastGameMmr !== null
        ? `typed at each join (last game ${MMR_FORMAT.format(lastGameMmr)})`
        : "typed at each join",
  };
}
