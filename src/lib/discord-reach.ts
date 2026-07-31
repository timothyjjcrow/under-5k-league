// The reach funnel's SHAPE and its pure copy builders, split from
// discord-roles.ts because that module imports prisma and these are needed by
// a "use client" component (ChaseCopy) — a client bundle must never drag the
// DB in. discord-roles re-exports everything here, so server callers keep
// their import path.

/**
 * A player in the funnel's guild lists: site name + the Discord handle of
 * the account they LINKED. The handle is load-bearing, not decoration — the
 * membership check runs against the linked account BY ID, so "in the Discord
 * but flagged missing" almost always means they linked a different account
 * (an alt, an old one) than the person sitting in the server. Without the
 * handle that reads as "the site is wrong" and cannot be checked; with it,
 * an admin searches the handle in the member list and sees the truth in
 * seconds, and the player knows exactly which account to fix.
 */
export type ReachPlayer = { name: string; handle: string };

/**
 * getDiscordReach plus the step it cannot see: of the linked, who is actually
 * IN the server? `guild: null` = no bot+guild configured, membership is
 * unknowable. Name lists are UNCAPPED — the chase message has to name
 * everyone; display capping is the card's concern.
 */
export type DiscordReachFunnel = {
  registered: number;
  linked: number;
  unlinkedNames: string[];
  guild: {
    inServer: number;
    /** In the server but behind Membership Screening — unpingable until they
     *  accept the rules. */
    pending: number;
    pendingNames: ReachPlayer[];
    /** The LINKED ACCOUNT is definitively not in the server — which is a
     *  fact about the account, not always the human (see ReachPlayer). */
    missing: number;
    missingNames: ReachPlayer[];
    /** Linked players we couldn't get an answer for — an outage or rate
     *  limit, but ALSO a bot that can't see the server at all (kicked, wrong
     *  guild id, reset token), which answers this way FOREVER. Reported as
     *  its own number, never lumped into missing; getPingHealth (rendered on
     *  the same admin card, and it runs without a ping role) is what names
     *  which cause. */
    unknown: number;
  } | null;
};

/** "A, B, C +2 more" — the cap keeps a confirm dialog a dialog. Site names
 *  only: the confirm is glanced at mid-click; the handles live on the card
 *  and in the chase message, where they can actually be acted on. */
function nameRun(players: ReachPlayer[], total: number): string {
  const shown = players.slice(0, 6).map((p) => p.name);
  return (
    shown.join(", ") + (total > shown.length ? ` +${total - shown.length} more` : "")
  );
}

/**
 * The reachability line appended to the Start-draft confirm. House rule: a
 * destructive confirm states the real numbers BEFORE the click — and this is
 * the last moment chasing a join is cheap, because after the draft these
 * players are on rosters that need to schedule with them.
 *
 * Missing and pending players are NAMED (they're the actionable, deceptive
 * cohort — each believes they're done); never-linked players are a count only,
 * since their names are already on the Discord card and a confirm has to stay
 * readable. `unknown` players appear as a caveat, not as missing. Empty string
 * when there is nothing to warn about, so the confirm is byte-identical to
 * what shipped before this existed.
 */
export function discordReachWarning(reach: DiscordReachFunnel): string {
  const parts: string[] = [];
  if (reach.guild) {
    const g = reach.guild;
    if (g.missing > 0) {
      parts.push(
        `${g.missing} ${g.missing === 1 ? "is" : "are"} not in the Discord server (${nameRun(g.missingNames, g.missing)})`,
      );
    }
    if (g.pending > 0) {
      parts.push(
        `${g.pending} ${g.pending === 1 ? "hasn't" : "haven't"} accepted the server rules (${nameRun(g.pendingNames, g.pending)})`,
      );
    }
    if (g.unknown > 0) {
      // Never claim the cause: this reads the same for a Discord blip and for
      // a bot that can't see the server at all. The card is where the
      // checklist that CAN tell them apart lives.
      parts.push(
        `${g.unknown} couldn't be checked (the Discord notifications card has the diagnosis)`,
      );
    }
  }
  const unlinked = reach.registered - reach.linked;
  if (unlinked > 0) {
    parts.push(`${unlinked} never linked Discord at all`);
  }
  if (parts.length === 0) return "";
  return ` Reachability: of ${reach.registered} signed-up players, ${parts.join("; ")} — captains may not be able to reach them for scheduling.`;
}

const ZWSP = "​";

/**
 * Make a Steam persona safe to PASTE into Discord as message text. This is
 * NOT escapeDiscordText: backslash-escapes would litter the admin's compose
 * box, and markdown styling in a pasted name is harmless. What is NOT
 * harmless, even in a user-typed message: a persona of literally "@everyone"
 * mass-pings the server when the sender has Mention Everyone (an admin
 * does), a newline forges message lines, and a bare URL auto-links into
 * something that reads league-authored. Zero-width splices neutralise all
 * three while leaving the name visually identical. Pure — tested.
 */
export function pasteSafeName(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .replace(/@/g, `@${ZWSP}`)
    .replace(/(https?):\/\//gi, `$1:${ZWSP}//`)
    .replace(/\bwww\./gi, `www${ZWSP}.`);
}

/**
 * The paste-into-Discord chase message, built from the funnel. The site
 * cannot notify the unlinked (that is the whole problem this feature maps),
 * so the last mile is a HUMAN posting in the channel — this hands the admin
 * that post instead of a report to transcribe. Names everyone (no display
 * caps — a chase that names 12 of 28 isn't a chase); every name passes
 * through pasteSafeName, because the names most worth chasing come from the
 * one cohort anyone can join. "The league can reach you", not "your captain"
 * — during signups most players don't have one yet. Null when there is
 * nobody to chase.
 */
export function discordChaseMessage(
  reach: DiscordReachFunnel,
  opts: { inviteUrl: string; profileUrl: string },
): string | null {
  const names = (list: string[]) => list.map(pasteSafeName).join(", ");
  // Missing players are listed WITH the handle of the account they linked —
  // the check is about that account, and "your linked account" is the phrase
  // that keeps this honest for the player who is sitting in the server on a
  // different one. The remedy line covers both cases: join on the linked
  // account, or re-link the account they actually use.
  const withHandles = (list: ReachPlayer[]) =>
    list
      .map((p) =>
        p.handle
          ? `${pasteSafeName(p.name)} (linked @${pasteSafeName(p.handle)})`
          : pasteSafeName(p.name),
      )
      .join(", ");
  const blocks: string[] = [];
  if (reach.guild && reach.guild.missing > 0) {
    blocks.push(
      `Your LINKED Discord account isn't in the league server — join on it (${opts.inviteUrl}), or if you're in the server on a different account, re-link that one instead: ${opts.profileUrl}\n` +
        withHandles(reach.guild.missingNames),
    );
  }
  if (reach.guild && reach.guild.pending > 0) {
    blocks.push(
      "In the server but still need to accept the rules (top of the channel list) — until then nothing can ping you:\n" +
        withHandles(reach.guild.pendingNames),
    );
  }
  const unlinked = reach.registered - reach.linked;
  if (unlinked > 0) {
    blocks.push(
      `Signed up but haven't linked Discord on the site (being in the server isn't enough — linking is what connects your Discord to your signup, so pings reach you): ${opts.profileUrl}\n` +
        names(reach.unlinkedNames),
    );
  }
  if (blocks.length === 0) return null;
  return `League Discord check:\n\n${blocks.join("\n\n")}`;
}
