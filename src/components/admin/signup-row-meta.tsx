import { Suspense } from "react";
import { approvedMedalMmr } from "@/lib/medal-approval";
import { type GuildMembership } from "@/lib/discord-roles";
import { membershipChipView, signupFlags } from "@/lib/signup-readiness";
import { DiscordTag } from "@/components/discord-tag";
import { Badge, RoleBadges } from "@/components/ui";
import type { AdminData } from "@/components/admin/season-admin-data";

/** signupFlags for one registration row (the chips and the review filter). */
export function regSignupFlags(reg: AdminData["players"][number], maxMmr: number) {
  return signupFlags(
    {
      mmr: reg.mmr,
      roles: reg.roles,
      favoriteHeroes: reg.favoriteHeroes,
      statement: reg.statement,
      captainNote: reg.captainNote,
      rankTier: reg.user.rankTier,
    },
    {
      maxMmr,
      medalApproved: approvedMedalMmr(reg.user.medalApproval) !== null,
    },
  );
}

/** A signup row's chip line and medal editor on one line; the editor,
 *  opened, takes the full width under it. */
export const ROW_META_LINE =
  "mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 [&>div]:mt-0 [&>details]:mt-0 [&>details[open]]:basis-full";

/**
 * The readiness line under each row of the signup-moderation lists — the
 * prune pass the panel exists for: is this signup reachable on Discord,
 * plausible on MMR, and filled in enough to draft? Every fact on it is
 * DB-only and renders inline on the blocking path; the ONE
 * Discord-dependent fact (live server membership) streams in behind a
 * row-level Suspense over the shared sweep, so the row's make-captain /
 * remove controls never swap component instances underneath a click — only
 * the chip does (which is why this doesn't inherit StartDraftControl's
 * accepted lost-pending-state trade-off). `sweep` is null when no bot+guild
 * is configured: membership is unknowable then, and the row renders exactly
 * what it always rendered (the funnel's `guild: null` rule).
 */
export function SignupRowMeta({
  reg,
  sweep,
  maxMmr,
  leading,
}: {
  reg: AdminData["players"][number];
  sweep: Promise<Map<string, GuildMembership>> | null;
  /** Season.maxMmr: the soft limit the "over soft limit" flag reads. */
  maxMmr: number;
  /** Row-specific badges shown first in the chip line. */
  leading?: React.ReactNode;
}) {
  const flags = regSignupFlags(reg, maxMmr);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {leading}
      {reg.user.discordId ? (
        <>
          {/* Verified ✓ = proven OWNERSHIP of the handle (the OAuth link) —
              deliberately not membership; the chip beside it answers that. */}
          <DiscordTag
            name={reg.user.discordName}
            verified
            className="min-w-0"
          />
          {sweep ? (
            <Suspense
              fallback={
                <Badge
                  className="opacity-60"
                  title="Checking the league's Discord server for this account…"
                >
                  checking Discord…
                </Badge>
              }
            >
              <MembershipChip
                sweep={sweep}
                discordId={reg.user.discordId}
                handle={reg.user.discordName}
              />
            </Suspense>
          ) : null}
        </>
      ) : (
        <>
          <Badge
            tone="danger"
            title="Hasn't linked a Discord account — match-found mentions, week reminders and pings can't reach them. A typed handle beside this is unverified text, not a link."
          >
            no Discord link
          </Badge>
          {/* The hand-typed handle, when they left one: unverified (no ✓),
              but still the admin's best lead for chasing them. Renders
              nothing when blank. */}
          <DiscordTag name={reg.user.discordName} className="min-w-0" />
        </>
      )}
      <RoleBadges roles={reg.roles} />
      {flags.map((f) => (
        <Badge key={f.key} tone={f.tone} title={f.detail}>
          {f.label}
        </Badge>
      ))}
    </div>
  );
}

/**
 * One row's live membership verdict, resolved from the card-wide sweep. All
 * four states (member / pending / not-member / couldn't-check) and their
 * copy live in the tested membershipChipView — including the two rules the
 * words must keep: unknown is neutral, never a negative, and a not-member
 * verdict names the LINKED account.
 */
async function MembershipChip({
  sweep,
  discordId,
  handle,
}: {
  sweep: Promise<Map<string, GuildMembership>>;
  discordId: string;
  handle: string;
}) {
  const byId = await sweep;
  const chip = membershipChipView(byId.get(discordId) ?? null, handle);
  return (
    <Badge tone={chip.tone} title={chip.detail}>
      {chip.label}
    </Badge>
  );
}
