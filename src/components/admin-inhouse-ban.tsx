import {
  banFromInhouse,
  liftBanFromInhouse,
  saveInhouseBanRole,
} from "@/app/actions/inhouse-admin";
import {
  INHOUSE_BAN_DEFAULT_LENGTH,
  INHOUSE_BAN_LENGTHS,
  INHOUSE_BAN_REASON_MAX,
} from "@/lib/inhouse-ban";
import type { InhouseBanAdminRow } from "@/lib/inhouse-ban-service";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { ActionForm, SubmitButton } from "./action-form";
import { LocalTime } from "./local-time";
import { Avatar, Badge, Card, CardBody, CardHeader, PlayerLink } from "./ui";

// Inhouse bans on /admin/inhouse-players (Tim, 2026-11-02): the ban form on
// each player row, the list of running and recent bans with Lift, and the
// Discord role the bot gives a banned player. The writes are the actions in
// inhouse-admin.ts over inhouse-ban-service.ts.

const fieldClass = "h-9 w-full rounded-md border border-line bg-surface-2 px-2 text-sm";

/** "until <their clock>" or "permanently", in the viewer's zone. */
function BanEnd({ endsAt }: { endsAt: Date | null }) {
  if (!endsAt) return <>permanently</>;
  return (
    <>
      {"until "}
      <LocalTime
        ts={endsAt.getTime()}
        variant="full"
        initial={formatLeagueMatchTime(endsAt, "full")}
      />
    </>
  );
}

/**
 * The ban form under one player row. A ban for a banned player replaces the
 * running one, so the same form changes a ban's length or reason.
 */
