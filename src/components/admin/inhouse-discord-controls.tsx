import {
  setInhouseWebhook,
  clearInhouseWebhook,
  setInhouseAlertWebhook,
  clearInhouseAlertWebhook,
  setInhousePingRole,
  testInhouseWebhook,
  postInhouseBoard,
  deleteInhouseBoard,
} from "@/app/actions/admin-discord";
import { adminHref } from "@/lib/admin-tabs";
import { discordMutationsAllowed } from "@/lib/discord-mutation-policy";
import {
  getInhouseBoardStatus,
  type InhouseBoardStatus,
} from "@/lib/inhouse-board-service";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, CardBody, textLink } from "@/components/ui";
import { AdminSection } from "@/components/admin/admin-section";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";

/**
 * Loads the inhouse half of Discord. Its own component so the Inhouse tab
 * can put it behind <Suspense>: the board status reads Discord.
 */
export async function InhouseDiscordSection() {
  // Whether the league webhook is set (the board falls back to it); never
  // the URL itself, a bearer credential.
  const [board, dbWebhook] = await Promise.all([
    getInhouseBoardStatus(),
    getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL),
  ]);
  return (
    <InhouseDiscordControls
      board={board}
      leagueConfigured={!!(dbWebhook || process.env.DISCORD_WEBHOOK_URL)}
      mutationsAllowed={discordMutationsAllowed()}
    />
  );
}

/** One line for the folded card: where inhouse posts go and the board. */
function inhouseDiscordSummary(board: InhouseBoardStatus): string {
  const channel = board.separateChannel
    ? "Inhouse posts go to their own channel"
    : "Inhouse posts share the league channel";
  const queueBoard = board.posted
    ? board.stranded
      ? "the queue board is stranded"
      : "the queue board is posted"
    : "no queue board posted";
  const role = board.pingRoleId ? "a ping role is set" : "no ping role";
  return `${channel} · ${queueBoard} · ${role}.`;
}

/**
 * Inhouse on Discord, on the Inhouse tab: the inhouse channel's webhook, the
 * alerts channel, the ping role and the live queue board. They used to sit
 * in the middle of the league's Discord notifications card.
 */
function InhouseDiscordControls({
  board,
  leagueConfigured,
  mutationsAllowed,
}: {
  board: InhouseBoardStatus;
  /** The league webhook is set, so inhouse posts have somewhere to go. */
  leagueConfigured: boolean;
  mutationsAllowed: boolean;
}) {
  return (
    <AdminSection
      id="adm-inhouse-discord"
      title="Inhouse Discord"
      subtitle={inhouseDiscordSummary(board)}
    >
      <CardBody className="space-y-3">
        {!mutationsAllowed ? (
          <div
            role="status"
            className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm"
          >
            <b>Read-only Discord preview.</b> Posting messages and changing
            live Discord messages are disabled here.
          </div>
        ) : null}

        <div className="space-y-3 border-t border-line pt-3 first:border-t-0 first:pt-0">
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

          <p className="text-xs text-muted">
            Whether the bot can grant this role is in the bot checklist under{" "}
            <a href={adminHref("adm-discord")} className={textLink()}>
              Discord notifications
            </a>{" "}
            on the Discord &amp; news tab.
          </p>

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
                    !mutationsAllowed || (!leagueConfigured && !board.separateChannel)
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
      </CardBody>
    </AdminSection>
  );
}
