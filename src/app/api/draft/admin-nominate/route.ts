import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { getDraftState, nominatePlayer } from "@/lib/draft-service";
import {
  draftActionErrorStatus,
  parseDraftTurnExpectation,
  requireExpectedDraftSeason,
} from "@/lib/draft-http";
import { rateLimit, retryAfterSeconds } from "@/lib/rate-limit";
import {
  guardJsonMutation,
  readBoundedJsonObject,
} from "@/lib/json-mutation";

export const dynamic = "force-dynamic";

// Admin fallback: nominate the top available player for the team on the clock,
// so the draft keeps moving if a captain is away.
export async function POST(req: NextRequest) {
  const invalidRequest = guardJsonMutation(req);
  if (invalidRequest) return invalidRequest;
  const parsed = await readBoundedJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const user = await getSessionUser();
  if (!user || user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
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
  const expectedTurn = parseDraftTurnExpectation(body);
  if (!expectedTurn.ok) {
    return NextResponse.json({ error: expectedTurn.error }, { status: 409 });
  }

  const state = await getDraftState(season.id, user);
  if (!state) return NextResponse.json({ error: "No draft" }, { status: 404 });
  if (state.nominatedPlayer) {
    return NextResponse.json(
      { error: "A nomination is already in progress" },
      { status: 400 },
    );
  }
  const top = state.available[0];
  if (!top) {
    return NextResponse.json(
      { error: "No players available" },
      { status: 400 },
    );
  }

  const res = await nominatePlayer(
    season.id,
    user,
    top.userId,
    state.minBid,
    expectedTurn.value,
  );
  if (!res.ok) {
    return NextResponse.json(
      { error: res.error },
      { status: draftActionErrorStatus(res.error) },
    );
  }

  return NextResponse.json(await getDraftState(season.id, user));
}
