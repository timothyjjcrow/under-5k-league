import { revokeAllSessions } from "@/app/actions/admin-season";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CardBody } from "@/components/ui";
import { AdminSection } from "@/components/admin/admin-section";

export function SecurityControls() {
  return (
    <AdminSection
      id="adm-security"
      title="Security"
      subtitle="Break-glass session controls."
    >
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 p-3">
          <p className="min-w-[14rem] flex-1 text-xs text-muted">
            <span className="font-medium text-fg">Sign out all users:</span>{" "}
            invalidates every active session at once — use if a login token may
            have leaked or an account is compromised. Everyone (including you)
            has to sign in with Steam again.
          </p>
          <ActionForm action={revokeAllSessions}>
            <SubmitButton
              variant="secondary"
              size="sm"
              confirm="Sign out ALL users, including yourself? Everyone must log in again."
            >
              Sign out all users
            </SubmitButton>
          </ActionForm>
        </div>
      </CardBody>
    </AdminSection>
  );
}
