import { createHmac } from "node:crypto";
import type { SessionUser } from "./auth";
import { prisma } from "./prisma";
import {
  DUEL_GAME_MODE,
  INHOUSE,
  INHOUSE_DUEL_STATUS,
  INHOUSE_PLAYING_STATUSES,
  INHOUSE_STATUS,
  LEAGUE_GAME_MODE,
} from "./constants";
import { getActiveSeason } from "./season";
import { matchResultsOpen } from "./league-lifecycle";
import { matchNightRoster } from "./availability";
import {
  effectiveDotaAccountId,
  type DotaAccountIdentity,
} from "./dota-account";
import { accountIdToSteamId64 } from "./dota";
import { UserFacingError } from "./user-facing-error";
import { LEAGUE_CONFIG } from "./league-config";
import { inhouseLobbyCode } from "./inhouse";
import {
  lobbyChatName,
  parseBotPlayers,
  parseInvitedCount,
  parseLobbyDigits,
  parseLobbyLeagueId,
  parseLobbyLifecycle,
  type BotBusyElsewhere,
  type DotaLobbyBotPlayer,
  type DotaLobbySpec,
  type LobbyKind,
  type LobbyAction,
  type DotaLobbyStatus,
  type LobbyRosterEntry,
  type LobbySide,
} from "./dota-lobby";
import {
  BotReplyUnreadableError,
  connectionRefused,
  readBotReply,
} from "./lobby-bot-transport";
import {
  cachedLobbyBotStatus,
  dropLobbyBotStatus,
  storeLobbyBotStatus,
} from "./lobby-bot-status-cache";
import { trackBotRelease } from "./lobby-bot-releases";

/**
 * An invite whose answer was lost on the bot's leg: the invites may have gone
 * out. The route marks it `unknown`, and the panel words it as unknown.
 */
export class InviteOutcomeUnknownError extends UserFacingError {
  constructor() {
    super(
      "The lobby bot didn't confirm, but the invites may have gone out. Check the list before sending again.",
    );
  }
}

/**
 * A lobby action whose answer was lost (a timeout, a dropped socket, an
 * unreadable reply): it may have reached Dota, so it is unknown, never a
 * refusal. The BUSY self-heal tells this apart from a refusal.
 */
class LobbyBotOutcomeUnknownError extends UserFacingError {
  constructor() {
    super(
      "The lobby bot could not be reached. Refresh its status before retrying; the request may have reached Dota.",
    );
  }
}

/**
 * The bot answered BUSY: its one Steam account holds another game's Dota
 * lobby. The route's Create tries `freeBotFromClosedInhouseGame` on it.
 */
export class LobbyBotBusyError extends UserFacingError {
  constructor() {
    super(
      "The bot is hosting another game's lobby. It hosts one game at a time and is free again when that game ends: try again then, or host this game by hand.",
    );
  }
}

/**
 * Nothing answered at the bot's address (ECONNREFUSED): the request never
 * reached it, so this is a definite failure, never "may have reached Dota".
 */
const BOT_NOT_RUNNING =
  "The lobby bot isn't running right now, so nothing was sent to Dota. Try again in a minute, or host this game by hand.";

/** The connection's request timeout: loopback answers at once or not at all. */
const LOOPBACK_TIMEOUT_MS = 5_000;
const RELAY_TIMEOUT_MS = 15_000;

function playingSteamId(user: DotaAccountIdentity) {
  const account = effectiveDotaAccountId(user);
  if (account == null)
    throw new UserFacingError(
      "A player needs to fix their linked Dota account before using the bot.",
    );
  return accountIdToSteamId64(account);
}

function regionalLobbyKey(kind: LobbyKind, id: string, game: number) {
  // Keep all existing US jobs addressable while Europe shares the same worker.
  return `${LEAGUE_CONFIG.region === "eu" ? "eu:" : ""}${kind}:${id}:${game}`;
}

/**
 * A job key of this league, parsed: `season:<id>:<game>`, `inhouse:<id>:1`
 * or `duel:<id>:1`, with Europe's `eu:` in front. Null for any other key,
 * the other league's included. An in-house game and a 1v1 are one Dota game
 * each, so their game number is always 1.
 */
function ownLobbyKey(key: string) {
  const match = /^(eu:)?(season|inhouse|duel):([a-zA-Z0-9_-]{1,128}):([1-9]\d?)$/.exec(key);
  if (!match || (match[1] ? "eu" : "us") !== LEAGUE_CONFIG.region) return null;
  const kind = match[2] as LobbyKind;
  const game = Number(match[4]);
  if (kind !== "season" && game !== 1) return null;
  return { kind, id: match[3], game };
}

/**
 * The single bot is reserved for in-house games (5v5 and 1v1) unless season
 * matches are explicitly opted in.
 */
export function lobbyBotKindEnabled(kind: LobbyKind) {
  return (
    kind === "inhouse" ||
    kind === "duel" ||
    process.env.DOTA_SEASON_LOBBY_BOT_ENABLED === "true"
  );
}

/**
 * The in-house league ticket's numeric id (`DOTA_INHOUSE_LEAGUE_ID`), or null
 * while it is unset or not a ticket id: Europe's, until Valve grants one. The
 * bot hosts no in-house game without it (`inhouseLobbyPlan` refuses).
 */
export function inhouseLobbyTicketId(): number | null {
  return parseLobbyLeagueId(process.env.DOTA_INHOUSE_LEAGUE_ID);
}

/**
 * Env only: can the lobby bot host this league's in-house games? It needs a
 * connection AND the in-house ticket's id, so no page promises a bot that
 * can't set the ticket. A connection that is set but malformed still counts:
 * its panel names the problem to admins.
 */
