import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import {
  acceptMatch,
  autoDetectResult,
  cancelLobby,
  voidLastResult,
  castVote,
  declineMatch,
  getInhouseState,
  joinQueue,
  leaveQueue,
  makePick,
  recordMatch,
  startGame,
} from "@/lib/inhouse-service";
import { placeInhouseBet } from "@/lib/inhouse-bet-service";

export const dynamic = "force-dynamic";

// One JSON endpoint for the whole inhouse room. `state` is polled; the rest are
// mutations. Every response is the fresh, viewer-tailored state (or { error }),
// so the client stays in sync without extra round-trips.
export async function POST(req: NextRequest) {
  // Unauthenticated polls run the lazy resolvers (which can reach OpenDota) —
  // same per-IP speed bump as /api/sync. Generous: the room polls at 1.5s
  // (~40/min per tab) and several players can share a NAT'd IP.
  const ip = clientIp(req);
  if (
    !rateLimit(`inhouse:${ip}`, { limit: 300, windowMs: 60_000 }, Date.now())
      .allowed
  ) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const user = await getSessionUser();
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "state");

  // Read-only poll — allowed for anyone (spectators included).
  if (action === "state") {
    return NextResponse.json(await getInhouseState(user));
  }

  if (!user) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  let res: { ok: true } | { ok: false; error: string };
  switch (action) {
    case "join":
      res = await joinQueue(user, Number(body.mmr));
      break;
    case "leave":
      res = await leaveQueue(user);
      break;
    case "accept":
      res = await acceptMatch(user);
      break;
    case "decline":
      res = await declineMatch(user);
      break;
    case "vote":
      res = await castVote(user, String(body.method ?? ""), body.nomineeId ? String(body.nomineeId) : undefined);
      break;
    case "pick":
      res = await makePick(user, String(body.userId ?? ""));
      break;
    case "start":
      res = await startGame(user);
      break;
    case "record":
      res = await recordMatch(user, String(body.matchId ?? ""));
      break;
    case "detect":
      res = await autoDetectResult(user);
      break;
    case "bet":
      // Deliberately NOT in INHOUSE_SCAN_ACTIONS: this is one bounded DB
      // transaction with no OpenDota call, so the room gives it
      // ROOM_ACTION_TIMEOUT_MS (15s). Filing it with detect/record would leave
      // the bet controls disabled for up to 45s inside a 45-second window —
      // the same as having no window at all. `betGateError` refuses a NaN
      // stake (it isn't an integer multiple of STEP), so a junk body is a
      // sentence, not a throw.
      res = await placeInhouseBet(user, Number(body.stake));
      break;
    case "cancel":
      // `force` overrides the live-pot guard on the IN_PROGRESS branch of
      // cancelLobby's claim — an admin must never be locked out (an unkillable
      // lobby holds the single active slot for hours, a strictly worse
      // failure), but it is a deliberate act that writes an AdminAction and
      // announces the pot. Boolean() so an absent field is a plain cancel.
      res = await cancelLobby(user, { force: Boolean(body.force) });
      break;
    case "void":
      res = await voidLastResult(
        user,
        typeof body.lobbyId === "string" ? body.lobbyId : null,
      );
      break;
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  // A mutation must never block on the Discord queue board: the request that
  // CHANGES the state is the one that would render the new digest and win the
  // edit claim, so ACCEPT / vote / pick — the second-sensitive clocks — would
  // each pay a round trip. This client nudges its own poll ~250ms later
  // (bumpPollRef in inhouse-room.tsx), and that poll repaints the board.
  return NextResponse.json(await getInhouseState(user, { syncBoard: false }));
}
