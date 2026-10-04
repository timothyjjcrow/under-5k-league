import { prisma } from "@/lib/prisma";
import { formatMatchTime, matchTimeParts } from "@/lib/match-time";
import { matchLogisticsOpen } from "@/lib/league-lifecycle";
import { loadRescheduleDeadline } from "@/lib/reschedule-service";
import {
  loadReadyCheckView,
  loadRecentLock,
} from "@/lib/reschedule-ready-check-service";
import { suggestRescheduleTimes } from "@/lib/reschedule-ready-check";
import { FIXTURE_CONFLICT_WINDOW_MS } from "@/lib/fixture-conflict";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { MATCH_STATUS, SCRIM_STATUS } from "@/lib/constants";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import { cancelReschedule, respondReschedule } from "@/app/actions/reschedule";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import {
  ProposeTimes,
  type ProposeTimesProps,
} from "@/components/reschedule/propose-times";
import { LockedInCard } from "@/components/reschedule/locked-in-card";
import { ReadyCheckCard } from "@/components/reschedule/ready-check-card";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { loadDraftStatus, type MatchPageMatch, type MatchViewer } from "./load";

/** How far ahead the quick picks look. */
const SUGGESTION_DAYS = 10;

/**
 * Captain-to-captain rescheduling, run as a ready check. A captain offers up
 * to three times; everyone playing the match answers each one on the
 * ReadyCheckCard, which fills in live; the match moves when an option has
 * both captains and a full lineup each side, or when a captain locks in a
 * time the other captain said yes to. With nothing open, captains get the
 * picker, and for a day after a ready check moves the match everyone gets a
 * "moved by ready check" card. Spectators see a read-only strip while one is
 * open, so a moved match doesn't blindside them; a proposal stranded by a
 * phase change gets a card that closes it.
 */
