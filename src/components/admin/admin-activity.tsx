import Link from "@/components/app-link";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { recentAdminActions } from "@/lib/admin-log";
import { CardBody, textLink } from "@/components/ui";
import { AdminSection } from "@/components/admin/admin-section";

/**
 * WHAT DID I PRESS? Until now nothing in the app could answer that: no model
 * carried an actor column, and Discord announces signups, sales and results but
 * is silent on every destructive action. Streamed behind Suspense like the
 * Discord card — it is a diagnostic, and must never delay the controls above it.
 */
export async function AdminActivity() {
  // A preview only: the full log, with search, lives at /admin/activity, so
  // a 40-row copy here was the same list twice.
  const rows = await recentAdminActions(5);
  return (
    <AdminSection
      id="adm-activity"
      title="Recent admin activity"
      subtitle="The last five changes, newest first. The full log is searchable on its own page."
    >
      <CardBody className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing recorded yet. Season, draft, schedule, playoff and result
            changes are logged here from now on.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-line px-3 py-1.5 text-sm"
              >
                <span className="font-medium">{r.actorName}</span>
                <span className="min-w-0 flex-1 text-muted">{r.summary}</span>
                <LocalTime
                  ts={r.createdAt.getTime()}
                  variant="short"
                  initial={formatLeagueMatchTime(r.createdAt, "short")}
                  className="shrink-0 text-xs text-muted tabular-nums"
                />
              </li>
            ))}
          </ul>
        )}
        <Link href="/admin/activity" className={textLink()}>
          All admin activity →
        </Link>
      </CardBody>
    </AdminSection>
  );
}
