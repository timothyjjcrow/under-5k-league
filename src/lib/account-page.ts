// Pure copy and ordering for My account (/me). No database or Discord calls:
// the page reads the facts and these helpers decide what to say.

import { parseHeroList } from "./heroes";
import { DOTA_ROLES, roleLabels } from "./roles";

/** Where a draft confirmation stands for a signed-up full player. */
export type DraftConfirmationState = "none" | "needed" | "changed";

/** Mirrors GuildMembership: null means we could not tell (never "not in"). */
export type AccountMembership = "member" | "pending" | "not-member" | null;

export type AccountStepKey =
  | "confirm-draft"
  | "link-discord"
  | "join-server"
  | "accept-rules"
  | "match-data";

export type AccountStep = {
  key: AccountStepKey;
  /** In-page anchor of the card that finishes the step. */
  href: string;
  label: string;
  /** Where that card sits relative to the next-steps list. */
  arrow: "up" | "down";
};

export type AccountStepInput = {
  /** An ACTIVE signup in a season that still takes changes. */
  signedUp: boolean;
  draftConfirmation: DraftConfirmationState;
  isCaptain: boolean;
  /** An OAuth-linked account. A typed handle can never be pinged, so it
   *  does not count while linking is on offer. */
  discordLinked: boolean;
  /** A typed Discord handle is saved. */
  discordHandle: boolean;
  /** This league has Discord linking set up. Without it the typed handle is
   *  the only thing a player can give, so it has to be enough. */
  discordLinkable: boolean;
  membership: AccountMembership;
  /** OpenDota says Expose Public Match Data is off (=== true only). */
  matchDataPrivate: boolean;
};

/**
 * What is still left to do, most urgent first. Empty when nothing is.
 *
 * The Discord steps only apply once someone has signed up: before that the
 * season card is the ask, and nagging a visitor to link Discord first put the
 * cart before the horse. Discord counts as done only when the linked account
 * is in the server; an unknown membership (no bot, Discord slow) adds nothing,
 * because telling someone they are missing from a server they are in reads as
 * broken.
 */
export function accountNextSteps(input: AccountStepInput): AccountStep[] {
  const steps: AccountStep[] = [];
  if (input.signedUp) {
    if (input.draftConfirmation !== "none") {
      steps.push({
        key: "confirm-draft",
        href: "#draft-commitment",
        label:
          input.draftConfirmation === "changed"
            ? "The draft time changed: confirm the new time"
            : "Confirm you can make draft night",
        arrow: "up",
      });
    }
    if (!input.discordLinked) {
      if (input.discordLinkable || !input.discordHandle) {
        const verb = input.discordLinkable ? "Link" : "Add";
        steps.push({
          key: "link-discord",
          href: "#profile-discord",
          label: input.isCaptain
            ? `${verb} your Discord so your team can reach you`
            : `${verb} your Discord so captains can reach you`,
          arrow: "down",
        });
      }
    } else if (input.membership === "not-member") {
      steps.push({
        key: "join-server",
        href: "#profile-discord",
        label: "Get your linked Discord account into the league server",
        arrow: "down",
      });
    } else if (input.membership === "pending") {
      steps.push({
        key: "accept-rules",
        href: "#profile-discord",
        label: "Accept the rules in the league's Discord so pings reach you",
        arrow: "down",
      });
    }
  }
  if (input.matchDataPrivate) {
    steps.push({
      key: "match-data",
      href: "#profile-dota",
      label: "Make your Dota match data public so your games import",
      arrow: "down",
    });
  }
  return steps;
}

export type SignupSummaryInput = {
  type: string;
  mmr: number;
  roles: string | null | undefined;
  favoriteHeroes: string | null | undefined;
  wantsCaptain: boolean;
};

/**
 * One line for the collapsed "Edit signup" row, so a player can check what
 * they submitted without opening the form: "Full player · 3200 MMR · Mid,
 * Offlane · 3 heroes". Empty answers are left out rather than printed as
 * gaps; MMR 0 is the stored "unknown" and captains see the medal instead.
 */
export function signupSummary(reg: SignupSummaryInput): string {
  const standin = reg.type === "STANDIN";
  const parts = [standin ? "Standin" : "Full player"];
  if (reg.mmr > 0) parts.push(`${reg.mmr} MMR`);
  const roles = roleLabels(reg.roles);
  if (roles.length === DOTA_ROLES.length) parts.push("Any position");
  else if (roles.length > 0) parts.push(roles.join(", "));
  const heroes = parseHeroList(reg.favoriteHeroes);
  const heroCount = heroes.matched.length + heroes.unmatched.length;
  if (heroCount > 0) parts.push(heroCount === 1 ? "1 hero" : `${heroCount} heroes`);
  // Standins never enter the captain pool, whatever the stored flag says.
  if (reg.wantsCaptain && !standin) parts.push("Captain volunteer");
  return parts.join(" · ");
}
