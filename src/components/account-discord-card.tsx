import type { ActionResult } from "@/lib/action-result";
import {
  discordCardCtas,
  discordLinkNote,
  type AccountMembership,
  type DiscordCta,
} from "@/lib/account-page";
import { DISCORD_INVITE_URL } from "@/lib/constants";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DiscordTag } from "@/components/discord-tag";
import { StripQueryParam } from "@/components/strip-query-param";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DiscordButton,
  buttonClasses,
  textLink,
} from "@/components/ui";

type FormAction = (prev: ActionResult, fd: FormData) => Promise<ActionResult>;

// My account's ONE Discord card. It used to sit under a separate "one step
// left" card and a join card that asked the same thing with identically named
// buttons. Now the card's headline badge and its single primary button follow
// the state (not linked, not in the server, rules pending, done), the invite
// stays beside any one-click OAuth button, and the typed handle sits behind a
// small "Can't link?" disclosure. Presentational and server-safe: the page
// reads the facts (and the one live member lookup) and passes them in.

function CtaButton({ cta, main }: { cta: DiscordCta; main: boolean }) {
  if (cta.kind === "oauth") {
    return (
      <a href="/api/auth/discord" className={buttonClasses("primary", "sm")}>
        {cta.label}
      </a>
    );
  }
  if (main) return <DiscordButton size="sm" label={cta.label} />;
  // The secondary invite is a quiet link, so the card keeps one main button.
  return (
    <a
      href={DISCORD_INVITE_URL}
      target="_blank"
      rel="noreferrer"
      className={textLink("text-sm")}
    >
      {cta.label} <span aria-hidden>↗</span>
    </a>
  );
}