export function inhouseLobbyBotConfigured(): boolean {
  if (inhouseLobbyTicketId() === null) return false;
  try {
    return lobbyBotConnection() != null;
  } catch {
    return true;
  }
}

/**
 * What an admin's bot panel says while the in-house ticket's id is unset.
 * Players get no panel then (`/api/dota-lobby` answers their read like a bot
 * that isn't set up), so this line is the only place it shows.
 */
export const INHOUSE_TICKET_MISSING_ADMIN_NOTE =
  "The bot can't host in-house games until the in-house league ticket's numeric ID is set (DOTA_INHOUSE_LEAGUE_ID). Players see the by-hand steps until then.";

/** The addresses the bot listens on when it runs on the same box as the site. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/**
 * Where the site reaches the bot, from DOTA_LOBBY_BOT_URL and
 * DOTA_LOBBY_BOT_SECRET, or null when neither is set. `loopback` is a bot on
 * this machine: a shorter timeout, since it answers at once or not at all.
 *
 * Production takes https for any host (the relay), or plain http only to the
 * bot on the same box: exactly `http://127.0.0.1:<port>` or
 * `http://[::1]:<port>`, never `localhost` (a name, and the bot binds IPv4)
 * and never another host, whose traffic would leave the machine unencrypted
 * with the bearer secret in it. Development also allows `http://localhost`.
 */
export function lobbyBotConnection() {
  const origin = process.env.DOTA_LOBBY_BOT_URL;
  const token = process.env.DOTA_LOBBY_BOT_SECRET;
  if (!origin && !token) return null;
  try {
    const url = new URL(origin ?? "");
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    const local =
      process.env.NODE_ENV !== "production" &&
      (loopback || url.hostname === "localhost");
    const plainHttpAllowed =
      url.protocol === "http:" && (local || (loopback && url.port !== ""));
    if (
      (url.protocol !== "https:" && !plainHttpAllowed) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !token ||
      token.length < 32 ||
      token.length > 512 ||
      /\s/.test(token)
    )
      throw new Error();
    return {
      origin: url.origin,
      token,
      loopback: loopback || url.hostname === "localhost",
    };
  } catch {
    throw new UserFacingError(
      "The lobby bot configuration needs an admin's attention.",
    );
  }
}

type LobbyBotConnection = NonNullable<ReturnType<typeof lobbyBotConnection>>;

