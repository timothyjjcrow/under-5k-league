import { NextResponse } from "next/server";
import {
  automationProbeView,
  type AutomationProbeRecord,
} from "@/lib/automation-health";
import { AUTOMATION_RUN_KEY } from "@/lib/automation-service";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" };

type LoadAutomationState = () => Promise<AutomationProbeRecord | null>;

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
) {
  try {
    const probe = automationProbeView(await loadState(), now());
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
