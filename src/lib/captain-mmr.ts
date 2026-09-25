import { clampMmrToRank, formatMmrRange, rankMedalName } from "./rank";

/**
 * Is the MMR that weights a captain's draft budget backed by anything the
 * captain did not simply type?
 *
 * `mmrWeightedBudgets` moves up to ±`budgetMmrWeight`% of the base budget on
 * captain MMR alone, and the signup clamp (`clampMmrToRank`) only checks a
 * claim when the player HAS a medal. A captain with no visible medal is never
 * checked at all, so typing low buys a bigger budget; and a stored MMR can sit
 * outside the medal window when the medal arrived or changed after signup (an
 * unchanged resubmit is never re-clamped, on purpose). Nothing here blocks:
 * warn-and-name, never hard-block on third-party data. The admin panel names
 * these captains on their row, in the Start-draft confirm and in the next-step
 * banner, and the admin decides.
 *
 * Two states, not three. An "admin-set" state (an admin override after the
 * player's last self-edit) was considered and dropped because nothing records
 * it reliably without a schema change: Registration has no updatedAt, a
 * player's /me edit leaves no trace at all, and the override's AdminAction
 * row is best-effort and names the player only by their mutable display name
 * (no registration or user id). What DOES leave a durable trace is a medal:
 * "Manual correction" in Edit medal & MMR (`setPlayerRank`, the only writer of
 * `User.rankTierManual`) stores an admin-chosen medal, and from then on the
 * MMR is checked against that medal exactly like an OpenDota one. So an admin
 * confirms a captain by saving a medal that matches the MMR, and the flag
 * clears for as long as the two agree.
 */
export type CaptainMmrStatus = "medal-backed" | "unverified";

/**
 * Why a captain's MMR is unverified, most specific first:
 * - `unknown`: stored 0. `mmrWeightedBudgets` gives an unknown captain the
 *   flat base budget, which is neutral for a mid-pool captain but a windfall
 *   for one who really sits at the top of the pool, and a blank field is the
 *   easiest claim there is. So unknown is flagged, not exempt. It is checked
 *   before the medal on purpose: a Herald 1-3 window is padded down to 0, so a
 *   0 there reads "inside the window" while the budget still treats it as
 *   unknown.
 * - `no-medal`: no medal on record, so nothing ever checked the number.
 * - `outside-range`: a medal exists but the MMR is outside its plausible
 *   window (the same window the signup clamp uses).
 */
export type CaptainMmrProblem = "unknown" | "no-medal" | "outside-range";

export type CaptainMmrCheck =
  | { status: "medal-backed" }
  | { status: "unverified"; problem: CaptainMmrProblem };

export function classifyCaptainMmr(captain: {
  mmr: number;
  rankTier: number | null | undefined;
}): CaptainMmrCheck {
  if (!Number.isFinite(captain.mmr) || captain.mmr <= 0) {
    return { status: "unverified", problem: "unknown" };
  }
  const clamp = clampMmrToRank(captain.mmr, captain.rankTier);
  if (!clamp.range) return { status: "unverified", problem: "no-medal" };
  if (clamp.adjusted) return { status: "unverified", problem: "outside-range" };
  return { status: "medal-backed" };
}

export type CaptainMmrInput = {
  teamId: string;
  name: string;
  /** The captain's ACTIVE PLAYER registration MMR; 0 = unknown / no row. */
  mmr: number;
  rankTier: number | null | undefined;
};

export type UnverifiedCaptainMmr = {
  teamId: string;
  name: string;
  problem: CaptainMmrProblem;
  /** One line for the captain's row on the Captains & draft card. */
  reason: string;
  /** A few words for the Start-draft confirm, where every captain shares a line. */
  short: string;
};

/**
 * The captains whose unverified MMR will move money at Start, in the order
 * given. Empty when the weighting is off: at a zero (or non-finite) weight
 * `mmrWeightedBudgets` hands everyone the flat base, so MMR moves no money
 * and there is nothing worth verifying. Same sanitisation as that function.
 */
export function unverifiedCaptainMmrs(
  budgetMmrWeight: number,
  captains: readonly CaptainMmrInput[],
): UnverifiedCaptainMmr[] {
  if (!Number.isFinite(budgetMmrWeight) || budgetMmrWeight <= 0) return [];
  const out: UnverifiedCaptainMmr[] = [];
  for (const c of captains) {
    const check = classifyCaptainMmr(c);
    if (check.status !== "unverified") continue;
    out.push({
      teamId: c.teamId,
      name: c.name,
      problem: check.problem,
      ...captainMmrCopy(check.problem, c),
    });
  }
  return out;
}

function captainMmrCopy(
  problem: CaptainMmrProblem,
  c: CaptainMmrInput,
): { reason: string; short: string } {
  if (problem === "unknown") {
    return {
      reason:
        "No MMR on file, so they get the flat base budget whatever their skill.",
      short: "no MMR on file",
    };
  }
  if (problem === "no-medal") {
    return {
      reason: `No medal on record to check ${c.mmr} MMR against.`,
      short: "no medal",
    };
  }
  const medal = rankMedalName(c.rankTier);
  const range = clampMmrToRank(c.mmr, c.rankTier).range;
  return {
    reason:
      `${c.mmr} MMR is outside their ${medal} medal's range` +
      (range ? ` (${formatMmrRange(range)}).` : "."),
    short: `outside the ${medal} range`,
  };
}

/** "A, B, C +2 more": the cap keeps a confirm dialog a dialog. */
export function captainNameRun(names: readonly string[]): string {
  const shown = names.slice(0, 6);
  return (
    shown.join(", ") +
    (names.length > shown.length ? ` +${names.length - shown.length} more` : "")
  );
}

/**
 * The line appended to the Start-draft confirm. House rule: a consequential
 * confirm states the real facts BEFORE the click, and Start is where these
 * numbers turn into money (budgets are fixed from then on; Abort draft is the
 * way back). Names each unverified captain with the short reason, points at
 * the control that fixes it, and says plainly that starting anyway is
 * allowed. Empty string when there is nothing to warn about, so the confirm
 * is byte-identical to what shipped before this existed.
 */
export function captainMmrWarning(
  unverified: readonly UnverifiedCaptainMmr[],
): string {
  if (unverified.length === 0) return "";
  const list = captainNameRun(unverified.map((c) => `${c.name} (${c.short})`));
  return (
    ` Unverified captain MMR sets draft budgets: ${list}.` +
    " Cancel and check each with Edit medal & MMR first; a medal that matches the MMR marks it verified." +
    " Starting anyway is allowed."
  );
}
