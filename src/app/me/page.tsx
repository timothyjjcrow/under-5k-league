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
} from "@/app/actions/registration";
import { steamIdToAccountId } from "@/lib/dota";
import { DOTA_ROLES, parseRoles } from "@/lib/roles";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { HeroPicker } from "@/components/hero-picker";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PageTitle,
  RankBadge,
} from "@/components/ui";

export const metadata = { title: "Your profile" };

export default async function MePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const season = await getActiveSeason();
  const reg = season
    ? await prisma.registration.findUnique({
        where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
      })
    : null;

  const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
  const isRegistered = reg?.status === "ACTIVE";
  const signupsOpen = season?.status === "SIGNUPS";
  const myRoles = parseRoles(reg?.roles);

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
          <ActionForm action={refreshSteamProfile} className="ml-auto">
            <SubmitButton variant="secondary" size="sm">
              Refresh from Steam
            </SubmitButton>
          </ActionForm>
        </CardBody>
      </Card>

      <DotaAccountCard
        effectiveId={dbUser?.dotaAccountId ?? steamIdToAccountId(user.steamId)}
        override={dbUser?.dotaAccountId ?? null}
        rankTier={dbUser?.rankTier ?? null}
      />

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
          <CardBody>
            <ActionForm action={saveRegistration} className="space-y-5">
              <div>
                <label className="mb-1.5 block text-sm font-medium">
                  Participation
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <RadioTile
                    name="type"
                    value="PLAYER"
                    defaultChecked={reg?.type !== "STANDIN"}
                    title="Full player"
                    desc="Get drafted onto a team and play every week."
                    disabled={!signupsOpen && !isRegistered}
                  />
                  <RadioTile
                    name="type"
                    value="STANDIN"
                    defaultChecked={reg?.type === "STANDIN"}
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
                  min={0}
                  max={12000}
                  defaultValue={reg?.mmr ?? ""}
                  placeholder="e.g. 3200"
                  className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
                />
                <p className="mt-1 text-xs text-muted">
                  Used to help balance the draft. Be honest!
                  {season.maxMmr > 0
                    ? ` This league is capped at ${season.maxMmr} MMR — players above it can't join.`
                    : ""}
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
                  defaultValue={reg?.favoriteHeroes}
                />
                <p className="mt-1 text-xs text-muted">
                  Pick the heroes you&apos;re known for — captains see these
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
                  defaultValue={reg?.statement ?? ""}
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
                  defaultValue={reg?.captainNote ?? ""}
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
                  defaultChecked={reg?.wantsCaptain ?? false}
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
              <form action={leaveLeague} className="mt-4 border-t border-line pt-4">
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  confirm="Withdraw from this season?"
                >
                  Withdraw from this season
                </SubmitButton>
              </form>
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
}: {
  effectiveId: number | null;
  override: number | null;
  rankTier: number | null;
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
