import { prisma } from "@/lib/prisma";
import { getGuildConfig } from "@/lib/discord-roles";
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
}: {
  linkAvailable: boolean;
  autoJoins: boolean;
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
            <a
              href="/api/auth/discord"
              className={buttonClasses("primary", "md")}
            >
              Link Discord &amp; join the server
            </a>
          ) : (
            <>
              <DiscordButton label="1. Join the server" />
              {linkAvailable ? (
                <a
                  href="/api/auth/discord"
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
 * Data wrapper for the dashboard. Renders NOTHING unless the viewer is signed
 * up for this season and hasn't linked — which is exactly the cohort every
 * Discord notification in the app silently skips.
 *
 * Deliberately its own component behind its own <Suspense> rather than more
 * fields on getSeasonSnapshot: those selects are trimmed on purpose, and this
 * is two indexed reads that must never delay the hero paint.
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
  if (user?.discordId) return null;

  return (
    <DiscordSetupCard
      linkAvailable={
        !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET)
      }
      autoJoins={!!getGuildConfig()}
    />
  );
}
