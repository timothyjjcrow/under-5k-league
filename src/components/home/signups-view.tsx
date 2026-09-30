import Link from "next/link";
import { Suspense } from "react";
import { confirmDraftReadiness } from "@/app/actions/registration";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Countdown } from "@/components/countdown";
import { InviteLink } from "@/components/invite-link";
import { LocalTime } from "@/components/local-time";
import {
  SteamSignInButton,
  SteamSignInNote,
} from "@/components/steam-sign-in";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  DiscordButton,
  EmptyState,
  LinkArrow,
  PlayerLink,
  RankBadge,
  RoleBadges,
  ScheduleCallout,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { DISCORD_INVITE_URL, REGISTRATION_STATUS } from "@/lib/constants";
import {
  DRAFT_READINESS,
  draftReadiness,
  owedDraftConfirmation,
  type DraftReadiness,
} from "@/lib/draft-readiness";
import { draftNightSoon, draftSetupOpen } from "@/lib/draft-setup";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { roleCoverage, shortRolesLine } from "@/lib/pool-stats";
import { prisma } from "@/lib/prisma";
import type { SeasonSnapshot } from "@/lib/queries";
import { DRAFT_PASSED_LABEL } from "@/lib/season-copy";
import { CaptainLine } from "./hero-controls";
import { HeroStat, type HeroParts, type HomeViewer } from "./hero";

/**
 * The hero during signups. Its buttons ask a newcomer to join and point
 * everyone else at How it works (on draft night, the draft room); its counts
 * carry the season's one printing of the draft date; and a player who has
 * signed up gets the SignupsAside panel instead of the buttons.
 */
export function signupsHero(
  snapshot: SeasonSnapshot,
  viewer: HomeViewer,
): HeroParts {
  const { season } = snapshot;
  const { user, isActiveReg, isRemovedReg, captaining } = viewer;
  // Draft night during Signups: from shortly before the scheduled time until
  // the admin presses Start, the hero points everyone at the draft room (a
  // waiting room that goes live by itself) instead of How it works.
  const draftRoomSoon = draftNightSoon(
    season.status,
    season.draftAt?.getTime(),
    // One time snapshot for this render.
    Date.now(),
  );
  // The draft-night confirmation a signed-up player still owes, if any. It is
  // asked in the hero's panel (SignupsAside), so it follows that panel's
  // window: on draft night the panel gives way to the draft room and /me keeps
  // the button.
  const owedConfirmation = !draftRoomSoon
    ? owedDraftConfirmation({
        seasonStatus: season.status,
        draftStatus: snapshot.draftStatus,
        draftAt: season.draftAt,
        draftRevision: season.draftRevision,
        registration: snapshot.myReg,
      })
    : null;

  // How it works rides along during signups: the draft, match nights and
  // who can join, on one screen, for visitors deciding whether to sign up.
  // On draft night the draft room takes its place.
  const sideLink = draftRoomSoon ? (
    <Link href="/draft" className={buttonClasses("accent", "lg")}>
      Enter the draft room <LinkArrow />
    </Link>
  ) : (
    <Link href="/how-it-works" className={buttonClasses("secondary", "lg")}>
      How it works
    </Link>
  );
  const action = !user ? (
    <>
      {/* next=/me: signing in "to join" should land on the signup form. */}
      <SteamSignInButton next="/me">
        Sign in with Steam to join <LinkArrow />
      </SteamSignInButton>
      {sideLink}
      <SteamSignInNote />
    </>
  ) : isRemovedReg ? (
    <>
      <Link href="/me" className={buttonClasses("secondary", "lg")}>
        Signup removed — see details
      </Link>
      {sideLink}
    </>
  ) : !isActiveReg ? (
    <>
      <Link href="/me" className={buttonClasses("primary", "lg")}>
        Join the season <LinkArrow />
      </Link>
      {sideLink}
    </>
  ) : captaining ? (
    <>
      {sideLink}
      <CaptainLine />
    </>
  ) : (
    sideLink
  );

  const { playerCount, capacity } = snapshot;
  const meta = (
    <>
      <HeroStat
        value={playerCount}
        label={playerCount === 1 ? "player signed up" : "players signed up"}
      />
      {/* Both states carry an ASK, because signups never close on a count —
          minTeams is a floor (see capacity.ts). Past it the badge alone was
          the whole story, and "Player minimum met" answers only whether the
          pool floor is covered; it says nothing to the person still deciding
          whether to be in it. The ask keeps the same HeroStat shape as the
          under-minimum one so the marquee reads identically either side of
          the threshold — only what it's counting toward changes. Which team
          number it would be is left to the card below; up here it just has to
          be true forever, and "another team" can't go stale. */}
      {capacity.canDraft ? (
        <>
          <Badge tone="success">Player minimum met</Badge>
          <HeroStat
            value={capacity.toNextTeam}
            label="more for another team"
            tone="accent"
          />
        </>
      ) : (
        <HeroStat
          value={capacity.needed}
          label="more to reach the player minimum"
          tone="accent"
        />
      )}
      {season.draftAt && !owedConfirmation ? (
        // The page's one printing of the draft date: the signup card below
        // used to repeat it with a second countdown. A player who still
        // owes the draft-night confirmation reads it in the hero's panel
        // instead, printed beside the button that confirms it.
        <span className="text-sm text-muted">
          <span aria-hidden>🗓️</span> Draft{" "}
          <strong className="font-medium text-fg">
            <LocalTime
              ts={season.draftAt.getTime()}
              variant="short"
              initial={formatLeagueMatchTime(season.draftAt, "short")}
            />
          </strong>
          {/* passedLabel, because this chip owns the date it prints. Without
              it a slipped draft night read as a plan, since the countdown
              goes quiet 3h past. The season being in SIGNUPS is what makes
              the state reachable at all: the phase does not advance itself. */}
          <Countdown
            targetMs={season.draftAt.getTime()}
            eventLabel="Draft"
            passedLabel={DRAFT_PASSED_LABEL}
          />
        </span>
      ) : null}
    </>
  );

  // A player who has ALREADY signed up gets a panel instead of the buttons.
  // The buttons would greet them with How it works (once the feature tour,
  // "See what you're joining"), a pitch for what they had already joined.
  // What they uniquely can do is fill the rest of the league, and the ask
  // the hero's counts make ("5 more for another team") had no control
  // behind it anywhere on the site. On draft night the panel gives way, so
  // the hero's action column can carry "Enter the draft room" to the
  // players about to be drafted.
  const aside =
    isActiveReg && !draftRoomSoon ? (
      <SignupsAside
        snapshot={snapshot}
        owed={owedConfirmation}
        captaining={captaining}
      />
    ) : null;

  return { action, meta, aside };
}

