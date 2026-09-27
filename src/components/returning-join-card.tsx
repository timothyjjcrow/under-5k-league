import type { ReactNode } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import type { ActionResult } from "@/lib/action-result";
import type { ReturningJoinPlan } from "@/lib/account-page";
import { parseRoles } from "@/lib/roles";

/**
 * "Welcome back" on /me for a player with a signup from an earlier season and
 * none in this one: last season's answers in one line, the MMR that will
 * actually be saved against today's medal, and one tap to join with them (two
 * for a former standin, who picks rather than being pre-set to Standin). The
 * buttons post to the same action as the full signup form, so every signup
 * check still runs; the full form stays one tap away behind "Change answers".
 */
export function ReturningJoinCard({
  plan,
  seasonName,
  roles,
  hidden,
  action,
  notice,
}: {
  plan: ReturningJoinPlan;
  /** The earlier season the answers come from. */
  seasonName: string;
  /** Last season's stored role keys ("1,3"). */
  roles: string | null | undefined;
  /** Every other answer, posted as it was saved last season. */
  hidden: Record<string, string>;
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  /** What joining makes public: shown beside the buttons, since joining is
   *  the consent. */
  notice: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-info/40 bg-info/10 px-4 py-3">
      <div>
        <h3 className="font-medium text-fg">Welcome back</h3>
        <p className="mt-1 text-sm text-muted">
          Your {seasonName} signup:{" "}
          <span className="text-fg">{plan.summary}</span>
        </p>
        <p className="mt-1 text-sm font-medium text-fg">{plan.mmrLine}</p>
        {plan.note ? (
          <p className="mt-1 text-xs text-muted">{plan.note}</p>
        ) : null}
      </div>
      {notice}
      <ActionForm
        action={action}
        hidden={hidden}
        className="flex flex-wrap items-center gap-3"
      >
        {/* A repeated field (formData.getAll), so one input per role. */}
        {parseRoles(roles).map((role) => (
          <input key={role} type="hidden" name="roles" value={role} />
        ))}
        {plan.buttons.map((button) => (
          <SubmitButton
            key={button.type}
            name="type"
            value={button.type}
            variant={button.primary ? "primary" : "secondary"}
          >
            {button.label}
          </SubmitButton>
        ))}
      </ActionForm>
    </div>
  );
}
