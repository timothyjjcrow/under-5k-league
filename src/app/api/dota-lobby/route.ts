import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { guardJsonMutation, readBoundedJsonObject } from "@/lib/json-mutation";
import {
  callLobbyBot,
  InviteOutcomeUnknownError,
  lobbyBotConnection,
  lobbyBotKindEnabled,
  resolveDotaLobby,
} from "@/lib/dota-lobby-service";
import {
  lobbyInviteScope,
  lobbyPlayerViews,
  type LobbyAction,
} from "@/lib/dota-lobby";
import { UserFacingError } from "@/lib/user-facing-error";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = guardJsonMutation(req);
  if (guard) return guard;
  const viewer = await getSessionUser();
  if (!viewer)
    return NextResponse.json(
      { error: "Sign in to use lobby controls." },
      { status: 401 },
    );
  const parsed = await readBoundedJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { kind, id, action } = parsed.value;
  if (
    (kind !== "inhouse" && kind !== "season") ||
    typeof id !== "string" ||
    typeof action !== "string" ||
    !["status", "create", "start", "release", "invite"].includes(action)
  ) {
    return NextResponse.json(
      { error: "Invalid lobby request." },
      { status: 400 },
    );
  }
  if (
    !rateLimit(
      `dota-lobby:${viewer.id}:${action === "status" ? "read" : "write"}`,
      { limit: action === "status" ? 30 : 10, windowMs: 60_000 },
      Date.now(),
    ).allowed
  ) {
    return NextResponse.json(
      { error: "Please wait before requesting the bot again." },
      { status: 429 },
    );
  }
  try {
    if (!lobbyBotKindEnabled(kind)) {
      if (action === "status")
        return NextResponse.json(
          { enabled: false },
          { headers: { "Cache-Control": "no-store" } },
        );
      return NextResponse.json(
        { error: "The lobby bot is currently enabled for in-house games only." },
        { status: 403 },
      );
    }
    if (!lobbyBotConnection())
      return NextResponse.json(
        { enabled: false },
        { headers: { "Cache-Control": "no-store" } },
      );
    const { spec, canControl, playable, roster } = await resolveDotaLobby(
      viewer,
      kind,
      id,
    );
    const rostered = roster.some((p) => p.self);
    // Who this viewer may invite: everyone missing (captains, admins) or only
    // themselves (anyone else on the roster), on a playable game. The panel's
    // invite buttons build on the same answer.
    const inviteScope = lobbyInviteScope({ canControl, playable, rostered });
    if (
      action !== "status" &&
      !canControl &&
      !(action === "invite" && rostered)
    )
      return NextResponse.json(
        { error: "Only the captains and admins can control this lobby." },
        { status: 403 },
      );
    if ((action === "create" || action === "start") && !playable)
      throw new UserFacingError(
        kind === "inhouse"
          ? "Only a live in-house game can create or start a Dota lobby, once its teams are locked."
          : "This match is not open for play.",
      );
    if (action === "invite" && !inviteScope)
      throw new UserFacingError(
        kind === "inhouse"
          ? "Only a live in-house game's bot can invite players, once its teams are locked."
          : "This match is not open for play.",
      );
    const status = await callLobbyBot(
      spec,
      action === "status" ? undefined : (action as LobbyAction),
      {
        withPlayers: true,
        // A player's own invite goes to the account they play Dota on, and
        // only to them; a captain's or admin's goes to everyone missing.
        invite:
          action === "invite" && inviteScope === "self"
            ? [...new Set(roster.filter((p) => p.self).map((p) => p.steamId))]
            : undefined,
      },
    );
    if (kind === "inhouse" && playable && status.state === "started") {
      // The GC has confirmed a running game. A cancelled/replaced lobby can
      // never be resurrected by this delayed response.
      await prisma.inhouseLobby.updateMany({
        where: { id, status: "READY" },
        data: { status: "IN_PROGRESS", startedAt: new Date() },
      });
    }
    // The bot's list carries Steam ids: the browser gets the roster's names
    // with each seat, and the status alone, never the reply as it came.
    const players = lobbyPlayerViews(roster, status.players);
    return NextResponse.json(
      {
        enabled: true,
        canControl: canControl && playable,
        canRelease: canControl,
        name: spec.name,
        password: spec.password,
        leagueId: spec.leagueId,
        radiantName: spec.radiantName,
        direName: spec.direName,
        inviteScope,
        status: {
          state: status.state,
          lobbyId: status.lobbyId,
          matchId: status.matchId,
        },
        ...(players ? { players } : {}),
        ...(action === "invite" && status.invited !== undefined
          ? { invited: status.invited }
          : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof UserFacingError
            ? error.message
            : "Lobby controls are temporarily unavailable.",
        // An invite whose answer was lost may have gone out: the panel says
        // so instead of reporting a failure.
        ...(error instanceof InviteOutcomeUnknownError ? { unknown: true } : {}),
      },
      { status: 400 },
    );
  }
}