/**
 * The hero's control slot for a player who has already signed up.
 *
 * MUST always render something — the Hero drops its identity column to full
 * width without an `aside`, so a branch that returns null here would leave a
 * 23rem hole (the rule `MyNextMatch`'s no-match branch exists for).
 *
 * It asks one thing at a time. A player who still owes the draft-night
 * confirmation gets it here as one tap, beside the draft time it confirms:
 * the only other way in was a link a screen further down that opened the top
 * of /me, with the real button far below that. It is the same action and
 * button name as /me, whose button stays; the hero's chip gives up the date
 * for this viewer, so the page still prints it once. Everyone else gets the
 * standing ask, filling the rest of the league, and its control. The numbers
 * behind that ask sit in the hero's own counts and phase line beside this
 * panel, so it states only the ask.
 */
function SignupsAside({
  snapshot,
  owed,
  captaining,
}: {
  snapshot: SeasonSnapshot;
  owed: ReturnType<typeof owedDraftConfirmation>;
  captaining: boolean;
}) {
  const { season } = snapshot;
  const { draftAt } = season;
  const stale = owed === DRAFT_READINESS.STALE;
  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/70 p-4 backdrop-blur-sm sm:p-5">
      {owed && draftAt ? (
        <>
          <p className="font-display text-lg font-semibold">
            {stale ? "The draft time changed" : "You're in"}
          </p>
          <p className="mt-1 text-sm text-muted">
            <span aria-hidden>🗓️</span> Draft night{" "}
            <strong className="font-medium text-fg">
              <LocalTime
                ts={draftAt.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(draftAt, "full")}
              />
            </strong>
            <Countdown
              targetMs={draftAt.getTime()}
              eventLabel="Draft"
              passedLabel={DRAFT_PASSED_LABEL}
            />
          </p>
          <p className="mt-1 text-sm text-muted">
            {stale
              ? "Confirm the new time so the admins know you can still make it."
              : "Confirm you’ve seen the time and still plan to play this season."}
          </p>
          <ActionForm
            action={confirmDraftReadiness}
            className="mt-3"
            hidden={{
              expectedActiveSeasonId: season.id,
              draftRevision: String(season.draftRevision),
              draftAtTs: String(draftAt.getTime()),
            }}
          >
            <SubmitButton
              variant={stale ? "accent" : "primary"}
              className="w-full"
            >
              {stale ? "Confirm updated draft time" : "Confirm I’m ready for draft"}
            </SubmitButton>
          </ActionForm>
        </>
      ) : (
        <>
          <p className="font-display text-lg font-semibold">You&apos;re in</p>
          <p className="mt-1 text-sm text-muted">Know anyone who&apos;d fit?</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <InviteLink />
            <Link href="/how-it-works" className={textLink("text-sm")}>
              How it works <LinkArrow />
            </Link>
          </div>
          <p className="mt-2 text-xs text-muted">
            Copies this season&apos;s link — it unfurls with the details in
            Discord.
          </p>
        </>
      )}
      {captaining ? (
        <CaptainLine className="mt-3 border-t border-line-soft pt-3" />
      ) : null}
    </div>
  );
}

