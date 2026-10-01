// What Home says about the next season while the league rests in Season
// complete: the signup date an admin set on /admin's Season handoff card, or
// "coming soon" when there is none. Pure; the action and Home read the
// Setting row and hand its raw value here.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead a next-season date may be set: a year and a day. */
export const NEXT_SEASON_MAX_LEAD_DAYS = 366;

/**
 * The saved plan. It lives in one Setting row (SETTING_KEYS.NEXT_SEASON_PLAN)
 * rather than on Season because there is no next Season row until the
 * handoff creates it. It names the COMPLETE season it was set during, so it
 * lapses by itself when "Open signups" opens the next season (createSeason
 * never has to clear it), and a save that races the handoff lands on the old
 * season's id, where nothing shows it.
 *
 * Display only: nothing reads it to open signups, post to Discord or wake the
 * automation worker. Opening the season stays the admin's button.
 */
export type NextSeasonPlan = {
  /** The COMPLETE season the date was set during. */
  seasonId: string;
  /** When the admin plans to open the next season's signups. */
  signupsAtMs: number;
};

export function serializeNextSeasonPlan(plan: NextSeasonPlan): string {
  return JSON.stringify({
    seasonId: plan.seasonId,
    signupsAt: new Date(plan.signupsAtMs).toISOString(),
  });
}

/**
 * The plan for the active season, or null: nothing saved, a value that
 * doesn't parse, or one saved during another season (the handoff has
 * happened since, or the season it named was deleted).
 */
export function parseNextSeasonPlan(
  raw: string | null | undefined,
  activeSeasonId: string | null | undefined,
): NextSeasonPlan | null {
  if (!raw || !activeSeasonId) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { seasonId, signupsAt } = value as Record<string, unknown>;
  if (typeof seasonId !== "string" || seasonId !== activeSeasonId) return null;
  if (typeof signupsAt !== "string") return null;
  const signupsAtMs = Date.parse(signupsAt);
  if (!Number.isFinite(signupsAtMs)) return null;
  return { seasonId, signupsAtMs };
}

/**
 * Why a submitted date can't be saved, or null when it can. A date already
 * past would print on Home as a plan that has slipped the moment it is saved,
 * and one more than a year out is almost certainly a typo in the year.
 */
export function nextSeasonDateProblem(
  whenMs: number,
  nowMs: number,
): string | null {
  if (!Number.isFinite(whenMs) || whenMs <= nowMs) {
    return "Pick a time in the future: Home shows it as when the next season's signups open.";
  }
  if (whenMs - nowMs > NEXT_SEASON_MAX_LEAD_DAYS * DAY_MS) {
    return "Pick a date within the next year.";
  }
  return null;
}