/** One POST to the bot's /lobby, bounded by the connection's timeout. */
function postToBot(
  connection: LobbyBotConnection,
  body: unknown,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(
    connection.loopback ? LOOPBACK_TIMEOUT_MS : RELAY_TIMEOUT_MS,
  );
  return fetch(`${connection.origin}/lobby`, {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${connection.token}`,
    },
    body: JSON.stringify(body),
  });
}

/** What the bot's health action says, or "offline" (not connected to Dota). */
type LobbyBotHealth =
  | { online: boolean; steamId: string | null; activeKey: string | null }
  | "offline";

/**
 * The bot's health: whether it is online, its Steam account and the job key
 * it holds. Throws on a reply that breaks the contract or a bot that can't be
 * reached; never changes anything on the bot.
 */
async function readLobbyBotHealth(
  connection: LobbyBotConnection,
): Promise<LobbyBotHealth> {
  const { status, body } = await readBotReply(
    await postToBot(connection, { action: "health" }),
  );
  if (status === 409 && body.code === "OFFLINE") return "offline";
  if (
    status !== 200 ||
    typeof body.online !== "boolean" ||
    (body.steamId !== null &&
      (typeof body.steamId !== "string" || !/^\d{17}$/.test(body.steamId))) ||
    (body.activeKey !== null && typeof body.activeKey !== "string")
  )
    throw new BotReplyUnreadableError();
  return {
    online: body.online,
    steamId: body.steamId as string | null,
    activeKey: body.activeKey as string | null,
  };
}

/** The in-house statuses a game can't come back from to use its bot again. */
const CLOSED_INHOUSE_STATUSES = [
  INHOUSE_STATUS.COMPLETED,
  INHOUSE_STATUS.CANCELLED,
  INHOUSE_STATUS.AWAITING_RESULT,
];

/**
 * The in-house game the bot's active job belongs to, when it is this
 * league's and the database shows it closed: finished, cancelled, or marked
 * over (its result on the way). Null for no job, another league's or a season
 * job, or a game still being played. Shared by admin recovery and Create's
 * BUSY self-heal, so both free the bot from exactly the same games.
 */
async function closedInhouseLobbyForBotKey(
  activeKey: string | null,
): Promise<string | null> {
  if (activeKey === null) return null;
  const key = ownLobbyKey(activeKey);
  if (key?.kind !== "inhouse") return null;
  const lobby = await prisma.inhouseLobby.findFirst({
    where: { id: key.id, status: { in: CLOSED_INHOUSE_STATUSES } },
    select: { id: true },
  });
  return lobby?.id ?? null;
}

/** The duel statuses whose bot job nothing needs any more. */
const CLOSED_DUEL_STATUSES = [
  INHOUSE_DUEL_STATUS.COMPLETED,
  INHOUSE_DUEL_STATUS.CANCELLED,
  INHOUSE_DUEL_STATUS.AWAITING_RESULT,
];

/**
 * The 1v1 the bot's active job belongs to, when it is this league's and the
 * database shows it closed (completed, cancelled, or over with its result on
 * the way). With `freeUnstarted` (a 5v5's Create), also a READY 1v1 whose game
 * hasn't started (`unstarted`): the 5v5 comes first, and that 1v1 stays READY
 * and waits for the bot again (its lobby is made anew once the bot is free and
 * no 5v5 is being set up). Null otherwise. Create's BUSY self-heal frees the
 * bot from exactly these, as it does from closed in-house games.
 */
async function freeableDuelForBotKey(
  activeKey: string | null,
  freeUnstarted: boolean,
): Promise<{ id: string; unstarted: boolean } | null> {
  if (activeKey === null) return null;
  const key = ownLobbyKey(activeKey);
  if (key?.kind !== "duel") return null;
  const duel = await prisma.inhouseDuel.findUnique({
    where: { id: key.id },
    select: { id: true, status: true, startedAt: true },
  });
  if (!duel) return null;
  if ((CLOSED_DUEL_STATUSES as readonly string[]).includes(duel.status))
    return { id: duel.id, unstarted: false };
  if (
    freeUnstarted &&
    duel.status === INHOUSE_DUEL_STATUS.READY &&
    duel.startedAt === null
  )
    return { id: duel.id, unstarted: true };
  return null;
}

/**
 * Admin health exposes only a closed in-house room confirmed by the database:
 * finished, cancelled, or marked over (its result on the way). A game marked
 * over has left the room, and with it the only other Release control, so a
 * bot still holding its Dota lobby would answer BUSY to every other game.
 */
export async function recoverableInhouseBotLobby(viewer: SessionUser) {
  if (viewer.role !== "ADMIN") throw new UserFacingError("Admins only.");
  const connection = lobbyBotConnection();
  if (!connection)
    return { enabled: false, online: false, steamId: null, id: null };
  try {
    const health = await readLobbyBotHealth(connection);
    if (health === "offline")
      return { enabled: true, online: false, steamId: null, id: null };
    return {
      enabled: true,
      online: health.online,
      steamId: health.steamId,
      id: await closedInhouseLobbyForBotKey(health.activeKey),
    };
  } catch {
    throw new UserFacingError(
      "Could not check bot recovery. Confirm the bot is online, then try again.",
    );
  }
}

/**
 * What Create's BUSY self-heal got the bot to do about a closed game: leave
 * its lobby now (`leavingNow`), or leave once Dota lets it (a game still
 * running in Dota, or a release whose answer was lost).
 */
export type FreedBot = {
  id: string;
  leavingNow: boolean;
  /** The closed game was a 1v1 (absent: an in-house 5v5 game). */
  duel?: true;
  /** That 1v1 hadn't started: a 5v5's Create took the bot first. */
  unstarted?: true;
};

/**
 * Create's BUSY self-heal, for a Create of `forKind`. When the bot's active
 * job is this league's in-house game or 1v1 and the database shows it closed,
 * ask the bot to release it. A 5v5's Create (in-house or season) also frees
 * the bot from a 1v1 lobby whose game hasn't started (freeableDuelForBotKey):
 * the 1v1 stays READY and its lobby is made again later; a 1v1's Create never
 * takes another 1v1's bot. Null when there is nothing to free, or when the bot refused the
 * release (it can't leave yet, isn't running, or the game's spec can't be
 * built): that changed nothing, so the BUSY answer stands. A release the bot
 * accepted for a game still running in Dota (`started`) only leaves at that
 * game's end, and a lost answer may or may not have landed: neither is
 * `leavingNow`. One health read and at most one release; never throws.
 */
export async function freeBotFromClosedInhouseGame(
  forKind: LobbyKind,
): Promise<FreedBot | null> {
  try {
    const connection = lobbyBotConnection();
    if (!connection) return null;
    const health = await readLobbyBotHealth(connection);
    if (health === "offline") return null;
    const lobbyId = await closedInhouseLobbyForBotKey(health.activeKey);
    const freeable = lobbyId
      ? null
      : await freeableDuelForBotKey(health.activeKey, forKind !== "duel");
    const duelId = freeable?.id ?? null;
    const id = lobbyId ?? duelId;
    if (!id) return null;
    const duel = freeable
      ? ({ duel: true, ...(freeable.unstarted ? { unstarted: true } : {}) } as const)
      : {};
    let reply: DotaLobbyBotReply | null;
    try {
      reply = duelId
        ? await releaseDuelBotLobby(duelId)
        : await releaseInhouseBotLobby(id);
    } catch (error) {
      return error instanceof LobbyBotOutcomeUnknownError
        ? { id, leavingNow: false, ...duel }
        : null;
    }
    if (!reply) return null;
    return { id, leavingNow: reply.state !== "started", ...duel };
  } catch {
    return null;
  }
}

/** Create's answer when the self-heal sent the closed game's release. */
export function freeingBotMessage(freed: FreedBot) {
  const game = freed.unstarted
    ? "a 1v1 lobby that hadn't started"
    : freed.duel
      ? "a finished 1v1"
      : `finished game #${inhouseLobbyCode(freed.id)}`;
  return freed.leavingNow
    ? `Freeing the bot from ${game}. Press “Create Dota lobby” again in a few seconds.`
    : `Asked the bot to leave ${game}. It leaves as soon as Dota lets it: at once if that game's lobby is gone, otherwise when that game ends in Dota. Press “Create Dota lobby” again in a minute, or host this game by hand.`;
}

/** The status cache's key for the shared health read (no job key looks like it). */
const HEALTH_CACHE_KEY = "health";

/**
 * For a panel whose own game has no bot lobby: the other game the one bot is
 * hosting, if any. Reads the bot's health through the status cache, so every
 * panel in this process shares one health read per TTL. This league's
 * in-house job names its game (`#1234`) and whether the site has closed it;
 * this league's 1v1 is "a 1v1" (`duel`; for a 5v5's panel a 1v1 whose game
 * hasn't started reads closed and `unstarted`, since that panel's Create frees
 * the bot from it); any other job (a season match, the other league's game)
 * is `game: null`. Null when the bot holds nothing,
 * holds this game, or can't be read: the panel then shows what it shows
 * today. A running game the bot has left early (`left`) is no claim at all:
 * the bot frees its active claim when it leaves, so its health names no key
 * and nothing reads as busy. Never throws, never changes the bot.
 */
export async function botBusyElsewhere(
  spec: Pick<DotaLobbySpec, "key">,
): Promise<BotBusyElsewhere | null> {
  try {
    const connection = lobbyBotConnection();
    if (!connection) return null;
    const health = await cachedLobbyBotStatus(HEALTH_CACHE_KEY, () =>
      readLobbyBotHealth(connection),
    );
    if (
      health === "offline" ||
      health.activeKey === null ||
      health.activeKey === spec.key
    )
      return null;
    const key = ownLobbyKey(health.activeKey);
    if (key?.kind === "duel") {
      const duel = await prisma.inhouseDuel.findUnique({
        where: { id: key.id },
        select: { status: true, startedAt: true },
      });
      // A 5v5's panel (in-house or season) comes first: a 1v1 lobby whose
      // game hasn't started is one its Create frees (never hand hosting).
      const fiveVFive = ownLobbyKey(spec.key)?.kind !== "duel";
      if (
        fiveVFive &&
        duel?.status === INHOUSE_DUEL_STATUS.READY &&
        duel.startedAt === null
      )
        return { game: "a 1v1", closed: true, duel: true, unstarted: true };
      return {
        game: "a 1v1",
        closed:
          !duel ||
          (CLOSED_DUEL_STATUSES as readonly string[]).includes(duel.status),
        duel: true,
      };
    }
    if (key?.kind !== "inhouse") return { game: null, closed: false };
    const lobby = await prisma.inhouseLobby.findUnique({
      where: { id: key.id },
      select: { id: true, status: true },
    });
    if (!lobby) return { game: null, closed: true };
    return {
      game: `#${inhouseLobbyCode(lobby.id)}`,
      closed: (CLOSED_INHOUSE_STATUSES as readonly string[]).includes(
        lobby.status,
      ),
    };
  } catch {
    return null;
  }
}

/** What an in-house bot spec is built from: the lobby's id, sides and roster. */
type InhouseSpecLobby = {
  id: string;
  radiantTeam: number;
  players: {
    userId?: string;
    team: number | null;
    isCaptain?: boolean;
    user: DotaAccountIdentity & { name?: string };
  }[];
};

/**
 * A side's display name in the bot panel: the drafting captain's team, the way
 * players think of it, or "Team N" when the roster has no single captain for
 * that side. Display only: the bot never sends or checks side names.
 */
function inhouseSideName(lobby: InhouseSpecLobby, team: number) {
  const captains = lobby.players.filter((p) => p.team === team && p.isCaptain);
  const name = captains.length === 1 ? captains[0].user.name : undefined;
  return name ? `${name}'s team` : `Team ${team}`;
}

/** A side's Steam ids for the bot spec, from the one roster pass. */
function sideSteamIds(roster: readonly LobbyRosterEntry[], side: LobbySide) {
  return roster.filter((p) => p.side === side).map((p) => p.steamId);
}

/**
 * A side's display names for the bot's lobby chat, from the same roster pass
 * and filter as `sideSteamIds`, so name i belongs to id i. Names only, never
 * contact info.
 */
function sideChatNames(roster: readonly LobbyRosterEntry[], side: LobbySide) {
  return roster.filter((p) => p.side === side).map((p) => lobbyChatName(p.name));
}

/**
 * The bot spec for an in-house lobby, and the roster it was built from (each
 * player's name, side and playing Steam id, and whether they are the viewer).
 * One builder for the browser controls and the scheduled result scan, so both
 * address the same bot job (the key) with the same settings. Throws a
 * UserFacingError when the ticket is unset or a player has no usable Dota
 * account.
 */
function inhouseLobbyPlan(
  lobby: InhouseSpecLobby,
  viewerId: string | null,
): { spec: DotaLobbySpec; roster: LobbyRosterEntry[] } {
  const leagueId = inhouseLobbyTicketId();
  if (!leagueId)
    throw new UserFacingError(
      "An admin must configure the numeric in-house league ticket ID before using the bot.",
    );
  const direTeam = lobby.radiantTeam === 1 ? 2 : 1;
  const team = (n: number, side: LobbySide): LobbyRosterEntry[] =>
    lobby.players
      .filter((p) => p.team === n)
      .map((p) => ({
        name: p.user.name ?? "Player",
        side,
        steamId: playingSteamId(p.user),
        self: viewerId !== null && p.userId === viewerId,
      }));
  const roster = [
    ...team(lobby.radiantTeam, "radiant"),
    ...team(direTeam, "dire"),
  ];
  return {
    spec: {
      key: regionalLobbyKey("inhouse", lobby.id, 1),
      name: `${INHOUSE.LOBBY_NAME} ${lobby.id.slice(-8)}`,
      password: INHOUSE.LOBBY_PASSWORD,
      leagueId,
      gameMode: LEAGUE_GAME_MODE.id,
      serverRegion: LEAGUE_CONFIG.gameServerRegionId,
      radiant: sideSteamIds(roster, "radiant"),
      dire: sideSteamIds(roster, "dire"),
      radiantName: inhouseSideName(lobby, lobby.radiantTeam),
      direName: inhouseSideName(lobby, direTeam),
      // The bot's lobby chat tells players where to sit (in-house only).
      radiantNames: sideChatNames(roster, "radiant"),
      direNames: sideChatNames(roster, "dire"),
    },
    roster,
  };
}

function inhouseLobbySpec(lobby: InhouseSpecLobby): DotaLobbySpec {
  return inhouseLobbyPlan(lobby, null).spec;
}

/** What a 1v1's bot spec is built from: its id and its two sides' players. */
export type DuelSpecDuel = {
  id: string;
  radiantUser: DotaAccountIdentity & { id?: string; name?: string | null };
  direUser: DotaAccountIdentity & { id?: string; name?: string | null };
};

/**
 * The bot spec for a 1v1 mid duel, and its roster: the in-house 5v5's
 * ticket, password and region, game mode 1v1 Solo Mid, one playing Steam id
 * per side, and a lobby name unique to the duel (players find it in Dota's
 * Custom Lobbies browser by it). One builder for the panel, the auto-create,
 * the worker's read and every release, so all address the same job. Throws
 * a UserFacingError when the ticket is unset or a player has no usable Dota
 * account.
 */
function duelLobbyPlan(
  duel: DuelSpecDuel,
  viewerId: string | null,
): { spec: DotaLobbySpec; roster: LobbyRosterEntry[] } {
  const leagueId = inhouseLobbyTicketId();
  if (!leagueId)
    throw new UserFacingError(
      "An admin must configure the numeric in-house league ticket ID before using the bot.",
    );
  const entry = (
    user: DuelSpecDuel["radiantUser"],
    side: LobbySide,
  ): LobbyRosterEntry => ({
    name: user.name ?? "Player",
    side,
    steamId: playingSteamId(user),
    self: viewerId !== null && user.id === viewerId,
  });
  const roster = [entry(duel.radiantUser, "radiant"), entry(duel.direUser, "dire")];
  return {
    spec: {
      key: regionalLobbyKey("duel", duel.id, 1),
      name: `${LEAGUE_CONFIG.name} 1v1 ${duel.id.slice(-6)}`,
      password: INHOUSE.LOBBY_PASSWORD,
      leagueId,
      gameMode: DUEL_GAME_MODE.id,
      serverRegion: LEAGUE_CONFIG.gameServerRegionId,
      radiant: sideSteamIds(roster, "radiant"),
      dire: sideSteamIds(roster, "dire"),
      radiantName: roster[0].name,
      direName: roster[1].name,
      // The bot's lobby chat tells each player which side is theirs.
      radiantNames: sideChatNames(roster, "radiant"),
      direNames: sideChatNames(roster, "dire"),
    },
    roster,
  };
}

/** A 1v1's bot spec (see duelLobbyPlan); throws as it does. */
export function duelLobbySpec(duel: DuelSpecDuel): DotaLobbySpec {
  return duelLobbyPlan(duel, null).spec;
}

/** A player's name and the columns their playing Steam id is built from. */
const BOT_IDENTITY_SELECT = {
  name: true,
  steamId: true,
  dotaAccountIdV2: true,
  legacyDotaAccountId: true,
} as const;

/** What an in-house bot spec is built from, and nothing else. */
const INHOUSE_SPEC_SELECT = {
  id: true,
  status: true,
  radiantTeam: true,
  players: {
    select: {
      userId: true,
      team: true,
      isCaptain: true,
      user: { select: BOT_IDENTITY_SELECT },
    },
  },
} as const;

/** What a 1v1's bot spec is built from, its status and its stored bot match id. */
const DUEL_SPEC_SELECT = {
  id: true,
  status: true,
  startedAt: true,
  botMatchId: true,
  radiantUser: { select: { id: true, ...BOT_IDENTITY_SELECT } },
  direUser: { select: { id: true, ...BOT_IDENTITY_SELECT } },
} as const;

/** A season side's display name, captain, standing and roster identities. */
const SEASON_TEAM_SELECT = {
  id: true,
  name: true,
  captainId: true,
  withdrawn: true,
  members: { select: { userId: true, user: { select: BOT_IDENTITY_SELECT } } },
} as const;

/** All lobby settings and roster identities come from trusted app state. */
export async function resolveDotaLobby(
  viewer: SessionUser,
  kind: LobbyKind,
  id: string,
) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw new UserFacingError("Invalid match identifier.");
  if (!lobbyBotKindEnabled(kind))
    throw new UserFacingError("The lobby bot is currently enabled for in-house games only.");
  const admin = viewer.role === "ADMIN";
  let spec: DotaLobbySpec;
  let roster: LobbyRosterEntry[];
  let canControl = false;
  let playable = false;
  /** A 1v1's status and stored bot match id, for the route's bot-driven writes. */
  let duel: {
    id: string;
    status: string;
    startedAt: Date | null;
    botMatchId: string | null;
  } | null = null;
  if (kind === "duel") {
    const row = await prisma.inhouseDuel.findUnique({
      where: { id },
      select: DUEL_SPEC_SELECT,
    });
    if (!row) throw new UserFacingError("1v1 not found.");
    const member =
      row.radiantUser.id === viewer.id || row.direUser.id === viewer.id;
    if (!member && !admin)
      throw new UserFacingError(
        "Only this 1v1's players and admins can use its bot controls.",
      );
    // Either player runs the lobby (there are no captains in a 1v1). Only a
    // paired duel whose game hasn't launched can create, start or invite;
    // any duel can still read its job and release the bot.
    canControl = true;
    playable = row.status === INHOUSE_DUEL_STATUS.READY;
    duel = {
      id: row.id,
      status: row.status,
      startedAt: row.startedAt,
      botMatchId: row.botMatchId,
    };
    ({ spec, roster } = duelLobbyPlan(row, viewer.id));
  } else if (kind === "inhouse") {
    const lobby = await prisma.inhouseLobby.findUnique({
      where: { id },
      select: INHOUSE_SPEC_SELECT,
    });
    if (!lobby) throw new UserFacingError("In-house lobby not found.");
    const member = lobby.players.find((p) => p.userId === viewer.id);
    if (!member && !admin)
      throw new UserFacingError(
        "Only this lobby's players and admins can use its bot controls.",
      );
    canControl = admin || !!member?.isCaptain;
    // Any live game with its teams locked can use the bot; two games can be
    // live at once, and each has its own bot job. The one Steam account hosts
    // one Dota lobby at a time, until that game's postgame, answering BUSY to
    // every other game meanwhile. A finished lobby can still release its bot.
    playable = (INHOUSE_PLAYING_STATUSES as readonly string[]).includes(
      lobby.status,
    );
    ({ spec, roster } = inhouseLobbyPlan(lobby, viewer.id));
  } else {
    const match = await prisma.match.findUnique({
      where: { id },
      select: {
        seasonId: true,
        phase: true,
        status: true,
        bestOf: true,
        homeScore: true,
        awayScore: true,
        season: { select: { status: true, dotaLeagueId: true } },
        homeTeam: { select: SEASON_TEAM_SELECT },
        awayTeam: { select: SEASON_TEAM_SELECT },
        standins: {
          select: {
            teamId: true,
            standinUserId: true,
            replacingUserId: true,
            standin: { select: BOT_IDENTITY_SELECT },
          },
        },
      },
    });
    if (!match) throw new UserFacingError("Season match not found.");
    const teams = [match.homeTeam, match.awayTeam];
    canControl = admin || teams.some((t) => t.captainId === viewer.id);
    const onRoster =
      teams.some((t) => t.members.some((p) => p.userId === viewer.id)) ||
      match.standins.some((s) => s.standinUserId === viewer.id);
    if (!canControl && !onRoster)
      throw new UserFacingError(
        "Only this match's players and admins can view its bot lobby.",
      );
    const season = await getActiveSeason();
    playable =
      season?.id === match.seasonId &&
      matchResultsOpen(match.season.status, match.phase) &&
      match.status !== "COMPLETED" &&
      !teams.some((t) => t.withdrawn);
    const leagueId = parseLobbyLeagueId(match.season.dotaLeagueId);
    if (!leagueId)
      throw new UserFacingError(
        "Set a valid season league ticket ID before using the bot.",
      );
    const side = (
      team: typeof match.homeTeam,
      side: LobbySide,
    ): LobbyRosterEntry[] => {
      const standins = match.standins.filter((s) => s.teamId === team.id);
      const users = new Map([
        ...team.members.map((p) => [p.userId, p.user] as const),
        ...standins.map((s) => [s.standinUserId, s.standin] as const),
      ]);
      return matchNightRoster(
        team.members.map((p) => p.userId),
        standins,
      ).map((userId) => {
        const user = users.get(userId)!;
        return {
          name: user.name,
          side,
          steamId: playingSteamId(user),
          self: userId === viewer.id,
        };
      });
    };
    // Home plays Radiant, away Dire.
    roster = [...side(match.homeTeam, "radiant"), ...side(match.awayTeam, "dire")];
    const game = match.homeScore + match.awayScore + 1;
    if (game > match.bestOf) playable = false;
    const key = regionalLobbyKey("season", id, game);
    const secret = process.env.DOTA_LOBBY_BOT_SECRET ?? "";
    spec = {
      key,
      // The league's own name in both regions, as the site and Discord say
      // it: players type this into Dota's Custom Lobbies browser.
      name: `${`${LEAGUE_CONFIG.name} ${match.homeTeam.name} vs ${match.awayTeam.name}`.slice(0, 90)} G${game} ${id.slice(-8)}`,
      password: createHmac("sha256", secret)
        .update(key)
        .digest("hex")
        .slice(0, 12),
      leagueId,
      gameMode: LEAGUE_GAME_MODE.id,
      serverRegion: LEAGUE_CONFIG.gameServerRegionId,
      radiant: sideSteamIds(roster, "radiant"),
      dire: sideSteamIds(roster, "dire"),
      radiantName: match.homeTeam.name,
      direName: match.awayTeam.name,
    };
  }
  // `roster` holds Steam ids: server only. The browser gets
  // `lobbyPlayerViews`, which leaves them out.
  return { spec, canControl, playable, roster, duel };
}

/**
 * What the bot answered: the status every action returns, plus the roster's
 * seats when the request asked for them and an invite's count. Server only:
 * `players` carries Steam ids.
 */
export type DotaLobbyBotReply = DotaLobbyStatus & {
  /** Only when asked (`withPlayers`) and the reply's list parsed. */
  players?: DotaLobbyBotPlayer[];
  /** An invite's reply only, when the count parsed. */
  invited?: number;
};

/** The status cache's key: one entry per bot, job and seat-report choice. */
function statusCacheKey(
  connection: LobbyBotConnection,
  jobKey: string,
  withPlayers: boolean,
) {
  return `${connection.origin}|${jobKey}|${withPlayers ? "players" : "plain"}`;
}

/** A write's reply, as the next status read of its job should see it. */
function rememberWrite(
  connection: LobbyBotConnection,
  jobKey: string,
  withPlayers: boolean,
  reply: DotaLobbyBotReply | null,
) {
  const own = statusCacheKey(connection, jobKey, withPlayers);
  // The other variant's copy predates this write: the next read asks again.
  dropLobbyBotStatus(statusCacheKey(connection, jobKey, !withPlayers));
  if (!reply) return dropLobbyBotStatus(own);
  const status: DotaLobbyBotReply = { ...reply };
  delete status.invited;
  storeLobbyBotStatus(own, status);
}

/**
 * Ask the bot to act on (or report) one game's job. Every request carries
 * `withLifecycle: true`, so the reply says when a release is pending and
 * when Dota showed the game over; an older bot ignores it.
 *
 * A browser status read (no `signal`) goes through the status cache: every
 * panel of a game shares one bot read per `LOBBY_BOT_STATUS_TTL_MS`. Writes
 * always ask the bot, then refresh that cache with their reply. The worker's
 * bounded read passes a `signal` and always asks the bot.
 */
export async function callLobbyBot(
  spec: DotaLobbySpec,
  action?: LobbyAction,
  options: {
    /** Extra cancellation (the scheduled worker's deadline); the connection's timeout applies regardless. */
    signal?: AbortSignal;
    /**
     * Ask for the roster's seats and invites. Browser reads only: a bot
     * without invites ignores it, and the scheduled worker never asks.
     */
    withPlayers?: boolean;
    /**
     * An invite's targets (playing Steam ids on this spec's sides). Omitted,
     * the bot invites everyone on the roster not already in its lobby.
     */
    invite?: readonly string[];
  } = {},
): Promise<DotaLobbyBotReply> {
  const key = ownLobbyKey(spec.key);
  if (!key)
    throw new UserFacingError("This lobby does not belong to this league.");
  if (key.kind === "season" && !lobbyBotKindEnabled("season"))
    throw new UserFacingError("The lobby bot is currently enabled for in-house games only.");
  const invite = action === "invite" ? options.invite : undefined;
  if (
    invite &&
    (invite.length < 1 ||
      invite.length > 20 ||
      new Set(invite).size !== invite.length ||
      invite.some((id) => !spec.radiant.includes(id) && !spec.dire.includes(id)))
  )
    throw new UserFacingError("Only this game's own players can be invited.");
  const connection = lobbyBotConnection();
  if (!connection)
    throw new UserFacingError("The lobby bot has not been configured yet.");
  const withPlayers = options.withPlayers === true;
  const ask = () =>
    askLobbyBot(connection, spec, key.kind, action, {
      signal: options.signal,
      withPlayers,
      invite,
    });
  if (!action) {
    if (options.signal) return ask();
    return {
      ...(await cachedLobbyBotStatus(
        statusCacheKey(connection, spec.key, withPlayers),
        ask,
      )),
    };
  }
  try {
    const reply = await ask();
    rememberWrite(connection, spec.key, withPlayers, reply);
    return reply;
  } catch (error) {
    // A refusal changed nothing, but an unknown outcome may have: either
    // way the next read asks the bot.
    rememberWrite(connection, spec.key, withPlayers, null);
    throw error;
  }
}

/** One request to the bot and its reply, read strictly. */
async function askLobbyBot(
  connection: LobbyBotConnection,
  spec: DotaLobbySpec,
  kind: LobbyKind,
  action: LobbyAction | undefined,
  options: {
    signal?: AbortSignal;
    withPlayers: boolean;
    invite: readonly string[] | undefined;
  },
): Promise<DotaLobbyBotReply> {
  const { withPlayers, invite } = options;
  // A lost answer may still have reached Dota: unknown, never failed.
  const unknown = () =>
    action === "invite"
      ? new InviteOutcomeUnknownError()
      : new LobbyBotOutcomeUnknownError();
  let response: Response;
  try {
    response = await postToBot(
      connection,
      {
        action: action ?? "status",
        // An older bot ignores the keys it doesn't know.
        spec: {
          ...spec,
          withLifecycle: true,
          ...(withPlayers ? { withPlayers: true } : {}),
          ...(invite ? { invite: [...invite] } : {}),
        },
      },
      options.signal,
    );
  } catch (error) {
    // Nothing listened: the request never reached the bot.
    if (connectionRefused(error)) throw new UserFacingError(BOT_NOT_RUNNING);
    throw unknown();
  }
  let reply: Awaited<ReturnType<typeof readBotReply>>;
  try {
    reply = await readBotReply(response);
  } catch {
    throw unknown();
  }
  const { body } = reply;
  // Only our controlled service's small, fixed response contract is exposed.
  if (reply.status !== 200) {
    const code: unknown = body.code;
    if (code === "BUSY") throw new LobbyBotBusyError();
    // The relay answers OFFLINE for a reply it lost after delivering the
    // command too (timeout, dropped socket), so an invite's OFFLINE through
    // it is unknown, never failed. On loopback only the bot itself says it.
    if (action === "invite" && code === "OFFLINE" && !connection.loopback)
      throw new InviteOutcomeUnknownError();
    const messages: Record<string, string> = {
      OFFLINE: "The bot is not connected to Dota yet. Try again shortly.",
      // Inhouses have no match page and no stand-ins: the ten drafted
      // players are the whole roster.
      ROSTER:
        kind === "duel"
          ? "Both players must sit on their own sides (Radiant or Dire) before the bot can start."
          : kind === "inhouse"
            ? "All ten players must sit on their assigned side (Radiant or Dire) before the bot can start."
            : "All ten registered players must join their assigned sides before starting. Check stand-ins on the match page.",
      SETTINGS:
        "Dota has not confirmed the required ticket and lobby settings. Ask an admin to check the bot's ticket permissions.",
      STATE:
        action === "invite"
          ? "The bot invites players only while its lobby is ready and waiting for them. Refresh its status first."
          : "This lobby cannot perform that action. Refresh its status first.",
      // An invite's targets the bot didn't accept: a roster that changed
      // since this page loaded.
      ...(action === "invite"
        ? {
            INVALID:
              "The bot couldn't match those invites to this game's roster. Refresh its status, then try again.",
          }
        : {}),
    };
    throw new UserFacingError(
      (typeof code === "string" && Object.hasOwn(messages, code)
        ? messages[code]
        : undefined) ??
        "The bot could not complete that request. Refresh its status before retrying.",
    );
  }
  if (
    typeof body.state !== "string" ||
    ![
      "idle",
      "creating",
      "ready",
      "starting",
      "started",
      "blocked",
      "released",
    ].includes(body.state)
  )
    throw unknown();
  const result: DotaLobbyBotReply = {
    state: body.state as DotaLobbyStatus["state"],
    lobbyId: parseLobbyDigits(body.lobbyId),
    matchId: parseLobbyDigits(body.matchId),
    // `releasing`, `over`, and `left` (a running game the bot has left).
    ...parseLobbyLifecycle(body),
  };
  // A malformed list or count is unknown: left out, never read as "not
  // invited" or "none sent".
  if (withPlayers) {
    const players = parseBotPlayers(body.players);
    if (players) result.players = players;
  }
  if (action === "invite") {
    const invited = parseInvitedCount(body.invited);
    if (invited !== undefined) result.invited = invited;
  }
  return result;
}

/**
 * Ask the bot to release this in-house game's job, built from the game's
 * own stored roster (the bot checks the job's name and password), and return
 * its answer. Throws what callLobbyBot throws; a missing game is a no-op
 * (null).
 */
async function releaseInhouseBotLobby(
  lobbyId: string,
): Promise<DotaLobbyBotReply | null> {
  const lobby = await prisma.inhouseLobby.findUnique({
    where: { id: lobbyId },
    select: INHOUSE_SPEC_SELECT,
  });
  if (!lobby) return null;
  return callLobbyBot(inhouseLobbySpec(lobby), "release");
}

/**
 * Ask the bot to release this 1v1's job, built from the duel's stored
 * players, and return its answer. Throws what callLobbyBot throws; a missing
 * duel is a no-op (null).
 */
export async function releaseDuelBotLobby(
  duelId: string,
): Promise<DotaLobbyBotReply | null> {
  const duel = await prisma.inhouseDuel.findUnique({
    where: { id: duelId },
    select: DUEL_SPEC_SELECT,
  });
  if (!duel) return null;
  return callLobbyBot(duelLobbySpec(duel), "release");
}

/**
 * After a game closes (marked over by a press or by the bot, cancelled, given
 * up on, voided, or its result recorded), ask the bot to release that game's
 * job, so a bot still attached never answers BUSY to the next game.
 *
 * Best-effort and never awaited: the close is already committed, the caller
 * answers at once, and the request runs on in this process (a lost release
 * changes nothing; a started game's bot also leaves by itself at the
 * postgame). A no-op when no bot is configured, before any database read.
 * Never call it inside a transaction.
 */
export function releaseInhouseBotAfterClose(lobbyId: string): void {
  try {
    if (!lobbyBotConnection()) return;
  } catch {
    return;
  }
  trackBotRelease(
    releaseInhouseBotLobby(lobbyId).then(
      () => {},
      () => {},
    ),
  );
}

// The worker's bot read is a garnish on a result scan that has its own
// OpenDota budget: never let an offline relay eat that budget.
const BOT_STATUS_TIMEOUT_MS = 3_000;
const BOT_STATUS_MIN_BUDGET_MS = 1_000;

/**
 * Server-side, for the scheduled result scan (there is no viewer): what the
 * lobby bot knows about this in-house game — in particular the Dota match id
 * it saw when the game launched, which it keeps after it leaves the game,
 * whether it saw the game running ("started": the scan stamps a READY game
 * IN_PROGRESS) and whether Dota showed it over (`over`: the scan marks it
 * over). Also read by "Game over", which waits for an unlaunched bot lobby to
 * be started or released (botHoldsUnlaunchedLobby).
 * One status read, bounded by the caller's deadline, never from the cache.
 *
 * Never throws: an unconfigured, misconfigured or unreachable bot, a missing
 * ticket id or a player with no usable Dota account all return null, and the
 * caller falls back to the player-history scan. The status read never creates
 * or changes a bot lobby.
 */
export async function inhouseBotGameStatus(
  lobby: InhouseSpecLobby,
  options: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<DotaLobbyStatus | null> {
  return boundedBotStatus(() => inhouseLobbySpec(lobby), options);
}

/**
 * One status read of a job, outside any request (the worker, "Game over"),
 * bounded by the caller's deadline and BOT_STATUS_TIMEOUT_MS, never from the
 * cache. Null for no bot, a misconfigured or unreachable one, too little time
 * left, or a spec that can't be built. Never throws, never changes the bot.
 */
export async function boundedBotStatus(
  buildSpec: () => DotaLobbySpec,
  options: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<DotaLobbyStatus | null> {
  try {
    if (!lobbyBotConnection()) return null;
    const remaining =
      options.deadlineMs === undefined
        ? BOT_STATUS_TIMEOUT_MS
        : options.deadlineMs - Date.now();
    if (remaining < BOT_STATUS_MIN_BUDGET_MS || options.signal?.aborted)
      return null;
    const timeout = AbortSignal.timeout(
      Math.min(BOT_STATUS_TIMEOUT_MS, remaining),
    );
    return await callLobbyBot(buildSpec(), undefined, {
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });
  } catch {
    return null;
  }
}

/**
 * The Dota match id of a game the bot actually launched, when it is a real
 * one. Only a "started" job counts: the GC saw that game running, so the id
 * is not left over from a launch that never began. The bot passes Valve's id
 * through as a string; "0" means no game was allocated.
 */
export function botReportedMatchId(
  status: DotaLobbyStatus | null,
): string | null {
  if (status?.state !== "started") return null;
  const id = status.matchId;
  return id && /^[1-9]\d{5,19}$/.test(id) ? id : null;
}
