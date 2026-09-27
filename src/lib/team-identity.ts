import { SEASON_STATUS } from "./constants";

/** Team names are headings, standings rows and Discord lines: one short line. */
export const TEAM_NAME_MAX_LENGTH = 60;

/**
 * The stored form of a typed team name: control characters and runs of
 * whitespace collapse to one space (a name is always one line), then trim and
 * cap. An empty result means "no name".
 */
export function normalizeTeamName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F\s]+/g, " ")
    .trim()
    .slice(0, TEAM_NAME_MAX_LENGTH)
    .trim();
}

/** Two names that read the same in a standings table are the same name. */
export function teamNameKey(name: string): string {
  return normalizeTeamName(name).toLowerCase();
}

/**
 * Who may edit a team's name and logo: its captain or an admin, for as long as
 * its season is the active one and not yet complete. The team page renders its
 * edit form on exactly this rule; `saveTeamIdentity` enforces the same one at
 * the write.
 */
export function canEditTeamIdentity(opts: {
  viewer: { id: string; role: string } | null;
  captainId: string;
  seasonIsActive: boolean;
  seasonStatus: string;
}): boolean {
  const { viewer } = opts;
  if (!viewer || !opts.seasonIsActive) return false;
  if (opts.seasonStatus === SEASON_STATUS.COMPLETE) return false;
  return viewer.role === "ADMIN" || viewer.id === opts.captainId;
}

export type TeamIdentityChange = {
  previousName: string;
  name: string;
  nameChanged: boolean;
  logoChanged: boolean;
  logoUrl: string | null;
  /** Saved by the team's own captain rather than through the admin override. */
  byCaptain: boolean;
};

/** One activity-log line naming what changed, old name first. */
export function teamIdentitySummary(change: TeamIdentityChange): string {
  const logo = change.logoUrl ? "a custom logo" : "the generated crest";
  const who = change.byCaptain ? " (as captain)" : "";
  if (change.nameChanged) {
    const withLogo = change.logoChanged ? ` with ${logo}` : "";
    return `Renamed team "${change.previousName}" → "${change.name}"${withLogo}${who}`;
  }
  return `Set "${change.name}" to ${logo}${who}`;
}

/** Whether a typed logo link has loaded as an image in the browser yet. */
export type LogoImageState = "loading" | "loaded" | "failed";

/** The one line under the live crest preview: how the crest will look, or why
 *  the logo won't show. Uses the same check the server applies on save. */
export function logoPreviewNote(
  logo: { error: string } | { logoUrl: string | null },
  image: LogoImageState | null,
): { text: string; tone: "muted" | "danger" } {
  if ("error" in logo) return { text: logo.error, tone: "danger" };
  if (!logo.logoUrl) {
    return {
      text: "No logo, so the crest shows the team's initials. Paste an HTTPS link to an image to use a logo.",
      tone: "muted",
    };
  }
  if (image === "failed") {
    return {
      text: "That link didn't load as an image, so the crest would show initials. Use a link that opens the image itself.",
      tone: "danger",
    };
  }
  if (image === "loaded") return { text: "Logo preview.", tone: "muted" };
  return { text: "Loading the logo…", tone: "muted" };
}