export async function RescheduleSection({
  match,
  viewer,
}: {
  match: MatchPageMatch;
  viewer: MatchViewer;
}) {
  // Async server component: request time, once, for the picker's earliest
  // allowed time and the deadline read (not client render state).
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const [draftStatus, view] = await Promise.all([
    loadDraftStatus(match),
    loadReadyCheckView(match, viewer, nowMs),
  ]);
  const season = match.season;
  const isCaptain =
    !!viewer &&
    (match.homeTeam.captainId === viewer.id ||
      match.awayTeam.captainId === viewer.id);
  const canRetime =
    season.isActive &&
    matchLogisticsOpen(season.status, draftStatus, match.status);

  if (!view) {
    // A ready check that just moved the match says so for a day (and
    // celebrates when it's seconds old: the re-render after the last answer).
    const [lock, composer] = await Promise.all([
      match.status === MATCH_STATUS.SCHEDULED
        ? loadRecentLock(match, nowMs)
        : Promise.resolve(null),
      isCaptain && canRetime && match.status !== MATCH_STATUS.COMPLETED
        ? composerProps(match, nowMs)
        : Promise.resolve(null),
    ]);
    if (!lock) return composer ? <ProposeCard composer={composer} /> : null;
    return (
      <div className="min-w-0 space-y-4">
        <LockedInCard lock={lock} />
        {composer ? <ProposeCard composer={composer} anchored={false} /> : null}
      </div>
    );
  }

  if (!view.open) {
    if (!isCaptain) return null;
    const mine = view.viewer.isProposer;
    return (
      <Card id={MATCH_ANCHOR.reschedule} className="scroll-mt-24">
        <CardHeader
          title="Reschedule locked"
          subtitle="This match can no longer be moved. You can close the stranded proposal so it does not look actionable."
        />
        <CardBody className="flex flex-wrap items-center gap-3 text-sm">
          <span className="min-w-[14rem] flex-1 text-muted">
            {mine ? "You" : <strong>{view.proposer.name}</strong>} proposed{" "}
            {view.options.length === 1 ? "moving it" : `${view.options.length} new times`}.
          </span>
          <ActionForm
            action={mine ? cancelReschedule : respondReschedule}
            hidden={
              mine
                ? { requestId: view.requestId }
                : { requestId: view.requestId, response: "decline" }
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

  if (view.viewer.kind === "spectator") {
    // Everyone else gets a read-only heads-up that a time change is pending,
    // so spectators/scouts aren't blindsided by a moved match.
    return (
      <div
        id={MATCH_ANCHOR.reschedule}
        className="flex scroll-mt-24 flex-wrap items-center gap-2 rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-2.5 text-sm text-muted"
      >
        <span aria-hidden>⏳</span>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          The captains are agreeing a new time —{" "}
          {view.options.map((option, i) => (
            <span key={option.timeMs}>
              {i > 0 ? (i === view.options.length - 1 ? " or " : ", ") : null}
              <strong className="text-fg">
                <LocalTime
                  ts={option.timeMs}
                  variant="full"
                  initial={formatMatchTime(new Date(option.timeMs), "full")}
                />
              </strong>
            </span>
          ))}
          . The current kickoff stands until both teams are in.
        </span>
      </div>
    );
  }

  return (
    <ReadyCheckCard
      initialView={view}
      timeParts={Object.fromEntries(
        view.options.map((o) => [
          String(o.timeMs),
          matchTimeParts(new Date(o.timeMs)),
        ]),
      )}
      kickoffLabel={
        match.scheduledAt ? formatMatchTime(match.scheduledAt, "full") : null
      }
      composer={isCaptain ? await composerProps(match, nowMs) : null}
    />
  );
}

/** A captain's picker when nothing is open: folded shut until wanted. */
function ProposeCard({
  composer,
  anchored = true,
}: {
  composer: ProposeTimesProps;
  /** False when a card above already carries the reschedule anchor. */
  anchored?: boolean;
}) {
  return (
    <Card
      id={anchored ? MATCH_ANCHOR.reschedule : undefined}
      className="scroll-mt-24"
    >
      <CardHeader
        title="Reschedule"
        subtitle={
          composer.kickoffMs != null
            ? "Need a different time? Offer up to three and both teams answer a ready check. The match moves once everyone's in."
            : "No time set yet — offer up to three and both teams answer a ready check."
        }
      />
      <CardBody>
        <details className="group">
          <summary className="inline-flex h-10 cursor-pointer list-none items-center gap-2 rounded-lg border border-accent/50 bg-accent/10 px-4 text-sm font-medium text-fg transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:h-9 [&::-webkit-details-marker]:hidden">
            <span aria-hidden>🗓️</span> Propose new times
            <span
              aria-hidden
              className="text-muted transition-transform group-open:rotate-180"
            >
              ▾
            </span>
          </summary>
          <div className="mt-4">
            <ProposeTimes {...composer} />
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

/**
 * The picker's settings: quick picks that fit the calendar (other fixtures
 * and booked scrims of both teams, the playoff deadline), the custom range
 * and the rule line. The service re-checks every time it is sent.
 */
async function composerProps(
  match: MatchPageMatch,
  nowMs: number,
): Promise<ProposeTimesProps> {
  const teamIds = [match.homeTeamId, match.awayTeamId];
  const window = {
    gte: new Date(nowMs - FIXTURE_CONFLICT_WINDOW_MS),
    lte: new Date(
      nowMs + (SUGGESTION_DAYS + 1) * 86_400_000 + FIXTURE_CONFLICT_WINDOW_MS,
    ),
  };
  const [deadline, fixtures, scrims] = await Promise.all([
    loadRescheduleDeadline(
      prisma,
      match,
      match.season.firstMatchNight,
      nowMs,
    ),
    prisma.match.findMany({
      where: {
        seasonId: match.seasonId,
        id: { not: match.id },
        status: { in: [MATCH_STATUS.SCHEDULED, MATCH_STATUS.LIVE] },
        scheduledAt: window,
        OR: [
          { homeTeamId: { in: teamIds } },
          { awayTeamId: { in: teamIds } },
        ],
      },
      select: { scheduledAt: true },
    }),
    prisma.scrim.findMany({
      where: {
        seasonId: match.seasonId,
        status: { in: [SCRIM_STATUS.SCHEDULED, SCRIM_STATUS.LIVE] },
        scheduledAt: window,
        OR: [
          { hostTeamId: { in: teamIds } },
          { opponentTeamId: { in: teamIds } },
        ],
      },
      select: { scheduledAt: true },
    }),
  ]);
  const suggestions = suggestRescheduleTimes({
    kickoffMs: match.scheduledAt?.getTime() ?? null,
    fallbackAnchorMs: match.season.firstMatchNight?.getTime() ?? null,
    nowMs,
    deadlineMs: deadline?.getTime() ?? null,
    busyMs: [...fixtures, ...scrims].flatMap((row) =>
      row.scheduledAt ? [row.scheduledAt.getTime()] : [],
    ),
    windowMs: FIXTURE_CONFLICT_WINDOW_MS,
    timeZone: LEAGUE_CONFIG.timeZone,
    count: 6,
    horizonDays: SUGGESTION_DAYS,
  });
  return {
    matchId: match.id,
    suggestions: suggestions.map((ts) => ({
      ts,
      parts: matchTimeParts(new Date(ts)),
    })),
    minTs: nowMs,
    // The browser keeps the custom time a minute inside the deadline.
    maxTs: deadline ? deadline.getTime() - 60_000 : null,
    deadline: deadline
      ? { ts: deadline.getTime(), label: formatMatchTime(deadline, "full") }
      : null,
    clashHours: Math.round(FIXTURE_CONFLICT_WINDOW_MS / 3_600_000),
    kickoffMs: match.scheduledAt?.getTime() ?? null,
  };
}
