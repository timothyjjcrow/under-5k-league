import { prisma } from "@/lib/prisma";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { matchLogisticsOpen } from "@/lib/league-lifecycle";
import { loadRescheduleDeadline } from "@/lib/reschedule-service";
import { FIXTURE_CONFLICT_WINDOW_MS } from "@/lib/fixture-conflict";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import {
  cancelReschedule,
  proposeReschedule,
  respondReschedule,
} from "@/app/actions/reschedule";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { LocalTime } from "@/components/local-time";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { loadDraftStatus, type MatchPageMatch, type MatchViewer } from "./load";

/**
 * Captain-to-captain rescheduling: a captain proposes a time and the other
 * captain accepts (retiming the match) or declines. While the match can still
 * be moved, both captains get the card; once it can't, a stranded proposal
 * gets a card that closes it. Everyone else sees a read-only strip while a
 * proposal is pending, so a moved match doesn't blindside them.
 */
export async function RescheduleSection({
  match,
  viewer,
}: {
  match: MatchPageMatch;
  viewer: MatchViewer;
}) {
  const [draftStatus, pending] = await Promise.all([
    loadDraftStatus(match),
    prisma.rescheduleRequest.findFirst({
      where: { matchId: match.id, status: "PENDING" },
      include: { proposedBy: { select: { name: true } } },
    }),
  ]);
  const season = match.season;
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  const canRetime =
    season.isActive &&
    matchLogisticsOpen(season.status, draftStatus, match.status);

  if (isCaptain && canRetime) {
    // Async server component: request time, once, for the form's earliest
    // allowed time and the deadline read (not client render state).
    // eslint-disable-next-line react-hooks/purity
    const nowMs = Date.now();
    // The same deadline the service enforces, shown under the form.
    const deadline = pending
      ? null
      : await loadRescheduleDeadline(
          prisma,
          match,
          season.firstMatchNight,
          nowMs,
        );
    return (
      <RescheduleCard
        match={match}
        viewerId={viewer!.id}
        pending={pending}
        deadline={deadline}
        nowMs={nowMs}
      />
    );
  }
  if (isCaptain && pending) {
    const mine = pending.proposedById === viewer!.id;
    return (
      <Card id={MATCH_ANCHOR.reschedule} className="scroll-mt-24">
        <CardHeader
          title="Reschedule locked"
          subtitle="This match can no longer be moved. You can close the stranded proposal so it does not look actionable."
        />
        <CardBody className="flex flex-wrap items-center gap-3 text-sm">
          <span className="min-w-[14rem] flex-1 text-muted">
            {mine ? "You" : <strong>{pending.proposedBy.name}</strong>} proposed{" "}
            <strong className="text-fg">
              <LocalTime
                ts={pending.proposedTime.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(pending.proposedTime, "full")}
              />
            </strong>
            .
          </span>
          <ActionForm
            action={mine ? cancelReschedule : respondReschedule}
            hidden={
              mine
                ? { requestId: pending.id }
                : { requestId: pending.id, response: "decline" }
            }
          >
            <SubmitButton variant="secondary" size="sm">
              {mine ? "Withdraw proposal" : "Decline proposal"}
            </SubmitButton>
          </ActionForm>
        </CardBody>
      </Card>
    );
  }
  // Everyone else gets a read-only heads-up that a time change is pending, so
  // spectators/scouts aren't blindsided by a moved match.
  if (!pending) return null;
  return (
    <div
      id={MATCH_ANCHOR.reschedule}
      className="flex scroll-mt-24 flex-wrap items-center gap-2 rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm text-muted"
    >
      <span aria-hidden>⏳</span>
      <span>
        Reschedule proposed —{" "}
        <strong className="text-fg">
          <LocalTime
            ts={pending.proposedTime.getTime()}
            variant="full"
            initial={formatLeagueMatchTime(pending.proposedTime, "full")}
          />
        </strong>{" "}
        pending the captains&apos; agreement.
      </span>
    </div>
  );
}

