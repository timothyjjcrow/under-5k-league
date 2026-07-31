import { prisma } from "@/lib/prisma";
import { getGuildConfig, memoGuildMembership } from "@/lib/discord-roles";
import { REGISTRATION_STATUS } from "@/lib/constants";
import { Card, CardBody, DiscordButton, buttonClasses } from "@/components/ui";

// The "you signed up, now finish" prompt.
//
// Signing up and being REACHABLE are two different things, and until now the
// site only ever asked for the second one in a card near the bottom of /me —
// a page a player opens once. This is the same ask, rendered at the moment
// they've just proved intent, and it disappears the instant it's satisfied
// (derived from discordId, never dismissed into a stored flag — a nag that can
// be dismissed permanently is a nag that stops working, and one that outlives
// the thing it asks for is worse).

/** The OAuth kickoff href. `next` is where a fully successful link should
 *  land — the flow is a full-page round-trip that used to always dump the
 *  player on /me, which was wrong for everyone who clicked from the
 *  dashboard. Unset keeps the /me landing (and its ?discord= note). */
function linkHref(next?: string): string {
  return next
    ? `/api/auth/discord?next=${encodeURIComponent(next)}`
    : "/api/auth/discord";
}

/**
 * Presentational, server-safe. `autoJoins` is the difference between the two
 * configurations the league can be in: with a bot token + guild id the OAuth
 * consent carries `guilds.join`, so ONE button links the account and puts them
 * in the server. Without it, joining is a separate trip through the invite.
 * Never promise the one-click version we can't perform.
 */
export function DiscordSetupCard({
  linkAvailable,
  autoJoins,
  next,
}: {
  linkAvailable: boolean;
  autoJoins: boolean;
  next?: string;
}) {
  // Nothing configured at all: the invite still works, so still worth asking.
  const oneClick = linkAvailable && autoJoins;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          {/* A real heading: this card asks the single most consequential
              thing on the dashboard, and as a <p> it was invisible to heading
              navigation — the page's outline jumped h1 straight to the h3s of
              cards further down, skipping both this and the signup card. */}
          <h2 className="font-display text-lg font-semibold">
            {oneClick
              ? "You're signed up — one step left"
              : linkAvailable
                ? "You're signed up — two things left"
                : "You're signed up — one step left"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            The league runs on Discord: scheduling, match-night check-ins and
            standin scrambles all happen there. Right now your captain has no
            way to reach you.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {oneClick ? (
            <a href={linkHref(next)} className={buttonClasses("primary", "md")}>
              Link Discord &amp; join the server
            </a>
          ) : (
            <>
              <DiscordButton label="1. Join the server" />
              {linkAvailable ? (
                <a
                  href={linkHref(next)}
                  className={buttonClasses("primary", "md")}
                >
                  2. Link your account
                </a>
              ) : null}
            </>
          )}
        </div>

        <p className="text-xs text-muted">
          {oneClick
            ? "Sign in with Discord once — it proves the handle is yours and adds you to the server. We only ever read your username."
            : linkAvailable
              ? "Linking proves the handle is really yours, so pings actually reach you. We only ever read your username."
              : "Your handle is how captains find you."}
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * The second half of the same ask, for the cohort that LOOKS finished: linked
 * (verified ✓ everywhere) but not actually in the league's server — or in it
 * behind Membership Screening's rules gate, which is "in the guild" in name
 * only, since nothing can ping a pending member. Every notification the
 * league sends silently misses both, and until this card existed nothing
 * anywhere ever said so after the one-shot ?discord= note was scrubbed.
 *
 * Only ever rendered when the caller has POSITIVELY determined the state — an
 * unknown (Discord down, no bot) must render nothing rather than nag a player
 * who is standing in the server.
 */
export function DiscordJoinCard({
  membership,
  linkAvailable,
  next,
}: {
  membership: "not-member" | "pending";
  linkAvailable: boolean;
  next?: string;
}) {
  const pending = membership === "pending";
  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <h2 className="font-display text-lg font-semibold">
            {pending
              ? "Almost there — accept the server rules"
              : "One step left — join the Discord server"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {pending
              ? "You're in the league's Discord, but until you accept its rules nothing can reach you — no match pings, no scheduling, no standin scrambles."
              : "Your Discord is linked, but you're not in the league's server — that's where scheduling, check-ins and standin scrambles happen, and your captain has no way to reach you until you join."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!pending && linkAvailable ? (
            /* Re-running the OAuth link re-consents guilds.join with a fresh
               token — a genuine one-click join for an already-linked player.
               This card only renders when a bot is configured (membership is
               unknowable otherwise). The invite rides along as the escape
               hatch: when the auto-join itself is what's broken (bot missing
               CREATE_INSTANT_INVITE, mismatched app), the OAuth button alone
               would bounce the player through consent back to this exact card
               forever. Distinct label on purpose — two controls named "Join
               the server" on one page is the one-control-one-name defect. */
            <>
              <a
                href={linkHref(next)}
                className={buttonClasses("primary", "md")}
              >
                Join the server
              </a>
              <DiscordButton label="Use the invite instead" />
            </>
          ) : (
            <DiscordButton
              label={pending ? "Open the server" : "Join the server"}
            />
          )}
        </div>

        <p className="text-xs text-muted">
          {pending
            ? "The rules screen is at the top of the server — one click and you're reachable."
            : "Your handle is already verified; this just puts you where the league talks."}
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * Data wrapper for the dashboard. Renders NOTHING unless the viewer is signed
 * up for this season and is short a step: not linked (the setup card — the
 * cohort every Discord notification in the app silently skips), or linked but
 * not (fully) in the server (the join card — the cohort that looks reachable
 * and isn't). Membership is the memoised live read; unknown renders nothing.
 *
 * Deliberately its own component behind its own <Suspense> rather than more
 * fields on getSeasonSnapshot: those selects are trimmed on purpose, and this
 * must never delay the hero paint.
 */
export async function DiscordSetupPrompt({
  userId,
  seasonId,
}: {
  userId: string;
  seasonId: string;
}) {
  const [reg, user] = await Promise.all([
    prisma.registration.findUnique({
      where: { seasonId_userId: { seasonId, userId } },
      select: { status: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { discordId: true },
    }),
  ]);
  if (reg?.status !== REGISTRATION_STATUS.ACTIVE) return null;

  const linkAvailable = !!(
    process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
  );
  const guildCfg = getGuildConfig();
  // next="/": these instances live on the dashboard, and a successful link
  // should put the player back where they clicked, not on /me.
  if (!user?.discordId) {
    return (
      <DiscordSetupCard
        linkAvailable={linkAvailable}
        autoJoins={!!guildCfg}
        next="/"
      />
    );
  }
  if (!guildCfg) return null; // membership unknowable — nothing to ask

  const membership = await memoGuildMembership(user.discordId, guildCfg);
  if (membership !== "not-member" && membership !== "pending") return null;
  return (
    <DiscordJoinCard
      membership={membership}
      linkAvailable={linkAvailable}
      next="/"
    />
  );
}
