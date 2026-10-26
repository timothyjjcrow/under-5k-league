import { MATCH_STATUS } from "@/lib/constants";
import { coverChoices } from "@/lib/standin";
import { formatLeagueMatchTime } from "@/lib/match-time";
import {
  matchLogisticsOpen,
  standinAssignmentOpen,
} from "@/lib/league-lifecycle";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import { lockOffered, readyCheckLive } from "@/lib/reschedule-ready-check";
import { loadReadyCheckView } from "@/lib/reschedule-ready-check-service";
import { LocalTime } from "@/components/local-time";
import { textLink } from "@/components/ui";
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
 * was waiting. Each line uses the same capability gate as its card, so it
 * never points at a card that isn't there.
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
  const roster = members.filter((m) => m.teamId === myTeamId);
  const assignOpen = standinAssignmentOpen(
    match.season.status,
    draftStatus,
    match.status,
  );
  // A player whose cover is waiting for the other captain's OK isn't
  // uncovered: the Standins card shows that request instead.
  const uncoveredOut = assignOpen
    ? coverChoices(
        roster,
        outIds,
        new Set([
          ...match.standins.flatMap((s) => (s.replaced ? [s.replaced.id] : [])),
          ...match.standinRequests.flatMap((r) =>
            r.replacingUserId ? [r.replacingUserId] : [],
          ),
        ]),
      )
        .choices.filter((c) => c.out)
        .map((c) => c.member.user.name)
    : [];
  // The other team's requests: this captain's OK books them. Agree shows only
  // where a booking would be accepted, as on the Standins card.
  const toAnswer =
    assignOpen && match.status !== MATCH_STATUS.COMPLETED
      ? match.standinRequests.filter((r) => r.teamId !== myTeamId)
      : [];
  const open =
    view &&
    readyCheckLive(view) &&
    matchLogisticsOpen(match.season.status, draftStatus, match.status)
      ? view
      : null;
  // The other captain's ready check, and this captain hasn't said yes to
  // any of its times yet.
  const answer =
    open &&
    !open.viewer.isProposer &&
    !open.options.some((o) => !o.passed && o.myAnswer === "ready")
      ? open
      : null;
  // This captain's own ready check, where the other captain has said yes to
  // a time that isn't locked in yet: one tap moves the match.
  const lockable =
    open?.viewer.isProposer ? (open.options.find(lockOffered) ?? null) : null;
  if (uncoveredOut.length === 0 && toAnswer.length === 0 && !answer && !lockable)
    return null;
  return (
    <ul
      aria-label="Waiting on you"
      className="space-y-2 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-4 py-3 text-sm"
    >
      {uncoveredOut.length > 0 ? (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
            <span aria-hidden>✗ </span>
            <strong>{uncoveredOut.join(", ")}</strong>{" "}
            {uncoveredOut.length === 1
              ? "can't make it and has no cover yet."
              : "can't make it and have no cover yet."}
          </span>
          <a
            href={`#${MATCH_ANCHOR.standins}`}
            className={textLink("shrink-0 font-medium")}
          >
            Find a standin <span aria-hidden>↓</span>
          </a>
        </li>
      ) : null}
      {toAnswer.length > 0 ? (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
            <span aria-hidden>⏳ </span>
            <strong>{toAnswer[0].requestedBy.name}</strong> wants{" "}
            {toAnswer.length === 1 ? (
              <>
                <strong>{toAnswer[0].standin.name}</strong> to stand in and
                needs your OK.
              </>
            ) : (
              `${toAnswer.length} standins and needs your OK.`
            )}
          </span>
          <a
            href={`#${MATCH_ANCHOR.standins}`}
            className={textLink("shrink-0 font-medium")}
          >
            Answer the standin request <span aria-hidden>↓</span>
          </a>
        </li>
      ) : null}
      {answer ? (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
            <span aria-hidden>⏳ </span>
            <strong>{answer.proposer.name}</strong> wants to move this match
            {answer.options.length === 1 ? (
              <>
                {" "}to{" "}
                <strong>
                  <LocalTime
                    ts={answer.options[0].timeMs}
                    variant="full"
                    initial={formatLeagueMatchTime(
                      new Date(answer.options[0].timeMs),
                      "full",
                    )}
                  />
                </strong>
                .
              </>
            ) : (
              ` and offered ${answer.options.length} times.`
            )}
          </span>
          <a
            href={`#${MATCH_ANCHOR.reschedule}`}
            className={textLink("shrink-0 font-medium")}
          >
            Answer the ready check <span aria-hidden>↓</span>
          </a>
        </li>
      ) : null}
      {lockable ? (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
            <span aria-hidden>✓ </span>
            The other captain said yes to{" "}
            <strong>
              <LocalTime
                ts={lockable.timeMs}
                variant="full"
                initial={formatLeagueMatchTime(new Date(lockable.timeMs), "full")}
              />
            </strong>{" "}
            ({lockable.readyTotal}/{lockable.seatTotal} ready).
          </span>
          <a
            href={`#${MATCH_ANCHOR.reschedule}`}
            className={textLink("shrink-0 font-medium")}
          >
            Lock it in <span aria-hidden>↓</span>
          </a>
        </li>
      ) : null}
    </ul>
  );
}
