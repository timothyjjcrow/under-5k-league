import { remindUnansweredCheckins } from "@/app/actions/availability";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { CHECKIN_NUDGE_THROTTLE_SECONDS } from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";

/**
 * A captain's optional "Remind the N who haven't answered": one Discord post
 * that pings only their own side's unanswered players. Once sent, it says
 * when the next one is allowed instead (sendCheckinNudge's throttle). The
 * match page's Matchup card and the Captains page draw it; the caller decides
 * whether it shows at all (the match preview's rule, `loadCaptainNudge`).
 */
export function CheckinNudgeControl({
  matchId,
  nudge,
}: {
  matchId: string;
  nudge: { waiting: number; sentAt: Date | null };
}) {
  if (nudge.sentAt) {
    const nextMs = nudge.sentAt.getTime() + CHECKIN_NUDGE_THROTTLE_SECONDS * 1000;
    return (
      <p className="mt-3 border-t border-line-soft pt-2 text-xs text-muted">
        Check-in reminder sent{" "}
        <LocalTime
          ts={nudge.sentAt.getTime()}
          variant="short"
          initial={formatLeagueMatchTime(nudge.sentAt, "short")}
        />
        . You can send another from{" "}
        <LocalTime
          ts={nextMs}
          variant="short"
          initial={formatLeagueMatchTime(new Date(nextMs), "short")}
        />
        .
      </p>
    );
  }
  return (
    <ActionForm
      action={remindUnansweredCheckins}
      hidden={{ matchId }}
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-soft pt-3"
    >
      <SubmitButton variant="secondary" size="sm">
        {nudge.waiting === 1
          ? "Remind the 1 who hasn't answered"
          : `Remind the ${nudge.waiting} who haven't answered`}
      </SubmitButton>
      <span className="text-xs text-muted">
        One Discord post that pings only them.
      </span>
    </ActionForm>
  );
}
