import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import {
  saveRegistration,
  leaveLeague,
  updateDotaAccount,
  refreshRank,
  refreshSteamProfile,
  updateDiscordName,
  unlinkDiscord,
} from "@/app/actions/registration";
import { DiscordTag } from "@/components/discord-tag";
import { StripQueryParam } from "@/components/strip-query-param";
import { steamIdToAccountId } from "@/lib/dota";
import { HARD_MMR_CEILING } from "@/lib/constants";
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
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  PageTitle,
  RankBadge,
  ScheduleCallout,
  TeamCrest,
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

  // Your-season context: the roster seat (from DRAFT on) or, for standins,
  // the matches they've been assigned to cover.
  const member =
    season
      ? await prisma.teamMember.findUnique({
          where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
          include: { team: true },
        })
      : null;
  const standinAssignments =
    season && reg?.type === "STANDIN" && reg.status === "ACTIVE"
      ? await prisma.standinAssignment.findMany({
          where: {
            standinUserId: user.id,
            match: { seasonId: season.id, status: { not: "COMPLETED" } },
          },
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

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageTitle title="Your profile" />

      <Card>
        <CardBody className="flex items-center gap-4">
          <Avatar name={user.name} src={user.avatar} size={56} />
          <div>
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
              className="text-sm text-muted hover:text-fg"
            >
              Steam: {user.steamId}
            </a>
          </div>
          <div className="ml-auto flex flex-col items-end gap-2">
            <ActionForm action={refreshSteamProfile}>
              <SubmitButton variant="secondary" size="sm">
                Refresh from Steam
              </SubmitButton>
            </ActionForm>
            <Link
              href={`/players/${user.id}`}
              className="whitespace-nowrap text-sm text-info hover:underline"
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
              ? "Linked via Discord — your handle is verified, and shown to signed-in league members."
              : dbUser?.discordName
                ? "Shown to signed-in league members on rosters and the player pool."
                : "Add your Discord so your captain can reach you — it's how the league talks."
          }
          action={
            dbUser?.discordId ? <Badge tone="success">Linked ✓</Badge> : null
          }
        />
        <CardBody className="space-y-3">
          {discordNote ? <StripQueryParam param="discord" /> : null}
          {discordNote ? (
            <p
              role="status"
              className={
                discordNote.tone === "success"
                  ? "rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
                  : discordNote.tone === "danger"
                    ? "rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
                    : "rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm text-muted"
              }
            >
              {discordNote.text}
            </p>
          ) : null}
          {dbUser?.discordId ? (
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
          ) : (
            <>
              {discordLinkAvailable ? (
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href="/api/auth/discord"
                    className={buttonClasses("primary", "sm")}
                  >
                    Link Discord
                  </a>
                  <span className="text-xs text-muted">
                    Sign in with Discord once — proves the handle is really
                    yours. We only ever see your username, nothing else.
                  </span>
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
                />
              </p>
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

            {isRegistered && !member && standinAssignments ? (
              <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                <div className="text-xs uppercase tracking-wide text-muted">
                  Your standin assignments
                </div>
                {standinAssignments.length === 0 ? (
                  <p className="mt-1 text-sm text-muted">
                    No assignments yet — admins place standins as matches need
                    cover.
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
                <div className="grid gap-2 sm:grid-cols-2">
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
                  Unranked or not sure? Leave it blank — captains will see your
                  ranked medal instead, and you can update it later. Used to
                  help balance the draft. Be honest!
                  {season.maxMmr > 0
                    ? ` ${season.maxMmr} is a soft limit — you can still sign up above it, but you'll be reviewed before the draft. We don't take anyone over ${HARD_MMR_CEILING} MMR (no Immortals).`
                    : ` We don't take anyone over ${HARD_MMR_CEILING} MMR (no Immortals).`}
                </p>
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
                    className="text-info hover:underline"
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
                className="text-info hover:underline"
              >
                Dotabuff ↗
              </a>
              <a
                href={`https://www.opendota.com/players/${effectiveId}`}
                target="_blank"
                rel="noreferrer"
                className="text-info hover:underline"
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
