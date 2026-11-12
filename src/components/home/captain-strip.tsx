import Link from "@/components/app-link";
import { Badge, LinkArrow } from "@/components/ui";
import { CAPTAINS_HREF } from "@/lib/captains";
import { loadCaptainTodoRows } from "@/lib/captains-service";
import { captainTodoCountLine } from "@/lib/captain-todos";
import { postAuctionWorkOpen } from "@/lib/league-lifecycle";
import type { SeasonSnapshot } from "@/lib/queries";

/**
 * For a sitting captain only, one line under the hero: how many things wait
 * on them across their team's open matches (`captainTodos`, the rule the
 * match page and the Captains page read), linking the Captains page. Like
 * AdminStrip, database reads only, never Discord, and only captains (about a
 * dozen people a league) ever run them.
 */
export async function CaptainStrip({
  snapshot,
  team,
  viewerId,
}: {
  snapshot: SeasonSnapshot;
  team: { id: string; name: string };
  viewerId: string;
}) {
  const { season, draftStatus } = snapshot;
  // A server component renders once per request; the line is a snapshot.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const todos = await loadCaptainTodoRows({
    season,
    draftStatus,
    teamId: team.id,
    viewerId,
    nowMs,
  });
  const first = todos[0];
  return (
    <Link
      href={CAPTAINS_HREF}
      data-testid="captain-strip"
      className="group flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm transition-colors hover:border-muted/60"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone="accent">Captain</Badge>
        {first ? (
          <>
            <span className="font-medium text-fg">
              {captainTodoCountLine(todos.length)}
            </span>
            <span className="min-w-0 text-muted [overflow-wrap:anywhere]">
              <span aria-hidden>· </span>
              {first.roundLabel} vs {first.opponentName}
              {todos.length > 1 ? " first" : ""}
            </span>
          </>
        ) : (
          <span className="min-w-0 text-fg [overflow-wrap:anywhere]">
            {postAuctionWorkOpen(season.status, draftStatus)
              ? "Nothing needs you right now"
              : `Your team: ${team.name}`}
          </span>
        )}
      </span>
      <span className="shrink-0 font-medium text-accent group-hover:underline">
        Manage your team <LinkArrow />
      </span>
    </Link>
  );
}
