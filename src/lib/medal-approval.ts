// Medal approvals (Tim, 2026-11-21): a player whose medal is over the
// league's line (a Divine 3 or higher, or Immortal: medalProvesIneligible)
// asks an admin to let them in anyway, and an admin approves them at an MMR
// they set, or declines. One approval covers the league signup and the
// inhouse queue. Pure rules here; the reads and writes are in
// medal-approval-service.ts. Rules: docs/features/players-and-registration.md
// ("Medal approvals").

import { HARD_MMR_CEILING, MEDAL_APPROVAL_STATUS } from "./constants";
import { escapeDiscordText } from "./discord-escape";
import { rankMedalName, rankTierExactMinMmr } from "./rank";
import { medalProvesIneligible } from "./registration";

/** The longest note a player can send with a request. */
export const MEDAL_APPROVAL_NOTE_MAX = 300;
/** The highest MMR an admin can approve a player at (the league editor's). */
export const MEDAL_APPROVAL_MMR_MAX = 12000;
/** Where /admin lists the requests (the section's id). */
export const MEDAL_APPROVALS_ANCHOR = "adm-medal-approvals";
/** Where /me shows the player's own request (the card's id). */
export const MEDAL_APPROVAL_CARD_ANCHOR = "medal-approval";

/** A fixed locale, so a message reads "5,020" on every server. */
const MMR_FORMAT = new Intl.NumberFormat("en-US");

/** The approval facts every rule reads: the row's status and MMR. */
export type MedalApprovalFacts = { status: string; mmr: number | null };

/**
 * The MMR an approval lets the player in at, or null when it lets them in
 * nowhere: no row, not APPROVED yet, or an MMR the admin form could never
 * have saved (a hand edit reads as no approval, never as "any MMR").
 */
export function approvedMedalMmr(
  approval: MedalApprovalFacts | null | undefined,
): number | null {
  if (!approval || approval.status !== MEDAL_APPROVAL_STATUS.APPROVED) {
    return null;
  }
  const mmr = approval.mmr;
  return typeof mmr === "number" &&
    Number.isInteger(mmr) &&
    mmr > 0 &&
    mmr <= MEDAL_APPROVAL_MMR_MAX
    ? mmr
    : null;
}

/**
 * Why a player can't ask, or null when they can: only a medal over the line
 * needs an approval, and a player asks once. A declined request stays on the
 * admins' list, where an admin can still approve it, so asking again would
 * only repeat it.
 */
export function medalApprovalAskRefusal({
  rankTier,
  existingStatus,
}: {
  rankTier: number | null | undefined;
  /** The player's MedalApproval row's status, or null for none. */
  existingStatus: string | null | undefined;
}): string | null {
  if (existingStatus === MEDAL_APPROVAL_STATUS.APPROVED) {
    return "An admin has already approved you.";
  }
  if (existingStatus === MEDAL_APPROVAL_STATUS.PENDING) {
    return "You've already asked. An admin will answer here on the site.";
  }
  if (existingStatus === MEDAL_APPROVAL_STATUS.DECLINED) {
    return "An admin declined your request. Message a league admin on Discord if something has changed.";
  }
  if (!medalProvesIneligible(rankTier)) {
    return "Your medal isn't over the league's line, so there's nothing to approve.";
  }
  return null;
}

/** The player's note as stored: trimmed, single-spaced, at most the max. */
export function parseMedalApprovalNote(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MEDAL_APPROVAL_NOTE_MAX);
}

/** The MMR box on the admin's Approve form. */
export function parseApprovalMmr(
  raw: string,
): { ok: true; mmr: number } | { ok: false; error: string } {
  const text = raw.trim();
  const mmr = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(mmr) || mmr < 1 || mmr > MEDAL_APPROVAL_MMR_MAX) {
    return {
      ok: false,
      error: `Enter the MMR they play at, a whole number from 1 to ${MMR_FORMAT.format(MEDAL_APPROVAL_MMR_MAX)}.`,
    };
  }
  return { ok: true, mmr };
}

/**
 * The Approve form's starting MMR: the least the medal can honestly mean
 * (its exact band floor, 5,020 for a Divine 3). The admin may type anything.
 */
export function defaultApprovalMmr(
  rankTier: number | null | undefined,
): number | null {
  return rankTierExactMinMmr(rankTier);
}

/** What /me shows the player about the medal line and their request. */
export type MedalApprovalView =
  | { kind: "none" }
  | { kind: "ask"; medal: string }
  | { kind: "pending"; medal: string }
  | { kind: "approved"; mmr: number }
  | { kind: "declined"; medal: string };

/**
 * The player's state, from their medal and their approval row. An approval
 * shows while it stands, even once their medal falls back under the line: it
 * still sets the MMR they play at. A pending or declined request whose medal
 * is now under the line shows nothing, since nothing refuses them.
 */