/**
 * What the draft-night confirmation says about the viewer, as one plain status
 * line. A badge and a link used to say "Confirm draft night" twice here, and
 * the link only opened the top of /me.
 */
function draftReadinessStatus(readiness: DraftReadiness): string {
  switch (readiness) {
    case DRAFT_READINESS.READY:
      return "Draft night confirmed ✓";
    case DRAFT_READINESS.STALE:
      return "Draft time changed — not confirmed yet";
    default:
      return "Draft night not confirmed yet";
  }
}

/**
 * Everything below the hero during signups. The counts, the minimum and the
 * draft date live in the hero ONCE: this view used to restate them in a signup
 * card heading, a progress sentence and four stat tiles (whose figures are
 * /players' own strip), so "37 signed up" printed three times and "3 more for
 * another team" three ways. What is left here is what the hero can't carry:
 * the viewer's own signup, and who is in.
 */
export function SignupsView({
  snapshot,
  loggedIn,
}: {
  snapshot: SeasonSnapshot;
  loggedIn: boolean;
}) {
  const { season, capacity, myReg } = snapshot;
  const isActivePlayer = myReg?.status === "ACTIVE" && myReg.type === "PLAYER";
  const isStandin = myReg?.status === "ACTIVE" && myReg.type === "STANDIN";
  const isRemoved = myReg?.status === REGISTRATION_STATUS.REMOVED;
  const myDraftReadiness =
    isActivePlayer &&
    season.draftAt &&
    draftSetupOpen(season.status, snapshot.draftStatus)
      ? draftReadiness(myReg, season.draftRevision)
      : null;

  return (
    <div className="space-y-6">
      {/* Signed out, the hero's pitch already names the match night. */}
      {loggedIn ? <ScheduleCallout label={season.matchSchedule} /> : null}
      {/* The viewer's own signup, as a status line. Joining is the hero's
          button (a second "Sign in with Steam to join" sat a screen below
          it), and a removed signup is the hero's "Signup removed" button. */}
      {isActivePlayer || isStandin ? (
        <Card>
          <CardHeader
            headingLevel={2}
            className="border-b-0"
            title={
              isStandin
                ? "You’re registered as a standin"
                : "You’re signed up to play"
            }
            subtitle={
              <>
                Teams of {season.teamSize}
                {season.maxMmr > 0 ? ` · ${season.maxMmr} MMR soft limit` : ""}
                {myDraftReadiness
                  ? ` · ${draftReadinessStatus(myDraftReadiness)}`
                  : ""}
              </>
            }
            action={
              <Link
                href={
                  myDraftReadiness && myDraftReadiness !== DRAFT_READINESS.READY
                    ? "/me#draft-commitment"
                    : "/me"
                }
                className={buttonClasses("secondary")}
              >
                {isStandin ? "Switch to full player" : "Review your signup"}
              </Link>
            }
          />
        </Card>
      ) : null}
      {/* One Discord CTA in <main> at a time. A signed-up player who hasn't
          linked gets <DiscordSetupPrompt> above, which sequences the SAME
          invite as "1. Join the server" and a link step after it, so this
          row is for everyone that prompt can't cover. */}
      {!isActivePlayer && !isStandin && !isRemoved && DISCORD_INVITE_URL ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm">
          <p className="min-w-[min(14rem,100%)] flex-1 text-muted">
            {loggedIn
              ? "Questions before you join? Ask in the league Discord."
              : "Questions before you sign up? Ask in the league Discord."}
          </p>
          <DiscordButton />
        </div>
      ) : null}

      <Suspense fallback={<CardSkeleton rows={2} />}>
        <WhoIsIn
          seasonId={season.id}
          playerCount={snapshot.playerCount}
          teamsNeeded={Math.max(season.minTeams, capacity.teamsFormable)}
          captains={snapshot.teams.map((team) => team.captain)}
        />
      </Suspense>
    </div>
  );
}

type SignupChipPlayer = {
  userId: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  roles: string;
  mmr: number;
};

/** The latest signups shown beside the captains, however many captains. */
const WHO_IS_IN_LATEST = 12;

