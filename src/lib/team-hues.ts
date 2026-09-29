// Crest colours that don't clash within a season. Pure + tested.
//
// A generated crest used to take its hue from a hash of the team id, so two
// or three teams in a season routinely landed on near-identical greens. Now
// each season's teams share the colour wheel evenly, in the order they were
// created (first captain first), starting from a point that differs by
// season. The hue is not stored: the root layout publishes these values as
// one small stylesheet keyed by team id (see teamHueStyleSheet), so every
// <TeamCrest> on every page picks it up without being passed anything. A team
// the stylesheet doesn't know yet keeps its old hash hue as the fallback.

export type HueTeam = {
  id: string;
  seasonId: string;
  /** Creation time in epoch ms: the order hues are handed out in. */
  createdAtMs: number;
};

/** The attribute that ties an element to its team's hue. */
const TEAM_HUE_ATTRIBUTE = "data-team-hue";

/** Deterministic 0–359 from a string (the old per-team crest hash). */
export function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/**
 * Each season's teams spaced evenly around the colour wheel in creation
 * order: with n teams, neighbours are 360/n degrees apart. The starting hue
 * comes from the season id, so seasons don't all open on the same colour.
 * Adding or removing a team re-spaces that season's teams.
 */
export function seasonTeamHues(teams: readonly HueTeam[]): Map<string, number> {
  const bySeason = new Map<string, HueTeam[]>();
  for (const team of teams) {
    bySeason.set(team.seasonId, [...(bySeason.get(team.seasonId) ?? []), team]);
  }
  const hues = new Map<string, number>();
  for (const [seasonId, members] of bySeason) {
    const ordered = [...members].sort(
      (a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id),
    );
    const start = hashHue(seasonId);
    const step = 360 / ordered.length;
    ordered.forEach((team, index) => {
      hues.set(team.id, Math.round(start + index * step) % 360);
    });
  }
  return hues;
}

// Team ids are cuids. Anything else is left to the fallback hue rather than
// written into a stylesheet.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * One CSS rule per team setting `--team-hue` on the elements that carry its
 * id in `data-team-hue` (crests and team-tinted glows).
 */
export function teamHueStyleSheet(hues: Map<string, number>): string {
  const rules: string[] = [];
  for (const [id, hue] of hues) {
    if (!SAFE_ID.test(id) || !Number.isInteger(hue)) continue;
    rules.push(`[${TEAM_HUE_ATTRIBUTE}="${id}"]{--team-hue:${hue}}`);
  }
  return rules.join("");
}

/** A CSS hue for a team: its season hue when published, else the hash hue. */
export function teamHueVar(teamId: string): string {
  return `var(--team-hue, ${hashHue(teamId)})`;
}
