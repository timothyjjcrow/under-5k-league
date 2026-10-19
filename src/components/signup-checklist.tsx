import type { DiscordNote } from "@/lib/account-page";
import { DISCORD_INVITE_URL } from "@/lib/constants";
import type {
  SignupChecklistCta,
  SignupChecklistState,
  SignupChecklistStep,
} from "@/lib/signup-discord";
import { StripQueryParam } from "@/components/strip-query-param";
import { DiscordButton, buttonClasses, textLink } from "@/components/ui";

// The steps to join a season, on /me, while the Discord rule applies to the
// player (`signupChecklist` decides every word and control): Steam, Discord,
// then the signup form. Presentational and server-safe.

/** Read before each step's name, since the markers are only pictures. */
const STATE_WORD: Record<SignupChecklistState, string> = {
  done: "Done",
  current: "To do now",
  locked: "Not yet",
  checking: "Checking",
};

function Marker({ n, state }: { n: number; state: SignupChecklistState }) {
  const tone =
    state === "done"
      ? "border-success/50 bg-success/15 text-success"
      : state === "current"
        ? "border-accent bg-accent/15 text-accent"
        : "border-line bg-surface-2/60 text-muted";
  return (
    <span
      aria-hidden
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${tone}`}
    >
      {state === "done" ? "✓" : n}
    </span>
  );
}

function Cta({ cta, main }: { cta: SignupChecklistCta; main: boolean }) {
  if (cta.kind === "oauth") {
    return (
      <a
        href="/api/auth/discord"
        className={buttonClasses(main ? "primary" : "secondary", "sm")}
      >
        {cta.label}
      </a>
    );
  }
  if (cta.kind === "invite") {
    if (main) return <DiscordButton size="sm" label={cta.label} />;
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
  // A plain link, so it reloads /me and its live membership read.
  return (
    <a href="/me" className={buttonClasses(main ? "primary" : "secondary", "sm")}>
      {cta.label}
    </a>
  );
}

/** The OAuth callback's one-shot report, shown once on the Discord step. */
function CallbackNote({ note }: { note: DiscordNote }) {
  return (
    <>
      <StripQueryParam param="discord" />
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
    </>
  );
}

export function SignupChecklist({
  steps,
  note = null,
}: {
  steps: SignupChecklistStep[];
  /** The ?discord= note for this render, if any (`discordLinkNote`). */
  note?: DiscordNote | null;
}) {
  return (
    <ol
      id="signup-checklist"
      aria-label="Steps to join the season"
      className="space-y-4 rounded-lg border border-line bg-surface-2/40 p-4"
    >
      {steps.map((step, index) => (
        <li
          key={step.key}
          id={step.key === "discord" ? "signup-discord-step" : undefined}
          data-state={step.state}
          className="flex scroll-mt-24 gap-3"
        >
          <Marker n={index + 1} state={step.state} />
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <p
                className={
                  step.state === "locked"
                    ? "font-medium text-muted"
                    : "font-medium text-fg"
                }
              >
                <span className="sr-only">{STATE_WORD[step.state]}: </span>
                {step.label}
              </p>
              <p
                role={step.state === "checking" ? "status" : undefined}
                className="text-sm text-muted [overflow-wrap:anywhere]"
              >
                {step.detail}
              </p>
            </div>
            {step.key === "discord" && note ? <CallbackNote note={note} /> : null}
            {step.ctas.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {step.ctas.map((cta, ctaIndex) => (
                  <Cta key={cta.kind} cta={cta} main={ctaIndex === 0} />
                ))}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
