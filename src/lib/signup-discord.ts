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

/** One control on the checklist's Discord step. */
export type SignupChecklistCta = {
  kind: "oauth" | "invite" | "recheck";
  label: string;
};

/** Where one step of the checklist stands. */
export type SignupChecklistState = "done" | "current" | "locked" | "checking";

export type SignupChecklistStep = {
  key: "steam" | "discord" | "signup";
  state: SignupChecklistState;
  label: string;
  detail: string;
  /** Controls, on the Discord step only. */
  ctas: SignupChecklistCta[];
};

/** The Discord step as the page can tell it. */
export type SignupChecklistDiscord =
  | { status: "blocked"; blocker: SignupDiscordBlocker }
  /** A linked player's membership lookup is still on its way. */
  | { status: "checking" }
  /** Linked, and in the server when `inServer`; false = Discord didn't
   *  say (or no bot), which never blocks but is never claimed either. */
  | { status: "done"; inServer: boolean };

/**
 * What a player joining the season sees on /me while the Discord rule applies
 * to them: Steam (done, they're signed in), Discord, then their signup. The
 * Discord step carries the real buttons, so the next thing to do is right
 * where they're looking, and the Discord card leaves its own out
 * (`signupOwnsDiscord`): one button per action on the page. Its copy is one
 * plain sentence on why (Tim's call: no ids, tokens or scopes here; the
 * button says it joins the server, and Discord's own screen says the rest).
 * The form shows under step 3 once Discord is done, never beside an
 * unfinished step 2: linking is a full-page round trip, so a half-filled form
 * would be lost. The invite appears only where it can finish the step (it
 * joins the server; it never links an account), and "Check again" reloads /me
 * after an invite join or accepting the rules in Discord.
 */
export function signupChecklist(input: {
  steamName: string;
  discord: SignupChecklistDiscord;
  /** The OAuth consent also carries guilds.join (bot + guild configured). */
  oneClick: boolean;
  /** The league has an invite link (Europe may not). */
  hasInvite: boolean;
  /** The linked account's username, when there is one. */
  handle: string | null;
  /** The OAuth callback's one-shot ?discord= code, if any. */
  callback: string | null;
}): SignupChecklistStep[] {
  const steam: SignupChecklistStep = {
    key: "steam",
    state: "done",
    label: "Steam",
    detail: `Signed in as ${input.steamName}.`,
    ctas: [],
  };
  const invite = (label: string): SignupChecklistCta[] =>
    input.hasInvite ? [{ kind: "invite", label }] : [];
  const recheck: SignupChecklistCta = { kind: "recheck", label: "Check again" };
  const discordStep = (
    state: SignupChecklistState,
    detail: string,
    ctas: SignupChecklistCta[] = [],
  ): SignupChecklistStep => ({ key: "discord", state, label: "Discord", detail, ctas });
  let discord: SignupChecklistStep;
  const d = input.discord;
  if (d.status === "done") {
    // A callback that couldn't finish the join, read while Discord isn't
    // answering, keeps the invite on offer (the Discord card's rule): the
    // player may sign up, but the note above it asks them to join.
    const leftover = d.inServer
      ? []
      : input.callback === "join_failed"
        ? invite("Join the server")
        : input.callback === "joined_pending"
          ? invite("Open Discord")
          : [];
    discord = discordStep(
      "done",
      d.inServer
        ? input.handle
          ? `Linked as @${input.handle}, and in the league's server.`
          : "Linked, and in the league's server."
        : input.handle
          ? `Linked as @${input.handle}.`
          : "Linked.",
      leftover,
    );
  } else if (d.status === "checking") {
    discord = discordStep("checking", "Checking the league's Discord…");
  } else if (d.blocker === "link") {
    discord = input.oneClick
      ? discordStep(
          "current",
          "Link your Discord so teams and admins can contact you about the league. Complete this step to finish signing up.",
          [{ kind: "oauth", label: "Link Discord & join the server" }],
        )
      : discordStep(
          "current",
          "Link your Discord and join the league's server so teams and admins can contact you about the league. Complete this step to finish signing up.",
          [{ kind: "oauth", label: "Link Discord" }, ...invite("Join the server")],
        );
  } else if (d.blocker === "join") {
    discord = discordStep(
      "current",
      `Your Discord${input.handle ? ` (@${input.handle})` : ""} is linked but isn't in the league's server yet. Join it so teams and admins can contact you, then finish signing up.`,
      input.oneClick
        ? [
            { kind: "oauth", label: "Join the server" },
            ...invite("Use the invite instead"),
            recheck,
          ]
        : [...invite("Join the server"), recheck],
    );
  } else {
    discord = discordStep(
      "current",
      "You're in the league's Discord, but you haven't accepted its rules yet. Accept them in Discord, then check again.",
      [...invite("Open Discord"), recheck],
    );
  }
  const signup: SignupChecklistStep =
    discord.state === "done"
      ? {
          key: "signup",
          state: "current",
          label: "Your signup",
          detail: "Fill in the form below.",
          ctas: [],
        }
      : {
          key: "signup",
          state: "locked",
          label: "Your signup",
          detail: "Opens here once your Discord is done.",
          ctas: [],
        };
  return [steam, discord, signup];
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
