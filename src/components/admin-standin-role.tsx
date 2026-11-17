import {
  saveStandinRole,
  syncStandinRoleNow,
} from "@/app/actions/admin-discord";
import type { StandinRoleStatus } from "@/lib/standin-role-service";
import { ActionForm, SubmitButton } from "./action-form";
import { Badge } from "./ui";

// The Discord "Standin" role on /admin's Discord card (Tim's call,
// 2026-11-17): the role id field, "Sync Standin role now", and who the rule
// gives it to. The writes are saveStandinRole and syncStandinRoleNow in
// admin-discord.ts over standin-role-service.ts.

/** How many unlinked names the card lists before "and N more". */
const UNLINKED_SHOWN = 12;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function AdminStandinRole({
  status,
  mutationsAllowed,
}: {
  status: StandinRoleStatus;
  mutationsAllowed: boolean;
}) {
  const { roleId, botReady } = status;
  const freeAgents = status.holders - status.standins;
  const shown = status.unlinkedNames.slice(0, UNLINKED_SHOWN);
  const more = status.unlinkedNames.length - shown.length;
  return (
    <div className="space-y-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Standin role</span>
        {roleId ? (
          <Badge tone="success">On</Badge>
        ) : (
          <Badge tone="neutral">Off</Badge>
        )}
        {roleId ? (
          <span className="font-mono text-xs text-muted">{roleId}</span>
        ) : null}
      </div>

      <ActionForm
        action={saveStandinRole}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="min-w-0 flex-1">
          <label
            htmlFor="standinRoleId"
            className="mb-1 block text-xs text-muted"
          >
            Standin role {roleId ? "" : "(optional)"}
          </label>
          <input
            id="standinRoleId"
            name="standinRoleId"
            type="text"
            autoComplete="off"
            defaultValue={roleId ?? ""}
            placeholder="Role id, or paste @Standin"
            className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
          />
        </div>
        <SubmitButton variant="secondary" size="sm">
          Save Standin role
        </SubmitButton>
      </ActionForm>

      {roleId ? (
        <ActionForm action={syncStandinRoleNow}>
          <SubmitButton
            variant="secondary"
            size="sm"
            disabled={!mutationsAllowed || !botReady}
          >
            Sync Standin role now
          </SubmitButton>
        </ActionForm>
      ) : null}

      <p className="text-xs text-muted" data-standin-role-count>
        {status.holders === 0 ? (
          "Nobody should have it right now."
        ) : (
          <>
            <b>{plural(status.holders, "player should", "players should")} have it now:</b>{" "}
            {plural(status.standins, "standin", "standins")} and{" "}
            {plural(freeAgents, "free agent", "free agents")}.
          </>
        )}
        {roleId
          ? ` The site last gave it to ${status.given}${status.away > 0 ? `, and ${plural(status.away, "player wasn't", "players weren't")} in the server` : ""}.`
          : null}
      </p>

      {shown.length > 0 ? (
        <p className="text-xs text-muted [overflow-wrap:anywhere]">
          <b>No linked Discord, so no role:</b> {shown.join(", ")}
          {more > 0 ? `, and ${more} more` : ""}.
        </p>
      ) : null}

      {roleId && !botReady ? (
        <p className="text-xs text-danger">
          The Discord bot isn&apos;t set up here (<code>DISCORD_BOT_TOKEN</code>{" "}
          and <code>DISCORD_GUILD_ID</code>), so the role can&apos;t be given.
        </p>
      ) : null}

      <p className="text-xs text-muted">
        The bot keeps this role on the season&apos;s standins, and once the
        draft is done on its free agents (signed-up players without a team),
        so captains can find cover in Discord. It comes off when they
        withdraw, are removed or take a roster seat (signed or drafted), and
        from everyone when the season ends. The bot&apos;s own
        role must sit above Standin in <b>Server Settings → Roles</b>.{" "}
        <b>Sync Standin role now</b> checks every signup in the server
        against that list and puts right anything changed by hand.
      </p>
    </div>
  );
}