export function medalApprovalView({
  rankTier,
  approval,
}: {
  rankTier: number | null | undefined;
  approval: MedalApprovalFacts | null | undefined;
}): MedalApprovalView {
  const mmr = approvedMedalMmr(approval);
  if (mmr !== null) return { kind: "approved", mmr };
  if (!medalProvesIneligible(rankTier)) return { kind: "none" };
  const medal = rankMedalName(rankTier);
  if (approval?.status === MEDAL_APPROVAL_STATUS.PENDING) {
    return { kind: "pending", medal };
  }
  if (approval?.status === MEDAL_APPROVAL_STATUS.DECLINED) {
    return { kind: "declined", medal };
  }
  return { kind: "ask", medal };
}

/**
 * The "Over the medal limit" card's line under its title. A player already
 * signed up for the season is in (`medalRefusesSignup`: a medal that rose
 * later never removes anyone), so their line says the signup stands and the
 * ask is for inhouses, which turn the medal away on every join.
 */
export function medalLimitLine(medal: string, signedUp: boolean): string {
  const line = `${MMR_FORMAT.format(HARD_MMR_CEILING)} MMR`;
  return signedUp
    ? `Your ${medal} medal is over the league's ${line} line. You're already signed up, so your signup stays, though an admin may ask you about your MMR. Inhouses turn the medal away: ask an admin here if you want to play them.`
    : `Your ${medal} medal is over the league's ${line} line, so league signups and inhouses turn it away. An admin can approve you anyway, at an MMR they set.`;
}

/** The line every medal refusal ends with, pointing at the ask. */
export const MEDAL_APPROVAL_ASK_HINT =
  "An admin can approve you: ask on My account.";

/**
 * The player's line for an approval, used on /me's card and under the
 * locked MMR box: who set the number and what it covers.
 */
export function approvedMedalLine(mmr: number): string {
  return `An admin approved you over the medal limit at ${MMR_FORMAT.format(mmr)} MMR. Your league signup and inhouse games use that number; only a league admin can change it.`;
}

/**
 * The signup toast's note when the player sent a number other than the one
 * their approval keeps (a stale tab, or a replayed form: /me disables the
 * box). Never a silent rewrite.
 */
export function approvedMmrKeptNote(mmr: number): string {
  return ` · An admin approved you over the medal limit, so your signup keeps ${MMR_FORMAT.format(mmr)} MMR. Ask a league admin to change it.`;
}

/** A queue join that found the player's approval changed since it read it. */
export const MEDAL_APPROVAL_CHANGED_JOIN =
  "An admin changed your medal limit approval just now. Reload and try joining again.";

/** The player's toast after asking. */
export const MEDAL_APPROVAL_ASKED_MESSAGE =
  "Request sent. An admin will approve or decline it here, and you'll see the answer on this page.";

/** The admin's toast after approving. */
export function medalApprovedMessage(name: string, mmr: number): string {
  return `${name} is approved over the medal limit at ${MMR_FORMAT.format(mmr)} MMR: they can sign up for the league and join inhouses.`;
}

/** The admin's toast after declining. */
export function medalDeclinedMessage(name: string): string {
  return `Declined ${name}'s request. It stays listed here, where you can still approve it.`;
}

/**
 * The admin's toast after removing a row. Removing an approval stops new
 * signups and inhouse joins on it, and touches nothing already there:
 * who plays is withdrawSignup's and the queue's remove, not a side effect.
 */
export function medalApprovalRemovedMessage(
  name: string,
  wasApproved: boolean,
): string {
  return wasApproved
    ? `Removed ${name}'s approval: their medal is checked again at signup and at every inhouse join. A signup or queue spot they already have stays until you remove it.`
    : `Removed ${name}'s request. They can ask again.`;
}

/** The admin log line for each decision. */
export function medalApprovalLogSummary(
  kind: "approve" | "decline" | "remove",
  name: string,
  mmr?: number,
): string {
  switch (kind) {
    case "approve":
      return `Approved ${name} over the medal limit at ${MMR_FORMAT.format(mmr ?? 0)} MMR`;
    case "decline":
      return `Declined ${name}'s request to play over the medal limit`;
    case "remove":
      return `Removed ${name}'s medal limit request or approval`;
  }
}

/**
 * The bot's direct message to each admin when a player asks. Names and the
 * note are the player's own text, escaped for Discord's markdown.
 */
export function medalApprovalRequestedDm(m: {
  playerName: string;
  rankTier: number | null;
  note: string;
  adminUrl: string;
}): string {
  const note = m.note ? `\n> ${escapeDiscordText(m.note)}` : "";
  return `🛡️ **${escapeDiscordText(m.playerName)}** (${rankMedalName(m.rankTier)}) asks to play over the league's ${MMR_FORMAT.format(HARD_MMR_CEILING)} MMR medal limit.${note}\nApprove at an MMR you set, or decline: ${m.adminUrl}`;
}

/** The bot's direct message to the player when an admin answers. */
export function medalApprovalDecidedDm(m: {
  approved: boolean;
  mmr: number | null;
  meUrl: string;
}): string {
  return m.approved
    ? `✅ An admin approved you to play over the medal limit at ${MMR_FORMAT.format(m.mmr ?? 0)} MMR. You can sign up for the league and join inhouses: ${m.meUrl}`
    : `An admin declined your request to play over the medal limit. Message a league admin on Discord if something has changed.`;
}
