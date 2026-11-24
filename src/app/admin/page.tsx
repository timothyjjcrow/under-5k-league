import Link from "@/components/app-link";
import { Card, CardBody, CardHeader, buttonClasses } from "@/components/ui";
import { adminHref } from "@/lib/admin-tabs";
import { loadAdminContext } from "@/components/admin/admin-context";
import { AdminFrame, AdminGateScreen } from "@/components/admin/admin-frame";
import { AdminHashForwarder } from "@/components/admin/admin-hash-forwarder";
import { AdminAnchor } from "@/components/admin/admin-section";
import { AdminAttention } from "@/components/admin/needs-attention-card";
import { SeasonControls } from "@/components/admin/season-controls";
import { TonightMatches } from "@/components/admin/tonight-matches";

export const metadata = { title: "Admin" };

// Server Actions invoked from an admin page inherit its segment's function
// budget. The bulk OpenDota syncs (ranks, league) fan out network calls that
// can each hit an 8s timeout, so give them headroom above the platform
// default rather than being killed mid-run (which leaves the button spinning
// "Working…"). 60s is the Hobby-plan ceiling; the actions themselves stop
// well before it. Every admin tab sets the same.
export const maxDuration = 60;

/**
 * Overview: what needs the admin now (the next step, then every to-do, each
 * linking to its card on the tab that holds it), tonight's matches, and the
 * league's phase. Every other card lives on one fixed tab (admin-tabs.ts);
 * an old /admin#card link is forwarded there.
 */
export default async function AdminPage() {
  const ctx = await loadAdminContext();
  if (ctx.gate !== "admin") return <AdminGateScreen gate={ctx.gate} path="/admin" />;
  const { season, data } = ctx;
  return (
    <AdminFrame tab="overview" counts={ctx.tabCounts}>
      <AdminHashForwarder />
      {season && data ? (
        <>
          <AdminAttention
            season={season}
            data={data}
            nextStep={ctx.nextStep}
            attention={ctx.attention}
            sections={ctx.sections}
          />
          {ctx.tonight.length > 0 ? (
            <TonightMatches
              season={season}
              data={data}
              slate={ctx.tonight}
              nowMs={ctx.nowMs}
            />
          ) : null}
          {ctx.nextStep ? (
            <AdminAnchor id="adm-season">
              <SeasonControls season={season} data={data} nextStep={ctx.nextStep} />
            </AdminAnchor>
          ) : null}
        </>
      ) : (
        <Card id="adm-attention" className="scroll-mt-40 lg:scroll-mt-56">
          <CardHeader headingLevel={2} title="No active season" />
          <CardBody className="space-y-3 text-sm text-muted">
            <p>
              The league is between seasons. Open the next one on Season;
              inhouse, Discord, news and System work the same with or without
              one.
            </p>
            <Link
              href={adminHref("adm-new-season")}
              className={buttonClasses("primary", "sm")}
            >
              Open a new season
            </Link>
          </CardBody>
        </Card>
      )}
    </AdminFrame>
  );
}
