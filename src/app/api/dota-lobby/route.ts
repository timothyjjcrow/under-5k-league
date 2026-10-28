import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { guardJsonMutation, readBoundedJsonObject } from "@/lib/json-mutation";
import {
  botBusyElsewhere,
  callLobbyBot,
  freeBotFromClosedInhouseGame,
  freeingBotMessage,
  INHOUSE_TICKET_MISSING_ADMIN_NOTE,
  inhouseLobbyTicketId,
  InviteOutcomeUnknownError,
  LobbyBotBusyError,
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
import {
  endInhouseGameFromBot,
  markInhouseGameStartedFromBot,
} from "@/lib/inhouse-service";
import { applyDuelBotStatus } from "@/lib/inhouse-duel-service";
import { duelBotSavedForA5v5 } from "@/lib/inhouse-duel-bot";
import {
  DUEL_BOT_SAVED_FOR_5V5,
  duelBotEndedWithoutGame,
  duelTakesResult,
} from "@/lib/inhouse-duel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Status reads per viewer per minute. One visible panel at the 3s rate
 * (LOBBY_PANEL_POLL_MS) reads 20 times a minute, so this covers three at once:
 * a player's game on two devices, or an admin watching two games' setup on
 * one page. A fourth (an admin with both games open on two visible devices)
 * gets an occasional 429, which its panel shows until the next read clears
 * it. A hidden tab never polls. The route serves every read of a game from
 * one short-lived bot read (the status cache in dota-lobby-service.ts), so
 * this bounds the site's work, not the bot's.
 */
const READS_PER_MINUTE = 60;
/** Creates, starts, releases and invites per viewer per minute. */
const WRITES_PER_MINUTE = 10;

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
    (kind !== "inhouse" && kind !== "season" && kind !== "duel") ||
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
      {
        limit: action === "status" ? READS_PER_MINUTE : WRITES_PER_MINUTE,
        windowMs: 60_000,
      },
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
    // No in-house ticket id (Europe's, until Valve grants one): the bot can't
    // host an in-house game, so its players' panel reads like a bot that
    // isn't set up, which the setup card hides behind its by-hand steps. Only
    // an admin's panel says what is missing. Before any read or bot call.
    if ((kind === "inhouse" || kind === "duel") && inhouseLobbyTicketId() === null) {
      if (viewer.role !== "ADMIN")
        return NextResponse.json(
          { enabled: false },
          { headers: { "Cache-Control": "no-store" } },
        );
      return NextResponse.json(
        { error: INHOUSE_TICKET_MISSING_ADMIN_NOTE },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const { spec, canControl, playable, roster, duel } = await resolveDotaLobby(
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
        kind === "duel"
          ? "Only a 1v1 whose game hasn't started can create or start a Dota lobby."
          : kind === "inhouse"
            ? "Only a live in-house game can create or start a Dota lobby, once its teams are locked."
            : "This match is not open for play.",
      );
    if (action === "invite" && !inviteScope)
      throw new UserFacingError(
        kind === "duel"
          ? "Only a 1v1 whose game hasn't started can invite its players."
          : kind === "inhouse"
            ? "Only a live in-house game's bot can invite players, once its teams are locked."
            : "This match is not open for play.",
      );
    // The one bot is saved for a 5v5 being set up: a 1v1's lobby then could
    // hold it through the 5v5's whole setup. Before any bot call.
    if (kind === "duel" && action === "create" && (await duelBotSavedForA5v5()))
      throw new UserFacingError(DUEL_BOT_SAVED_FOR_5V5);
    let status;
    try {
      status = await callLobbyBot(
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
    } catch (error) {
      // BUSY: the bot holds another game's lobby. When that game is one of
      // this league's in-house games and already closed, free the bot from
      // it (one health read, one release) and say what the release did; a
      // refused release leaves the BUSY answer as it is.
      if (action === "create" && error instanceof LobbyBotBusyError) {
        // A 5v5's Create also frees the bot from a 1v1 whose game hasn't
        // started (the 5v5 comes first); a 1v1's Create never does.
        const freed = await freeBotFromClosedInhouseGame(kind);
        // Progress, not a failure: the panel words it as information.
        if (freed)
          return NextResponse.json(
            { error: freeingBotMessage(freed), freeing: true },
            { status: 400, headers: { "Cache-Control": "no-store" } },
          );
        // A 1v1 is never hosted by hand: it waits for the bot, and the
        // worker asks for its lobby again each pass.
        if (kind === "duel")
          throw new UserFacingError(
            "The bot is hosting another game. It makes your 1v1 lobby as soon as it's free.",
          );
      }
      throw error;
    }
    let stillPlayable = playable;
    if (kind === "inhouse" && playable) {
      // Each is a guarded claim that publishes its own commit before this
      // response (rule P), so a cancelled or finished game is never
      // resurrected by a delayed answer. Dota's postgame ends the game (Tim's
      // call 2026-10-18); a running game marks it started. The worker's
      // result scan does the same from its own bot read, so a failure here
      // only delays it: the panel still gets the bot's answer.
      try {
        if (status.over) {
          stillPlayable = false;
          await endInhouseGameFromBot(id);
        } else if (status.state === "started") {
          await markInhouseGameStartedFromBot(id);
        }
      } catch {
        console.error("[dota-lobby] bot-driven game update failed");
      }
    }
    if (kind === "duel" && duel && duelTakesResult(duel.status)) {
      // The 1v1's own bot-driven writes (applyDuelBotStatus): over ->
      // AWAITING_RESULT, started -> PLAYING with the bot's match id, a job
      // released after its game started -> CANCELLED. A READY duel whose
      // game never started stays playable on a `released` read (a dropped
      // Create, a lobby gone after a reconnect, a Release before the start):
      // Create makes it a fresh lobby, and so does the worker. Each is a
      // guarded claim that publishes the room and wakes the automation gate
      // before this response; the worker's read does the same, so a failure
      // only delays.
      if (
        status.over ||
        status.state === "started" ||
        duelBotEndedWithoutGame(status, duel)
      )
        stillPlayable = false;
      try {
        await applyDuelBotStatus(duel, status);
      } catch {
        console.error("[dota-lobby] bot-driven 1v1 update failed");
      }
    }
    // The bot's list carries Steam ids: the browser gets the roster's names
    // with each seat, and the status alone, never the reply as it came.
    const players = lobbyPlayerViews(roster, status.players);
    // A playable game with no bot lobby of its own: say whether the one bot
    // is another game's (one shared health read per cache TTL), so its card
    // can send this game to the by-hand steps instead of a bot that is busy.
    const busyElsewhere =
      stillPlayable &&
      (status.state === "idle" || status.state === "released")
        ? await botBusyElsewhere(spec)
        : null;
    return NextResponse.json(
      {
        enabled: true,
        canControl: canControl && stillPlayable,
        canRelease: canControl,
        playable: stillPlayable,
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
          ...(status.releasing ? { releasing: true } : {}),
          ...(status.over ? { over: true } : {}),
          ...(status.left ? { left: true } : {}),
        },
        ...(players ? { players } : {}),
        ...(busyElsewhere ? { busyElsewhere } : {}),
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
