import { prisma } from "@/lib/prisma";
import { LocalTime } from "@/components/local-time";
import { formatMatchTime } from "@/lib/match-time";
import { ImportProgressControls } from "@/components/import-progress-controls";
import Link from "next/link";

const labels: Record<string, string> = {
  PENDING: "Waiting for game details",
  READY: "Downloaded; awaiting matching",
  RETRYABLE: "Waiting to retry",
  NEEDS_REVIEW: "Review needed",
};

/** Admin-only caller; never select cached provider payloads for this view. */
export async function ImportProgress({ seasonId, page, query = {} }: {
  seasonId: string;
  page?: string | string[];
  query?: Record<string, string | string[] | undefined>;
}) {
  const count = await prisma.importCandidate.count({
    where: { seasonId, status: { in: Object.keys(labels) } },
  });
  if (count === 0) return null;
  const pageSize = 25;
  const lastPage = Math.ceil(count / pageSize);
  const requestedPage = typeof page === "string" && /^[1-9]\d{0,8}$/.test(page)
    ? Number(page) : 1;
  const currentPage = Math.min(requestedPage, lastPage);
  const rows = await prisma.importCandidate.findMany({
      where: { seasonId, status: { in: Object.keys(labels) } },
      // The fixed status names put NEEDS_REVIEW before PENDING/READY/RETRYABLE.
      // Pagination still exposes every item even when review alone exceeds 25.
      orderBy: [{ status: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, dotaMatchId: true, status: true, reason: true,
        attempts: true, fetchedAt: true, nextAttemptAt: true, updatedAt: true, revision: true,
      },
  });
  function pageHref(target: number) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === "importPage" || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
    }
    params.set("importPage", String(target));
    return `/admin?${params.toString()}#adm-sync`;
  }
  return (
    <section aria-label="Saved import progress" className="space-y-3 rounded-lg border border-line p-3">
      <h3 className="font-semibold">Saved import progress</h3>
      <p className="text-sm text-muted">
        {count} game{count === 1 ? " is" : "s are"} waiting for details or a safe fixture match.
        Downloaded details survive interrupted syncs. Review items need attention:
        queue an item for the next sync, or ignore it with a reason. To correct an
        existing result, import a verified game ID from its match page.
      </p>
      <ul className="space-y-3 text-sm">
        {rows.map((row) => (
          <li key={row.id} className="border-t border-line pt-2">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium">Game {row.dotaMatchId}</span>
              <span className={row.status === "NEEDS_REVIEW" ? "text-danger" : "text-muted"}>
                {labels[row.status]}
              </span>
            </div>
            <p className="text-xs text-muted">
              {row.attempts} attempt{row.attempts === 1 ? "" : "s"}
              {row.fetchedAt ? " · Details saved" : " · Details not available yet"}
              {row.reason ? ` · ${row.reason.replaceAll("_", " ").toLowerCase()}` : ""}
            </p>
            <p className="text-xs text-muted">
              Last activity: <LocalTime ts={row.updatedAt.getTime()} variant="short" initial={formatMatchTime(row.updatedAt, "short")} />
              {row.nextAttemptAt && row.status !== "NEEDS_REVIEW" ? (
                <> · Retry after <LocalTime ts={row.nextAttemptAt.getTime()} variant="short" initial={formatMatchTime(row.nextAttemptAt, "short")} /></>
              ) : null}
            </p>
            <ImportProgressControls candidateId={row.id} seasonId={seasonId} revision={row.revision} />
          </li>
        ))}
      </ul>
      {lastPage > 1 ? (
        <nav aria-label="Import progress pages" className="flex flex-wrap items-center gap-4 text-sm">
          {currentPage > 1 ? <Link href={pageHref(currentPage - 1)} className="py-2 text-accent hover:underline">Previous import items</Link> : null}
          <span className="text-muted">Page {currentPage} of {lastPage} · Review needed first</span>
          {currentPage < lastPage ? <Link href={pageHref(currentPage + 1)} className="py-2 text-accent hover:underline">Next import items</Link> : null}
        </nav>
      ) : null}
    </section>
  );
}
