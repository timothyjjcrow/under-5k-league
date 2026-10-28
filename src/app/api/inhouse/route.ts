import { NextRequest, NextResponse } from "next/server";
import { invalidateAutomationGateBestEffort } from "@/lib/automation-gate-invalidation";
import { getSessionUser } from "@/lib/auth";
import {
  clientIp,
  rateLimit,
  retryAfterSeconds,
} from "@/lib/rate-limit";
import {
  acceptMatch,
  autoDetectResult,
  cancelLobby,
  voidLastResult,
  castVote,
  declineMatch,
  finishGame,
  getInhouseState,
  giveUpOnResult,
  joinQueue,
  leaveQueue,
  makePick,
  recordMatch,
  removeFromQueue,
  setInhouseRoles,
  startGame,
} from "@/lib/inhouse-service";
import {
  acceptDuel,
  callOffDuel,
  cancelDuel,
  declineDuel,
  finishDuel,
  joinDuelQueue,
  leaveDuelQueue,
  recordDuelMatch,
  removeFromDuelQueue,
  voidDuelResult,
} from "@/lib/inhouse-duel-service";
import {
  holdInhouseRoomPoll,
  pollInhouseState,
} from "@/lib/inhouse-room-state";
import {
  inhouseRoomHoldMark,
  inhouseRoomVersionToken,
  publishInhouseRoomChange,
  readInhouseRoomVersion,
} from "@/lib/inhouse-room-version";
import {
  inhouseRoomShuttingDown,
  parseInhouseHold,
} from "@/lib/inhouse-room-wait";
import {
  readBoundedJsonObject,
  requireJsonContentType,
  requireSameOrigin,
} from "@/lib/json-mutation";

export const dynamic = "force-dynamic";

const RATE_WINDOW_MS = 60_000;
const STATE_RATE_LIMIT = 1200;
const MUTATION_RATE_LIMIT = 300;
const MUTATION_ACTIONS = new Set([
  "join",
  "leave",
  "accept",
  "decline",
  "vote",
  "pick",
  "start",
  "finish",
  "roles",
  "record",
  "detect",
  "cancel",
  "giveup",
  "void",
  "remove",
  // The 1v1 mid queue and duels (inhouse-duel-service.ts).
  "duelJoin",
  "duelLeave",
  "duelAccept",
  "duelDecline",
  "duelOver",
  "duelCallOff",
  "duelRecord",
  "duelCancel",
  "duelRemove",
  "duelVoid",
]);

