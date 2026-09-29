import Link from "next/link";
import { LinkArrow } from "@/components/ui";
import { INHOUSE, INHOUSE_ACTIVE_STATUSES } from "@/lib/constants";
import { queuePresentCutoff } from "@/lib/inhouse";
import { prisma } from "@/lib/prisma";

// The inhouse scene runs year-round but was invisible from the dashboard.
// A slim strip keeps it one click away in every phase. Read-only queries —
// lobby formation/resolution stays lazy on the /inhouse poll.
//
// `tile` is the same live line drawn as one of the dashboard's side-game
// tiles (season-view.tsx), which used to print a static "Inhouse" tile and
// this strip under it.
export async function InhouseStrip({
  variant = "strip",
}: {
  variant?: "strip" | "tile";
} = {}) {
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
  const liveDot = liveLobby ? (
    <span
      aria-hidden
      className="animate-live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-success"
    />
  ) : null;

  if (variant === "tile") {
    return (
      <Link
        href="/inhouse"
        className="group flex min-w-0 items-center gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 transition-colors hover:border-muted/60"
      >
        <span aria-hidden className="text-xl">
          ⚔️
        </span>
        <span className="min-w-0 flex-1">
          {/* The call to action shares the title's line, so the live line
              below it gets the tile's whole width. */}
          <span className="flex items-center gap-1.5 text-sm">
            <span className="font-medium group-hover:text-info">Inhouse</span>
            {liveDot}
            <span className="ml-auto shrink-0 pl-2 text-xs font-medium text-accent group-hover:underline">
              {cta} <LinkArrow />
            </span>
          </span>
          <span className="block text-xs text-muted">{label}</span>
        </span>
      </Link>
    );
  }

  return (
    <Link
      href="/inhouse"
      className="group flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm transition-colors hover:border-muted/60"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden>⚔️</span>
        {liveDot}
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
