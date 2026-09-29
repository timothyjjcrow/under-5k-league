import Link from "next/link";
import { LinkArrow } from "@/components/ui";
import { INHOUSE, INHOUSE_ACTIVE_STATUSES } from "@/lib/constants";
import { queuePresentCutoff } from "@/lib/inhouse";
import { prisma } from "@/lib/prisma";

// The inhouse scene runs year-round but was invisible from the dashboard.
// A slim strip keeps it one click away in every phase. Read-only queries —
// lobby formation/resolution stays lazy on the /inhouse poll.
export async function InhouseStrip() {
  const [queued, liveLobby] = await Promise.all([
    // Same presence rule as /inhouse: only recently-seen players count.
    prisma.inhouseQueueEntry.count({
      // eslint-disable-next-line react-hooks/purity -- async server component
      where: { lastSeenAt: { gte: queuePresentCutoff(Date.now()) } },
    }),
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: { id: true },
    }),
  ]);

  const label = liveLobby
    ? queued > 0
      ? `An inhouse is live · ${queued} / ${INHOUSE.LOBBY_SIZE} queued next`
      : "An inhouse is live — the next-game queue is open"
    : queued > 0
      ? `${queued} / ${INHOUSE.LOBBY_SIZE} queued for the next inhouse`
      : "The inhouse queue is open";
  const cta = liveLobby
    ? "Watch or queue"
    : queued > 0
      ? "Jump in"
      : "Start the queue";

  return (
    <Link
      href="/inhouse"
      className="group flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm transition-colors hover:border-muted/60"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden>⚔️</span>
        {liveLobby ? (
          <span
            aria-hidden
            className="animate-live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success"
          />
        ) : null}
        {/* Two lines on a phone rather than "The inhouse queue i…": the
            sentence is the strip's whole message. */}
        <span className="line-clamp-2 text-muted">{label}</span>
      </span>
      <span className="shrink-0 font-medium text-accent group-hover:underline">
        {cta} <LinkArrow />
      </span>
    </Link>
  );
}
