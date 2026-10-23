import { NextRequest, NextResponse } from "next/server";
import { invalidateAutomationGateBestEffort } from "@/lib/automation-gate-invalidation";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import {
  holdDraftRoomPoll,
  pollDraftRoomState,
} from "@/lib/draft-room-state";
import {
  draftRoomHoldMark,
  draftRoomVersionToken,
  readDraftRoomVersion,
} from "@/lib/draft-room-version";
import {
  draftRoomShuttingDown,
  parseDraftHold,
} from "@/lib/draft-room-wait";
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

export const dynamic = "force-dynamic";

// Polled by the draft room. It LONG-POLLS: every reply carries `roomVersion`,
// the draft room version read before the reply's rows (so the rows are at
// least that new). A tick that sends it back as `since` (with the `holdMs` it
// can wait, and `sinceNow`, the `now` of the reply it shows) is held until
// the room moves past it, the auction's clock wakes this viewer, or the
// hold's end, and then polled as any other tick (holdDraftRoomPoll). Without
// `since` it answers at once. `held` says whether this tick was held: false
// for a `since` the room had already moved past, which the client counts to
// back off from a version that never stops moving.
//
// Authenticated participants may settle an expired clock (under the 2s
// claim, only when one has run out); anonymous spectators receive a
// side-effect-free reply. The leased one-minute worker advances the auction
// even when nobody has the room open.
export async function POST(req: NextRequest) {
  const invalidRequest = guardJsonMutation(req);
  if (invalidRequest) return invalidRequest;

  // Public spectator reads still reach the database, so retain the same
  // per-instance speed bump as /api/inhouse beneath the required edge rule.
  // Generous: a tab asks about once per change, captains may have a couple
  // of tabs open, and a room that falls back to its ladder asks every 2-6s.
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
  // Authorization on every request; the tick decides what is due. The room
  // version is read beside the session: it is what decides whether this
  // instance's room snapshot may serve, and whether this tick is held. The
  // hold mark is taken first, so a publish in this process that starts or
  // finishes around the read re-checks the hold instead of waiting for the
  // 2s watch.
  const hold = parseDraftHold(body);
  const mark = draftRoomHoldMark();
  const [firstUser, firstSeason, firstVersion] = await Promise.all([
    getSessionUser(),
    getActiveSeason(),
    readDraftRoomVersion(),
  ]);
  let user = firstUser;
  let season = firstSeason;
  let version = firstVersion;
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
  // A stopping process answers at once, and says so (unheld): a tab then
  // backs off to its ladder rather than re-polling every second while Caddy
  // still routes to this slot (a restart of the live one).
  const held =
    hold !== null &&
    hold.since === draftRoomVersionToken(version) &&
    !draftRoomShuttingDown();
  if (hold && held) {
    // The client shows this version: wait for news, then authorize and read
    // again, as a fresh tick would.
    const wake = await holdDraftRoomPoll({
      viewer: user,
      seasonId: season.id,
      version,
      hold,
      mark,
      signal: req.signal,
    });
    if (wake === "aborted") return new NextResponse(null, { status: 204 });
    // The season too: an admin can archive it, or open another, during the
    // hold, and this tab must hear 404 or 409, never the old room's rows.
    [user, season, version] = await Promise.all([
      getSessionUser(),
      getActiveSeason(),
      readDraftRoomVersion(),
    ]);
    if (!season) {
      return NextResponse.json({ error: "No active season" }, { status: 404 });
    }
    const stillExpected = requireExpectedDraftSeason(body, season.id);
    if (!stillExpected.ok) {
      return NextResponse.json({ error: stillExpected.error }, { status: 409 });
    }
  }
  let invalidateGate = false;
  try {
    const polled = await pollDraftRoomState(user, season.id, version);
    invalidateGate = polled.invalidateGate;
    if (!polled.state) {
      return NextResponse.json({ error: "No active season" }, { status: 404 });
    }
    return NextResponse.json(
      {
        ...polled.state,
        // The version its rows were read under (never a later one): the one
        // read beside the session, or the copy's after the tick's own
        // publish, so its client holds next instead of asking again.
        roomVersion: draftRoomVersionToken(polled.version),
        held,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } finally {
    // Only the throttle winner may mutate clocks. Expire after its resolving
    // read. The immutable hard wake remains the fallback if a cache fill that
    // began earlier finishes after this best-effort expiry signal.
    if (invalidateGate) {
      invalidateAutomationGateBestEffort();
    }
  }
}
