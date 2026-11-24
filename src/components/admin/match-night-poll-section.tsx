import { prisma } from "@/lib/prisma";
import { MatchNightPollControls } from "@/components/admin/match-night-poll-controls";
import {
  closedPollStatus,
  pollOnHome,
  pollResultMarker,
  pollTurnoutLine,
} from "@/lib/match-night-poll";
import { loadLatestPoll } from "@/lib/match-night-poll-service";
import { AdminSection } from "@/components/admin/admin-section";
import type { Season } from "@/components/admin/season-admin-data";

export async function AdminMatchNightPoll({
  admin,
  season,
  fixturesNight,
}: {
  admin: { id: string; role: string };
  season: Season | null;
  fixturesNight: string | null;
}) {
  // Async server component: rendered once per request.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const poll = await loadLatestPoll(admin, nowMs);
  // Once voting closes, while the result is still on Home: who won, and
  // whether it is the season's match night yet and announced. The section
  // used to fold away under its generic subtitle the moment voting closed.
  const winner =
    poll && !poll.open && poll.results?.winner
      ? (poll.slots.find((slot) => slot.key === poll.results?.winner) ?? null)
      : null;
  const announced = winner
    ? (
        await prisma.setting.findUnique({
          where: { key: pollResultMarker(poll!.id, poll!.closesAt) },
          select: { value: true },
        })
      )?.value === "sent"
    : false;
  const closed =
    poll && !poll.open && pollOnHome({ closesAt: new Date(poll.closesAt) }, nowMs)
      ? closedPollStatus({
          winnerLabel: winner?.label ?? null,
          count: winner ? (poll.results?.counts[winner.key] ?? 0) : 0,
          ballots: poll.results?.ballots ?? poll.ballots,
          usedAsMatchNight: !!winner && season?.matchSchedule === winner.label,
          announced,
        })
      : null;
  return (
    <AdminSection
      id="adm-poll"
      title="Match night poll"
      subtitle={
        poll?.open
          ? `Voting is open: ${pollTurnoutLine(poll.ballots, poll.electorate, true)}. Signed-up players mark every time they could play on Home; the time the most can make wins.`
          : closed
            ? closed.line
            : "Let signed-up players mark every weekly time they could play. The grid fills itself, the poll shows on Home, and the time the most players can make wins."
      }
      defaultOpen={(poll?.open ?? false) || !!closed?.needsFollowUp}
    >
      <MatchNightPollControls
        poll={poll}
        season={
          season
            ? {
                id: season.id,
                updatedAt: season.updatedAt,
                matchSchedule: season.matchSchedule,
                fixturesNight,
              }
            : null
        }
        nowMs={nowMs}
        announced={announced}
      />
    </AdminSection>
  );
}