/**
 * "Who's in": the captains first (they used to have a card of their own,
 * "Captains so far", repeating half this list), then the latest signups, and
 * one line on the positions the pool is short of. That line replaces a whole
 * card of role and MMR bars whose buckets were mostly empty; /players keeps
 * the scouting detail.
 */
async function WhoIsIn({
  seasonId,
  playerCount,
  teamsNeeded,
  captains,
}: {
  seasonId: string;
  playerCount: number;
  teamsNeeded: number;
  captains: SeasonSnapshot["teams"][number]["captain"][];
}) {
  const captainIds = captains.map((captain) => captain.id);
  const [pool, latest] = await Promise.all([
    prisma.registration.findMany({
      where: { seasonId, status: "ACTIVE", type: "PLAYER" },
      select: { userId: true, roles: true, mmr: true },
    }),
    prisma.registration.findMany({
      where: {
        seasonId,
        status: "ACTIVE",
        type: "PLAYER",
        userId: { notIn: captainIds },
      },
      // Only the fields the chips render — this list serializes into the page.
      select: {
        userId: true,
        roles: true,
        mmr: true,
        user: { select: { name: true, avatar: true, rankTier: true } },
      },
      orderBy: { createdAt: "desc" },
      take: WHO_IS_IN_LATEST,
    }),
  ]);
  const signupOf = new Map(pool.map((reg) => [reg.userId, reg]));
  // A captain is in the pool through their own signup; one without an active
  // player signup isn't "in" as a player, so the chip would be a claim the
  // count beside it doesn't make.
  const captainChips: SignupChipPlayer[] = captains.flatMap((captain) => {
    const reg = signupOf.get(captain.id);
    return reg
      ? [
          {
            userId: captain.id,
            name: captain.name,
            avatar: captain.avatar,
            rankTier: captain.rankTier,
            roles: reg.roles,
            mmr: reg.mmr,
          },
        ]
      : [];
  });
  const latestChips: SignupChipPlayer[] = latest.map((reg) => ({
    userId: reg.userId,
    name: reg.user.name,
    avatar: reg.user.avatar,
    rankTier: reg.user.rankTier,
    roles: reg.roles,
    mmr: reg.mmr,
  }));
  const shown = captainChips.length + latestChips.length;
  const shortage = shortRolesLine(roleCoverage(pool), teamsNeeded, pool.length);

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Who's in"
        /* Names the cap: the list stops at the latest few, so a 30-player
           season silently hid 18 people behind a "View all →" that gave no
           reason to click. */
        subtitle={
          captainChips.length > 0
            ? `Captains first, then the latest signups${shown < playerCount ? ` · ${shown} of ${playerCount} players` : ""}`
            : shown < playerCount
              ? `Latest ${shown} of ${playerCount} players`
              : "Latest players to sign up"
        }
        action={
          <Link href="/players" className={textLink("text-sm")}>
            View all <LinkArrow />
          </Link>
        }
      />
      <CardBody className="space-y-3">
        {shown === 0 ? (
          <EmptyState
            title="No signups yet"
            description="Be the first to join this season."
          />
        ) : (
          <>
            {shortage ? <p className="text-sm text-muted">{shortage}</p> : null}
            {/* Compact on phones: name, captain mark and MMR only, so the
                chips wrap two to a row instead of stacking twelve tall rows
                of medals and bare role digits. */}
            <div className="flex flex-wrap gap-2">
              {captainChips.map((player) => (
                <SignupChip key={player.userId} player={player} captain />
              ))}
              {latestChips.map((player) => (
                <SignupChip key={player.userId} player={player} />
              ))}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SignupChip({
  player,
  captain = false,
}: {
  player: SignupChipPlayer;
  captain?: boolean;
}) {
  return (
    <PlayerLink
      userId={player.userId}
      className="flex min-w-6 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface-2/50 py-1 pl-1 pr-2.5 hover:border-muted/60 hover:no-underline sm:gap-2 sm:pr-3"
    >
      <Avatar name={player.name} src={player.avatar} size={22} />
      <span className="min-w-0 truncate text-sm">{player.name}</span>
      {captain ? (
        <span
          title="Captain"
          className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-accent/40 bg-accent/15 px-1 text-[11px] font-semibold text-accent"
        >
          <span aria-hidden>C</span>
          <span className="sr-only">captain</span>
        </span>
      ) : null}
      <RankBadge rankTier={player.rankTier} className="hidden sm:inline-flex" />
      <RoleBadges roles={player.roles} className="hidden sm:inline-flex" />
      {player.mmr > 0 ? (
        <span className="shrink-0 text-xs text-muted">{player.mmr} MMR</span>
      ) : null}
    </PlayerLink>
  );
}