export function AccountDiscordCard({
  discordId,
  discordName,
  membership,
  param,
  linkAvailable,
  autoJoins,
  isCaptain,
  warnBeforeLeaving,
  pingOptIn,
  unlinkAction,
  saveHandleAction,
  pingAction,
}: {
  /** The OAuth-linked snowflake; null when not linked. */
  discordId: string | null;
  /** The handle: from the link when linked, typed by hand otherwise. */
  discordName: string | null;
  /** Live membership of the linked account. null = we can't tell (no bot,
   *  Discord slow), and it never renders as "not in the server". */
  membership: AccountMembership;
  /** The one-shot ?discord= code from the OAuth callback. */
  param?: string;
  linkAvailable: boolean;
  autoJoins: boolean;
  isCaptain: boolean;
  /** Warn that the OAuth link leaves the page (an unsaved signup is lost). */
  warnBeforeLeaving: boolean;
  /** `on: null` = unknown; rendered as unknown, never as "off". */
  pingOptIn: { available: boolean; on: boolean | null };
  unlinkAction: FormAction;
  saveHandleAction: FormAction;
  pingAction: FormAction;
}) {
  const linked = !!discordId;
  const note = discordLinkNote(param, membership);
  const ctas = discordCardCtas({
    linked,
    membership,
    linkAvailable,
    autoJoins,
    hasInvite: !!DISCORD_INVITE_URL,
    param,
  });
  const oneClick = linkAvailable && autoJoins;
  const ctaRow =
    ctas.primary || ctas.secondary ? (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {ctas.primary ? <CtaButton cta={ctas.primary} main /> : null}
        {ctas.secondary ? <CtaButton cta={ctas.secondary} main={false} /> : null}
      </div>
    ) : null;

  const handleForm = (
    <ActionForm action={saveHandleAction} className="space-y-1.5">
      <label htmlFor="discord-handle" className="block text-sm font-medium">
        Discord username
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="discord-handle"
          name="discordName"
          defaultValue={discordName ?? ""}
          placeholder="e.g. dendi_official"
          maxLength={40}
          // Grows beside Save instead of a fixed 20rem that pushed Save to
          // its own line in the account page's rail.
          className="h-10 min-w-0 max-w-xs flex-1 basis-48 rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
        />
        <SubmitButton variant="secondary" size="sm">
          Save
        </SubmitButton>
      </div>
      <p className="text-xs text-muted">
        {linkAvailable
          ? "Captains can copy a typed handle, but the league can't ping it. "
          : ""}
        Blank clears it. Legacy Name#1234 tags work too.
      </p>
    </ActionForm>
  );

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Discord"
        subtitle={
          linked
            ? membership === "member"
              ? isCaptain
                ? "Linked and in the league's Discord server — your handle is verified, and your team and league admins can reach you."
                : "Linked and in the league's Discord server — your handle is verified, and captains can reach you."
              : "Linked via Discord — your handle is verified, and shown to you, league admins, and active league participants."
            : discordName
              ? "Shown to you, league admins, and active league participants on rosters and the player pool."
              : isCaptain
                ? "Add your Discord so your team and league admins can reach you — it's how the league coordinates."
                : "Add your Discord so your captain can reach you — it's how the league talks."
        }
        action={
          /* The badge only claims what this render actually verified:
             membership when the bot could answer, plain "Linked ✓" when it
             couldn't (no bot, or Discord down) — an unknown must never be
             downgraded to "Not in the server". */
          linked ? (
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
        {note ? <StripQueryParam param="discord" /> : null}
        {note ? (
          <p
            role={note.tone === "danger" ? "alert" : "status"}
            className={
              note.tone === "success"
                ? "rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
                : note.tone === "danger"
                  ? "rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-soft"
                  : "rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm text-muted"
            }
          >
            {note.text}
          </p>
        ) : null}

        {linked ? (
          <>
            {/* Live state, re-derived on every render, so it survives the
                scrubbed query param and disappears once the join (or the
                rules screen) is done. */}
            {membership === "not-member" ? (
              <p className="text-sm text-danger">
                {/* "The account you linked", never "you": the check is by ID,
                    and the commonest cause is a player in the server on a
                    DIFFERENT account. Naming the handle makes that clear. */}
                The Discord account you linked
                {discordName ? ` (@${discordName})` : ""}
                {/* Quoted string: JSX line-trimming eats a plain leading
                    space after an expression across a source-line break. */}
                {
                  " isn't in the league's server — that's where scheduling, match-night check-ins and standin scrambles happen, and nothing can reach you until it is."
                }
                {oneClick
                  ? ' In the server on a different account? "Join the server" re-links whichever account your browser is signed into, so one click fixes both.'
                  : linkAvailable
                    ? " In the server on a different account? Unlink below, then link the one you use."
                    : ""}
              </p>
            ) : membership === "pending" ? (
              <p className="text-sm text-muted">
                You&apos;re in the server but haven&apos;t accepted its rules
                yet — until you do, nothing can ping you: not match found, not
                {isCaptain ? " your team." : " your captain."}
              </p>
            ) : null}
            {ctaRow}
            <div className="flex flex-wrap items-center gap-3">
              {discordName ? <DiscordTag name={discordName} verified /> : null}
              <ActionForm action={unlinkAction}>
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
                      Get a Discord notification when a queue is filling up
                      and when your match is found. Off by default, and you
                      can turn it back off here any time.
                    </p>
                  </div>
                  <ActionForm action={pingAction}>
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
                    Couldn&apos;t check your current setting — either Discord
                    is slow right now, or you&apos;re not in the league&apos;s
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
            {ctaRow}
            {linkAvailable ? (
              <p className="text-xs text-muted">
                {/* This has to describe the real consent screen. With
                    guilds.join in the scope, the copy must name both the
                    stable identity we store and the server write it permits. */}
                {autoJoins
                  ? "Discord gives us your account ID and username to verify the link and lets us add that account to the league server. We don't request your email or server list, and the OAuth token is discarded after the callback."
                  : "Join the server with the invite, and link your account so captains can ping you. Discord gives us your account ID and username to verify the link. We don't request your email or server list, and the OAuth token is discarded after the callback."}
                {warnBeforeLeaving
                  ? " Linking leaves this page, so save your signup first if you've started it."
                  : ""}
              </p>
            ) : null}
            {discordName ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Your typed handle:</span>
                <DiscordTag name={discordName} />
              </div>
            ) : null}
            {linkAvailable ? (
              <details className="rounded-lg border border-line px-3">
                <summary className="min-h-11 cursor-pointer py-2.5 text-sm text-muted hover:text-fg">
                  Can&apos;t link? Type your handle
                </summary>
                <div className="pb-3">{handleForm}</div>
              </details>
            ) : (
              handleForm
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
