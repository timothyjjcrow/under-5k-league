import { NextResponse } from "next/server";
import {
  automationProbeView,
  type AutomationProbeRecord,
} from "@/lib/automation-health";
import { AUTOMATION_RUN_KEY } from "@/lib/automation-service";
import { prisma } from "@/lib/prisma";
import { getAutomationGateDecision } from "@/lib/automation-gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" };

type LoadAutomationState = () => Promise<AutomationProbeRecord | null>;
type LoadAutomationGate = typeof getAutomationGateDecision;

/**
 * Public dead-man probe for an external monitor. The response contains only a
 * bounded status enum; detailed failure, lease, and backlog information stays
 * behind the administrator session.
 */
export async function automationHealthResponse(
  loadState: LoadAutomationState = () =>
    prisma.automationRunState.findUnique({
      where: { key: AUTOMATION_RUN_KEY },
      select: {
        lastStatus: true,
        leaseExpiresAt: true,
        lastSuccessAt: true,
        consecutiveFailures: true,
      },
    }),
  now: () => number = Date.now,
  loadGate: LoadAutomationGate = getAutomationGateDecision,
) {
  const nowMs = now();
  try {
    // A sleeping snapshot carries a generic persisted runner-health bit and an
    // immutable hard wake. Trusting it avoids turning the public dead-man
    // probe itself into a Neon keepalive while still reporting a known blocked
    // transport as degraded. Misses/errors fall through to the runner row.
    try {
      const gate = await loadGate(nowMs);
      // A RUNNING snapshot only proves that a lease has not expired yet; it
      // does not prove there was ever a successful pass. Preserve the public
      // probe's existing running/never-run semantics by reading that row.
      if (!gate.run && gate.snapshot.reason !== "RUNNER") {
        if (!gate.snapshot.runnerHealthy) {
          return NextResponse.json(
            { ok: false, status: "degraded" },
            { status: 503, headers: NO_STORE },
          );
        }
        return NextResponse.json(
          { ok: true, status: "healthy" },
          { status: 200, headers: NO_STORE },
        );
      }
    } catch {
      // Fall through to the persisted database-owned health state.
    }

    const probe = automationProbeView(await loadState(), nowMs);
    return NextResponse.json(probe, {
      status: probe.ok ? 200 : 503,
      headers: NO_STORE,
    });
  } catch {
    return NextResponse.json(
      { ok: false, status: "unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}

export function GET() {
  return automationHealthResponse();
}
