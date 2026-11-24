import {
  setDiscordWebhook,
  clearDiscordWebhook,
  testDiscordWebhook,
  discardWaitingDiscordPosts,
  setInhouseWebhook,
  clearInhouseWebhook,
  setInhouseAlertWebhook,
  clearInhouseAlertWebhook,
  setInhousePingRole,
  testInhouseWebhook,
  postInhouseBoard,
  deleteInhouseBoard,
  setLeagueStatusWebhook,
  clearLeagueStatusWebhook,
  postLeagueStatusCard,
  deleteLeagueStatusCard,
  updateLeagueStatusCardNow,
} from "@/app/actions/admin-discord";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { loadLeagueDeliveryHealth } from "@/lib/league-announcement-outbox";
import {
  deliveryErrorLabel,
  deliveryPaused,
  leagueDeliveryAttention,
  refusedPostsSentence,
  type LeagueDeliveryHealth,
} from "@/lib/league-delivery";
import { maskWebhookUrl } from "@/lib/discord";
import { discordMutationsAllowed } from "@/lib/discord-mutation-policy";
import {
  getInhouseBoardStatus,
  type InhouseBoardStatus,
} from "@/lib/inhouse-board-service";
import {
  getLeagueStatusCardStatus,
  type LeagueStatusCardStatus,
} from "@/lib/league-status-service";
import {
  getStandinRoleStatus,
  type StandinRoleStatus,
} from "@/lib/standin-role-service";
import { getPingHealth, type PingHealth } from "@/lib/discord-roles";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AdminStandinRole } from "@/components/admin-standin-role";
import { Badge, CardBody } from "@/components/ui";
import { AdminSection } from "@/components/admin/admin-section";
import { AutomationTimestamp } from "@/components/admin/automation-runner";

/**
 * The opt-in has four independent ways to be half-configured and three are
 * invisible until a player clicks the button and gets an error. This says
 * which one, in the order they have to be fixed.
 */
