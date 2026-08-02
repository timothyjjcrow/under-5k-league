import type { GuildMembership } from "./discord-roles";
import {
  clampMmrToRank,
  formatMmrRange,
  rankMedalName,
} from "./rank";

/**
 * Pure row-level readiness signals for the admin signup-moderation lists —
 * the "is this signup a real, reachable, draftable player?" pass an admin
 * makes before the season locks people onto rosters. Everything here is
 * ADVISORY: a stored registration MMR is league-approved (the clamp ran at
 * signup, and admin overrides are the documented escape hatch), so a flag is
 * a reason to look, never a verdict. The rendering stays in admin/page.tsx;
 * the words and the decisions live here where they can be tested.
 */

export type SignupFlag = {
  key: "mmr-off-medal" | "blank-signup" | "no-mmr";
  label: string;
  detail: string;
  /** Badge tone: "accent" = worth a look before the draft; "neutral" = context. */
  tone: "accent" | "neutral";
};

export function signupFlags(reg: {
  mmr: number;
  roles: string;
  favoriteHeroes: string;
  statement: string;
  captainNote: string;
  rankTier: number | null | undefined;
}): SignupFlag[] {
  const flags: SignupFlag[] = [];
  // Advisory only, same contract as setRegistrationMmr's heads-up: the medal
  // window comes from the same clampMmrToRank the signup path used, so this
  // can only flag values that arrived via an admin override or a medal that
  // changed since — exactly the rows worth a second look before the draft
  // prices them.
  const clamp = clampMmrToRank(reg.mmr, reg.rankTier);
  if (clamp.adjusted && clamp.range) {
    flags.push({
      key: "mmr-off-medal",
      label: "MMR ≠ medal",
      tone: "accent",
      detail:
        `Listed at ${reg.mmr} MMR, but their OpenDota medal is ` +
        `${rankMedalName(reg.rankTier)} (plausible ${formatMmrRange(clamp.range)}). ` +
        "The stored number is league-approved — this is a heads-up for review, not a block.",
    });
  } else if (reg.mmr === 0) {
    // A stored 0 is the unknown sentinel: the pool sort, the budget weighting
    // and the auto-nominate resolver all treat this player as
    // bottom-of-the-pool unknown. The copy must branch on the medal: a
    // Herald 1-3 window is padded down to 0, so a blank claim with one of
    // those medals is NOT clamped (0 is "plausible") and lands here — saying
    // "no OpenDota medal" beside their rendered Herald medal would be a
    // visible self-contradiction.
    flags.push({
      key: "no-mmr",
      label: "MMR unknown",
      tone: "neutral",
      detail:
        (clamp.range
          ? `No MMR claim, and their ${rankMedalName(reg.rankTier)} medal's ` +
            "plausible window reaches 0, so nothing pins a number"
          : "No MMR claim and no OpenDota medal") +
        " — pool sorting and MMR-weighted budgets treat this player as unknown.",
    });
  }
  const blank = [reg.roles, reg.favoriteHeroes, reg.statement, reg.captainNote]
    .every((s) => s.trim() === "");
  if (blank) {
    flags.push({
      key: "blank-signup",
      label: "blank signup",
      tone: "accent",
      detail:
        "No positions, heroes or notes on the signup form — captains have " +
        "nothing to draft on. Worth confirming this is a real player who " +
        "intends to play.",
    });
  }
  return flags;
}

export type MembershipChipView = {
  label: string;
  tone: "success" | "accent" | "danger" | "neutral";
  detail: string;
};

/**
 * The per-row rendering decision for a LINKED player's live guild membership.
 * Two house rules are encoded here rather than trusted to call sites:
 * unknown never renders as a negative (it is its own neutral state, and the
 * copy points at the bot checklist instead of claiming a reload fixes it),
 * and a not-member verdict names the LINKED account — membership is a fact
 * about the account they linked, not always the human, and the handle is
 * what lets an admin check the member list in seconds.
 */
export function membershipChipView(
  membership: GuildMembership,
  handle: string,
): MembershipChipView {
  switch (membership) {
    case "member":
      return {
        label: "in server",
        tone: "success",
        detail:
          "Their linked Discord account is in the league's server — " +
          "mentions and pings reach them.",
      };
    case "pending":
      return {
        label: "rules pending",
        tone: "accent",
        detail:
          "In the server but still behind its rules screen — unpingable " +
          "until they accept it.",
      };
    case "not-member":
      return {
        label: "not in server",
        tone: "danger",
        detail:
          `The Discord account they linked${handle ? ` (@${handle})` : ""} ` +
          "isn't in the league's server, so mentions and pings can't reach " +
          "them. They may be in it on a different account — have them join " +
          "on the linked account, or re-link the one they actually use.",
      };
    default:
      return {
        label: "couldn't check",
        tone: "neutral",
        detail:
          "Discord didn't answer for this account just now — that is not a " +
          "verdict. If every player reads this, the bot is likely missing " +
          "or misconfigured; the Discord notifications card's checklist " +
          "names the cause.",
      };
  }
}
