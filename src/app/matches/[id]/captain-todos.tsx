import { CaptainTodoItem } from "@/components/captain-todo-item";
import { CAPTAIN_TODO_CARD, captainTodos } from "@/lib/captain-todos";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import { loadReadyCheckView } from "@/lib/reschedule-ready-check-service";
import {
  loadDraftStatus,
  loadOutUserIds,
  loadRosters,
  type MatchPageMatch,
} from "./load";

/**
 * One line per thing waiting on this captain, each linking to the card that
 * answers it: a player on their roster who can't make it and has no cover,
 * the other captain's standin request (a standin over the MMR allowance),
 * the other captain's ready check (until this captain says yes to a time),
 * and their own ready check once the other captain has said yes to a time
 * they can lock in. Both cards sit inside Captain tools,
 * below the scoreboard and any box scores; without this a captain arriving
 * from a Discord ping had to scroll a phone-height or more to learn anything
 * was waiting. The rules are `captainTodos` (src/lib/captain-todos.ts), which
 * Home's captain line and the Captains page read too.
 */
export async function CaptainTodos({
  match,
  viewerId,
}: {
  match: MatchPageMatch;
  viewerId: string;
}) {
  const myTeamId =
    match.homeTeam.captainId === viewerId
      ? match.homeTeamId
      : match.awayTeam.captainId === viewerId
        ? match.awayTeamId
        : null;
  if (!myTeamId || !match.season.isActive) return null;
  // Async server component: request time for the ready check's "passed".
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const [draftStatus, members, outIds, view] = await Promise.all([
    loadDraftStatus(match),
    loadRosters(match),
    loadOutUserIds(match),
    // The viewer captains this match, so the card shows them names anyway.
    loadReadyCheckView(match, { id: viewerId, role: "USER" }, nowMs),
  ]);
  const todos = captainTodos({
    myTeamId,
    seasonStatus: match.season.status,
    draftStatus,
    match: {
      status: match.status,
      coveredUserIds: match.standins.flatMap((s) =>
        s.replaced ? [s.replaced.id] : [],
      ),
      standinRequests: match.standinRequests.map((r) => ({
        teamId: r.teamId,
        replacingUserId: r.replacingUserId,
        requestedByName: r.requestedBy.name,
        standinName: r.standin.name,
      })),
    },
    roster: members
      .filter((m) => m.teamId === myTeamId)
      .map((m) => ({ userId: m.userId, name: m.user.name })),
    outUserIds: outIds,
    readyCheck: view,
  });
  if (todos.length === 0) return null;
  return (
    <ul
      aria-label="Waiting on you"
      className="space-y-2 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-4 py-3 text-sm"
    >
      {todos.map((todo) => (
        <CaptainTodoItem
          key={todo.kind}
          todo={todo}
          href={`#${MATCH_ANCHOR[CAPTAIN_TODO_CARD[todo.kind]]}`}
        />
      ))}
    </ul>
  );
}