function PingHealthLines({
  health,
  mutationsAllowed,
}: {
  health: PingHealth;
  mutationsAllowed: boolean;
}) {
  const rows: { ok: boolean | null; label: string; fix: string }[] = [
    {
      ok: health.hasToken,
      label: "Bot token",
      fix: "Set DISCORD_BOT_TOKEN in the host env, then redeploy — env changes only apply to NEW deployments.",
    },
    {
      ok: health.hasGuild,
      label: "Server id",
      fix: "Set DISCORD_GUILD_ID (right-click the server → Copy Server ID), then redeploy.",
    },
    {
      ok: health.hasRole,
      label: "Ping role chosen",
      fix: "Paste the role id into the field above.",
    },
    {
      ok: health.botInGuild,
      label: health.botName
        ? `Bot in server (${health.botName})`
        : "Bot in server",
      fix: "Invite the bot: Developer Portal → OAuth2 → URL Generator → scope bot + permission Manage Roles.",
    },
    {
      ok: health.roleExists,
      label: health.roleName ? `Role found (${health.roleName})` : "Role found",
      fix: "That role id doesn't exist in this server — re-copy it.",
    },
    {
      ok: health.hasManageRoles,
      label: "Bot has Manage Roles",
      fix: "Re-invite the bot with the Manage Roles permission (Developer Portal → OAuth2 → URL Generator).",
    },
    {
      ok: health.canGrant,
      label: "Bot can grant it",
      fix: "Server Settings → Roles: drag the bot's role ABOVE the ping role. Discord won't let a bot assign a role above its own.",
    },
  ];
  const firstBroken = rows.find((r) => r.ok === false);
  const allGood = rows.every((r) => r.ok === true);

  // The OAuth guild-join rides the same bot but fails for its OWN two reasons,
  // both of them silent: Discord 403s a join from a bot without
  // CREATE_INSTANT_INVITE, and it 403s a `guilds.join` token issued by a
  // different application. Kept as a separate verdict so a join problem can't
  // mask a ping-role problem (or be masked by one) in the single "Next:" line.
  const joinRows: { ok: boolean | null; label: string; fix: string }[] = [
    {
      ok: health.appMatchesOauth,
      label: "Bot is the OAuth app",
      fix: "DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID come from DIFFERENT Discord applications — Discord only honours a join token from the app that issued it. Use the bot token from the same application as the OAuth client.",
    },
    {
      ok: health.canInvite,
      label: "Bot can add members",
      fix: "Re-invite the bot with the Create Invite permission (Developer Portal → OAuth2 → URL Generator → bot + Create Instant Invite).",
    },
  ];
  const firstBrokenJoin = joinRows.find((r) => r.ok === false);

  return (
    <div className="rounded-lg border border-line bg-surface-2/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {rows.map((r) => (
          <span
            key={r.label}
            className={
              r.ok === true
                ? "text-success"
                : r.ok === false
                  ? "text-danger"
                  : "text-muted"
            }
          >
            {r.ok === true ? "✓" : r.ok === false ? "✗" : "•"} {r.label}
          </span>
        ))}
      </div>
      {/* The raw numbers behind the verdict. A boolean on its own is how the
          first version of this check stayed wrong on every server it ran on —
          there was nothing visible to sanity-check it against. */}
      {health.botTopPosition !== null && health.rolePosition !== null ? (
        <p className="mt-1 text-xs text-muted">
          Bot&apos;s highest role sits at position {health.botTopPosition}; the
          ping role is at {health.rolePosition}.
          {health.canGrant ? " Higher, so it can assign it." : ""}
        </p>
      ) : null}
      {/* Only meaningful once a bot exists at all — without one the site never
          asks for guilds.join in the first place. */}
      {health.hasToken && health.hasGuild ? (
        <div className="mt-2 border-t border-line pt-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-muted">
              {mutationsAllowed
                ? "Auto-join on link:"
                : "Production auto-join readiness:"}
            </span>
            {joinRows.map((r) => (
              <span
                key={r.label}
                className={
                  r.ok === true
                    ? "text-success"
                    : r.ok === false
                      ? "text-danger"
                      : "text-muted"
                }
              >
                {r.ok === true ? "✓" : r.ok === false ? "✗" : "•"} {r.label}
              </span>
            ))}
          </div>
          {firstBrokenJoin ? (
            <p className="mt-1 text-xs text-danger">{firstBrokenJoin.fix}</p>
          ) : null}
          {!mutationsAllowed ? (
            <p className="mt-1 text-xs text-muted">
              Preview verifies these credentials with read-only checks but does
              not request guild-join permission or add members.
            </p>
          ) : null}
          {/* The inhouse night's server event rides the same bot and fails
              for its own reason, so it gets its own line too. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-muted">Inhouse night events:</span>
            <span
              className={
                health.canCreateEvents === true
                  ? "text-success"
                  : health.canCreateEvents === false
                    ? "text-danger"
                    : "text-muted"
              }
            >
              {health.canCreateEvents === true
                ? "✓"
                : health.canCreateEvents === false
                  ? "✗"
                  : "•"}{" "}
              Bot can create events
            </span>
          </div>
          {health.canCreateEvents === false ? (
            <p className="mt-1 text-xs text-danger">
              Server Settings → Roles: give the bot&apos;s role the Create
              Events permission, so an inhouse night shows in the server&apos;s
              Events with an Interested button.
            </p>
          ) : null}
        </div>
      ) : null}
      {health.problem ? (
        <p className="mt-2 text-xs text-danger">{health.problem}</p>
      ) : firstBroken ? (
        <p className="mt-2 text-xs text-danger">
          <b>Next:</b> {firstBroken.fix}
        </p>
      ) : allGood ? (
        <p className="mt-2 text-xs text-success">
          Players who&apos;ve linked Discord can now opt in from their profile.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Loads everything the Discord card needs. Its own component so the page can
 * put it behind <Suspense> — see the render site for why that matters.
 */
export async function DiscordSection() {
  // Never hand the raw webhook URL to the client — it's a bearer credential.
  // Resolve it server-side only to derive a boolean + a masked fingerprint.
  const dbWebhook = (await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL)) ?? "";
  const activeWebhook = dbWebhook || process.env.DISCORD_WEBHOOK_URL || "";
  const [board, statusCard, pingHealth, delivery, standinRole] =
    await Promise.all([
      getInhouseBoardStatus(),
      getLeagueStatusCardStatus(),
      getPingHealth(),
      loadLeagueDeliveryHealth().catch(() => null),
      getStandinRoleStatus(),
    ]);
  return (
    <DiscordControls
      delivery={delivery}
      status={{
        configured: !!activeWebhook,
        masked: maskWebhookUrl(activeWebhook),
        // Set only via env, not the DB — Remove (which clears the DB key)
        // can't touch it, so we hide that button and say where it lives.
        envManaged: !dbWebhook && !!process.env.DISCORD_WEBHOOK_URL,
      }}
      board={board}
      statusCard={statusCard}
      pingHealth={pingHealth}
      standinRole={standinRole}
      mutationsAllowed={discordMutationsAllowed()}
    />
  );
}

/**
 * Whether league posts are actually getting through. The badge above only
 * says a webhook URL is saved; this says what Discord did with the posts.
 * Error codes only — the webhook URL never reaches the page.
 */
function LeagueDeliveryLine({
  health,
  paused,
}: {
  health: LeagueDeliveryHealth;
  paused: boolean;
}) {
  const lastError =
    health.waiting > 0 ? deliveryErrorLabel(health.headErrorCode) : null;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">
        {health.lastDeliveredAt ? (
          <>
            Last post delivered{" "}
            <AutomationTimestamp
              value={health.lastDeliveredAt}
              emptyLabel="never"
            />
          </>
        ) : (
          "No league post delivered yet"
        )}
        {" · "}
        {health.waiting > 0 ? `${health.waiting} waiting` : "nothing waiting"}
        {lastError ? ` · last error: ${lastError}` : null}
      </p>
      {paused ? (
        <p className="text-danger">
          Posting is paused: Discord refuses this webhook (it was deleted, its
          token changed, or it lost access to the channel). Paste a new webhook
          URL below and the waiting posts go out, oldest first.
        </p>
      ) : null}
      {health.refusedRecently > 0 ? (
        <p className="text-muted [overflow-wrap:anywhere]">
          {refusedPostsSentence(health)}
        </p>
      ) : null}
      {health.expiredRecently > 0 ? (
        <p className="text-muted">
          {health.expiredRecently} out-of-date post
          {health.expiredRecently === 1 ? " was" : "s were"} dropped in the
          last day instead of posting late (reminders after kickoff, draft
          posts after the draft).
        </p>
      ) : null}
      {health.waiting > 0 && health.newestWaitingAt ? (
        <ActionForm
          action={discardWaitingDiscordPosts}
          hidden={{ upTo: String(health.newestWaitingAt.getTime()) }}
        >
          <SubmitButton
            variant="ghost"
            size="sm"
            confirm={`Discard the ${health.waiting} league post${health.waiting === 1 ? "" : "s"} waiting to go to Discord? ${health.waiting === 1 ? "It" : "They"} will never be posted.`}
          >
            Discard {health.waiting} waiting post
            {health.waiting === 1 ? "" : "s"}
          </SubmitButton>
        </ActionForm>
      ) : null}
    </div>
  );
}

function DiscordControls({
  status,
  delivery,
  board,
  statusCard,
  pingHealth,
  standinRole,
  mutationsAllowed,
}: {
  status: { configured: boolean; masked: string; envManaged: boolean };
  delivery: LeagueDeliveryHealth | null;
  board: InhouseBoardStatus;
  statusCard: LeagueStatusCardStatus;
  pingHealth: PingHealth;
  standinRole: StandinRoleStatus;
  mutationsAllowed: boolean;
}) {
  const { configured, masked, envManaged } = status;
  const paused = !!delivery && deliveryPaused(delivery);
  return (
    <AdminSection
      id="adm-discord"
      title="Discord notifications"
      subtitle="Configure league announcements and the Standin role, plus the year-round inhouse queue board, alerts, and ping role."
      // Opens itself when league posts are stuck: in the offseason there is
      // no Needs attention card to say so. A post Discord refused does not
      // open it; the queue already dropped that post, and the card lists it
      // below for whoever looks.
      defaultOpen={!!delivery && leagueDeliveryAttention(delivery).length > 0}
    >
      <CardBody className="space-y-3">
        {!mutationsAllowed ? (
          <div
            role="status"
            className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm"
          >
            <b>Read-only Discord preview.</b> Identity, membership, bot, and
            permission checks are live. Posting messages, joining members, and
            changing or deleting live Discord roles/messages are disabled.
            Configuration edits below affect only the isolated preview database.
          </div>
        ) : null}
        {/* Moved out of the card header: a button inside a <summary> toggles
            the disclosure instead of submitting. */}
        <div className="flex justify-end">
          <ActionForm action={testDiscordWebhook}>
            <SubmitButton
              variant="secondary"
              size="sm"
              disabled={!configured || !mutationsAllowed}
            >
              Send test message
            </SubmitButton>
          </ActionForm>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {configured ? (
            <>
              <Badge tone={paused ? "danger" : "success"}>
                {paused ? "Refused by Discord" : "Configured"}
              </Badge>
              <span className="font-mono text-xs text-muted">{masked}</span>
              {envManaged ? (
                <span className="text-xs text-muted">
                  · via <code>DISCORD_WEBHOOK_URL</code> env var
                </span>
              ) : null}
            </>
          ) : (
            <Badge tone="neutral">Not configured</Badge>
          )}
        </div>
        {delivery && (configured || delivery.waiting > 0) ? (
          <LeagueDeliveryLine health={delivery} paused={paused} />
        ) : null}

        <ActionForm
          action={setDiscordWebhook}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1">
            <label
              htmlFor="discordWebhookUrl"
              className="mb-1 block text-xs text-muted"
            >
              {configured ? "Replace webhook URL" : "Webhook URL"}
            </label>
            <input
              id="discordWebhookUrl"
              name="discordWebhookUrl"
              type="url"
              autoComplete="off"
              placeholder="https://discord.com/api/webhooks/…"
              className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
            />
          </div>
          <SubmitButton variant="secondary" size="sm">
            Save webhook
          </SubmitButton>
        </ActionForm>

        {configured && !envManaged ? (
          <ActionForm action={clearDiscordWebhook}>
            <SubmitButton
              variant="ghost"
              size="sm"
              confirm="Turn off Discord announcements? This removes the saved webhook."
            >
              Remove webhook
            </SubmitButton>
          </ActionForm>
        ) : null}

        <p className="text-xs text-muted">
          In Discord:{" "}
          <b>Server Settings → Integrations → Webhooks → New Webhook</b>, pick
          the announcements channel, copy the URL and paste it here. For
          security the saved URL is never shown again — paste a new one to
          replace it, or Remove to turn announcements off.
        </p>
        <p className="text-xs text-muted">
          <b>Who gets pinged:</b> league posts mention only the people each
          post is for, such as a captain who needs cover, a booked standin,
          the captains when a fixture moves, players who haven&apos;t checked
          in, drafted and signed players, and the Player of the Week and the
          champions. League posts never ping a role or everyone, and only
          players who linked Discord on their profile can be pinged.
        </p>

        <AdminStandinRole
          status={standinRole}
          mutationsAllowed={mutationsAllowed}
        />

        <div className="space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Inhouse channel</span>
            {board.separateChannel ? (
              <Badge tone="success">Separate</Badge>
            ) : (
              <Badge tone="neutral">Same as above</Badge>
            )}
            {board.separateChannel ? (
              <span className="font-mono text-xs text-muted">
                {board.inhouseMasked}
              </span>
            ) : null}
            <ActionForm action={testInhouseWebhook}>
              <SubmitButton
                variant="ghost"
                size="sm"
                disabled={!mutationsAllowed}
              >
                Test
              </SubmitButton>
            </ActionForm>
          </div>

          <ActionForm
            action={setInhouseWebhook}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <label
                htmlFor="inhouseWebhookUrl"
                className="mb-1 block text-xs text-muted"
              >
                {board.separateChannel
                  ? "Replace inhouse webhook URL"
                  : "Inhouse webhook URL (optional)"}
              </label>
              <input
                id="inhouseWebhookUrl"
                name="inhouseWebhookUrl"
                type="url"
                autoComplete="off"
                placeholder="https://discord.com/api/webhooks/…"
                className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
            </div>
            <SubmitButton variant="secondary" size="sm">
              Save
            </SubmitButton>
          </ActionForm>

          {board.separateChannel ? (
            <ActionForm action={clearInhouseWebhook}>
              <SubmitButton
                variant="ghost"
                size="sm"
                confirm="Send inhouse posts back to the league channel? The queue board will be removed."
              >
                Use the league channel instead
              </SubmitButton>
            </ActionForm>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Alerts channel</span>
            {board.alertsSeparate ? (
              <Badge tone="success">Separate</Badge>
            ) : (
              <Badge tone="neutral">Same as the board</Badge>
            )}
            {board.alertsSeparate ? (
              <span className="font-mono text-xs text-muted">
                {board.alertsMasked}
              </span>
            ) : null}
          </div>

          <ActionForm
            action={setInhouseAlertWebhook}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <label
                htmlFor="inhouseAlertWebhookUrl"
                className="mb-1 block text-xs text-muted"
              >
                {board.alertsSeparate
                  ? "Replace alerts webhook URL"
                  : "Alerts webhook URL (optional)"}
              </label>
              <input
                id="inhouseAlertWebhookUrl"
                name="inhouseAlertWebhookUrl"
                type="url"
                autoComplete="off"
                placeholder="https://discord.com/api/webhooks/…"
                className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
            </div>
            <SubmitButton variant="secondary" size="sm">
              Save
            </SubmitButton>
          </ActionForm>

          {board.alertsSeparate ? (
            <ActionForm action={clearInhouseAlertWebhook}>
              <SubmitButton variant="ghost" size="sm">
                Send alerts to the board channel instead
              </SubmitButton>
            </ActionForm>
          ) : null}

          <p className="text-xs text-muted">
            {board.alertsSeparate ? (
              <>
                The board&apos;s channel now holds <b>only the board</b> — queue
                pings, &ldquo;match found&rdquo; and results post in the alerts
                channel instead.
              </>
            ) : (
              <>
                <b>Alerts currently share the board&apos;s channel.</b> The
                board is read at a glance from the bottom of its channel, so
                every ping and result pushes it out of view. Make a webhook in a
                separate channel (e.g. <b>#inhouse-chat</b>) and paste it here
                to keep the board channel board-only.
              </>
            )}
          </p>

          <ActionForm
            action={setInhousePingRole}
            className="flex flex-wrap items-end gap-2"
          >
            <div className="min-w-0 flex-1">
              <label
                htmlFor="inhousePingRoleId"
                className="mb-1 block text-xs text-muted"
              >
                Ping role {board.pingRoleId ? "" : "(optional)"}
              </label>
              <input
                id="inhousePingRoleId"
                name="inhousePingRoleId"
                type="text"
                autoComplete="off"
                defaultValue={board.pingRoleId ?? ""}
                placeholder="Role id, or paste @the-role"
                className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
            </div>
            <SubmitButton variant="secondary" size="sm">
              Save role
            </SubmitButton>
          </ActionForm>

          <PingHealthLines
            health={pingHealth}
            mutationsAllowed={mutationsAllowed}
          />

          <p className="text-xs text-muted">
            {board.pingRoleId ? (
              <>
                <b>The ping role is on.</b> Three inhouse posts ping this role:
                the queue filling up, and the inhouse night&apos;s planned and
                start posts. &ldquo;Match found&rdquo; mentions only the ten
                players in the lobby, and board edits never notify anyone.
              </>
            ) : (
              <>
                <b>No ping role set</b>, so the &ldquo;queue is
                filling&rdquo; post pings nobody. Set a role here and that post
                and the inhouse night&apos;s planned and start posts will ping
                it. Board edits never notify anyone.
              </>
            )}{" "}
            Make the role <b>self-assignable</b> (Server Settings → Onboarding,
            or a Channels &amp; Roles picker) — a ping people can&apos;t opt out
            of gets the channel muted, which is worse than silence. With or
            without a role, the ten players are mentioned when their match is
            found, if they&apos;ve linked Discord on their profile.
          </p>

          <p className="text-xs text-muted">
            A Discord webhook only ever posts to the channel it was made in.
            Make one in <b>#inhouse</b> and paste it here to send the queue
            board, &ldquo;match found&rdquo;, the queue ping and inhouse results
            there — leaving signups, draft night and match results in the
            channel above. Leave this blank and everything shares one channel.
          </p>
        </div>

        <div className="space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Live queue board</span>
            {board.posted ? (
              board.stranded ? (
                <Badge tone="danger">Stranded</Badge>
              ) : (
                <Badge tone="success">Posted</Badge>
              )
            ) : board.postingStuck ? (
              <Badge tone="danger">Post interrupted</Badge>
            ) : board.posting ? (
              <Badge tone="accent">Posting…</Badge>
            ) : (
              <Badge tone="neutral">Not posted</Badge>
            )}
            {board.posted ? (
              <span className="font-mono text-xs text-muted">
                msg {board.messageHint}
              </span>
            ) : null}
            {board.posted && board.failures > 0 ? (
              <Badge tone="danger">
                {board.failures} failed edit{board.failures === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {board.posted && board.lastEdit ? (
              <span className="text-xs text-muted">
                · last edit{" "}
                <LocalTime
                  ts={new Date(board.lastEdit).getTime()}
                  variant="full"
                  initial={formatLeagueMatchTime(new Date(board.lastEdit), "full")}
                />
              </span>
            ) : null}
          </div>

          {board.posted ? (
            <p className="text-xs text-muted">
              Queue right now: <b>{board.liveState}</b> —{" "}
              {board.inSync
                ? "the board is showing this."
                : "the board hasn't caught up yet. It updates within about a minute."}
            </p>
          ) : null}

          {board.stranded ? (
            <p className="text-xs text-danger">
              The board belongs to a different webhook than the one configured
              now — it can no longer be updated or deleted from here. Remove it
              here, delete the message by hand in the old channel, then post a
              new one.
            </p>
          ) : null}

          {board.postingStuck ? (
            <p className="text-xs text-danger">
              The server stopped while it was posting this board, so it never
              saved a Discord message id. Check the channel for an untracked
              board first; then clear this interrupted post below and delete any
              orphaned message by hand before posting again.
            </p>
          ) : board.posting ? (
            <p className="text-xs text-muted">
              Discord is creating the message. Reload in a moment; a second post
              is blocked while this short lease is active.
            </p>
          ) : null}

          {board.posted && board.failures > 0 ? (
            <p className="text-xs text-danger">
              Discord has rejected the last {board.failures} edit
              {board.failures === 1 ? "" : "s"} — the channel is showing a count
              the site already knows is out of date. Check the webhook.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {board.posted ? (
              <ActionForm action={deleteInhouseBoard}>
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  disabled={!mutationsAllowed}
                  confirm="Delete the queue board message from Discord?"
                >
                  Remove board
                </SubmitButton>
              </ActionForm>
            ) : board.postingStuck ? (
              <ActionForm action={deleteInhouseBoard}>
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  disabled={!mutationsAllowed}
                  confirm="Clear the interrupted board post? First check Discord and delete any board message that may have been created, because the site never received its message id."
                >
                  Clear interrupted post
                </SubmitButton>
              </ActionForm>
            ) : board.posting ? null : (
              <ActionForm action={postInhouseBoard}>
                <SubmitButton
                  variant="secondary"
                  size="sm"
                  // Gated on the INHOUSE webhook, which is what the board
                  // actually posts through — a league that configured only the
                  // inhouse one had a working board behind a disabled button.
                  disabled={
                    !mutationsAllowed || (!configured && !board.separateChannel)
                  }
                >
                  Post queue board
                </SubmitButton>
              </ActionForm>
            )}
          </div>

          <p className="text-xs text-muted">
            Posts <b>one</b> message showing who&apos;s in the inhouse queue and
            rewrites it in place as players come and go — a live count with no
            new messages, ever. Editing a message doesn&apos;t notify anyone, so{" "}
            <b>pin it</b> (right-click → Pin Message) or it will scroll away.
            The separate queue ping (fired once the queue reaches 4 players) is
            what actually alerts people; this board just shows the state.
          </p>
        </div>

        <LeagueStatusCardControls
          card={statusCard}
          mutationsAllowed={mutationsAllowed}
        />
      </CardBody>
    </AdminSection>
  );
}

/**
 * The league status card: its own webhook (made in #schedule), the post and
 * remove controls, and whether the card is showing what the league is now.
 */
function LeagueStatusCardControls({
  card,
  mutationsAllowed,
}: {
  card: LeagueStatusCardStatus;
  mutationsAllowed: boolean;
}) {
  return (
    <div className="space-y-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">League status card</span>
        {card.posted ? (
          card.stranded ? (
            <Badge tone="danger">Stranded</Badge>
          ) : (
            <Badge tone="success">Posted</Badge>
          )
        ) : card.postingStuck ? (
          <Badge tone="danger">Post interrupted</Badge>
        ) : card.posting ? (
          <Badge tone="accent">Posting…</Badge>
        ) : (
          <Badge tone="neutral">Not posted</Badge>
        )}
        {card.posted ? (
          <span className="font-mono text-xs text-muted">
            msg {card.messageHint}
          </span>
        ) : null}
        {card.posted && card.failures > 0 ? (
          <Badge tone="danger">
            {card.failures} failed edit{card.failures === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {card.posted && card.lastEdit ? (
          <span className="text-xs text-muted">
            · last edit{" "}
            <LocalTime
              ts={new Date(card.lastEdit).getTime()}
              variant="full"
              initial={formatLeagueMatchTime(new Date(card.lastEdit), "full")}
            />
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-muted">Webhook:</span>
        {card.configured ? (
          <span className="font-mono text-xs text-muted">{card.masked}</span>
        ) : (
          <Badge tone="neutral">Not set</Badge>
        )}
      </div>

      <ActionForm
        action={setLeagueStatusWebhook}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="min-w-0 flex-1">
          <label
            htmlFor="leagueStatusWebhookUrl"
            className="mb-1 block text-xs text-muted"
          >
            {card.configured
              ? "Replace status card webhook URL"
              : "Status card webhook URL"}
          </label>
          <input
            id="leagueStatusWebhookUrl"
            name="leagueStatusWebhookUrl"
            type="url"
            autoComplete="off"
            placeholder="https://discord.com/api/webhooks/…"
            className="h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
          />
        </div>
        <SubmitButton variant="secondary" size="sm">
          Save
        </SubmitButton>
      </ActionForm>

      {card.posted ? (
        <p className="text-xs text-muted">
          League right now: <b>{card.liveState}</b> —{" "}
          {card.inSync
            ? "the card is showing this."
            : "the card hasn't caught up yet. A change made on the site reaches it within seconds, and one only time makes (a poll closing) within about ten minutes; Update now does it at once."}
        </p>
      ) : null}

      {card.stranded ? (
        <p className="text-xs text-danger">
          The card belongs to a different webhook than the one saved now, so it
          can no longer be updated or deleted from here. Remove it here, delete
          the message by hand in the old channel, then post a new one.
        </p>
      ) : null}

      {card.postingStuck ? (
        <p className="text-xs text-danger">
          The server stopped while it was posting this card, so it never saved
          a Discord message id. Check the channel for an untracked card first;
          then clear this interrupted post below and delete any orphaned
          message by hand before posting again.
        </p>
      ) : card.posting ? (
        <p className="text-xs text-muted">
          Discord is creating the message. Reload in a moment; a second post is
          blocked while this short lease is active.
        </p>
      ) : null}

      {card.posted && card.failures > 0 ? (
        <p className="text-xs text-danger">
          Discord has rejected the last {card.failures} edit
          {card.failures === 1 ? "" : "s"}, so the card is showing something
          the site already knows is out of date. Check the webhook.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {card.posted ? (
          <>
            <ActionForm action={updateLeagueStatusCardNow}>
              <SubmitButton
                variant="secondary"
                size="sm"
                disabled={!mutationsAllowed}
              >
                Update now
              </SubmitButton>
            </ActionForm>
            <ActionForm action={deleteLeagueStatusCard}>
              <SubmitButton
                variant="ghost"
                size="sm"
                disabled={!mutationsAllowed}
                confirm="Delete the league status card message from Discord?"
              >
                Remove status card
              </SubmitButton>
            </ActionForm>
          </>
        ) : card.postingStuck ? (
          <ActionForm action={deleteLeagueStatusCard}>
            <SubmitButton
              variant="ghost"
              size="sm"
              disabled={!mutationsAllowed}
              confirm="Clear the interrupted card post? First check Discord and delete any card message that may have been created, because the site never received its message id."
            >
              Clear interrupted post
            </SubmitButton>
          </ActionForm>
        ) : card.posting ? null : (
          <ActionForm action={postLeagueStatusCard}>
            <SubmitButton
              variant="secondary"
              size="sm"
              disabled={!mutationsAllowed || !card.configured}
            >
              Post status card
            </SubmitButton>
          </ActionForm>
        )}
        {card.configured ? (
          <ActionForm action={clearLeagueStatusWebhook}>
            <SubmitButton
              variant="ghost"
              size="sm"
              confirm="Remove the status card webhook? The card is deleted from Discord and stops updating."
            >
              Remove status card webhook
            </SubmitButton>
          </ActionForm>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        Posts <b>one</b> message that shows where the league is: signups and
        the team goal, draft night, this week&apos;s fixtures with standins,
        reschedule offers and moved kickoffs, the table and last week&apos;s
        Player and Team of the week, the playoffs or the champion, plus a
        planned inhouse night. The site rewrites it in place as things change,
        so it never adds a message or notifies anyone. Make the webhook in a
        read-only channel such as <b>#schedule</b>, so nothing pushes the card
        out of view.
      </p>
    </div>
  );
}
