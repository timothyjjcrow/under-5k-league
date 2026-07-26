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
    case "cancel":
      res = await cancelLobby(user);
      break;
    case "void":
      res = await voidLastResult(user);
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
