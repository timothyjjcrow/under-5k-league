import type { SignupDiscordStep } from "@/lib/signup-discord";
import { buttonClasses } from "@/components/ui";

/**
 * The signup card's Discord step on /me, shown in place of the signup form
 * until the player's linked account is in the league's server
 * (`signupDiscordStep` decides the copy and controls). Presentational and
 * server-safe. Its main control is an in-page link to the Discord card,
 * which holds the buttons that do the work; "Check again" is a plain link to
 * /me, so it reloads the page and its live membership read.
 */
export function SignupDiscordStepPanel({ step }: { step: SignupDiscordStep }) {
  return (
    <div
      id="signup-discord-step"
      className="scroll-mt-24 rounded-lg border border-accent/35 bg-accent/10 px-4 py-3"
    >
      <h3 className="font-medium text-fg">{step.title}</h3>
      <p className="mt-1 text-sm text-muted">{step.body}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {step.ctas.map((cta, index) =>
          cta.kind === "card" ? (
            <a
              key={cta.kind}
              href="#profile-discord"
              className={buttonClasses(index === 0 ? "primary" : "secondary", "sm")}
            >
              {cta.label} <span aria-hidden>↓</span>
            </a>
          ) : (
            <a
              key={cta.kind}
              href="/me"
              className={buttonClasses(index === 0 ? "primary" : "secondary", "sm")}
            >
              {cta.label}
            </a>
          ),
        )}
      </div>
    </div>
  );
}
