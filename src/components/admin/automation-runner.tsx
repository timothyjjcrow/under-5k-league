import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { runMaintenanceNow } from "@/app/actions/automation";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import {
  ANNOUNCE_FAILED_PREFIX,
  HONORS_ANNOUNCED_PREFIX,
} from "@/lib/settings";
import { HONORS_STALE_PREFIX } from "@/lib/announcement-marker";
import { AUTOMATION_RUN_KEY } from "@/lib/automation-service";
import { getAutomationGateDecision } from "@/lib/automation-gate";
import {
  AUTOMATION_BACKLOG_STUCK_MS,
  automationAttention,
  automationHealthView,
  automationQuiet,
  type AutomationBacklog,
  type AutomationHealthRecord,
  type AutomationHealthView,
} from "@/lib/automation-health";
import { LEAGUE_ANNOUNCEMENT_STATUS } from "@/lib/league-announcement-outbox";
import { INHOUSE_ANNOUNCEMENT_STATUS } from "@/lib/inhouse-announcement-outbox";
import { cn } from "@/lib/utils";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  StatCell,
  StatStrip,
} from "@/components/ui";
import { AdminSection } from "@/components/admin/admin-section";

export function AutomationTimestamp({
  value,
  emptyLabel,
}: {
  value: Date | null | undefined;
  emptyLabel: string;
}) {
  return value ? (
    <LocalTime
      ts={value.getTime()}
      variant="short"
      initial={formatLeagueMatchTime(value, "short")}
    />
  ) : (
    emptyLabel
  );
}

type AutomationSnapshot = {
  now: number;
  /** undefined = the runner row could not be read; null = it never ran. */
  state: AutomationHealthRecord | null | undefined;
  backlog: AutomationBacklog | undefined;
  idleWindow: { nextWakeAtMs: number; hardWakeAtMs: number } | undefined;
};

/**
 * The runner row, the Discord delivery backlog and the gate's idle window,
 * read once per request: the runner card and Needs attention share it. DB
 * only (the gate snapshot is cached), and it never throws — a readiness
 * incident reads as "unavailable" instead of taking the admin page down.
 */
const loadAutomationSnapshot = cache(async (): Promise<AutomationSnapshot> => {
  const now = Date.now();
  const stuckBefore = new Date(now - AUTOMATION_BACKLOG_STUCK_MS);
  const queuedLeague = {
    status: {
      in: [
        LEAGUE_ANNOUNCEMENT_STATUS.PENDING,
        LEAGUE_ANNOUNCEMENT_STATUS.SENDING,
      ],
    },
  };
  const queuedInhouse = {
    status: {
      in: [
        INHOUSE_ANNOUNCEMENT_STATUS.PENDING,
        INHOUSE_ANNOUNCEMENT_STATUS.SENDING,
      ],
    },
  };
  try {
    const [
      runner,
      league,
      inhouse,
      stuckLeague,
      stuckInhouse,
      markerRetries,
      gate,
    ] = await Promise.all([
      prisma.automationRunState.findUnique({
        where: { key: AUTOMATION_RUN_KEY },
        select: {
          lastStatus: true,
          leaseExpiresAt: true,
          lastAttemptAt: true,
          lastStartedAt: true,
          lastFinishedAt: true,
          lastSuccessAt: true,
          lastSource: true,
          lastDurationMs: true,
          consecutiveFailures: true,
          lastErrorCode: true,
          lastSummary: true,
        },
      }),
      prisma.leagueAnnouncement.count({ where: queuedLeague }),
      prisma.inhouseAnnouncement.count({ where: queuedInhouse }),
      prisma.leagueAnnouncement.count({
        where: { ...queuedLeague, createdAt: { lt: stuckBefore } },
      }),
      prisma.inhouseAnnouncement.count({
        where: { ...queuedInhouse, createdAt: { lt: stuckBefore } },
      }),
      prisma.setting.count({
        where: {
          OR: [
            { value: { startsWith: ANNOUNCE_FAILED_PREFIX } },
            {
              key: { startsWith: HONORS_ANNOUNCED_PREFIX },
              value: { startsWith: HONORS_STALE_PREFIX },
            },
          ],
        },
      }),
      getAutomationGateDecision(now).catch(() => ({ run: true }) as const),
    ]);
    return {
      now,
      state: runner,
      backlog: {
        league,
        inhouse,
        markerRetries,
        stuck: stuckLeague + stuckInhouse,
      },
      idleWindow: gate.run
        ? undefined
        : {
            nextWakeAtMs: Math.min(
              gate.snapshot.nextWakeAtMs,
              gate.snapshot.hardWakeAtMs,
            ),
            hardWakeAtMs: gate.snapshot.hardWakeAtMs,
          },
    };
  } catch {
    // `undefined` is intentionally distinct from a missing (never-run) row.
    return { now, state: undefined, backlog: undefined, idleWindow: undefined };
  }
});

