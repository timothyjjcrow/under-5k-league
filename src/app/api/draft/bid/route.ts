import { NextRequest, NextResponse } from "next/server";
import { invalidateAutomationGateBestEffort } from "@/lib/automation-gate-invalidation";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { getDraftState, placeBid } from "@/lib/draft-service";
import {
  draftActionErrorStatus,
  parseDraftLotExpectation,
  requireExpectedDraftSeason,
} from "@/lib/draft-http";
import { rateLimit, retryAfterSeconds } from "@/lib/rate-limit";
import {
  guardJsonMutation,
  readBoundedJsonObject,
} from "@/lib/json-mutation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const invalidRequest = guardJsonMutation(req);
  if (invalidRequest) return invalidRequest;
  const parsed = await readBoundedJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const allowance = rateLimit(
    `draft:mutation:${user.id}`,
    { limit: 120, windowMs: 60_000 },
    Date.now(),
  );
  if (!allowance.allowed) {
    return NextResponse.json(
      { error: "Too many draft actions — wait a moment and try again" },
      {
        status: 429,
        headers: {
          "Retry-After": retryAfterSeconds(allowance),
        },
      },
    );
  }
  const season = await getActiveSeason();
  if (!season)
    return NextResponse.json({ error: "No active season" }, { status: 404 });

  const expectedSeason = requireExpectedDraftSeason(body, season.id);
  if (!expectedSeason.ok) {
    return NextResponse.json({ error: expectedSeason.error }, { status: 409 });
  }
  const expectedLot = parseDraftLotExpectation(body);
  if (!expectedLot.ok) {
    return NextResponse.json({ error: expectedLot.error }, { status: 409 });
  }
  const amount = Number(body.amount);

  try {
    const res = await placeBid(season.id, user, amount, expectedLot.value);
    if (!res.ok) {
      return NextResponse.json(
        { error: res.error },
        { status: draftActionErrorStatus(res.error) },
      );
    }
    return NextResponse.json(await getDraftState(season.id, user));
  } finally {
    // The service can resolve an expired clock before rejecting the bid.
    // Expire after every dispatched attempt, including a failed follow-up
    // state read. Next queues this best-effort signal; the gate's hard wake
    // bounds the rare case where an older cache fill finishes afterward.
    invalidateAutomationGateBestEffort();
  }
}
