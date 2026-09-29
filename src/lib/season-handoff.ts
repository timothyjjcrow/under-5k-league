// What a new season inherits from the one before it, and how the admin panel
// describes that before the click. Pure, so the carried line and the action
// that writes it can never disagree about a value.

import type { Season } from "@prisma/client";
import { SOFT_MMR_LIMIT } from "./constants";

/**
 * Every league setting a new season copies from the season before it. The
 * series lengths and the Valve league id used to reset to the defaults
 * silently (Bo2/Bo3/Bo5, no league id) while the draft settings carried, so a
 * league that had customised them lost them at every handoff with no warning.
 * Each is still changed afterwards in the new season's phase and league-id
 * cards; the handoff form only states them.
 */
export type CarriedSeasonSettings = Pick<
  Season,
  | "teamSize"
  | "minTeams"
  | "draftBudget"
  | "budgetMmrWeight"
  | "maxMmr"
  | "regularBestOf"
  | "playoffBestOf"
  | "finalBestOf"
  | "dotaLeagueId"
>;

/** The select that reads exactly the carried settings off a Season row. */
export const CARRIED_SEASON_SELECT = {
  teamSize: true,
  minTeams: true,
  draftBudget: true,
  budgetMmrWeight: true,
  maxMmr: true,
  regularBestOf: true,
  playoffBestOf: true,
  finalBestOf: true,
  dotaLeagueId: true,
} as const satisfies Record<keyof CarriedSeasonSettings, true>;

/**
 * A league's very first season: the schema defaults, except the soft MMR
 * limit, which the first-season form has always prefilled with the league's
 * standard review threshold.
 */
const FIRST_SEASON: CarriedSeasonSettings = {
  teamSize: 5,
  minTeams: 4,
  draftBudget: 100,
  budgetMmrWeight: 20,
  maxMmr: SOFT_MMR_LIMIT,
  regularBestOf: 2,
  playoffBestOf: 3,
  finalBestOf: 5,
  dotaLeagueId: null,
};

/** The settings a new season opens with, given the season it follows. */
export function carriedSeasonSettings(
  previous: CarriedSeasonSettings | null,
): CarriedSeasonSettings {
  if (!previous) return { ...FIRST_SEASON };
  const leagueId = previous.dotaLeagueId?.trim();
  return {
    teamSize: previous.teamSize,
    minTeams: previous.minTeams,
    draftBudget: previous.draftBudget,
    budgetMmrWeight: previous.budgetMmrWeight,
    maxMmr: previous.maxMmr,
    regularBestOf: previous.regularBestOf,
    playoffBestOf: previous.playoffBestOf,
    finalBestOf: previous.finalBestOf,
    dotaLeagueId: leagueId ? leagueId : null,
  };
}

/**
 * The carried settings in one line, e.g. "Teams of 5 · 4 teams to start ·
 * $100 budget · 20% MMR budget weighting · 4,500 soft MMR limit ·
 * Bo2 / Bo3 / Bo5 series · league id 17654". The soft limit is a review
 * threshold, never a block, and the wording says only "limit".
 */
export function carriedSettingsLine(s: CarriedSeasonSettings): string {
  return [
    `Teams of ${s.teamSize}`,
    `${s.minTeams} teams to start`,
    `$${s.draftBudget.toLocaleString("en-US")} budget`,
    s.budgetMmrWeight > 0
      ? `${s.budgetMmrWeight}% MMR budget weighting`
      : "flat budgets",
    s.maxMmr > 0
      ? `${s.maxMmr.toLocaleString("en-US")} soft MMR limit`
      : "no soft MMR limit",
    `Bo${s.regularBestOf} / Bo${s.playoffBestOf} / Bo${s.finalBestOf} series`,
    s.dotaLeagueId ? `league id ${s.dotaLeagueId}` : "no league id",
  ].join(" · ");
}

/**
 * The next season's name, prefilled in the handoff form: "Season 9" becomes
 * "Season 10". The number after "Season" wins; otherwise the last number in
 * the name. Anything after that number ("Season 9 (test run)") is left off
 * rather than guessed at. Empty when there is no number to count on, so the
 * admin types a name.
 */
export function nextSeasonName(previous: string | null | undefined): string {
  if (previous == null) return "Season 1";
  const name = previous.trim();
  const numbered =
    /^(.*?\bseason\s*#?\s*)(\d{1,6})(?!\d)/i.exec(name) ??
    /^(.*\D|)(\d{1,6})(?!.*\d)/.exec(name);
  if (!numbered) return "";
  const next = `${numbered[1]}${Number(numbered[2]) + 1}`.trim();
  return next.length <= 60 ? next : "";
}