export function AdminInhouseBanEditor({
  userId,
  name,
  banned,
  roleOn,
}: {
  userId: string;
  name: string;
  /** Their running ban, if any. */
  banned: { endsAt: Date | null; reason: string } | null;
  /** A ban role is set, so a ban also gives the Discord role. */
  roleOn: boolean;
}) {
  return (
    <details className="mt-2" data-inhouse-ban-editor={userId}>
      <summary className="cursor-pointer text-xs text-muted hover:text-fg">
        {banned ? "Change the inhouse ban" : "Ban from inhouse"}
      </summary>
      <ActionForm
        action={banFromInhouse}
        className="mt-2 space-y-3 rounded-lg bg-surface-2/40 p-3"
        hidden={{ userId }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="min-w-0 space-y-1 text-xs text-muted">
            <span>Length</span>
            <select
              name="length"
              defaultValue={INHOUSE_BAN_DEFAULT_LENGTH}
              aria-label={`Ban length for ${name}`}
              className={fieldClass}
            >
              {INHOUSE_BAN_LENGTHS.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 space-y-1 text-xs text-muted sm:col-span-2">
            <span>Reason (players see it)</span>
            <input
              name="reason"
              type="text"
              required
              maxLength={INHOUSE_BAN_REASON_MAX}
              defaultValue={banned?.reason ?? ""}
              placeholder="e.g. Griefing and leaving games"
              aria-label={`Ban reason for ${name}`}
              className={fieldClass}
            />
          </label>
        </div>
        <p className="text-xs text-muted">
          They leave the 5v5 and 1v1 queues and can&apos;t join either until the
          ban ends. /inhouse and the Discord queue board list the ban with this
          reason.
          {roleOn
            ? " The bot gives them the Inhouse Banned role in Discord for the ban's length."
            : ""}
          {banned ? " This replaces their running ban, from now." : ""}
        </p>
        <SubmitButton
          variant="danger"
          size="sm"
          confirm={
            banned
              ? `Replace ${name}'s inhouse ban with this one?`
              : `Ban ${name} from inhouse games?`
          }
        >
          {banned ? "Replace the ban" : "Ban from inhouse"}
        </SubmitButton>
      </ActionForm>
    </details>
  );
}

/** The badge on a banned player's row. */
export function InhouseBanBadge({ endsAt }: { endsAt: Date | null }) {
  return (
    <Badge tone="danger">
      banned <BanEnd endsAt={endsAt} />
    </Badge>
  );
}

/**
 * Running bans (each with Lift) and the latest that ended, plus the Discord
 * role's id. Ended bans stay listed as the record: who, why, how long, who
 * banned and who lifted.
 */
export function AdminInhouseBansCard({
  rows,
  roleId,
  botConfigured,
}: {
  rows: InhouseBanAdminRow[];
  roleId: string | null;
  /** A bot token and guild are set, so the role can work at all. */
  botConfigured: boolean;
}) {
  const running = rows.filter((r) => r.active);
  const ended = rows.filter((r) => !r.active).slice(0, 10);
  return (
    <Card id="inhouse-bans">
      <CardHeader
        headingLevel={2}
        title="Inhouse bans"
        subtitle="A banned player can't join the 5v5 or the 1v1 queue until the ban ends. /inhouse and the Discord queue board list every running ban with its reason. Ban a player from their row below."
      />
      <CardBody className="space-y-5">
        {running.length === 0 ? (
          <p className="text-sm text-muted">Nobody is banned.</p>
        ) : (
          <ul className="divide-y divide-line">
            {running.map((ban) => (
              <li key={ban.id} className="min-w-0 py-3 first:pt-0 last:pb-0" data-inhouse-ban={ban.id}>
                <div className="flex min-w-0 items-start gap-3">
                  <Avatar name={ban.user.name} src={ban.user.avatar} size={32} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <PlayerLink userId={ban.userId} className="min-w-6 max-w-full truncate font-medium">
                        {ban.user.name}
                      </PlayerLink>
                      <span className="text-xs text-muted">
                        banned <BanEnd endsAt={ban.endsAt} />
                      </span>
                    </div>
                    <p className="text-sm break-words">{ban.reason}</p>
                    <p className="text-xs text-muted">
                      {`By ${ban.bannedByName}. `}
                      {!roleId
                        ? null
                        : ban.roleAddedAt
                          ? "Has the Discord role."
                          : ban.user.discordId
                            ? "Discord role not given yet: the site keeps trying."
                            : "No linked Discord, so no role."}
                    </p>
                    <ActionForm action={liftBanFromInhouse} hidden={{ banId: ban.id }}>
                      <SubmitButton
                        variant="secondary"
                        size="sm"
                        confirm={`Lift ${ban.user.name}'s inhouse ban? They can queue again at once.`}
                      >
                        Lift ban
                      </SubmitButton>
                    </ActionForm>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {ended.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted hover:text-fg">
              {`Ended bans (latest ${ended.length})`}
            </summary>
            <ul className="mt-2 space-y-2 text-xs text-muted">
              {ended.map((ban) => (
                <li key={ban.id} className="min-w-0 break-words">
                  <span className="font-medium text-fg">{ban.user.name}</span>
                  {` · ${ban.reason} · by ${ban.bannedByName}`}
                  {ban.liftedAt
                    ? ` · lifted${ban.liftedByName ? ` by ${ban.liftedByName}` : ""}`
                    : " · ran its length"}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="space-y-2 border-t border-line pt-4">
          <ActionForm action={saveInhouseBanRole} className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 basis-56 space-y-1 text-xs text-muted">
              <span>Discord ban role {roleId ? "" : "(optional)"}</span>
              <input
                name="inhouseBanRoleId"
                type="text"
                autoComplete="off"
                defaultValue={roleId ?? ""}
                placeholder="Role id, or paste @the-role"
                className={fieldClass}
              />
            </label>
            <SubmitButton variant="secondary" size="sm">
              Save role
            </SubmitButton>
          </ActionForm>
          <p className="text-xs text-muted">
            {roleId
              ? "The bot gives banned players this role for the ban's length and takes it off when the ban ends or is lifted. Its channel permissions in Discord are what keep them out of the inhouse channels."
              : "No ban role set, so bans leave Discord alone. Make an Inhouse Banned role in Discord that can't see or post in the inhouse channels, put the bot's role above it, and paste its id here."}
            {!botConfigured ? " The site has no Discord bot here, so the role can't be given." : ""}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
