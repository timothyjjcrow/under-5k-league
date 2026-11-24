import { Suspense } from "react";
import Link from "@/components/app-link";
import { CardBody, CardSkeleton, buttonClasses } from "@/components/ui";
import { loadAdminContext } from "@/components/admin/admin-context";
import { AdminFrame, AdminGateScreen } from "@/components/admin/admin-frame";
import { AdminSection } from "@/components/admin/admin-section";
import { AdminInhouseNight } from "@/components/admin/inhouse-night-section";

export const metadata = { title: "Inhouse · Admin" };

// See /admin: Server Actions inherit this segment's function budget.
export const maxDuration = 60;

/**
 * Inhouse: season-independent, like inhouse itself. The planned inhouse
 * night, and the page that sets any player's inhouse MMR and medal and
 * makes or lifts inhouse bans.
 */
export default async function AdminInhousePage() {
  const ctx = await loadAdminContext();
  if (ctx.gate !== "admin") return <AdminGateScreen gate={ctx.gate} path="/admin/inhouse" />;
  return (
    <AdminFrame tab="inhouse" counts={ctx.tabCounts}>
      {/* Streamed: its Discord interested count must never hold up the page. */}
      <Suspense fallback={<CardSkeleton rows={2} />}>
        <AdminInhouseNight />
      </Suspense>
      {/* Any player's inhouse MMR and medal, signed up for the league or not:
          a page of its own, since it lists and searches every player. */}
      <AdminSection
        id="adm-inhouse-players"
        title="Inhouse players"
        subtitle="Set any player's inhouse MMR and medal, signed up for the league or not, and ban players from inhouse games."
      >
        <CardBody className="space-y-3">
          <p className="text-sm text-muted">
            Every inhouse join uses an MMR set there, over the player&apos;s
            league signup&apos;s and anything they type. The medal is the one
            shown across the site. Inhouse bans are made and lifted there
            too, with the Discord role a banned player gets.
          </p>
          <Link
            href="/admin/inhouse-players"
            className={buttonClasses("secondary", "sm")}
          >
            Open inhouse players
          </Link>
        </CardBody>
      </AdminSection>
    </AdminFrame>
  );
}
