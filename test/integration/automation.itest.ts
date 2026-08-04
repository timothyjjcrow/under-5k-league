import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATION_LEASE_MS,
  AUTOMATION_RUN_KEY,
  acquireAutomationLease,
  finalizeAutomationLease,
} from "@/lib/automation-service";
import { prisma } from "@/lib/prisma";
import { setRaceHook } from "@/lib/race-hook";
import { ON_POSTGRES } from "./factories";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const PROBE = "automation.acquire.afterRecoveryProbe";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function seedIdleAutomationState() {
  return prisma.automationRunState.create({
    data: {
      key: AUTOMATION_RUN_KEY,
      lastStatus: "SUCCEEDED",
      lastSuccessAt: new Date(NOW - 60_000),
      lastSummary: '{"source":"CRON","imported":0}',
    },
  });
}

afterEach(() => setRaceHook(null));

describe.skipIf(!ON_POSTGRES)("automation lease election (PostgreSQL)", () => {
  it("claims an idle completed row without inventing an abandoned run", async () => {
    await seedIdleAutomationState();

    const lease = await acquireAutomationLease({
      source: "ADMIN",
      nowMs: NOW,
      token: "idle-owner",
    });

    expect(lease).toMatchObject({
      kind: "acquired",
      token: "idle-owner",
      recoveredExpiredLease: false,
    });
    const state = await prisma.automationRunState.findUniqueOrThrow({
      where: { key: AUTOMATION_RUN_KEY },
    });
    expect(state).toMatchObject({
      leaseToken: "idle-owner",
      leaseOwner: "ADMIN",
      lastStatus: "RUNNING",
      consecutiveFailures: 0,
      lastFailureAt: null,
    });
    expect(state.lastSummary).toContain('"recoveredExpiredLease":false');
  });

  it("does not let the idle branch steal a delayed contender's RUNNING lease", async () => {
    await seedIdleAutomationState();
    const firstProbe = deferred();
    const releaseOlder = deferred();
    const olderFinished = deferred();
    let probeArrivals = 0;

    setRaceHook(async (label) => {
      if (label !== PROBE) return;
      probeArrivals += 1;
      if (probeArrivals === 1) {
        firstProbe.resolve();
        await releaseOlder.promise;
      } else if (probeArrivals === 2) {
        releaseOlder.resolve();
        await olderFinished.promise;
      }
    });

    // This request calculated its deadline before being delayed. It reaches
    // the normal claim only after the current request has also established
    // that the row was idle, reproducing the exact two-statement TOCTOU gap.
    const olderAttempt = acquireAutomationLease({
      source: "CRON",
      nowMs: NOW - AUTOMATION_LEASE_MS - 1,
      token: "delayed-owner",
    });
    const trackedOlder = olderAttempt.then(
      (result) => {
        olderFinished.resolve();
        return result;
      },
      (error) => {
        olderFinished.resolve();
        throw error;
      },
    );

    // If the recovery status guard is removed, the first call completes
    // without reaching the seam. Fail promptly instead of leaving a promise
    // parked forever while that separate mutant is under test.
    const firstEvent = await Promise.race([
      firstProbe.promise.then(() => "probe" as const),
      trackedOlder.then(() => "completed" as const),
    ]);
    expect(firstEvent).toBe("probe");
    if (firstEvent !== "probe") return;

    const currentAttempt = acquireAutomationLease({
      source: "ADMIN",
      nowMs: NOW,
      token: "current-owner",
    });
    const [older, current] = await Promise.all([
      trackedOlder,
      currentAttempt,
    ]);

    expect(older).toMatchObject({
      kind: "acquired",
      token: "delayed-owner",
      recoveredExpiredLease: false,
    });
    expect(current).toMatchObject({
      kind: "lease-held",
      leaseExpiresAt: new Date(NOW - 1),
    });
    const delayedState = await prisma.automationRunState.findUniqueOrThrow({
      where: { key: AUTOMATION_RUN_KEY },
    });
    expect(delayedState).toMatchObject({
      leaseToken: "delayed-owner",
      leaseOwner: "CRON",
      lastStatus: "RUNNING",
      consecutiveFailures: 0,
      lastFailureAt: null,
    });

    // A later attempt owns the explicit recovery and counts the abandoned run
    // exactly once; the idle claimant above must not disguise that transition.
    setRaceHook(null);
    const recovery = await acquireAutomationLease({
      source: "ADMIN",
      nowMs: NOW,
      token: "recovery-owner",
    });
    expect(recovery).toMatchObject({
      kind: "acquired",
      token: "recovery-owner",
      recoveredExpiredLease: true,
    });
    expect(
      await prisma.automationRunState.findUniqueOrThrow({
        where: { key: AUTOMATION_RUN_KEY },
      }),
    ).toMatchObject({
      leaseToken: "recovery-owner",
      leaseOwner: "ADMIN",
      consecutiveFailures: 1,
      lastFailureAt: new Date(NOW),
    });
  });

  it("fences an expired owner from overwriting its replacement's health", async () => {
    const first = await acquireAutomationLease({
      source: "CRON",
      nowMs: NOW,
      token: "expired-owner",
    });
    const replacementStartedAt = NOW + AUTOMATION_LEASE_MS + 1;
    const replacement = await acquireAutomationLease({
      source: "ADMIN",
      nowMs: replacementStartedAt,
      token: "replacement-owner",
    });
    expect(first.kind).toBe("acquired");
    expect(replacement).toMatchObject({
      kind: "acquired",
      token: "replacement-owner",
      recoveredExpiredLease: true,
    });
    if (first.kind !== "acquired" || replacement.kind !== "acquired") return;

    const replacementHealth =
      await prisma.automationRunState.findUniqueOrThrow({
        where: { key: AUTOMATION_RUN_KEY },
      });
    const staleFinalized = await finalizeAutomationLease({
      lease: first,
      status: "FAILED",
      startedAtMs: NOW,
      finishedAtMs: replacementStartedAt + 1_000,
      summary: '{"source":"CRON","obsolete":true}',
      errorCode: "AUTOMATION_FAILED",
    });

    expect(staleFinalized).toBe(false);
    const afterStaleFinalize =
      await prisma.automationRunState.findUniqueOrThrow({
        where: { key: AUTOMATION_RUN_KEY },
      });
    expect(afterStaleFinalize).toMatchObject({
      leaseToken: "replacement-owner",
      leaseOwner: "ADMIN",
      leaseExpiresAt: replacement.leaseExpiresAt,
      lastStatus: "RUNNING",
      lastStartedAt: new Date(replacementStartedAt),
      lastFinishedAt: replacementHealth.lastFinishedAt,
      lastFailureAt: replacementHealth.lastFailureAt,
      consecutiveFailures: replacementHealth.consecutiveFailures,
      lastErrorCode: replacementHealth.lastErrorCode,
      lastSummary: replacementHealth.lastSummary,
    });

    // Positive control: the capability that actually owns the row can still
    // publish its final health and release the lease.
    expect(
      await finalizeAutomationLease({
        lease: replacement,
        status: "SUCCEEDED",
        startedAtMs: replacementStartedAt,
        finishedAtMs: replacementStartedAt + 2_000,
        summary: '{"source":"ADMIN","imported":0}',
      }),
    ).toBe(true);
    expect(
      await prisma.automationRunState.findUniqueOrThrow({
        where: { key: AUTOMATION_RUN_KEY },
      }),
    ).toMatchObject({
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastStatus: "SUCCEEDED",
      consecutiveFailures: 0,
    });
  });
});
