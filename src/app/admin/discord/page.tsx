import { Suspense } from "react";
import { CardSkeleton } from "@/components/ui";
import { loadAdminContext } from "@/components/admin/admin-context";
import { AdminFrame, AdminGateScreen } from "@/components/admin/admin-frame";
import { AdminAnchor } from "@/components/admin/admin-section";
import { DiscordSection } from "@/components/admin/discord-controls";
import { AdminNews } from "@/components/admin/news-controls";
import { StreamControls } from "@/components/admin/stream-controls";

export const metadata = { title: "Discord & news · Admin" };

// See /admin: Server Actions inherit this segment's function budget.
export const maxDuration = 60;

/**
 * Discord & news: the league's Discord setup (announcements, the #schedule
 * status card, the Standin role, and the year-round inhouse board, alerts
 * and ping role), league news, and the match stream link. None of it
 * belongs to a season.
 */
export default async function AdminDiscordPage({
  searchParams,
}: {
  searchParams: Promise<{ newsPage?: string | string[] }>;
}) {
  const ctx = await loadAdminContext();
  if (ctx.gate !== "admin") return <AdminGateScreen gate={ctx.gate} path="/admin/discord" />;
  return (
    <AdminFrame tab="discord" counts={ctx.tabCounts}>
      {/* Streamed: Discord health has bounded network calls and must never
          hold up the rest of the page. */}
      <Suspense fallback={<CardSkeleton rows={6} />}>
        <DiscordSection />
      </Suspense>
      <Suspense fallback={<CardSkeleton rows={4} />}>
        <AdminNews searchParams={searchParams} />
      </Suspense>
      {/* The stream link outlives the season and needs no active one. */}
      <AdminAnchor id="adm-stream">
        <Suspense fallback={<CardSkeleton rows={2} />}>
          <StreamControls />
        </Suspense>
      </AdminAnchor>
    </AdminFrame>
  );
}
