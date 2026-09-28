import { SEASON_STATUS } from "./constants";
import { normalizeTeamLogoUrl } from "./team-logo";

/** Team names are headings, standings rows and Discord lines: one short line. */
export const TEAM_NAME_MAX_LENGTH = 60;

/**
 * Characters that draw nothing: format characters (zero-width spaces, bidi
 * overrides, soft hyphens, the byte-order mark) plus the blank "letters" and
 * "symbols" that other categories miss (Hangul fillers, the blank braille
 * cell, the combining grapheme joiner, Khmer inherent vowels). The zero-width
 * joiner is kept in a stored name because emoji sequences use it; the key
 * below drops it too.
 */
const INVISIBLE = /(?!\u200D)[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]/gu;
const INVISIBLE_IN_KEY = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0\uFE00-\uFE0F]/gu;
/** Something a reader can see: a letter, digit, punctuation mark or symbol. */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/**
 * The stored form of a typed team name: invisible characters are dropped,
 * control characters and runs of whitespace collapse to one space (a name is
 * always one line), then trim and cap. An empty result means "no name",
 * including a name with nothing visible in it.
 */
export function normalizeTeamName(raw: string): string {
  const name = raw
    .replace(INVISIBLE, "")
    .replace(/[\u0000-\u001F\u007F\s]+/g, " ")
    .trim()
    .slice(0, TEAM_NAME_MAX_LENGTH)
    .trim();
  return VISIBLE.test(name.replace(INVISIBLE_IN_KEY, "")) ? name : "";
}

/**
 * Two names that read the same in a standings table are the same name: case,
 * spacing, invisible characters, emoji variation selectors and compatibility
 * forms (full-width letters, ligatures) don't make a different name.
 */
export function teamNameKey(name: string): string {
  return normalizeTeamName(name)
    .replace(INVISIBLE_IN_KEY, "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

/**
 * A captain's logo-only changes post to the league channel at most once per
 * team in this window. Renames are never held back: the league announces
 * every rename, from a captain or an admin. Every change is still saved and
 * logged; this only stops a captain trying logos back and forth from flooding
 * the channel and using up the webhook's rate limit, which other
 * announcements share.
 */
export const TEAM_IDENTITY_PING_THROTTLE_SECONDS = 15 * 60;

export function teamIdentityPingKey(teamId: string): string {
  return `teamIdentityPing:${teamId}`;
}

/**
 * Whether the post for this change waits on the throttle. Only a captain's
 * change that keeps the name does; a rename always posts, and so does
 * anything an admin saves.
 */
export function teamIdentityPostIsThrottled(
  change: Pick<TeamIdentityChange, "byCaptain" | "nameChanged">,
): boolean {
  return change.byCaptain && !change.nameChanged;
}

/** The toast for a logo change whose Discord post was held back by the throttle. */
export function teamIdentityNotPostedMessage(name: string): string {
  const minutes = Math.round(TEAM_IDENTITY_PING_THROTTLE_SECONDS / 60);
  return `Saved ${name}. Discord already heard about a change to this team in the last ${minutes} minutes, so this logo change wasn't posted there.`;
}

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

/** The name addCaptain gives a new team: "<captain>'s Team". */
export function defaultTeamName(captainName: string): string {
  return normalizeTeamName(`${captainName}'s Team`) || "New team";
}

/**
 * What a returning captain's new team keeps from the last team they captained
 * (their own account only — the caller looks up teams by captainId). Nothing
 * is carried that would be worse than the default: a generated
 * "<name>'s Team" name, a name another team this season already uses, or a
 * logo link the logo check would now refuse (an expired Discord upload).
 */
export function carriedTeamIdentity(
  previous: { name: string; logoUrl: string | null } | null,
  takenNames: readonly string[],
): { name: string | null; logoUrl: string | null } {
  if (!previous) return { name: null, logoUrl: null };
  const name = normalizeTeamName(previous.name);
  const taken = new Set(takenNames.map(teamNameKey));
  const keepName =
    name && !/'s team$/i.test(name) && !taken.has(teamNameKey(name))
      ? name
      : null;
  const logo = normalizeTeamLogoUrl(previous.logoUrl ?? "");
  return { name: keepName, logoUrl: "logoUrl" in logo ? logo.logoUrl : null };
}

/** The sentence the "captain added" message ends with when something carried. */
export function carriedTeamIdentityNote(carried: {
  name: string | null;
  logoUrl: string | null;
}): string {
  if (carried.name && carried.logoUrl) {
    return `Their team keeps last time's name, ${carried.name}, and its logo.`;
  }
  if (carried.name) return `Their team keeps last time's name, ${carried.name}.`;
  if (carried.logoUrl) return "Their team keeps its logo from last time.";
  return "";
}
