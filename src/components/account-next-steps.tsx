import type { AccountStep } from "@/lib/account-page";

// Presentational and server-safe. Each step is ONE in-page link whose name is
// the whole task, so no two controls on /me share a name with the buttons in
// the cards they point at (the one-control-one-name rule).

const ROW =
  "flex min-h-11 items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

function StepLink({ step, className }: { step: AccountStep; className: string }) {
  return (
    <a href={step.href} className={`${ROW} ${className}`}>
      <span className="min-w-0">{step.label}</span>
      <span aria-hidden className="shrink-0 text-muted">
        {step.arrow === "up" ? "↑" : "↓"}
      </span>
    </a>
  );
}

/**
 * "You're signed up. Next:" under the signup form, right where the player
 * pressed the button. Renders nothing once nothing is left.
 */
export function SignupNextSteps({ steps }: { steps: AccountStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div
      id="signup-next-steps"
      className="rounded-lg border border-accent/35 bg-accent/5 p-3"
    >
      <h3 className="text-sm font-medium text-fg">You&apos;re signed up. Next:</h3>
      <ul className="mt-2 space-y-2">
        {steps.map((step) => (
          <li key={step.key}>
            <StepLink
              step={step}
              className="border-line bg-surface/60 hover:border-muted/60"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The single most urgent step, as one line at the top of the page. */
export function AccountNextStepBanner({ step }: { step: AccountStep | undefined }) {
  if (!step) return null;
  return (
    <StepLink
      step={step}
      className="border-accent/35 bg-accent/5 hover:bg-accent/10"
    />
  );
}
