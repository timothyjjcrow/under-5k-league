import Link from "next/link";
import { ContextBackLink } from "@/components/context-back-link";
import { DiscordTag } from "@/components/discord-tag";
import {
  Avatar,
  Badge,
  LinkArrow,
  RankMedal,
  RoleBadges,
  textLink,
} from "@/components/ui";
import { heroPortrait, type Hero } from "@/lib/heroes";
import { pubTitle, pubToken } from "@/lib/player-pool";
import type { PoolPub, PubActivity } from "@/lib/pub-stats";
import { roleLabels } from "@/lib/roles";

/**
 * A joined player's profile header: the back link, then the banner with their
 * name, badges, signup and pub facts, outbound links, members-only contact,
 * team and their own About text. Every fact arrives precomputed; the page
 * decides what is shown and to whom.
 */
export function ProfileHeader({
  user,
  isSelf,
  canSeeLeagueContact,
  comparable,
  signatureHero,
  isCaptain,
  isStandin,
  wantsCaptainNow,
  subtitle,
  subtitleIsPastSeason,
  signup,
  pubScout,
  pubLast,
  nowMs,
  accountId,
  team,
  draftPrice,
  signupAbout,
}: {
  user: {
    id: string;
    name: string;
    avatar: string | null;
    role: string;
    rankTier: number | null;
    profileUrl: string | null;
    discordName: string;
    discordId: string | null;
    fhUnavailable: boolean | null;
  };
  isSelf: boolean;
  /** The shared league-contact policy (canViewLeagueContact): the Discord
   *  tokens and the private-match-data flag are members-only. */
  canSeeLeagueContact: boolean;
  /** Has an imported league game, so the Compare page can list them. */
  comparable: boolean;
  /** Banner backdrop: their most-played or first favorite hero. */
  signatureHero: Hero | null;
  isCaptain: boolean;
  isStandin: boolean;
  wantsCaptainNow: boolean;
  subtitle: string | null;
  /** The subtitle is their latest past league line, not the current season's
   *  (they aren't in it), so it carries no "Edit your signup" link. */
  subtitleIsPastSeason: boolean;
  /** Their ACTIVE signup this season, if any. */
  signup: { mmr: number; roles: string } | null;
  pubScout: PoolPub | null;
  pubLast: PubActivity | null;
  nowMs: number;
  accountId: number | null;
  /** Their team this season, if drafted. */
  team: { id: string; name: string } | null;
  /** What a drafted non-captain went for; null hides the line. */
  draftPrice: number | null;
  /** What they wrote about themselves on the signup. */
  signupAbout: string | null;
}) {
  const roles = roleLabels(signup?.roles);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <ContextBackLink href="/players" className={textLink("text-sm")}>
          ← All players
        </ContextBackLink>
        {/* Compare lists players with an imported league game (the same
            trusted lines as gameRows); anyone else, such as a standin who
            never played, would open onto "Player unavailable". */}
        {comparable ? (
          <Link
            href={`/players/compare?a=${user.id}`}
            className={textLink("text-sm")}
          >
            Compare vs… <LinkArrow />
          </Link>
        ) : null}
      </div>
      <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-br from-surface-2/70 via-surface/50 to-surface/30 shadow-sm">
        {/* Signature hero portrait fading in from the right. */}
        {signatureHero ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-2/3 sm:w-1/2"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={heroPortrait(signatureHero)}
              alt=""
              className="profile-hero-bg h-full w-full object-cover object-center opacity-30"
            />
          </div>
        ) : null}
        {/* Ambient graphics shared with the home hero for brand cohesion. */}
        <div
          aria-hidden
          className="hero-grid pointer-events-none absolute inset-0 opacity-50"
        />
        <div
          aria-hidden
          className="animate-hero-glow pointer-events-none absolute -left-8 top-0 h-40 w-40 -translate-y-1/3 rounded-full bg-brand/20 blur-3xl"
        />
        <div
          aria-hidden
          className="animate-hero-glow-alt pointer-events-none absolute -right-8 bottom-0 h-40 w-40 translate-y-1/3 rounded-full bg-accent/15 blur-3xl"
        />
        <div className="relative flex flex-wrap items-center gap-5 p-6">
          <Avatar
            name={user.name}
            src={user.avatar}
            size={88}
            className="shrink-0 shadow-lg shadow-black/40 ring-2 ring-line/80"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="font-display text-3xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">
                {user.name}
              </h1>
              {user.role === "ADMIN" ? (
                <Badge tone="accent">Admin</Badge>
              ) : null}
              {isCaptain ? <Badge tone="accent">Captain</Badge> : null}
              {isStandin ? <Badge tone="info">Standin</Badge> : null}
              {wantsCaptainNow ? (
                <Badge tone="neutral">Wants to captain</Badge>
              ) : null}
              <RankMedal rankTier={user.rankTier} size={34} showLabel />
            </div>
            {subtitle ? (
              <div className="mt-1 text-sm text-muted">
                {subtitle}
                {/* The signup link belongs to the current season's line,
                    not to a past season's. */}
                {isSelf && !subtitleIsPastSeason ? (
                  <>
                    {" · "}
                    <Link href="/me" className={textLink()}>
                      Edit your signup →
                    </Link>
                  </>
                ) : null}
              </div>
            ) : null}
            {/* gap-y-2, not gap-y-1.5: every link in this row carries
                TAP_SAFE, which grows the hit box 4px above and below, so two
                wrapped rows need >=8px between them. At 6px the Dotabuff and
                OpenDota boxes overlapped by 2px (measured) and OpenDota
                painted last, so a tap on the bottom edge of Dotabuff opened
                OpenDota. Same rule player-pool.tsx already states: hit boxes
                may touch, never overlap. */}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
              {signup ? (
                <span>
                  <span className="font-semibold text-fg">{signup.mmr}</span>{" "}
                  MMR
                </span>
              ) : null}
              {roles.length > 0 ? <RoleBadges roles={signup?.roles} /> : null}
              {pubScout ? (
                <span
                  className="tabular-nums"
                  title={pubTitle(pubScout, nowMs)}
                >
                  {pubToken(pubScout, nowMs)}
                </span>
              ) : null}
              {pubLast?.quiet ? (
                /* The consequence is part of the text, not a tooltip: a
                   phone never shows a title, and "last played 5mo ago"
                   alone doesn't say why a captain should care. Measured
                   when the snapshot was taken, and only while it is
                   recent (pubLastPlayed). */
                <span title="No visible pub games in over two months when their pub stats were last checked, so the listed MMR may describe who they used to be">
                  last played {pubLast.label} · MMR may be stale
                </span>
              ) : null}
              {user.profileUrl ? (
                <a
                  href={user.profileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={textLink()}
                >
                  Steam ↗
                </a>
              ) : null}
              {accountId ? (
                <>
                  <a
                    href={`https://www.dotabuff.com/players/${accountId}`}
                    target="_blank"
                    rel="noreferrer"
                    className={textLink()}
                  >
                    Dotabuff ↗
                  </a>
                  <a
                    href={`https://www.opendota.com/players/${accountId}`}
                    target="_blank"
                    rel="noreferrer"
                    className={textLink()}
                  >
                    OpenDota ↗
                  </a>
                </>
              ) : null}
              {canSeeLeagueContact ? (
                <DiscordTag
                  name={user.discordName}
                  verified={!!user.discordId}
                />
              ) : null}
              {canSeeLeagueContact && !user.discordName ? (
                /* Members-only like the tag itself: on draft night the
                   absence IS the information — this player can't be reached
                   where the league lives. The player themself gets the fix,
                   not just the fact. */
                isSelf ? (
                  <Link href="/me#profile-discord" className={textLink()}>
                    Add your Discord →
                  </Link>
                ) : (
                  <span
                    className="text-muted"
                    title="No Discord linked or entered. The league coordinates on Discord, so reaching this player takes extra work"
                  >
                    no Discord
                  </span>
                )
              ) : null}
            </div>
            {canSeeLeagueContact && user.fhUnavailable === true ? (
              /* Members-only operational flag, like the Discord tokens
                 above. === true on purpose: null is UNKNOWN and unknown must
                 never render as a negative. Its own line, because the
                 explanation used to live only in a hover title, and the
                 player it is about needs the fix spelled out. */
              <p className="mt-2 text-xs text-muted">
                <span className="font-medium text-danger">
                  Private match data.
                </span>{" "}
                {isSelf ? (
                  <>
                    Expose Public Match Data is off in your Dota client, so
                    your games can&apos;t auto-import.{" "}
                    <Link href="/me#profile-dota" className={textLink()}>
                      How to turn it on →
                    </Link>
                  </>
                ) : (
                  "Expose Public Match Data is off in their Dota client, so their games can't auto-import and results need a manual report."
                )}
              </p>
            ) : null}
          </div>
          {team ? (
            // basis-full below sm: this card and the name column are flex
            // siblings, and the column carries `min-w-0` (it must, or a long
            // name widens the page). min-w-0 sets its min-content
            // contribution to ZERO, so the row can never overflow and
            // `flex-wrap` NEVER FIRES — the card kept its full 153px and the
            // name column absorbed the whole shortfall. Measured at 375px it
            // was 12px wide, and `[overflow-wrap:anywhere]` on the h1 then
            // rendered the player's name ONE CHARACTER PER LINE: a 504px-tall
            // h1 in a 908px hero card, with Dotabuff/OpenDota squeezed to
            // 57px and wrapped onto two lines ~940px down. Broken at every
            // phone width, healthy by 640px — which is why it never showed up
            // on a desktop. Taking the card out of the line is the fix that
            // cannot backfire: the floor has to go on the item that is
            // ALLOWED to shrink, and a min-width on the name column instead
            // overflows the page below ~320px.
            <Link
              href={`/teams/${team.id}`}
              className="basis-full rounded-lg border border-line bg-surface/60 px-4 py-2 text-sm backdrop-blur transition-colors hover:border-muted/60 sm:basis-auto"
            >
              <div className="text-xs uppercase tracking-wide text-muted">
                Team
              </div>
              <div className="font-medium">{team.name}</div>
              {draftPrice != null ? (
                <div className="text-xs text-muted">
                  Drafted for ${draftPrice}
                </div>
              ) : null}
            </Link>
          ) : null}
          {signupAbout ? (
            // Their own words, once, under the header. Full width so a
            // long answer wraps instead of squeezing the name.
            <dl className="basis-full border-t border-line/60 pt-4 text-sm">
              <div className="min-w-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted">
                  About
                </dt>
                <dd className="mt-0.5 whitespace-pre-line [overflow-wrap:anywhere]">
                  {signupAbout}
                </dd>
              </div>
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The whole profile of an account that has joined nothing yet. */
export function UnjoinedProfile({
  user,
  isSelf,
}: {
  user: { name: string; avatar: string | null; role: string };
  isSelf: boolean;
}) {
  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3">
          <ContextBackLink href="/players" className={textLink("text-sm")}>
            ← All players
          </ContextBackLink>
        </div>
        <div className="flex flex-wrap items-center gap-5 rounded-[var(--radius)] border border-line bg-gradient-to-br from-surface-2/70 via-surface/50 to-surface/30 p-6 shadow-sm">
          <Avatar
            name={user.name}
            src={user.avatar}
            size={88}
            className="shrink-0 shadow-lg shadow-black/40 ring-2 ring-line/80"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="font-display text-3xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">
                {user.name}
              </h1>
              {user.role === "ADMIN" ? (
                <Badge tone="accent">Admin</Badge>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted">
              Hasn&apos;t joined a season yet
            </p>
            {isSelf ? (
              <p className="mt-2.5 text-sm text-muted">
                Your profile fills in once you sign up for a season or play an
                inhouse.{" "}
                <Link href="/me" className={textLink()}>
                  Go to My account <LinkArrow />
                </Link>
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