export async function loadAutomationAttention(): Promise<string[]> {
  const { now, state, backlog, idleWindow } = await loadAutomationSnapshot();
  return automationAttention(
    automationHealthView(state, now, idleWindow),
    backlog,
  );
}

/**
 * Production-wide runner health. This is separate from AutoSyncHealth below:
 * that card explains per-match scan/backoff state during playable phases,
 * while this one answers whether the single scheduled worker is alive and
 * safe to recover in every phase (including offseason and no season).
 *
 * Healthy, it folds to one line; the details stay one click away, and any
 * problem also raises a line in Needs attention.
 */
export async function AutomationRunnerHealth() {
  const { now, state, backlog, idleWindow } = await loadAutomationSnapshot();
  const health = automationHealthView(state, now, idleWindow);
  const lastRun = state?.lastSuccessAt ?? state?.lastFinishedAt ?? null;
  if (automationQuiet(health, backlog)) {
    return (
      <AdminSection
        title="Automation runner"
        subtitle={
          <>
            {health.kind === "RUNNING" ? "Healthy · running now" : "Healthy"}
            {lastRun ? (
              <>
                {" · last run "}
                <AutomationTimestamp value={lastRun} emptyLabel="Never" />
              </>
            ) : null}
          </>
        }
      >
        <CardBody>
          <AutomationRunnerDetails
            health={health}
            state={state}
            backlog={backlog}
          />
        </CardBody>
      </AdminSection>
    );
  }
  const badgeTone =
    health.kind === "RUNNING"
      ? "accent"
      : health.kind === "DEGRADED" || health.kind === "UNAVAILABLE"
        ? "danger"
        : health.kind === "HEALTHY"
          ? "success"
          : "neutral";
  const calloutClass =
    health.kind === "RUNNING"
      ? "border-accent/30 bg-accent/10"
      : health.kind === "DEGRADED" || health.kind === "UNAVAILABLE"
        ? "border-danger/30 bg-danger/10"
        : health.kind === "HEALTHY"
          ? "border-success/30 bg-success/10"
          : "border-line bg-surface-2/40";

  return (
    <Card>
      <CardHeader
        title="Automation runner"
        subtitle="The scheduled worker behind result imports, reminders and Discord posts, in every league phase."
        action={<Badge tone={badgeTone}>{health.label}</Badge>}
      />
      <CardBody className="space-y-5">
        <div className={cn("rounded-lg border px-4 py-3", calloutClass)}>
          <div className="font-medium text-fg">{health.headline}</div>
          <p className="mt-1 text-sm text-muted">{health.description}</p>
        </div>
        <AutomationRunnerDetails
          health={health}
          state={state}
          backlog={backlog}
        />
      </CardBody>
    </Card>
  );
}

