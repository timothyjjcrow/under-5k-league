import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import {
  saveRegistration,
  confirmDraftReadiness,
  leaveLeague,
  updateDotaAccount,
  refreshRank,
  refreshSteamProfile,
  updateDiscordName,
  unlinkDiscord,
  setInhousePingOptIn,
} from "@/app/actions/registration";
import { DiscordTag } from "@/components/discord-tag";
import {
  fetchGuildMember,
  getGuildConfig,
  getRoleConfig,
  primeMembershipMemo,
} from "@/lib/discord-roles";
import { DiscordJoinCard, DiscordSetupCard } from "@/components/discord-setup";
import { StripQueryParam } from "@/components/strip-query-param";
import { steamIdToAccountId } from "@/lib/dota";
import { pendingCoverWhere } from "@/lib/standin";
import { DRAFT_PASSED_LABEL } from "@/lib/season-copy";
import { HARD_MMR_CEILING, REGISTRATION_TYPE } from "@/lib/constants";
import { DRAFT_READINESS, draftReadiness } from "@/lib/draft-readiness";
import {
  formatMmrRange,
  mmrRangeForRankTier,
  rankMedalName,
  rankTierExactMinMmr,
} from "@/lib/rank";
import { DOTA_ROLES, parseRoles } from "@/lib/roles";
import { matchPhaseLabel } from "@/lib/schedule";
import { formatMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { Countdown } from "@/components/countdown";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { HeroPicker } from "@/components/hero-picker";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  DiscordButton,
  PageTitle,
  RankBadge,
  ScheduleCallout,
  TeamCrest,
  buttonClasses,
  textLink,
} from "@/components/ui";

export const metadata = { title: "Your profile" };

// The Discord OAuth callback bounces outcomes back here as ?discord=<code>.
// Map only KNOWN codes to copy — never echo the raw query value (same
// injection/phishing hygiene as the login page's ?error=).
const DISCORD_LINK_NOTES: Record<
  string,
  { tone: "success" | "danger" | "muted"; text: string }
