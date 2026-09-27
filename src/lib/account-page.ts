// Pure copy and ordering for My account (/me). No database or Discord calls:
// the page reads the facts and these helpers decide what to say.

import type { ActionResult } from "./action-result";
import {
  DRAFT_STATUS,
  HARD_MMR_CEILING,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "./constants";
import {
  clampMmrToRank,
  mmrRangeForRankTier,
  rankMedalName,
} from "./rank";
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

export type DiscordNote = { tone: "success" | "danger" | "muted"; text: string };

// The Discord OAuth callback bounces outcomes back to /me as ?discord=<code>.
// Only KNOWN codes map to copy; the raw query value is never echoed (same
// injection/phishing hygiene as the login page's ?error=).
const DISCORD_LINK_NOTES: Record<string, DiscordNote> = {
  linked: {
    tone: "success",
    text: "Discord linked — your handle is now verified.",
  },
  joined: {
    tone: "success",
    text: "Discord linked and you're in the league server — that's everything.",
  },
  joined_pending: {
    tone: "muted",
    text: "Discord linked and you've been added to the server — open it and accept the rules, otherwise nobody can ping you.",
  },
  join_failed: {
    tone: "muted",
    text: "Discord linked. We couldn't add you to the server automatically — join it with the button below.",
  },
  denied: {
    tone: "muted",
    text: "Discord link cancelled — nothing was changed.",
  },
  taken: {
    tone: "danger",
    text: "That Discord account is already linked to another player — sign in to that account and unlink it there first.",
  },
  state: {
    tone: "danger",
    text: "That link attempt expired or didn't start here — try Link Discord again.",
  },
  error: {
    tone: "danger",
    text: "Discord didn't confirm the link — give it another try.",
  },
  unconfigured: {
    tone: "danger",
    text: "Discord linking isn't available right now — ask a league admin.",
  },
  session: {
    tone: "danger",
    text: "Your site session expired while Discord was open. Sign in again, then retry the link.",
  },
};

/**
 * The one-shot note for a ?discord= code. An unknown code gets the generic
 * error, and the hasOwnProperty guard stops ?discord=__proto__ (or toString)
 * resolving an inherited value. The note was minted by the CALLBACK, while
 * the membership check ran just now, so the live answer wins: a player who was
 * already in the server when the auto-join failed must not read "join it with
 * the button below" under "In the server ✓" with no such button on the page.
 */
export function discordLinkNote(
  param: string | undefined,
  membership: AccountMembership,
): DiscordNote | null {
  if (!param) return null;
  if (
    (param === "join_failed" || param === "joined_pending") &&
    membership === "member"
  ) {
    return DISCORD_LINK_NOTES.joined;
  }
  if (param === "join_failed" && membership === "pending") {
    return DISCORD_LINK_NOTES.joined_pending;
  }
  return Object.prototype.hasOwnProperty.call(DISCORD_LINK_NOTES, param)
    ? DISCORD_LINK_NOTES[param]
    : DISCORD_LINK_NOTES.error;
}

/** A button on the Discord card: the OAuth round trip, or the invite link. */
export type DiscordCta = { kind: "oauth" | "invite"; label: string };

export type DiscordCardCtas = {
  /** The one main button for this state, or null when nothing is left. */
  primary: DiscordCta | null;
  /** The invite, kept beside a one-click OAuth button: when the auto-join
   *  itself is broken (bot missing CREATE_INSTANT_INVITE, mismatched app),
   *  OAuth alone bounces the player back to this card forever. */
  secondary: DiscordCta | null;
};

export type DiscordCardInput = {
  linked: boolean;
  membership: AccountMembership;
  /** OAuth linking is configured (client id + secret). */
  linkAvailable: boolean;
  /** The OAuth consent also carries guilds.join (bot + guild configured). */
  autoJoins: boolean;
  /** The league has an invite link (Europe may not). */
  hasInvite: boolean;
  /** The one-shot ?discord= code from the OAuth callback, if any. */
  param?: string;
};

/**
 * Which buttons the one Discord card on /me shows. One primary per state,
 * every label distinct within a state, and an unknown membership (no bot,
 * Discord slow) never produces a join button on a guess: only the callback's
 * own one-shot report can ask for one then.
 */
export function discordCardCtas(input: DiscordCardInput): DiscordCardCtas {
  const oneClick = input.linkAvailable && input.autoJoins;
  const invite = (label: string): DiscordCta | null =>
    input.hasInvite ? { kind: "invite", label } : null;
  if (!input.linked) {
    if (!input.linkAvailable) {
      return { primary: invite("Join the server"), secondary: null };
    }
    return oneClick
      ? {
          primary: { kind: "oauth", label: "Link Discord & join the server" },
          secondary: invite("Use the invite instead"),
        }
      : {
          primary: { kind: "oauth", label: "Link Discord" },
          secondary: invite("Join the server"),
        };
  }
  if (input.membership === "not-member") {
    return oneClick
      ? {
          // Re-running OAuth re-consents guilds.join with a fresh token: a
          // real one-click join, and it re-links whichever account the
          // browser is signed into.
          primary: { kind: "oauth", label: "Join the server" },
          secondary: invite("Use the invite instead"),
        }
      : { primary: invite("Join the server"), secondary: null };
  }
  if (input.membership === "pending") {
    return { primary: invite("Open Discord"), secondary: null };
  }
  if (input.membership === null) {
    if (input.param === "join_failed") {
      return { primary: invite("Join the server"), secondary: null };
    }
    if (input.param === "joined_pending") {
      return { primary: invite("Open Discord"), secondary: null };
    }
  }
  return { primary: null, secondary: null };
}

/**
 * One toast for My account's single refresh button, which runs the Steam
 * and OpenDota refreshes side by side. Each half's own message already names
 * its provider, so the halves are joined; one failed half still reports what
 * the other did. Both on cooldown reads as one sentence, not two.
 */
export function mergeAccountRefresh(
  steam: ActionResult,
  dota: ActionResult,
): ActionResult {
  const steamError = steam?.error;
  const dotaError = dota?.error;
  if (steamError && dotaError) {
    if (/refreshed recently/.test(steamError) && /refreshed recently/.test(dotaError)) {
      return {
        error:
          "Your Steam and Dota info were refreshed recently — wait about a minute before trying again.",
      };
    }
    return { error: `${steamError} · ${dotaError}` };
  }
  const parts = [
    steamError ?? steam?.message,
    dotaError ?? dota?.message,
  ].filter((part): part is string => !!part);
  return { message: parts.join(" · ") || "Steam and Dota info refreshed" };
}

/** The auction is running (live or paused): the pool is frozen. */
export function auctionRunning(draftStatus: string | null | undefined): boolean {
  return (
    draftStatus === DRAFT_STATUS.IN_PROGRESS ||
    draftStatus === DRAFT_STATUS.PAUSED
  );
}

export type SignupChoiceInput = {
  seasonStatus: string;
  /** The season's draft row status; null or undefined when there is none. */
  draftStatus: string | null | undefined;
  /** This season's signup, in any status; null when there is none. */
  existing: { type: string; status: string } | null;
};

/**
 * Whether "Full player" is a real choice on the signup form. Mirrors the
 * server instead of guessing: registrationGate takes anyone as a full player
 * during SIGNUPS and lets a former full player (still active, or withdrawn by
 * their own hand) keep or retake it later, and saveRegistration refuses a
 * withdrawn player's return only while the auction runs. The page used to
 * lock the choice for every withdrawn player after SIGNUPS, so an accidental
 * withdrawal during draft setup could not be undone. An admin removal never
 * reaches the form at all.
 */
export function fullPlayerChoiceOpen(input: SignupChoiceInput): boolean {
  if (input.seasonStatus === SEASON_STATUS.SIGNUPS) return true;
  const existing = input.existing;
  if (!existing || existing.type !== REGISTRATION_TYPE.PLAYER) return false;
  if (existing.status === REGISTRATION_STATUS.ACTIVE) return true;
  return (
    existing.status === REGISTRATION_STATUS.WITHDRAWN &&
    !auctionRunning(input.draftStatus)
  );
}

/**
 * A self-withdrawn full player can't come back at all while the auction
 * runs: saveRegistration refuses both the return as a player and the switch
 * to standin until the draft finishes.
 */
export function rejoinPausedByDraft(input: SignupChoiceInput): boolean {
  return (
    input.existing?.type === REGISTRATION_TYPE.PLAYER &&
    input.existing.status === REGISTRATION_STATUS.WITHDRAWN &&
    auctionRunning(input.draftStatus)
  );
}

/**
 * The Withdraw button's confirm, said before the click: which pool you leave
 * and when you can come back, by what the server actually allows (a former
 * full player may rejoin as one in any phase except while the auction runs;
 * a standin may re-register until the season ends).
 */
export function withdrawConfirmText(input: {
  type: string;
  seasonStatus: string;
  draftStatus: string | null | undefined;
}): string {
  const ask = "Withdraw from this season?";
  if (input.type === REGISTRATION_TYPE.STANDIN) {
    return `${ask} You'll leave the standin pool, so captains can't book you as cover. You can register again from this page until the season ends.`;
  }
  if (auctionRunning(input.draftStatus)) {
    return `${ask} You'll leave the draft pool now, and you can't rejoin until the draft finishes.`;
  }
  const draftDone =
    input.draftStatus === DRAFT_STATUS.COMPLETE ||
    (input.seasonStatus !== SEASON_STATUS.SIGNUPS &&
      input.seasonStatus !== SEASON_STATUS.DRAFT);
  if (draftDone) {
    return `${ask} You'll leave the free-agent pool, so admins can't sign you to a team. You can rejoin from this page until the season ends.`;
  }
  return `${ask} You'll leave the draft pool, so captains can't pick you. You can rejoin from this page, but not while the draft is running.`;
}

/**
 * The one line above the MMR box: the medal first, since many players don't
 * know their exact number, then what a blank does. The window's display is
 * capped at the ceiling, the form's max, even where the tolerance runs past
 * it. Null when the medal alone rules the player out (the page says so in
 * its own danger line).
 */
export function mmrLeadLine(rankTier: number | null | undefined): string | null {
  const window = mmrRangeForRankTier(rankTier);
  if (!window) {
    return "Type your MMR, or leave it blank if you're not sure.";
  }
  const max =
    window.max === null
      ? HARD_MMR_CEILING
      : Math.min(window.max, HARD_MMR_CEILING);
  if (window.min > HARD_MMR_CEILING) return null;
  const medal = `Your ${rankMedalName(rankTier)} medal ≈ ${window.min}–${max} MMR.`;
  return window.min > 0
    ? `${medal} Leave it blank and we'll list you at ${window.min}, or type your exact MMR.`
    : `${medal} Type your exact MMR, or leave it blank if you're not sure.`;
}

/** The ceiling and the soft limit, in one short line under the MMR box. */
export function mmrRulesLine(softLimit: number): string {
  const ceiling = `We don't take anyone over ${HARD_MMR_CEILING} MMR (no Immortals).`;
  return softLimit > 0
    ? `${ceiling} Above ${softLimit} you can still sign up, and an admin reviews your signup.`
    : ceiling;
}

export type MmrPreviewInput = {
  /** The MMR box's raw value ("" when blank). */
  typed: string;
  rankTier: number | null;
  /** This season's stored MMR when a signup row exists (any status). */
  storedMmr: number | null;
  /** An active full-player signup while the auction runs: the server keeps
   *  the stored number whatever is typed. */
  frozen: boolean;
};

/**
 * "You'll be listed at …", updated as the player types. DISPLAY ONLY: it
 * mirrors saveRegistration (the raw claim is judged against the ceiling, an
 * unchanged number is never re-clamped, a live auction freezes it, anything
 * else outside the medal's window snaps to its floor), but the server still
 * decides and says so in its toast. Null when the box holds something the
 * browser will refuse anyway.
 */
export function mmrPreviewLine(
  input: MmrPreviewInput,
): { tone: "muted" | "danger"; text: string } | null {
  const raw = input.typed.trim();
  if (raw !== "" && !/^\d+$/.test(raw)) return null;
  const typed = raw === "" ? 0 : Number(raw);
  if (typed > HARD_MMR_CEILING) {
    return {
      tone: "danger",
      text: `Over ${HARD_MMR_CEILING} MMR: this league can't take the signup.`,
    };
  }
  if (raw !== "" && typed === 0) return null;
  const listed = (mmr: number) =>
    mmr > 0 ? `${mmr} MMR` : "an unknown MMR";
  if (input.frozen && input.storedMmr != null) {
    return {
      tone: "muted",
      text: `The draft is running, so you stay listed at ${listed(input.storedMmr)} until it ends.`,
    };
  }
  if (input.storedMmr != null && typed === input.storedMmr) {
    return { tone: "muted", text: `You're listed at ${listed(typed)}.` };
  }
  const check = clampMmrToRank(typed, input.rankTier);
  if (check.mmr === 0) {
    return {
      tone: "muted",
      text: check.adjusted
        ? `${typed} doesn't fit your medal, so you'll be listed at an unknown MMR and captains will judge by the medal.`
        : "You'll be listed at an unknown MMR.",
    };
  }
  if (!check.adjusted) {
    return { tone: "muted", text: `You'll be listed at ${check.mmr} MMR.` };
  }
  return {
    tone: "muted",
    text:
      typed === 0
        ? `Left blank, you'll be listed at ${check.mmr} MMR, your medal's low end.`
        : `${typed} is outside your medal's range, so you'll be listed at ${check.mmr} MMR.`,
  };
}
