// Medal approvals (Tim, 2026-11-21): a player whose medal is over the
// league's line (a Divine 3 or higher, or Immortal: medalProvesIneligible)
// asks an admin to let them in anyway, and an admin approves them at an MMR
// they set, or declines. One approval covers the league signup and the
// inhouse queue. The smurf check (smurf-check.ts; Tim, 2026-11-27) asks
// through the same row with reason SMURF: any approval sets the MMR they
// play at and clears the smurf check, and only a MEDAL one lets a medal over
// the line in. Pure rules here; the reads and writes are in
// medal-approval-service.ts. Rules: docs/features/players-and-registration.md
// ("Medal approvals", "Smurf check").

import {
  APPROVAL_REASON,
  HARD_MMR_CEILING,
  MEDAL_APPROVAL_STATUS,
  type ApprovalReason,
} from "./constants";
import { escapeDiscordText } from "./discord-escape";
import { rankMedalName, rankTierExactMinMmr } from "./rank";
import { medalProvesIneligible } from "./registration";
import { smurfSignalPhrase, type SmurfSignal } from "./smurf-check";

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

/** The approval facts every rule reads: the row's status, MMR and reason
 *  (required, so no read can forget it and take a smurf check's approval
 *  for one over the medal limit). */
export type MedalApprovalFacts = {
  status: string;
  mmr: number | null;
  reason: string;
};

/** The reason as the rules read it: anything but SMURF is the medal's. */
export function approvalReason(reason: string | null | undefined): ApprovalReason {
  return reason === APPROVAL_REASON.SMURF ? APPROVAL_REASON.SMURF : APPROVAL_REASON.MEDAL;
}

/**
 * The MMR an approval lets the player in at, or null when it lets them in
 * nowhere: no row, not APPROVED yet, or an MMR the admin form could never
 * have saved (a hand edit reads as no approval, never as "any MMR"). Either
 * reason: an admin set this number, so it is what the player plays at, and
 * it clears the smurf check. Whether it also lets a medal over the line in
 * is `approvalCoversMedal`.
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
 * Whether an approval lets a medal over the line in: an APPROVED row asked
 * for the medal. A smurf check's approval set an MMR for an account under
 * the line; once that player's medal climbs over it, the medal is judged
 * again and they ask again (`approvalAskPlan`'s "convert").
 */
export function approvalCoversMedal(
  approval: MedalApprovalFacts | null | undefined,
): boolean {
  return (
    approvedMedalMmr(approval) !== null &&
    approval?.reason === APPROVAL_REASON.MEDAL
  );
}

/** The two facts a signup and a join judged, compared at their write. */
export function approvalStanding(approval: MedalApprovalFacts | null | undefined): {
  mmr: number | null;
  coversMedal: boolean;
} {
  return { mmr: approvedMedalMmr(approval), coversMedal: approvalCoversMedal(approval) };
}

/** What a player's "Ask an admin" does, from their medal, the smurf check's
 *  findings and the row they have. */
export type ApprovalAskPlan =
  | { kind: "create"; reason: ApprovalReason }
  /** Their smurf check's approval stands, and their medal has since gone
   *  over the line: the row becomes a fresh medal request. */
  | { kind: "convert"; reason: typeof APPROVAL_REASON.MEDAL }
  | { kind: "refuse"; error: string };

/**
 * Whether a player may ask, and for what: a medal over the line asks for
 * the medal, else the smurf check's findings ask for a smurf check. A
 * player asks once. A declined request stays on the admins' list, where an
 * admin can still approve it, so asking again would only repeat it.
 */
export function approvalAskPlan({
  rankTier,
  signals,
  existing,
}: {
  rankTier: number | null | undefined;
  /** What the smurf check finds on their account now. */
  signals: readonly SmurfSignal[];
  /** The player's row, or null for none. */
  existing: { status: string; reason: string } | null | undefined;
}): ApprovalAskPlan {
  const medalOver = medalProvesIneligible(rankTier);
  if (existing?.status === MEDAL_APPROVAL_STATUS.APPROVED) {
    return medalOver && approvalReason(existing.reason) === APPROVAL_REASON.SMURF
      ? { kind: "convert", reason: APPROVAL_REASON.MEDAL }
      : { kind: "refuse", error: "An admin has already approved you." };
  }
  if (existing?.status === MEDAL_APPROVAL_STATUS.PENDING) {
    return {
      kind: "refuse",
      error: "You've already asked. An admin will answer here on the site.",
    };
  }
  if (existing?.status === MEDAL_APPROVAL_STATUS.DECLINED) {
    return {
      kind: "refuse",
      error:
        "An admin declined your request. Message a league admin on Discord if something has changed.",
    };
  }
  if (medalOver) return { kind: "create", reason: APPROVAL_REASON.MEDAL };
  if (signals.length > 0) return { kind: "create", reason: APPROVAL_REASON.SMURF };
  return {
    kind: "refuse",
    error:
      "Your medal isn't over the league's line and the smurf check found nothing, so there's nothing to approve.",
  };
}

