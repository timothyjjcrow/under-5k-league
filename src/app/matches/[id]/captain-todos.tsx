import { prisma } from "@/lib/prisma";
import { coverChoices } from "@/lib/standin";
import { formatLeagueMatchTime } from "@/lib/match-time";
import {
  matchLogisticsOpen,
  standinAssignmentOpen,
} from "@/lib/league-lifecycle";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
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
 * answers it: a player on their roster who can't make it and has no cover, and
 * a time the other captain proposed. Both cards sit inside Captain tools,
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
  const [draftStatus, members, outIds, pending] = await Promise.all([
    loadDraftStatus(match),
    loadRosters(match),
    loadOutUserIds(match),
    prisma.rescheduleRequest.findFirst({
      where: {
        matchId: match.id,
        status: "PENDING",
        proposedById: { not: viewerId },
      },
      select: { proposedTime: true, proposedBy: { select: { name: true } } },
    }),
  ]);
  const roster = members.filter((m) => m.teamId === myTeamId);
  const uncoveredOut = standinAssignmentOpen(
    match.season.status,
    draftStatus,
    match.status,
  )
    ? coverChoices(
        roster,
        outIds,
        new Set(
          match.standins.flatMap((s) => (s.replaced ? [s.replaced.id] : [])),
        ),
      )
        .choices.filter((c) => c.out)
        .map((c) => c.member.user.name)
    : [];
  const answer =
    pending &&
    matchLogisticsOpen(match.season.status, draftStatus, match.status)
      ? pending
      : null;
  if (uncoveredOut.length === 0 && !answer) return null;
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
      {answer ? (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
            <span aria-hidden>⏳ </span>
            <strong>{answer.proposedBy.name}</strong> proposed moving this
            match to{" "}
            <strong>
              <LocalTime
                ts={answer.proposedTime.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(answer.proposedTime, "full")}
              />
            </strong>
            .
          </span>
          <a
            href={`#${MATCH_ANCHOR.reschedule}`}
            className={textLink("shrink-0 font-medium")}
          >
            Answer <span aria-hidden>↓</span>
          </a>
        </li>
      ) : null}
    </ul>
  );
}