// One JSON endpoint for the whole inhouse room. `state` is long-polled; the
// rest are mutations. Every response is the fresh, viewer-tailored state (or
// { error }), so the client stays in sync without extra round-trips.
//
// `state` replies also carry `roomVersion`, the room version read before the
// reply's rows (so the rows are at least that new). A client that sends it
// back as `since` (with the `holdMs` it can wait, and `sinceNow`, the `now`
// of the reply it shows) is held until the room moves past it, its next
// clock or the hold's end, and then polled as any other request
// (holdInhouseRoomPoll). Without `since` it answers at once. `held` says
// whether this request was held: false for a `since` the room had already
// moved past, which the client counts to back off from a version that never
// stops moving (inhouseLongPollGapMs).
export async function POST(req: NextRequest) {
  const invalidMediaType = requireJsonContentType(req);
  if (invalidMediaType) return invalidMediaType;
  const parsed = await readBoundedJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (typeof body.action !== "string" || body.action.trim().length === 0) {
    return NextResponse.json(
      { error: "A non-empty string action is required" },
      { status: 400 },
    );
  }
  const action = body.action;
  const ip = clientIp(req);

  // Read-only poll — allowed for anyone (spectators included).
  if (action === "state") {
    // Public room traffic stays IP-keyed, but the allowance covers ten visible
    // players polling every 1.5s behind one venue/NAT with ample headroom.
    const allowance = rateLimit(
      `inhouse:state:ip:${ip}`,
      { limit: STATE_RATE_LIMIT, windowMs: RATE_WINDOW_MS },
      Date.now(),
    );
    if (!allowance.allowed) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: { "retry-after": retryAfterSeconds(allowance) },
        },
      );
    }
    // Authorization on every request; the poll decides what is due. The
    // room version is read beside the session: it is what decides whether
    // this instance's room snapshot may serve, and whether this request is
    // held. The hold mark is taken first, so a publish in this process that
    // starts or finishes around the read re-checks the hold instead of
    // waiting for the 2s watch.
    const hold = parseInhouseHold(body);
    const mark = inhouseRoomHoldMark();
    let [user, version] = await Promise.all([
      getSessionUser(),
      readInhouseRoomVersion(),
    ]);
    // A stopping process answers at once, and says so (unheld): a tab then
    // backs off to its ladder rather than re-polling every second while
    // Caddy still routes to this slot (a restart of the live one).
    const held =
      hold !== null &&
      hold.since === inhouseRoomVersionToken(version) &&
      !inhouseRoomShuttingDown();
    if (hold && held) {
      // The client shows this version: wait for news, then authorize and
      // read again, as a fresh request would.
      const wake = await holdInhouseRoomPoll({
        viewer: user,
        version,
        hold,
        mark,
        signal: req.signal,
      });
      if (wake === "aborted") return new NextResponse(null, { status: 204 });
      [user, version] = await Promise.all([
        getSessionUser(),
        readInhouseRoomVersion(),
      ]);
    }
    let invalidateGate = false;
    try {
      const polled = await pollInhouseState(user, version);
      invalidateGate = polled.invalidateGate;
      return NextResponse.json({
        ...polled.state,
        roomVersion: inhouseRoomVersionToken(version),
        held,
      });
    } finally {
      // Only a signed-in poll that won the 2s maintenance claim, flipped a
      // queued player back to present or edited the board changed what the
      // gate schedules on. Queue a fresh snapshot; the hard wake bounds any
      // older fill that happens to finish after this signal.
      if (invalidateGate) {
        invalidateAutomationGateBestEffort();
      }
    }
  }

  const invalidOrigin = requireSameOrigin(req);
  if (invalidOrigin) return invalidOrigin;

  const user = await getSessionUser();
  // Mutations do not compete with the hot polling bucket. Signed-in users get
  // independent limits; signed-out attempts remain bounded by source IP.
  const mutationKey = user
    ? `inhouse:mutation:user:${user.id}`
    : `inhouse:mutation:ip:${ip}`;
  const allowance = rateLimit(
    mutationKey,
    { limit: MUTATION_RATE_LIMIT, windowMs: RATE_WINDOW_MS },
    Date.now(),
  );
  if (!allowance.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "retry-after": retryAfterSeconds(allowance) },
      },
    );
  }
  if (!user) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!MUTATION_ACTIONS.has(action)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  // The game an action is for: the room sends the lobby it showed, so a
  // click is judged against that game even with two live (see
  // chooseActionLobby in inhouse-service.ts).
  const lobbyId = typeof body.lobbyId === "string" ? body.lobbyId : null;
  // The 1v1 a duel action is for: the one the room showed.
  const duelId = typeof body.duelId === "string" ? body.duelId : "";
  // Rule P: whether a write since the last publish may still be unpublished.
  // Starts true: the action itself may commit and then throw.
  let unpublished = true;
  try {
    let res: { ok: true } | { ok: false; error: string };
    switch (action) {
      case "join":
        // `roles` only when the room's picker sent them; absent, the stored
        // choice stands (auto-join, "Run it back", API callers).
        res = await joinQueue(user, Number(body.mmr), body.roles);
        break;
      case "leave":
        res = await leaveQueue(user);
        break;
      case "accept":
        res = await acceptMatch(user, lobbyId);
        break;
      case "decline":
        res = await declineMatch(user, lobbyId);
        break;
      case "vote":
        res = await castVote(
          user,
          String(body.method ?? ""),
          body.nomineeId ? String(body.nomineeId) : undefined,
          lobbyId,
        );
        break;
      case "pick":
        res = await makePick(user, String(body.userId ?? ""), lobbyId);
        break;
      case "start":
        res = await startGame(user, lobbyId);
        break;
      case "finish":
        // "Game over". `requeue` also queues the presser for the next game.
        res = await finishGame(user, lobbyId, {
          requeue: body.requeue === true,
        });
        break;
      case "roles":
        res = await setInhouseRoles(user, body.roles);
        break;
      case "record":
        res = await recordMatch(user, String(body.matchId ?? ""), lobbyId);
        break;
      case "detect":
        res = await autoDetectResult(user, lobbyId);
        break;
      case "cancel":
        res = await cancelLobby(user, lobbyId);
        break;
      case "giveup":
        // Give up on a game marked over: its own action, never a cancel.
        res = await giveUpOnResult(user, lobbyId);
        break;
      case "void":
        res = await voidLastResult(user, lobbyId);
        break;
      case "remove":
        // Admin: take the named player out of the queue.
        res = await removeFromQueue(user, String(body.userId ?? ""));
        break;
      case "duelJoin":
        // A pair formed here is ACCEPTING: both players accept first.
        res = await joinDuelQueue(user);
        break;
      case "duelLeave":
        res = await leaveDuelQueue(user);
        break;
      case "duelAccept":
        // The second accept asks the bot for the lobby after the response
        // (acceptDuel's runAfterResponse).
        res = await acceptDuel(user, duelId);
        break;
      case "duelDecline":
        res = await declineDuel(user, duelId);
        break;
      case "duelOver":
        // "1v1 over": the fallback for a bot game whose end the bot missed.
        res = await finishDuel(user, duelId);
        break;
      case "duelCallOff":
        res = await callOffDuel(user, duelId);
        break;
      case "duelRecord":
        res = await recordDuelMatch(user, String(body.matchId ?? ""), duelId);
        break;
      case "duelCancel":
        res = await cancelDuel(user, duelId);
        break;
      case "duelRemove":
        // Admin: take the named player out of the 1v1 queue.
        res = await removeFromDuelQueue(user, String(body.userId ?? ""));
        break;
      case "duelVoid":
        res = await voidDuelResult(user, duelId);
        break;
      default:
        throw new Error("Unsupported inhouse mutation");
    }

    // Rule P: publish the action's commit NOW, before the follow-up read
    // below. That read is several round trips (heartbeat, rows, viewer
    // extras), and a poll this client sent while the action was in flight
    // must not find the old version (and another instance's pre-action
    // snapshot) all that time, or its later reply repaints the room as it was
    // before the click. A refusal publishes too: refusals can commit
    // (removeFromQueue).
    await publishInhouseRoomChange();
    unpublished = false;
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: 400 });
    }
    // The follow-up read heartbeats, so publish once more in the finally.
    unpublished = true;
    // A mutation must never block on the Discord queue board: the request that
    // CHANGES the state is the one that would render the new digest and win the
    // edit claim, so ACCEPT / vote / pick — the second-sensitive clocks — would
    // each pay a round trip. This client nudges its own poll ~250ms later
    // (bumpPollRef in inhouse-room.tsx), and that poll repaints the board.
    const state = await getInhouseState(user, {
      runMaintenance: false,
      syncBoard: false,
    });
    return NextResponse.json(state);
  } finally {
    // Rule P, again: an action that threw may have committed (resolver
    // writes before an error), and the follow-up read above heartbeats.
    // Publish before the response goes out, so this client's poll ~250ms
    // later, on any instance, sees it. A refusal already published above.
    if (unpublished) await publishInhouseRoomChange();
    // Some services perform safe resolver/claim writes before returning an
    // error. Expire after every dispatched action and follow-up read.
    invalidateAutomationGateBestEffort();
  }
}
