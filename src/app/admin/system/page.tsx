import { Suspense } from "react";
import Link from "@/components/app-link";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { siteAnalyticsEnabled } from "@/lib/site-analytics";
import { webAnalyticsUrl } from "@/lib/web-analytics";
import {
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  LinkArrow,
  textLink,
} from "@/components/ui";
import { DatabaseHealth } from "@/components/database-health";
import { HistoryCoverage } from "@/components/history-coverage";
import { loadAdminContext } from "@/components/admin/admin-context";
import { AdminFrame, AdminGateScreen } from "@/components/admin/admin-frame";
import { AdminAnchor, AdminSection } from "@/components/admin/admin-section";
import { AutomationRunnerHealth } from "@/components/admin/automation-runner";
import { AdminActivity } from "@/components/admin/admin-activity";
import { SecurityControls } from "@/components/admin/security-controls";

export const metadata = { title: "System · Admin" };

// See /admin: Server Actions inherit this segment's function budget.
export const maxDuration = 60;

/**
 * System: how the site itself is doing. The automation runner, database
 * performance, historical records, recent admin activity, the league health
 * and imported-game reports, and break-glass security.
 */
export default async function AdminSystemPage() {
  const ctx = await loadAdminContext();
  if (ctx.gate !== "admin") return <AdminGateScreen gate={ctx.gate} path="/admin/system" />;
  const query = ctx.season ? `?season=${ctx.season.id}` : "";
  return (
    <AdminFrame tab="system" counts={ctx.tabCounts}>
      {/* Evergreen: cron also owns offseason and inhouse maintenance, and an
          absent active season must never hide the only production scheduler
          health surface. The query is isolated so an unavailable health
          table does not take the rest of the tab down with it. */}
      <AdminAnchor id="adm-automation">
        <Suspense fallback={<CardSkeleton rows={5} />}>
          <AutomationRunnerHealth />
        </Suspense>
      </AdminAnchor>
      <AdminSection
        id="adm-database"
        title="Database performance"
        subtitle="Connection waits, busy connections and timeouts on this server instance."
      >
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <DatabaseHealth />
        </Suspense>
      </AdminSection>
      <AdminAnchor id="adm-history">
        <AdminSection
          title="Historical records"
          subtitle="How many imported games are indexed and how much roster history is kept, with the tools to fill gaps."
        >
          <Suspense fallback={<CardSkeleton rows={3} />}>
            <HistoryCoverage />
          </Suspense>
        </AdminSection>
      </AdminAnchor>
      <div>
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <AdminActivity />
        </Suspense>
      </div>
      <Card>
        <CardHeader
          headingLevel={2}
          title="League reports"
          subtitle="Counts for one season: signups, check-ins, standins and Discord reach, and the imported games worth a second look."
        />
        <CardBody>
          {/* inline-flex min-h-6: on 12px text TAP_SAFE alone left a 22px
              target, under the 24px minimum. gap-y-2 keeps 8px between the
              two links when they wrap. */}
          <p className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
            <Link
              href={`/admin/data-quality${query}`}
              className={textLink("inline-flex min-h-6 items-center")}
            >
              Check imported-game quality <LinkArrow />
            </Link>
            <Link
              href={`/admin/health${query}`}
              className={textLink("inline-flex min-h-6 items-center")}
            >
              League health <LinkArrow />
            </Link>
          </p>
        </CardBody>
      </Card>
      <SecurityControls />
      {/* One outbound link, so a footer line rather than a card. Each league
          is its own Vercel project; the link follows this deployment's region.
          Only Vercel production counts traffic there: the self-hosted box
          reads Cloudflare's zone analytics, so it shows no link. */}
      {siteAnalyticsEnabled() ? (
        <p className="border-t border-line-soft pt-4 text-xs text-muted">
          Website traffic:{" "}
          <a
            href={webAnalyticsUrl(LEAGUE_CONFIG.region)}
            target="_blank"
            rel="noopener noreferrer"
            className={textLink()}
          >
            open {LEAGUE_CONFIG.name} in Vercel Web Analytics ↗
          </a>{" "}
          (needs access to the league&rsquo;s Vercel project; admin, account and
          sign-in pages aren&rsquo;t counted).
        </p>
      ) : null}
    </AdminFrame>
  );
}