/**
 * The reason an admin's Approve records: the row's, unless the player's
 * medal is over the line now, when it is the medal's. A smurf check's
 * request whose medal has climbed past Divine 3 since is then answered for
 * both, instead of approving an MMR the medal rule still refuses.
 */
export function reasonOnApprove(
  rowReason: string | null | undefined,
  currentRankTier: number | null | undefined,
): ApprovalReason {
  return medalProvesIneligible(currentRankTier)
    ? APPROVAL_REASON.MEDAL
    : approvalReason(rowReason);
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

/** What /me shows the player about the medal line, the smurf check and
 *  their request. `reason` is what the card is about now. */
export type MedalApprovalView =
  | { kind: "none" }
  | { kind: "ask"; reason: ApprovalReason; medal: string; signals: SmurfSignal[] }
  | { kind: "pending"; reason: ApprovalReason; medal: string; signals: SmurfSignal[] }
  | { kind: "approved"; reason: ApprovalReason; mmr: number }
  | { kind: "declined"; reason: ApprovalReason; medal: string; signals: SmurfSignal[] };

/**
 * The player's state, from their medal, the smurf check and their approval
 * row. An approval shows while it stands, even once their medal falls back
 * under the line or the check stops finding anything: it still sets the MMR
 * they play at. The one exception is a smurf check's approval under a medal
 * now over the line, which the medal rule refuses: that card asks again. A
 * pending or declined request that nothing refuses any more shows nothing.
 *
 * `smurfMatters`: the check would refuse them somewhere now (a signup
 * admission or their first inhouse: smurfRefusesSignup,
 * smurfRefusesInhouse). Findings on a player already in show nothing here;
 * the admin signup list flags them instead.
 */
export function medalApprovalView({
  rankTier,
  approval,
  signals = [],
  smurfMatters = false,
}: {
  rankTier: number | null | undefined;
  approval: MedalApprovalFacts | null | undefined;
  signals?: readonly SmurfSignal[];
  smurfMatters?: boolean;
}): MedalApprovalView {
  const medalOver = medalProvesIneligible(rankTier);
  const mmr = approvedMedalMmr(approval);
  if (mmr !== null && (!medalOver || approvalCoversMedal(approval))) {
    return { kind: "approved", reason: approvalReason(approval?.reason), mmr };
  }
  const reason = medalOver
    ? APPROVAL_REASON.MEDAL
    : signals.length > 0 && smurfMatters
      ? APPROVAL_REASON.SMURF
      : null;
  if (!reason) return { kind: "none" };
  const facts = {
    reason,
    medal: rankMedalName(rankTier),
    signals: reason === APPROVAL_REASON.SMURF ? [...signals] : [],
  };
  if (approval?.status === MEDAL_APPROVAL_STATUS.PENDING) {
    return { kind: "pending", ...facts };
  }
  if (approval?.status === MEDAL_APPROVAL_STATUS.DECLINED) {
    return { kind: "declined", ...facts };
  }
  return { kind: "ask", ...facts };
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

/**
 * The "Smurf check" card's line under its title: what the check found, and
 * where it stops them. A player already signed up stays signed up, so for
 * them the check is about inhouses.
 */
export function smurfCheckLine(signals: readonly SmurfSignal[], signedUp: boolean): string {
  const found = `The smurf check found: ${smurfSignalPhrase(signals)}.`;
  return signedUp
    ? `${found} You're already signed up, so your signup stays, but your first inhouse waits for an admin to look at your account.`
    : `${found} An admin has to look at your account before you sign up or play your first inhouse, and sets the MMR you play at.`;
}

/** The line every medal refusal ends with, pointing at the ask. */
export const MEDAL_APPROVAL_ASK_HINT =
  "An admin can approve you: ask on My account.";

/** "approved you over the medal limit" or "checked your account and
 *  approved you", the phrase every approval line shares. */
function approvedPhrase(reason: string | null | undefined): string {
  return approvalReason(reason) === APPROVAL_REASON.SMURF
    ? "checked your account and approved you"
    : "approved you over the medal limit";
}

/**
 * The player's line for an approval, used on /me's card and under the
 * locked MMR box: who set the number and what it covers.
 */
export function approvedMedalLine(mmr: number, reason: string = APPROVAL_REASON.MEDAL): string {
  return `An admin ${approvedPhrase(reason)} at ${MMR_FORMAT.format(mmr)} MMR. Your league signup and inhouse games use that number; only a league admin can change it.`;
}

/**
 * The signup toast's note when the player sent a number other than the one
 * their approval keeps (a stale tab, or a replayed form: /me disables the
 * box). Never a silent rewrite.
 */
export function approvedMmrKeptNote(mmr: number, reason: string = APPROVAL_REASON.MEDAL): string {
  return ` · An admin ${approvedPhrase(reason)}, so your signup keeps ${MMR_FORMAT.format(mmr)} MMR. Ask a league admin to change it.`;
}

/** A queue join that found the player's approval changed since it read it. */
export const MEDAL_APPROVAL_CHANGED_JOIN =
  "An admin changed your approval just now. Reload and try joining again.";

/** The player's toast after asking. */
export const MEDAL_APPROVAL_ASKED_MESSAGE =
  "Request sent. An admin will approve or decline it here, and you'll see the answer on this page.";

/** The admin's toast after approving. */
export function medalApprovedMessage(
  name: string,
  mmr: number,
  reason: string = APPROVAL_REASON.MEDAL,
): string {
  const what =
    approvalReason(reason) === APPROVAL_REASON.SMURF
      ? "passed the smurf check"
      : "is approved over the medal limit";
  return `${name} ${what} at ${MMR_FORMAT.format(mmr)} MMR: they can sign up for the league and join inhouses.`;
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
    ? `Removed ${name}'s approval: the medal limit and the smurf check judge them again at signup and when they join inhouses. A signup or queue spot they already have stays until you remove it.`
    : `Removed ${name}'s request. They can ask again.`;
}

/** The admin log line for each decision. */
export function medalApprovalLogSummary(
  kind: "approve" | "decline" | "remove",
  name: string,
  mmr?: number,
  reason: string = APPROVAL_REASON.MEDAL,
): string {
  const smurf = approvalReason(reason) === APPROVAL_REASON.SMURF;
  switch (kind) {
    case "approve":
      return smurf
        ? `Passed ${name}'s smurf check at ${MMR_FORMAT.format(mmr ?? 0)} MMR`
        : `Approved ${name} over the medal limit at ${MMR_FORMAT.format(mmr ?? 0)} MMR`;
    case "decline":
      return smurf
        ? `Declined ${name}'s smurf check`
        : `Declined ${name}'s request to play over the medal limit`;
    case "remove":
      return `Removed ${name}'s medal limit or smurf check request or approval`;
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
  reason?: string;
  /** The smurf check's findings, for a SMURF request. */
  signals?: readonly SmurfSignal[];
}): string {
  const note = m.note ? `\n> ${escapeDiscordText(m.note)}` : "";
  const who = `**${escapeDiscordText(m.playerName)}** (${rankMedalName(m.rankTier)})`;
  const ask =
    approvalReason(m.reason) === APPROVAL_REASON.SMURF
      ? `🔎 ${who} asks for a smurf check. It found: ${smurfSignalPhrase(m.signals ?? [])}.`
      : `🛡️ ${who} asks to play over the league's ${MMR_FORMAT.format(HARD_MMR_CEILING)} MMR medal limit.`;
  return `${ask}${note}\nApprove at an MMR you set, or decline: ${m.adminUrl}`;
}

/** The bot's direct message to the player when an admin answers. */
export function medalApprovalDecidedDm(m: {
  approved: boolean;
  mmr: number | null;
  meUrl: string;
  reason?: string;
}): string {
  const smurf = approvalReason(m.reason) === APPROVAL_REASON.SMURF;
  if (m.approved) {
    return smurf
      ? `✅ An admin checked your account and approved you at ${MMR_FORMAT.format(m.mmr ?? 0)} MMR. You can sign up for the league and join inhouses: ${m.meUrl}`
      : `✅ An admin approved you to play over the medal limit at ${MMR_FORMAT.format(m.mmr ?? 0)} MMR. You can sign up for the league and join inhouses: ${m.meUrl}`;
  }
  return smurf
    ? `An admin declined your smurf check. Message a league admin on Discord if something has changed.`
    : `An admin declined your request to play over the medal limit. Message a league admin on Discord if something has changed.`;
}
