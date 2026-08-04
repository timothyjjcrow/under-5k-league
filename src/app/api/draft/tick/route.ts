import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { getDraftState } from "@/lib/draft-service";
import {
  clientIp,
  rateLimit,
  retryAfterSeconds,
} from "@/lib/rate-limit";
import { requireExpectedDraftSeason } from "@/lib/draft-http";
import {
  guardJsonMutation,
  readBoundedJsonObject,
} from "@/lib/json-mutation";
import { claimThrottle, SETTING_KEYS } from "@/lib/settings";

export const dynamic = "force-dynamic";

// Polled by the draft room. Authenticated participants may lazily resolve an
// expired clock; anonymous spectators receive a side-effect-free snapshot.
// The leased one-minute worker advances the auction even when nobody has the
// room open.
export async function POST(req: NextRequest) {
  const invalidRequest = guardJsonMutation(req);
  if (invalidRequest) return invalidRequest;

  // Public spectator reads still reach the database, so retain the same
  // per-instance speed bump as /api/inhouse beneath the required edge rule.
  // Generous: the room polls at ~1.2s (≈50/min per tab) and captains may have
  // a couple of tabs open.
  const ip = clientIp(req);
  const preflightAllowance = rateLimit(
    `draft:preflight:ip:${ip}`,
    { limit: 1200, windowMs: 60_000 },
    Date.now(),
  );
  if (!preflightAllowance.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "retry-after": retryAfterSeconds(preflightAllowance) },
      },
    );
  }
  const parsed = await readBoundedJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const [user, season] = await Promise.all([
    getSessionUser(),
    getActiveSeason(),
  ]);
  if (user) {
    const userAllowance = rateLimit(
      `draft:user:${user.id}`,
      { limit: 300, windowMs: 60_000 },
      Date.now(),
    );
    if (!userAllowance.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: { "retry-after": retryAfterSeconds(userAllowance) },
        },
      );
    }
  }

  if (!season) {
    return NextResponse.json({ error: "No active season" }, { status: 404 });
  }
  const expectedSeason = requireExpectedDraftSeason(body, season.id);
  if (!expectedSeason.ok) {
    return NextResponse.json({ error: expectedSeason.error }, { status: 409 });
  }
  const resolveDeadlines = user
    ? await claimThrottle(
        SETTING_KEYS.DRAFT_ROOM_MAINTENANCE_AT,
        2,
        Date.now(),
      )
    : false;
  const state = await getDraftState(season.id, user, { resolveDeadlines });
  return NextResponse.json(state, {
    headers: { "cache-control": "no-store" },
  });
}