async function RescheduleCard({
  match,
  viewerId,
  pending,
  deadline,
  nowMs,
}: {
  match: {
    id: string;
    status: string;
    scheduledAt: Date | null;
    scheduleRevision: number;
    homeTeam: { name: string; captainId: string };
    awayTeam: { name: string; captainId: string };
  };
  viewerId: string;
  pending: {
    id: string;
    proposedById: string;
    proposedTime: Date;
    proposedBy: { name: string };
  } | null;
  /** A new time must be before this (the playoffs); null = no limit. */
  deadline: Date | null;
  nowMs: number;
}) {
  if (match.status === "COMPLETED") return null;
  const checkinCount = pending
    ? await prisma.matchAvailability.count({ where: { matchId: match.id, scheduleRevision: match.scheduleRevision } })
    : 0;
  const mine = pending?.proposedById === viewerId;
  const clashHours = Math.round(FIXTURE_CONFLICT_WINDOW_MS / 3_600_000);
  const hintId = `proposed-time-hint-${match.id}`;

  return (
    <Card id={MATCH_ANCHOR.reschedule} className="scroll-mt-24">
      <CardHeader
        title="Reschedule"
        subtitle={
          match.scheduledAt
            ? "Agree a new time with the other captain. A real time change resets every player's check-in."
            : "No time set yet — propose one to the other captain."
        }
      />
      <CardBody className="space-y-3 text-sm">
        {pending ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-[14rem] flex-1">
              {mine ? "You" : <strong>{pending.proposedBy.name}</strong>}{" "}
              proposed{" "}
              {/* Old and new side by side, so the answer doesn't need the
                  current kickoff looked up elsewhere. */}
              {match.scheduledAt ? (
                <>
                  moving it from{" "}
                  <LocalTime
                    ts={match.scheduledAt.getTime()}
                    variant="full"
                    initial={formatLeagueMatchTime(match.scheduledAt, "full")}
                  />{" "}
                  to{" "}
                </>
              ) : null}
              <strong>
                <LocalTime
                  ts={pending.proposedTime.getTime()}
                  variant="full"
                  initial={formatLeagueMatchTime(pending.proposedTime, "full")}
                />
              </strong>
              {mine ? " — waiting on the other captain." : "."}
              {!mine && checkinCount > 0 ? (
                <span className="mt-1 block text-xs text-accent">
                  Accepting will clear {checkinCount} check-in
                  {checkinCount === 1 ? "" : "s"}; every player must answer
                  again for the new night.
                </span>
              ) : null}
            </span>
            {mine ? (
              <ActionForm
                action={cancelReschedule}
                hidden={{ requestId: pending.id }}
              >
                <SubmitButton variant="secondary" size="sm">
                  Withdraw
                </SubmitButton>
              </ActionForm>
            ) : (
              <div className="flex shrink-0 gap-2">
                <ActionForm
                  action={respondReschedule}
                  hidden={{ requestId: pending.id, response: "accept" }}
                >
                  <SubmitButton
                    variant="primary"
                    size="sm"
                    confirm={`Accept this new kickoff? ${checkinCount} check-in${checkinCount === 1 ? "" : "s"} will be cleared and every player must answer again.`}
                  >
                    ✓ Accept time
                  </SubmitButton>
                </ActionForm>
                <ActionForm
                  action={respondReschedule}
                  hidden={{ requestId: pending.id, response: "decline" }}
                >
                  <SubmitButton variant="secondary" size="sm">
                    ✗ Decline
                  </SubmitButton>
                </ActionForm>
              </div>
            )}
          </div>
        ) : (
          <ActionForm
            action={proposeReschedule}
            hidden={{ matchId: match.id }}
            className="flex flex-wrap items-center gap-2"
          >
            <label htmlFor={`proposed-time-${match.id}`} className="sr-only">
              Proposed new kickoff, in your time
            </label>
            {/* The two captains may sit in different zones, so each proposes
                on their own clock; the admin boxes use the league's. Say
                which one this is. Starts on the current kickoff, and the
                browser keeps it between now and the deadline; the server
                still checks every rule. */}
            <span className="inline-flex max-w-full flex-wrap items-center gap-2">
              <LocalDatetimeField
                id={`proposed-time-${match.id}`}
                name="proposedTime"
                tsName="proposedTs"
                required
                defaultTs={match.scheduledAt?.getTime() ?? null}
                minTs={nowMs}
                maxTs={deadline ? deadline.getTime() - 60_000 : null}
                describedBy={hintId}
                className="h-9 rounded-md border border-line bg-surface-2/50 px-2 text-sm text-fg"
              />
              <span aria-hidden="true" className="text-xs text-muted">
                your time
              </span>
            </span>
            <SubmitButton variant="secondary" size="sm">
              Propose new time
            </SubmitButton>
            <p id={hintId} className="basis-full text-xs text-muted">
              {deadline ? (
                <>
                  Must be before{" "}
                  <LocalTime
                    ts={deadline.getTime()}
                    variant="full"
                    initial={formatLeagueMatchTime(deadline, "full")}
                  />
                  , when the playoffs start, and not within {clashHours}{" "}
                  hours of another match or scrim for either team.
                </>
              ) : (
                `Must not be within ${clashHours} hours of another match or scrim for either team.`
              )}
            </p>
          </ActionForm>
        )}
      </CardBody>
    </Card>
  );
}
