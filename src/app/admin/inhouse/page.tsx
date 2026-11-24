import { Suspense } from "react";
import { CardSkeleton } from "@/components/ui";
import { singleSearchParam } from "@/lib/search-params";
import { loadAdminContext } from "@/components/admin/admin-context";
import { AdminFrame, AdminGateScreen } from "@/components/admin/admin-frame";
import { AdminInhouseNight } from "@/components/admin/inhouse-night-section";
import { InhousePlayersSection } from "@/components/admin/inhouse-players-section";
import { InhouseDiscordSection } from "@/components/admin/inhouse-discord-controls";

export const metadata = { title: "Inhouse · Admin" };

// See /admin: Server Actions inherit this segment's function budget.
export const maxDuration = 60;

/**
 * Inhouse: season-independent, like inhouse itself. The planned inhouse
 * night; every player's inhouse MMR and medal, signed up for the league or
 * not, and the inhouse bans (`?q=` searches them); and inhouse on Discord
 * (the channel, the ping role, the live queue board).
 */
export default async function AdminInhousePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const ctx = await loadAdminContext();
  if (ctx.gate !== "admin") return <AdminGateScreen gate={ctx.gate} path="/admin/inhouse" />;
  // A repeated ?q= is no search, never an array.
  const raw = singleSearchParam((await searchParams).q);
  const search = raw ? raw.slice(0, 100) : null;
  return (
    <AdminFrame tab="inhouse" counts={ctx.tabCounts}>
      {/* Streamed: its Discord interested count must never hold up the page. */}
      <Suspense fallback={<CardSkeleton rows={2} />}>
        <AdminInhouseNight />
      </Suspense>
      <Suspense fallback={<CardSkeleton rows={4} />}>
        <InhousePlayersSection search={search} />
      </Suspense>
      {/* Streamed: the queue board's status reads Discord. */}
      <Suspense fallback={<CardSkeleton rows={2} />}>
        <InhouseDiscordSection />
      </Suspense>
    </AdminFrame>
  );
}
