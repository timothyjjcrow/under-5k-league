import Link from "next/link";
import { DiscordTag } from "@/components/discord-tag";
import { Countdown } from "@/components/countdown";
import { LocalTime } from "@/components/local-time";
import {
  SteamSignInButton,
  SteamSignInLink,
} from "@/components/steam-sign-in";
import { LinkArrow, PlayerLink, buttonClasses, textLink } from "@/components/ui";
import { formatMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import type { SeasonSnapshot } from "@/lib/queries";
import { DRAFT_PASSED_LABEL } from "@/lib/season-copy";
import { cn } from "@/lib/utils";
import {
  canViewLeagueContact,
  type VisibilityViewer,
} from "@/lib/visibility";

/**
 * The controls and lines more than one phase puts in the hero's control slot:
 * the late standin signup (the draft through the playoffs), the captain's
 * line (signups and the draft) and the viewer's own team (the draft, and the
 * season before its fixtures exist).
 */

/** Signed in without a team: the standin signup is on /me. */
export function StandinSignupLink({
  variant,
}: {
  variant: "primary" | "secondary";
}) {
  return (
    <Link href="/me" className={buttonClasses(variant, "lg")}>
      Register as a standin <LinkArrow />
    </Link>
  );
}

/**
 * Signed out from the draft on, the button just signs in and comes back
 * here: it used to read "Sign in to stand in", which told rostered players
 * opening a Discord link signed out to sign up as standins. Newcomers get
 * the standin route as a line under it (NewcomerStandinLine). Both go straight
 * to Steam, so the sign-in note rides along (/login would otherwise have
 * shown it).
 */
export function SignInHereButton({
  variant,
}: {
  variant: "primary" | "secondary";
}) {
  return (
    <SteamSignInButton next="/" variant={variant}>
      Sign in with Steam <LinkArrow />
    </SteamSignInButton>
  );
}

export function NewcomerStandinLine() {
  return (
    <p className="w-full text-sm text-muted">
      New here?{" "}
      <SteamSignInLink next="/me">Sign in to join as a standin</SteamSignInLink>
    </p>
  );
}

/**
 * The one captain-only line on home before the auction: what a captain can do
 * that week is scout the pool. It deliberately carries no budget or
 * nomination slot. Start sets the MMR-weighted budgets from the final captain
 * pool, and the order can be re-randomised until then, so any figure shown
 * earlier is a guess that can still change. Once the auction runs, the draft
 * room shows the real budget, live.
 *
 * `draftAt` only where nothing else on the page prints the draft time; it then
 * owns saying the time has passed, like every surface that prints it.
 */
export function CaptainLine({
  draftAt,
  className,
}: {
  draftAt?: Date | null;
  className?: string;
}) {
  return (
    <p className={cn("text-sm text-muted", className)}>
      <span className="font-medium text-fg">You’re captaining</span>
      {draftAt ? (
        <>
          {" · "}Draft{" "}
          <LocalTime
            ts={draftAt.getTime()}
            variant="short"
            initial={formatMatchTime(draftAt, "short")}
          />
          <Countdown
            targetMs={draftAt.getTime()}
            eventLabel="Draft"
            passedLabel={DRAFT_PASSED_LABEL}
          />
        </>
      ) : null}
      {" · "}
      <Link href="/players" className={textLink()}>
        Scout the pool <LinkArrow />
      </Link>
    </p>
  );
}

/**
 * The captain's Discord handle for their teammate's team line: members only
 * (the league-wide contact rule), and never the viewer's own.
 */
export async function captainContact(
  viewer: NonNullable<VisibilityViewer>,
  captainId: string,
  viewerHasActiveRegistration: boolean,
) {
  if (
    viewer.id === captainId ||
    !canViewLeagueContact(viewer, captainId, viewerHasActiveRegistration)
  ) {
    return null;
  }
  return prisma.user.findUnique({
    where: { id: captainId },
    select: { discordName: true, discordId: true },
  });
}

/**
 * The viewer's own team in the hero, from the moment they are drafted until
 * their first fixture exists: home listed every roster but never said "you're
 * on Team 3, your captain is ...". A player gets their captain (with the
 * captain's Discord handle, for members); a captain gets their roster count.
 */
export function YourTeamLine({
  team,
  viewerId,
  teamSize,
  captainContact,
  fixturesSoon,
}: {
  team: SeasonSnapshot["teams"][number];
  viewerId: string;
  teamSize: number;
  captainContact: { discordName: string; discordId: string | null } | null;
  /** The auction is over and fixtures are what comes next. */
  fixturesSoon: boolean;
}) {
  const captaining = team.captainId === viewerId;
  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/70 p-4 text-sm backdrop-blur-sm">
      <p className="font-medium [overflow-wrap:anywhere]">
        {captaining ? "Your team: " : "You’re on "}
        <Link href={`/teams/${team.id}`} className={textLink("font-semibold")}>
          {team.name}
        </Link>
      </p>
      {captaining ? (
        <p className="mt-1 text-muted">
          Your roster: {team.members.length}/{teamSize}
          {fixturesSoon ? " · Fixtures coming soon" : ""}
        </p>
      ) : (
        <>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
            <span className="[overflow-wrap:anywhere]">
              Captain{" "}
              <PlayerLink userId={team.captainId} className="text-fg">
                {team.captain.name}
              </PlayerLink>
            </span>
            {captainContact?.discordName ? (
              <DiscordTag
                name={captainContact.discordName}
                verified={!!captainContact.discordId}
              />
            ) : null}
          </p>
          {fixturesSoon ? (
            <p className="mt-1 text-muted">Fixtures coming soon.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
