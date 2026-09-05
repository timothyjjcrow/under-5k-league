import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { guardJsonMutation, readBoundedJsonObject } from "@/lib/json-mutation";
import {
  callLobbyBot,
  lobbyBotConnection,
  lobbyBotKindEnabled,
  resolveDotaLobby,
} from "@/lib/dota-lobby-service";
import type { LobbyAction } from "@/lib/dota-lobby";
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
    !["status", "create", "start", "release"].includes(action)
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
    const { spec, canControl, playable } = await resolveDotaLobby(
      viewer,
      kind,
      id,
    );
    if (action !== "status" && !canControl)
      return NextResponse.json(
        { error: "Only the captains and admins can control this lobby." },
        { status: 403 },
      );
    if ((action === "create" || action === "start") && !playable)
      throw new UserFacingError(
        kind === "inhouse"
          ? "Only the current active in-house game can create or start a Dota lobby after teams are locked."
          : "This match is not open for play.",
      );
    const status = await callLobbyBot(
      spec,
      action === "status" ? undefined : (action as LobbyAction),
    );
    if (kind === "inhouse" && playable && status.state === "started") {
      // The GC has confirmed a running game. A cancelled/replaced lobby can
      // never be resurrected by this delayed response; betting deadlines stay fixed.
      await prisma.inhouseLobby.updateMany({
        where: { id, status: "READY" },
        data: { status: "IN_PROGRESS", startedAt: new Date() },
      });
    }
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
        status,
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
      },
      { status: 400 },
    );
  }
}
