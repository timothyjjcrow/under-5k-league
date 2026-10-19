// Discord before a signup (Tim's call, 2026-10-19). A new signup needs a
// linked Discord account, and that account in the league's server, so every
// player who joins a season can be reached: before this, players signed up
// whom no captain, standin post or admin could contact. Pure: the signup
// action and /me read the facts, and these decide and word them.

import type { AccountMembership } from "./account-page";
import { REGISTRATION_STATUS } from "./constants";

/** What this deployment can require (`signupDiscordPolicy` reads it). */
export type SignupDiscordPolicy = {
  /** Accounts can be linked here (`discordLinkingConfigured`). Without it
   *  there is nothing a player could do, so nothing is required. */
  linkRequired: boolean;
  /** The bot can look a linked account up in the server (`getGuildConfig`).
   *  Without it the link is all that can be checked. */
  membershipCheckable: boolean;
};

/** What still stands between a player and a new signup. */
export type SignupDiscordBlocker = "link" | "join" | "rules";

/**
 * Whether a submit is an admission the rule judges: no signup this season
 * yet, or a withdrawn one coming back. An ACTIVE signup is already in, as for
 * the medal rule, so a player admitted before the rule (or one who unlinked
 * since) can still edit their signup. A REMOVED one is refused by the write
 * itself, which says the true thing ("an admin removed your signup"); asking
 * that player to link Discord first would send them on an errand that ends
 * in the same refusal.
 */
export function signupDiscordJudged(
  existingStatus: string | null | undefined,
): boolean {
  return (
    existingStatus == null || existingStatus === REGISTRATION_STATUS.WITHDRAWN
  );
}

/**
 * The rule. Membership must be "member": a pending member (Membership
 * Screening) can't read the channels or be pinged, so the league still can't
 * reach them. An unknown answer (Discord didn't say: down, slow, or the bot
 * missing from the server) never blocks, so a Discord outage or a kicked bot
 * can't close signups: the link is still required, and the admin reach card
 * shows who couldn't be checked.
 */
export function signupDiscordBlocker(input: {
  policy: SignupDiscordPolicy;
  linked: boolean;
  membership: AccountMembership;
}): SignupDiscordBlocker | null {
  if (!input.policy.linkRequired) return null;
  if (!input.linked) return "link";
  if (!input.policy.membershipCheckable) return null;
  if (input.membership === "not-member") return "join";
  if (input.membership === "pending") return "rules";
  return null;
}

/** The action's refusal, for a submit from a page that predates the step. */
export function signupDiscordRefusal(blocker: SignupDiscordBlocker): string {
  switch (blocker) {
    case "link":
      return "Link your Discord first: every player who signs up needs a linked Discord account in the league's server, so captains and admins can reach them.";
    case "join":
      return "Your linked Discord account isn't in the league's server yet. Join the server, then sign up.";
    case "rules":
      return "Accept the rules in the league's Discord server, then sign up: until you do, nobody can reach you there.";
  }
}

/**
 * One control on the step: an in-page link to the Discord card, which holds
 * the buttons that do the work, or a reload of /me.
 */
export type SignupDiscordCta = {
  kind: "card" | "recheck";
  label: string;
};

export type SignupDiscordStep = {
  title: string;
  body: string;
  ctas: SignupDiscordCta[];
};

/**
 * What /me shows in place of the signup form until the rule is met. The form
 * itself stays hidden: linking is a full-page round trip to Discord, so a
 * half-filled form would be lost on the way. The step says why and points at
 * the Discord card, as /me's next-steps list does: the card holds the link,
 * join and invite buttons and the consent text beside them, and no two
 * controls on /me share a name. "Check again" reloads /me, for a player who
 * joined with the invite or accepted the rules in Discord.
 */
export function signupDiscordStep(
  blocker: SignupDiscordBlocker,
  input: {
    /** The OAuth consent also carries guilds.join (bot + guild configured). */
    oneClick: boolean;
    /** The linked account's username, when there is one. */
    handle: string | null;
  },
): SignupDiscordStep {
  const recheck: SignupDiscordCta = { kind: "recheck", label: "Check again" };
  if (blocker === "link") {
    return {
      title: "Link your Discord to sign up",
      body: input.oneClick
        ? "Every player has to be in the league's Discord server: it's where captains, standins and admins reach you. The Discord card links your account and adds it to the server in one click, then the signup form opens here."
        : "Every player has to link a Discord account and be in the league's server: it's where captains, standins and admins reach you. Link yours in the Discord card, then the signup form opens here.",
      ctas: [{ kind: "card", label: "Link your Discord" }],
    };
  }
  if (blocker === "join") {
    const account = input.handle
      ? `The Discord account you linked (@${input.handle})`
      : "The Discord account you linked";
    return {
      title: "Join the league's Discord server to sign up",
      body: `${account} isn't in the league's server yet, and every player has to be: it's where captains, standins and admins reach you. Join from the Discord card, then check again.`,
      ctas: [
        { kind: "card", label: "Get your linked account into the server" },
        recheck,
      ],
    };
  }
  return {
    title: "Accept the server's rules to sign up",
    body: "You're in the league's Discord server, but you haven't accepted its rules yet, and until you do nobody can reach you there. Accept them in Discord, then check again.",
    ctas: [recheck],
  };
}

/** How it works' first step, saying what the rule asks for here. */
export function signupStepDetail(policy: SignupDiscordPolicy): string {
  const team = "You don't need a team: everyone signs up on their own.";
  if (!policy.linkRequired) {
    return `Sign in with Steam and add your roles and favorite heroes. ${team}`;
  }
  return policy.membershipCheckable
    ? `Sign in with Steam, link your Discord and join the league's server, then add your roles and favorite heroes. ${team}`
    : `Sign in with Steam, link your Discord, then add your roles and favorite heroes. ${team}`;
}