> = {
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
    text: "Discord linking isn't set up on this server yet (admin: set DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET).",
  },
};

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<{ discord?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/me");
  const { discord: discordParam } = await searchParams;
  // hasOwnProperty guard: a crafted ?discord=__proto__/constructor/toString
  // would otherwise resolve an inherited truthy value past the ?? fallback
  // and render an empty note instead of the generic error copy.
  const discordNote = discordParam
    ? Object.prototype.hasOwnProperty.call(DISCORD_LINK_NOTES, discordParam)
      ? DISCORD_LINK_NOTES[discordParam]
      : DISCORD_LINK_NOTES.error
    : null;
  // Server component, so we can check the OAuth app config directly and only
  // offer "Link Discord" when clicking it can actually work.
  const discordLinkAvailable = !!(
    process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
  );
  // With a bot + server configured the OAuth consent also carries
  // `guilds.join`, so linking adds them to the server in the same click. The
  // copy has to match what the consent screen actually asks for.
  const guildCfg = getGuildConfig();
  const discordAutoJoins = !!guildCfg;

  const season = await getActiveSeason();
  const reg = season
    ? await prisma.registration.findUnique({
        where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
      })
    : null;

  // Returning player: no signup for this season yet, but one from a past
  // season — carry those answers into the fresh form so they don't retype.
  const previous =
    season && !reg
      ? await prisma.registration.findFirst({
          where: { userId: user.id, NOT: { seasonId: season.id } },
          orderBy: { createdAt: "desc" },
          include: { season: { select: { name: true } } },
        })
      : null;
  const form = reg ?? previous;

  const dbUser = await prisma.user.findUnique({ where: { id: user.id } });

  // ONE live member lookup answers both questions this page has about the
  // linked account: is the player actually IN the league's server (linking
  // proves ownership of the handle; only membership makes them reachable), and
  // do they hold the ping role. `membership` null = we can't tell — no bot
  // configured, or Discord didn't answer — and null renders as the plain
  // "Linked ✓" card, never as "not in the server": telling a player they left
  // a server they're sitting in reads as broken (the hasPingRole rule).
  const memberInfo =
    dbUser?.discordId && guildCfg
      ? await fetchGuildMember(dbUser.discordId, guildCfg)
      : null;
  const membership = memberInfo === null ? null : memberInfo.membership;
  if (dbUser?.discordId && guildCfg) {
    // Keep the dashboard's memoised join nag in step with what this page is
    // about to render — the player mid-fix is exactly who would notice the
    // two surfaces disagreeing for a memo window.
    primeMembershipMemo(dbUser.discordId, membership);
  }
  // The ?discord= note was minted by the CALLBACK; the membership check ran
  // just now — and the callback can be wrong about the present: a player who
  // was ALREADY in the server when the auto-join 403'd (mismatched app,
  // missing invite permission) arrives with ?discord=join_failed while the
  // live check says "member". Rendering the param's copy verbatim put "we
  // couldn't add you — join it with the button below" directly under an
  // "In the server ✓" badge, with no such button anywhere on the page. The
  // live answer wins; the param is still scrubbed either way.
  const discordNoteResolved =
    (discordParam === "join_failed" || discordParam === "joined_pending") &&
    membership === "member"
      ? DISCORD_LINK_NOTES.joined
      : discordParam === "join_failed" && membership === "pending"
        ? DISCORD_LINK_NOTES.joined_pending
        : discordNote;
  // Inhouse ping opt-in. `on: null` = we genuinely don't know (Discord slow,
  // or the player isn't in the server) — rendered as unknown rather than "off",
  // because showing an unticked box to someone already opted in makes them
  // click it and change nothing, which reads as broken.
  const pingCfg = dbUser?.discordId ? await getRoleConfig() : null;
  const pingOptIn = {
    available: !!pingCfg,
    on: pingCfg
      ? memberInfo && memberInfo.membership !== "not-member"
        ? memberInfo.roles.includes(pingCfg.roleId)
        : null
      : false,
  };
  // The medal's plausible MMR window — signup claims outside it are snapped
  // to its floor by saveRegistration, so tell the player up front. A medal
  // whose EXACT band floor clears the hard ceiling (Divine 3+/Immortal) is
  // ineligible outright — registrationGate will reject it whatever they type.
  const mmrWindow = mmrRangeForRankTier(dbUser?.rankTier ?? null);
  const medalFloor = rankTierExactMinMmr(dbUser?.rankTier ?? null);
  const medalBlocked = medalFloor != null && medalFloor > HARD_MMR_CEILING;

  // Your-season context: the roster seat (from DRAFT on) or, for standins,
  // the matches they've been assigned to cover.
  const member =
    season
      ? await prisma.teamMember.findUnique({
          where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
          include: { team: true },
        })
      : null;
  // Gated on "ACTIVE and not rostered" — the SAME predicate the assign pools
  // use — never on type: both assign forms deliberately offer undrafted
  // PLAYER-type free agents as cover ("anyone registered but undrafted"), and
  // the type gate hid this card from exactly those people. The member check
  // rides below (isRostered), so a rostered player never sees a stray card.
  const standinAssignments =
    season && reg?.status === "ACTIVE"
      ? await prisma.standinAssignment.findMany({
          where: pendingCoverWhere(user.id, season.id),
          include: { match: { include: { homeTeam: true, awayTeam: true } } },
          orderBy: { match: { week: "asc" } },
        })
      : null;
  const isRostered = !!member;
  const isCaptain = !!member?.isCaptain;

  const isRegistered = reg?.status === "ACTIVE";
  const signupsOpen = season?.status === "SIGNUPS";
  // Post-signups, PLAYER stays available only to those already registered as
  // one (matches registrationGate — standins can't upgrade mid-season). The
  // locked tile must also not stay default-checked: disabled radios don't
  // submit, so the form would silently fall back to PLAYER and get rejected.
  const playerLocked =
    !signupsOpen && !(isRegistered && reg?.type === "PLAYER");
  const myRoles = parseRoles(form?.roles);
  const myDraftReadiness = reg
    ? draftReadiness(reg, season?.draftRevision ?? 0)
    : DRAFT_READINESS.AWAITING;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageTitle title="Your profile" />

      {/* Signed up but unreachable. Above the fold rather than in the Discord
          card below, because that card is what everyone has already scrolled
          past. Gone the moment discordId exists. */}
      {isRegistered && !dbUser?.discordId ? (
        <DiscordSetupCard
          linkAvailable={discordLinkAvailable}
          autoJoins={discordAutoJoins}
        />
      ) : isRegistered &&
        (membership === "not-member" || membership === "pending") ? (
        /* Linked but not (fully) in the server — the cohort that LOOKS done.
           Same above-the-fold placement as the setup card, same derived-state
           rule: it disappears the moment the join/rules step is complete. */
        <DiscordJoinCard
          membership={membership}
          linkAvailable={discordLinkAvailable}
          handle={dbUser?.discordName}
        />
      ) : null}

      <Card>
        {/* Two separate defects, both here all along, and only one of them is
            about width.

            THE SQUASH is what `shrink-0` fixes: Avatar sets width/height but
            bakes in no shrink floor (callers pass one), so beside the name
            block and the button column it rendered 19px wide inside its 56px
            box — measured still squashed at 430px, i.e. on every phone made.
            It is not width-dependent and no overflow check can see it.

            THE OVERFLOW is the 17-digit SteamID64, one unbreakable token,
            pushing this row past its own card: 58px at 320px, 18px at 360px,
            3px at 375px, and gone by 390px. `min-w-0` + `break-all` and
            `flex-wrap` + `basis-full` EACH fix that on their own (verified by
            reverting one at a time) — both are kept because they do different
            jobs: the first stops the id widening the row, the second gives the
            buttons their own line rather than a 135px sliver of this one.

            Note which item carries the floor. It goes on the column that is
            ALLOWED to leave the line; a min-width on the min-w-0 child instead
            is the trap that broke the player profile hero. */}
        <CardBody className="flex flex-wrap items-center gap-4">
          <Avatar
            name={user.name}
            src={user.avatar}
            size={56}
            className="shrink-0"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-xl font-semibold">
                {user.name}
              </span>
              {user.role === "ADMIN" ? (
                <Badge tone="accent">Admin</Badge>
              ) : null}
              <RankBadge rankTier={dbUser?.rankTier} />
            </div>
            <a
              href={dbUser?.profileUrl ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="break-all text-sm text-muted hover:text-fg"
            >
              Steam: {user.steamId}
            </a>
          </div>
          <div className="ml-auto flex basis-full flex-col items-end gap-2 sm:basis-auto">
            <ActionForm action={refreshSteamProfile}>
              <SubmitButton variant="secondary" size="sm">
                Refresh from Steam
              </SubmitButton>
            </ActionForm>
            <Link
              href={`/players/${user.id}`}
              className={textLink("whitespace-nowrap text-sm")}
            >
              View public profile →
            </Link>
          </div>
        </CardBody>
      </Card>

      <DotaAccountCard
        effectiveId={dbUser?.dotaAccountId ?? steamIdToAccountId(user.steamId)}
        override={dbUser?.dotaAccountId ?? null}
        rankTier={dbUser?.rankTier ?? null}
        fhUnavailable={dbUser?.fhUnavailable ?? null}
      />

      {/* The league coordinates on Discord — this is how captains reach their
          roster for scheduling, check-ins, and standin scrambles. Linking via
          OAuth proves account ownership; the typed handle is the fallback. */}
      <Card>
        <CardHeader
          title="Discord"
          subtitle={
            dbUser?.discordId
              ? membership === "member"
                ? "Linked and in the league's Discord server — your handle is verified, and captains can reach you."
                : "Linked via Discord — your handle is verified, and shown to signed-in league members."
              : dbUser?.discordName
                ? "Shown to signed-in league members on rosters and the player pool."
                : "Add your Discord so your captain can reach you — it's how the league talks."
          }
          action={
            /* The badge only claims what this render actually verified:
               membership when the bot could answer, plain "Linked ✓" when it
               couldn't (no bot, or Discord down) — an unknown must never be
               downgraded to "Not in the server". */
            dbUser?.discordId ? (
              membership === "member" ? (
                <Badge tone="success">In the server ✓</Badge>
              ) : membership === "pending" ? (
                <Badge tone="info">Rules pending</Badge>
              ) : membership === "not-member" ? (
                <Badge tone="danger">Not in the server</Badge>
              ) : (
                <Badge tone="success">Linked ✓</Badge>
              )
            ) : null
          }
        />
        <CardBody className="space-y-3">
          {discordNoteResolved ? <StripQueryParam param="discord" /> : null}
          {discordNoteResolved ? (
            <p
              role="status"
              className={
                discordNoteResolved.tone === "success"
                  ? "rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
                  : discordNoteResolved.tone === "danger"
                    ? "rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
                    : "rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm text-muted"
              }
            >
              {discordNoteResolved.text}
            </p>
          ) : null}
          {/* Both of these leave the player linked but not actually reachable,
              so the note must come with the way out of it. Only rendered when
              the live membership check below couldn't run (membership null) —
              when it could, the durable strip carries the same CTA and two
              stacked join buttons would fight over one click. */}
          {(discordParam === "join_failed" ||
            discordParam === "joined_pending") &&
          membership === null ? (
            <DiscordButton
              size="sm"
              label={
                discordParam === "joined_pending"
                  ? "Open the server"
                  : "Join the server"
              }
            />
          ) : null}
          {/* Durable membership state — unlike the one-shot ?discord= note,
              this is re-derived live on every render, so it survives the
              scrubbed query param and disappears the moment the join (or the
              rules screen) is actually done. */}
          {membership === "not-member" ? (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
              <p className="text-danger">
                {/* "The account you linked", never "you" — the check is about
                    the linked account BY ID, and the commonest cause of this
                    state is a player sitting in the server on a DIFFERENT
                    account than the one they linked. Naming the handle makes
                    that self-diagnosable. */}
                The Discord account you linked
                {dbUser?.discordName ? ` (@${dbUser.discordName})` : ""}
                {/* Quoted string: JSX line-trimming eats a plain leading
                    space after an expression across a source-line break. */}
                {" isn't in the league's server — that's where scheduling, match-night check-ins and standin scrambles happen, and nothing can reach you until it is. In the server on a different account? Use the Join button at the top of this page — it re-links whichever account your browser is signed into, so one click fixes both."}
              </p>
              <div className="mt-2">
                {/* The INVITE, deliberately not the one-click OAuth join. This
                    strip sits directly under the ?discord=join_failed note
                    ("join it with the button below"), i.e. it renders for the
                    player whose auto-join just FAILED — offering them the same
                    OAuth round-trip again is a loop, and the invite works
                    regardless of the bot's health. The one-click join lives in
                    the DiscordJoinCard at the top of the page; the distinct
                    label keeps one accessible name per control. */}
                <DiscordButton size="sm" label="Join via the invite" />
              </div>
            </div>
          ) : membership === "pending" ? (
            <div className="rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm">
              <p className="text-muted">
                You&apos;re in the server but haven&apos;t accepted its rules
                yet — until you do, nothing can ping you: not match found, not
                your captain.
              </p>
              <div className="mt-2">
                {/* "Open Discord", not "Open the server" — the top-of-page
                    DiscordJoinCard's pending CTA already carries that name,
                    and two controls with one accessible name is the /players
                    "Clear filters" defect. */}
                <DiscordButton size="sm" label="Open Discord" />
              </div>
            </div>
          ) : null}
          {dbUser?.discordId ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <DiscordTag name={dbUser.discordName} verified />
                <ActionForm action={unlinkDiscord}>
                  <SubmitButton
                    variant="secondary"
                    size="sm"
                    confirm="Unlink Discord? Your handle disappears from rosters until you link or type one again."
                  >
                    Unlink
                  </SubmitButton>
                </ActionForm>
              </div>

              {/* Self-serve opt-in to the inhouse ping role. Only offered when
                  the league has actually configured one — advertising a
                  notification that can't fire is worse than not offering it. */}
              {pingOptIn.available ? (
                <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-[14rem] flex-1">
                      <p className="text-sm font-medium">
                        Ping me for inhouse games
                      </p>
                      <p className="text-xs text-muted">
                        Get a Discord notification when a queue is filling up and
                        when your match is found. Off by default, and you can
                        turn it back off here any time.
                      </p>
                    </div>
                    <ActionForm action={setInhousePingOptIn}>
                      <input
                        type="hidden"
                        name="on"
                        value={pingOptIn.on ? "0" : "1"}
                      />
                      <SubmitButton
                        variant={pingOptIn.on ? "secondary" : "primary"}
                        size="sm"
                      >
                        {pingOptIn.on ? "Turn off" : "Turn on"}
                      </SubmitButton>
                    </ActionForm>
                  </div>
                  {pingOptIn.on === null ? (
                    <p className="mt-2 text-xs text-muted">
                      Couldn&apos;t check your current setting — either Discord is
                      slow right now, or you&apos;re not in the league&apos;s
                      server yet.
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-muted">
                      Currently <b>{pingOptIn.on ? "on" : "off"}</b>.
                    </p>
                  )}
                </div>
              ) : null}
            </>
          ) : (
            <>
              {discordLinkAvailable ? (
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href="/api/auth/discord"
                    className={buttonClasses("primary", "sm")}
                  >
                    {discordAutoJoins
                      ? "Link Discord & join the server"
                      : "Link Discord"}
                  </a>
                  <span className="text-xs text-muted">
                    {/* This has to describe the real consent screen. With
                        guilds.join in the scope, "we only see your username"
                        is still true of what we READ — but it stops being the
                        whole story, and a player who spots the gap has every
                        reason to distrust the rest. */}
                    {discordAutoJoins
                      ? "Sign in with Discord once — proves the handle is really yours and adds you to the league server. We only ever read your username; the join is the only thing we ask to do."
                      : "Sign in with Discord once — proves the handle is really yours. We only ever see your username, nothing else."}
                  </span>
                  {!isRegistered && signupsOpen ? (
                    <span className="text-xs text-muted">
                      This leaves the page — if you&apos;ve started filling in
                      the signup below, save it first.
                    </span>
                  ) : null}
                </div>
              ) : null}
              <ActionForm
                action={updateDiscordName}
                className="flex flex-wrap items-center gap-2"
              >
                <input
                  name="discordName"
                  defaultValue={dbUser?.discordName ?? ""}
                  placeholder="or type it — e.g. dendi_official"
                  aria-label="Discord username"
                  maxLength={40}
                  className="h-10 w-full max-w-xs rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
                />
                <SubmitButton variant="secondary" size="sm">
                  Save
                </SubmitButton>
                <span className="text-xs text-muted">
                  Blank clears it. Legacy Name#1234 tags work too.
                </span>
              </ActionForm>
            </>
          )}
        </CardBody>
      </Card>

      {!season ? (
        <Card>
          <CardBody className="text-center text-muted">
            There is no active season to sign up for right now.
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={`Signup — ${season.name}`}
            subtitle={
              isRegistered
                ? `You're currently ${reg?.type === "STANDIN" ? "a standin" : "signed up to play"}.`
                : signupsOpen
                  ? "Fill this out to join the season."
                  : "Player signups are closed, but you can still register as a standin."
            }
            action={
              isRegistered ? (
                <Badge tone={reg?.type === "STANDIN" ? "info" : "success"}>
                  {reg?.type === "STANDIN" ? "Standin" : "Playing"}
                </Badge>
              ) : null
            }
          />
          <CardBody className="space-y-5">
            {season.draftAt && season.status === "SIGNUPS" ? (
              <p className="text-sm text-muted">
                🗓️ Draft night:{" "}
                <strong className="text-fg">
                  <LocalTime
                    ts={season.draftAt.getTime()}
                    variant="full"
                    initial={formatMatchTime(season.draftAt, "full")}
                  />
                </strong>
                <Countdown
                  targetMs={season.draftAt.getTime()}
                  eventLabel="Draft"
                  passedLabel={DRAFT_PASSED_LABEL}
                />
              </p>
            ) : null}
            {season.draftAt &&
            signupsOpen &&
            isRegistered &&
            reg?.type === REGISTRATION_TYPE.PLAYER ? (
              <div
                className={
                  myDraftReadiness === DRAFT_READINESS.READY
                    ? "rounded-lg border border-success/35 bg-success/10 px-4 py-3"
                    : "rounded-lg border border-accent/35 bg-accent/10 px-4 py-3"
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-medium text-fg">Draft commitment</h4>
                      {myDraftReadiness === DRAFT_READINESS.READY ? (
                        <Badge tone="success">Ready for draft ✓</Badge>
                      ) : myDraftReadiness === DRAFT_READINESS.STALE ? (
                        <Badge tone="accent">Reconfirmation required</Badge>
                      ) : (
                        <Badge tone="accent">Confirmation needed</Badge>
                      )}
                    </div>
                    {myDraftReadiness === DRAFT_READINESS.READY ? (
                      <p className="mt-1 text-sm text-muted">
                        You&apos;ve seen the draft time and confirmed you&apos;re
                        still committed to playing this season.
                        {reg.draftConfirmedAt ? (
                          <>
                            {" "}Confirmed{" "}
                            <LocalTime
                              ts={reg.draftConfirmedAt.getTime()}
                              variant="short"
                              initial={formatMatchTime(
                                reg.draftConfirmedAt,
                                "short",
                              )}
                            />
                            .
                          </>
                        ) : null}
                      </p>
                    ) : (
                      <>
                        <p className="mt-1 text-sm text-muted">
                          {myDraftReadiness === DRAFT_READINESS.STALE
                            ? "The draft time changed after your last confirmation. Review the current time above and confirm again."
                            : "Confirm that you have seen the draft time above and are still committed to playing this season."}
                        </p>
                        {myDraftReadiness === DRAFT_READINESS.STALE &&
                        reg.draftConfirmedFor ? (
                          <p className="mt-1 text-xs text-muted">
                            Previously confirmed for{" "}
                            <LocalTime
                              ts={reg.draftConfirmedFor.getTime()}
                              variant="full"
                              initial={formatMatchTime(
                                reg.draftConfirmedFor,
                                "full",
                              )}
                            />
                            .
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                  {myDraftReadiness !== DRAFT_READINESS.READY ? (
                    <ActionForm
                      action={confirmDraftReadiness}
                      hidden={{
                        draftRevision: String(season.draftRevision),
                        draftAtTs: String(season.draftAt.getTime()),
                      }}
                    >
                      <SubmitButton
                        variant={
                          myDraftReadiness === DRAFT_READINESS.STALE
                            ? "accent"
                            : "primary"
                        }
                        size="sm"
                      >
                        {myDraftReadiness === DRAFT_READINESS.STALE
                          ? "Confirm updated draft time"
                          : "Confirm I’m ready for draft"}
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                </div>
                <p className="mt-2 text-xs text-muted">
                  If your plans change later, withdraw your signup below or
                  message an admin.
                </p>
              </div>
            ) : null}
            {member ? (
              <Link
                href={`/teams/${member.team.id}`}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5 transition-colors hover:border-muted/60"
              >
                <TeamCrest
                  name={member.team.name}
                  seed={member.team.id}
                  size={40}
                />
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-wide text-muted">
                    Your team
                  </div>
                  <div className="truncate font-medium">
                    {member.team.name}
                  </div>
                </div>
                <div className="ml-auto shrink-0">
                  {member.isCaptain ? (
                    <Badge tone="brand">Captain</Badge>
                  ) : (
                    <span className="text-sm text-muted">
                      Drafted for{" "}
                      <span className="font-semibold text-fg">
                        ${member.price}
                      </span>
                    </span>
                  )}
                </div>
              </Link>
            ) : null}

            {/* Renders for a STANDIN signup (empty state included) and for ANY
                unrostered signup that actually holds a booking — undrafted
                PLAYER-type free agents are legal cover in both assign forms,
                and the old type gate hid their own bookings from them. The
                bare card stays standin-only: during SIGNUPS every registrant
                is unrostered, and an empty "your assignments" box for the
                whole pool would be noise. */}
            {isRegistered &&
            !member &&
            standinAssignments &&
            (reg?.type === "STANDIN" || standinAssignments.length > 0) ? (
              <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                <div className="text-xs uppercase tracking-wide text-muted">
                  Your standin assignments
                </div>
                {standinAssignments.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">
                    No assignments yet — captains grab cover from the standin
                    pool on each match page as their players drop out. Keep
                    your Discord linked so their ping reaches you.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {standinAssignments.map((a) => {
                      const fillFor =
                        a.match.homeTeamId === a.teamId
                          ? a.match.homeTeam
                          : a.match.awayTeam;
                      const opponent =
                        a.match.homeTeamId === a.teamId
                          ? a.match.awayTeam
                          : a.match.homeTeam;
                      return (
                        <li key={a.id}>
                          <Link
                            href={`/matches/${a.match.id}`}
                            className="block rounded-md border border-line bg-surface/60 px-3 py-2 transition-colors hover:border-muted/60"
                          >
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                              <Badge tone="info">
                                {matchPhaseLabel(a.match.phase, a.match.week)}
                              </Badge>
                              <span className="min-w-0">
                                Filling in for{" "}
                                <span className="font-medium text-fg">
                                  {fillFor.name}
                                </span>{" "}
                                vs{" "}
                                <span className="font-medium text-fg">
                                  {opponent.name}
                                </span>
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-muted">
                              {a.match.scheduledAt ? (
                                <LocalTime
                                  ts={a.match.scheduledAt.getTime()}
                                  variant="short"
                                  initial={formatMatchTime(
                                    a.match.scheduledAt,
                                    "short",
                                  )}
                                />
                              ) : (
                                "Time TBD"
                              )}
                            </div>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ) : null}

            <ScheduleCallout label={season.matchSchedule} />
            {!reg && previous ? (
              <div className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-xs">
                <span aria-hidden>↩️</span>
                <span>
                  Welcome back! We prefilled this from your{" "}
                  <b>{previous.season.name}</b> signup — update anything that
                  changed, then submit to join.
                </span>
              </div>
            ) : null}
            <ActionForm action={saveRegistration} className="space-y-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Participation
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <RadioTile
                    name="type"
                    value="PLAYER"
                    defaultChecked={!playerLocked && form?.type !== "STANDIN"}
                    title="Full player"
                    desc="Get drafted onto a team and play every week."
                    disabled={playerLocked}
                  />
                  <RadioTile
                    name="type"
                    value="STANDIN"
                    defaultChecked={playerLocked || form?.type === "STANDIN"}
                    title="Standin"
                    desc="Fill in for teams when someone can't play."
                  />
                </div>
                {!signupsOpen ? (
                  <p className="mt-2 text-xs text-muted">
                    Full-player signups are closed for this season. Standins are
                    always welcome.
                  </p>
                ) : null}
              </div>

              <div>
                <label
                  htmlFor="mmr"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Dota 2 MMR
                </label>
                <input
                  id="mmr"
                  name="mmr"
                  type="number"
                  // min=1: a typed 0 fails native validation, while BLANK stays
                  // allowed — 0 is the stored "unknown" sentinel, never typed.
                  min={1}
                  max={HARD_MMR_CEILING}
                  // `|| ""` (not ??): a stored unknown (0) must render blank,
                  // or resubmitting the form trips the min=1 validation.
                  defaultValue={form?.mmr || ""}
                  placeholder="e.g. 3200"
                  className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
                />
                <p className="mt-1 text-xs text-muted">
                  {mmrWindow && mmrWindow.min > 0
                    ? "Not sure? Leave it blank — we'll estimate it from your ranked medal. "
                    : "Unranked or not sure? Leave it blank — captains will see your ranked medal instead, and you can update it later. "}
                  Used to help balance the draft. Be honest!
                  {season.maxMmr > 0
                    ? ` ${season.maxMmr} is a soft limit — you can still sign up above it, but you'll be reviewed before the draft. We don't take anyone over ${HARD_MMR_CEILING} MMR (no Immortals).`
                    : ` We don't take anyone over ${HARD_MMR_CEILING} MMR (no Immortals).`}
                </p>
                {medalBlocked ? (
                  <p className="mt-1 text-xs text-danger">
                    Your {rankMedalName(dbUser?.rankTier)} medal puts you above{" "}
                    {HARD_MMR_CEILING} MMR, so this league can&apos;t take your
                    signup.
                  </p>
                ) : mmrWindow ? (
                  <p className="mt-1 text-xs text-muted">
                    Your {rankMedalName(dbUser?.rankTier)} medal puts you
                    around{" "}
                    <strong>
                      {/* Display capped at the ceiling — the form's max —
                          even where the tolerance window runs past it. */}
                      {formatMmrRange({
                        min: mmrWindow.min,
                        max:
                          mmrWindow.max === null
                            ? HARD_MMR_CEILING
                            : Math.min(mmrWindow.max, HARD_MMR_CEILING),
                      })}
                    </strong>{" "}
                    MMR —{" "}
                    {mmrWindow.min > 0
                      ? `a value outside that range is automatically set to ${mmrWindow.min}.`
                      : "a value outside that range is treated as unknown (captains judge by your medal)."}
                  </p>
                ) : null}
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Preferred roles
                </label>
                <div className="flex flex-wrap gap-2">
                  {DOTA_ROLES.map((r) => (
                    <label
                      key={r.key}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10"
                    >
                      <input
                        type="checkbox"
                        name="roles"
                        value={r.key}
                        defaultChecked={myRoles.includes(r.key)}
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      {r.label}{" "}
                      <span className="text-xs text-muted">({r.short})</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Favorite heroes
                </label>
                <HeroPicker
                  name="favoriteHeroes"
                  defaultValue={form?.favoriteHeroes}
                />
                <p className="mt-1 text-xs text-muted">
                  Pick the heroes you&apos;re known for —{" "}
                  <Link
                    href={`/players/${user.id}`}
                    className={textLink()}
                  >
                    captains see these
                  </Link>{" "}
                  during the draft.
                </p>
              </div>

              <div>
                <label
                  htmlFor="statement"
                  className="mb-1.5 block text-sm font-medium"
                >
                  What you want from the league
                </label>
                <textarea
                  id="statement"
                  name="statement"
                  rows={3}
                  maxLength={1000}
                  defaultValue={form?.statement ?? ""}
                  placeholder="Why you're here, your goals, availability…"
                  className="w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-accent/60"
                />
              </div>

              <div>
                <label
                  htmlFor="captainNote"
                  className="mb-1.5 block text-sm font-medium"
                >
                  Note for captains / drafters
                </label>
                <textarea
                  id="captainNote"
                  name="captainNote"
                  rows={3}
                  maxLength={1000}
                  defaultValue={form?.captainNote ?? ""}
                  placeholder="What should captains know about you as a player?"
                  className="w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-accent/60"
                />
                <p className="mt-1 text-xs text-muted">
                  Shown to captains during the draft.
                </p>
              </div>

              <label className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 p-3">
                <input
                  type="checkbox"
                  name="wantsCaptain"
                  defaultChecked={form?.wantsCaptain ?? false}
                  className="h-4 w-4 accent-[var(--color-brand)]"
                />
                <span className="text-sm">
                  I&apos;d like to be considered as a team captain
                </span>
              </label>

              <div className="flex flex-wrap gap-3">
                <SubmitButton>
                  {isRegistered ? "Update signup" : "Join the season"}
                </SubmitButton>
              </div>
            </ActionForm>

            {isRegistered ? (
              <div className="mt-4 border-t border-line pt-4">
                {isRostered || isCaptain ? (
                  <p className="text-xs text-muted">
                    {isCaptain ? (
                      <>
                        You captain{" "}
                        <b>{member?.team.name}</b> — ask an admin to replace you
                        before you can withdraw.
                      </>
                    ) : (
                      <>
                        You&apos;re on <b>{member?.team.name}</b>&apos;s roster —
                        ask an admin to release you before withdrawing.
                      </>
                    )}
                  </p>
                ) : (
                  <ActionForm action={leaveLeague}>
                    <SubmitButton
                      variant="ghost"
                      size="sm"
                      confirm="Withdraw from this season?"
                    >
                      Withdraw from this season
                    </SubmitButton>
                  </ActionForm>
                )}
              </div>
            ) : null}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function RadioTile({
  name,
  value,
  title,
  desc,
  defaultChecked,
  disabled,
}: {
  name: string;
  value: string;
  title: string;
  desc: string;
  defaultChecked?: boolean;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors has-[:checked]:border-accent has-[:checked]:bg-accent/10 ${
        disabled ? "opacity-50" : "border-line hover:border-muted/60"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{desc}</span>
      </span>
    </label>
  );
}

function DotaAccountCard({
  effectiveId,
  override,
  rankTier,
  fhUnavailable,
}: {
  effectiveId: number | null;
  override: number | null;
  rankTier: number | null;
  /** OpenDota fh_unavailable: true = match data private (auto-import blind). */
  fhUnavailable: boolean | null;
}) {
  return (
    <Card>
      <CardHeader
        title="Dota / Dotabuff account"
        subtitle="Link it so captains can see your rank when drafting."
        action={
          effectiveId ? (
            <div className="flex items-center gap-3 text-sm">
              <a
                href={`https://www.dotabuff.com/players/${effectiveId}`}
                target="_blank"
                rel="noreferrer"
                className={textLink()}
              >
                Dotabuff ↗
              </a>
              <a
                href={`https://www.opendota.com/players/${effectiveId}`}
                target="_blank"
                rel="noreferrer"
                className={textLink()}
              >
                OpenDota ↗
              </a>
            </div>
          ) : null
        }
      />
      <CardBody className="space-y-3">
        {fhUnavailable === true ? (
          <div
            role="status"
            className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger"
          >
            <b>Your Dota match data is private</b> — league results can&apos;t
            auto-import your games, and your medal/stats stay invisible. In
            Dota 2: <b>Settings → Options → Advanced → Social → Expose Public
            Match Data</b>, play a game, then hit Refresh medal below.
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {effectiveId ? (
            <>
              <span>
                Account{" "}
                <span className="font-mono text-fg">{effectiveId}</span>{" "}
                {override == null ? "(from Steam)" : "(manual)"}
              </span>
              <span>·</span>
              <span>Medal:</span>
              {rankTier ? (
                <RankBadge rankTier={rankTier} />
              ) : (
                <span>not synced yet</span>
              )}
            </>
          ) : (
            <span>
              We couldn&apos;t derive your account from Steam — link it below.
            </span>
          )}
        </div>

        <ActionForm
          action={updateDotaAccount}
          className="flex flex-wrap items-end gap-2"
        >
          <div>
            <label
              htmlFor="dotaAccountId"
              className="mb-1 block text-xs text-muted"
            >
              Dotabuff/OpenDota URL, account id, or SteamID64
            </label>
            <input
              id="dotaAccountId"
              name="dotaAccountId"
              defaultValue={override ?? ""}
              placeholder="Dotabuff/OpenDota URL or account id"
              className="h-10 w-80 max-w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
            />
          </div>
          <SubmitButton variant="secondary">Link &amp; fetch medal</SubmitButton>
        </ActionForm>

        <div className="flex flex-wrap items-center gap-3">
          <ActionForm action={refreshRank}>
            <SubmitButton variant="ghost" size="sm">
              Refresh medal
            </SubmitButton>
          </ActionForm>
          <p className="text-xs text-muted">
            Medal needs <b>Settings → Options → Expose Public Match Data</b>{" "}
            enabled in Dota 2.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