function AutomationRunnerDetails({
  health,
  state,
  backlog,
}: {
  health: AutomationHealthView;
  state: AutomationHealthRecord | null | undefined;
  backlog: AutomationBacklog | undefined;
}) {
  const emptyTime = state === undefined ? "Unavailable" : "Never";
  return (
    <div className="space-y-5">
      <StatStrip>
        <StatCell
          label="Last attempt"
          value={
            <AutomationTimestamp
              value={state?.lastAttemptAt}
              emptyLabel={emptyTime}
            />
          }
        />
        <StatCell
          label="Last success"
          value={
            <AutomationTimestamp
              value={state?.lastSuccessAt}
              emptyLabel={emptyTime}
            />
          }
        />
        <StatCell label="Source" value={health.sourceLabel} />
        <StatCell label="Duration" value={health.durationLabel} />
        <StatCell
          label="Failure streak"
          value={health.consecutiveFailures}
          tone={health.consecutiveFailures > 0 ? "accent" : "muted"}
        />
      </StatStrip>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface-2/30 p-4">
          <h4 className="font-medium text-fg">Latest run</h4>
          {health.signals.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {health.signals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">
              No failure or unfinished work is recorded.
            </p>
          )}
          {health.leaseExpiresAt ? (
            <p className="mt-2 text-xs text-muted">
              {health.leaseActive
                ? "The current run's lock expires "
                : "The last run's lock expired "}
              <AutomationTimestamp
                value={health.leaseExpiresAt}
                emptyLabel="Not recorded"
              />
              .
            </p>
          ) : null}
        </div>

        <div className="rounded-lg border border-line bg-surface-2/30 p-4">
          <h4 className="font-medium text-fg">How often it runs</h4>
          <p className="mt-2 text-sm text-muted">
            Production checks every minute. When work is due it runs a pass;
            when everything is caught up it can wait for the next known
            deadline, and it always reconciles about once an hour.
          </p>
          <p className="mt-2 text-xs text-muted">
            A manual run takes the same lock as the scheduled one: it can take
            over a run that stopped, but never one that is still going.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface-2/30 p-4">
        <h4 className="font-medium text-fg">Discord posts waiting to send</h4>
        {backlog ? (
          backlog.league + backlog.inhouse + backlog.markerRetries > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              <li>{backlog.league} league-channel post(s) queued</li>
              <li>{backlog.inhouse} inhouse post(s) queued</li>
              {backlog.stuck > 0 ? (
                <li className="text-danger">
                  {backlog.stuck} of those queued over{" "}
                  {AUTOMATION_BACKLOG_STUCK_MS / 60_000} minutes ago
                </li>
              ) : null}
              <li>
                {backlog.markerRetries} announcement(s) waiting to be sent
                again after a failed send or a result correction
              </li>
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">Nothing is waiting.</p>
          )
        ) : (
          <p className="mt-2 text-sm text-danger">
            Can&apos;t read the queue until the database is reachable again.
          </p>
        )}
        <p className="mt-2 text-xs text-muted">
          Queued posts survive a restart and go out in order, usually within a
          minute or two. Posts waiting longer than{" "}
          {AUTOMATION_BACKLOG_STUCK_MS / 60_000} minutes mean Discord or the
          scheduler needs attention.
        </p>
      </div>

      <div
        className="flex flex-wrap items-start justify-between gap-4 border-t border-line pt-4"
        role="group"
        aria-labelledby="automation-manual-run-title"
      >
        <div className="min-w-0 flex-1 basis-64">
          <div
            id="automation-manual-run-title"
            className="font-medium text-fg"
          >
            Manual recovery
          </div>
          <p className="mt-1 text-sm text-muted">
            {health.disabledReason ??
              "Run a bounded pass now. If the scheduled run starts first, this request stops without doing the work twice."}
          </p>
        </div>
        <ActionForm action={runMaintenanceNow}>
          <SubmitButton
            variant={health.kind === "DEGRADED" ? "accent" : "secondary"}
            disabled={!health.canRunNow}
          >
            Run maintenance now
          </SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
