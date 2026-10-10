import { createHmac } from "node:crypto";
import type { SessionUser } from "./auth";
import { prisma } from "./prisma";
import {
  INHOUSE,
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
import {
  parseBotPlayers,
  parseInvitedCount,
  parseLobbyLeagueId,
  type DotaLobbyBotPlayer,
  type DotaLobbySpec,
  type LobbyKind,
  type LobbyAction,
  type DotaLobbyStatus,
  type LobbyRosterEntry,
  type LobbySide,
} from "./dota-lobby";

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

function ownLobbyKey(key: string) {
  const match = /^(eu:)?(season|inhouse):([a-zA-Z0-9_-]{1,128}):([1-9]\d?)$/.exec(key);
  if (!match || (match[1] ? "eu" : "us") !== LEAGUE_CONFIG.region) return null;
  const kind = match[2] as LobbyKind;
  const game = Number(match[4]);
  if (kind === "inhouse" && game !== 1) return null;
  return { kind, id: match[3], game };
}

/** The single bot is reserved for in-house games unless explicitly opted in. */
export function lobbyBotKindEnabled(kind: LobbyKind) {
  return kind === "inhouse" || process.env.DOTA_SEASON_LOBBY_BOT_ENABLED === "true";
}

export function lobbyBotConnection() {
  const origin = process.env.DOTA_LOBBY_BOT_URL;
  const token = process.env.DOTA_LOBBY_BOT_SECRET;
  if (!origin && !token) return null;
  try {
    const url = new URL(origin ?? "");
    const local =
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
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
    return { origin: url.origin, token };
  } catch {
    throw new UserFacingError(
      "The lobby bot configuration needs an admin's attention.",
    );
  }
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
    const response = await fetch(`${connection.origin}/lobby`, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify({ action: "health" }),
    });
    const body = await response.json();
    if (response.status === 409 && body?.code === "OFFLINE")
      return { enabled: true, online: false, steamId: null, id: null };
    if (
      !response.ok ||
      !body ||
      typeof body.online !== "boolean" ||
      (body.steamId !== null &&
        (typeof body.steamId !== "string" || !/^\d{17}$/.test(body.steamId))) ||
      (body.activeKey !== null && typeof body.activeKey !== "string")
    )
      throw new Error();
    const health = {
      enabled: true,
      online: body.online as boolean,
      steamId: body.steamId as string | null,
      id: null,
    };
    if (body.activeKey === null) return health;
    const key = ownLobbyKey(body.activeKey);
    if (key?.kind !== "inhouse") return health;
    const lobby = await prisma.inhouseLobby.findFirst({
      where: {
        id: key.id,
        status: {
          in: [
            INHOUSE_STATUS.COMPLETED,
            INHOUSE_STATUS.CANCELLED,
            INHOUSE_STATUS.AWAITING_RESULT,
          ],
        },
      },
      select: { id: true },
    });
    return { ...health, id: lobby?.id ?? null };
  } catch {
    throw new UserFacingError(
      "Could not check bot recovery. Confirm the bot is online, then try again.",
    );
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
  const leagueId = parseLobbyLeagueId(process.env.DOTA_INHOUSE_LEAGUE_ID);
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
    },
    roster,
  };
}

function inhouseLobbySpec(lobby: InhouseSpecLobby): DotaLobbySpec {
  return inhouseLobbyPlan(lobby, null).spec;
}

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
  if (kind === "inhouse") {
    const lobby = await prisma.inhouseLobby.findUnique({
      where: { id },
      include: { players: { include: { user: true } } },
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
    // one Dota lobby at a time, answering BUSY until the other game starts.
    // A finished lobby can still release its bot.
    playable = (INHOUSE_PLAYING_STATUSES as readonly string[]).includes(
      lobby.status,
    );
    ({ spec, roster } = inhouseLobbyPlan(lobby, viewer.id));
  } else {
    const match = await prisma.match.findUnique({
      where: { id },
      include: {
        season: true,
        homeTeam: { include: { members: { include: { user: true } } } },
        awayTeam: { include: { members: { include: { user: true } } } },
        standins: { include: { standin: true } },
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
  return { spec, canControl, playable, roster };
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

export async function callLobbyBot(
  spec: DotaLobbySpec,
  action?: LobbyAction,
  options: {
    /** Extra cancellation (the scheduled worker's deadline); 15s applies regardless. */
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
  try {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(`${connection.origin}/lobby`, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify({
        action: action ?? "status",
        // Without these the request is exactly what an older bot expects.
        spec: {
          ...spec,
          ...(options.withPlayers ? { withPlayers: true } : {}),
          ...(invite ? { invite: [...invite] } : {}),
        },
      }),
    });
    const body = await response.json();
    // Only our controlled service's small, fixed response contract is exposed.
    if (!response.ok) {
      const messages: Record<string, string> = {
        BUSY: "The bot is setting up another game's lobby. It's free again once that game starts, usually within a few minutes: try again then, or host this game by hand.",
        OFFLINE: "The bot is not connected to Dota yet. Try again shortly.",
        // Inhouses have no match page and no stand-ins: the ten drafted
        // players are the whole roster.
        ROSTER:
          key.kind === "inhouse"
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
      const code: unknown = body?.code;
      // The relay answers OFFLINE for a reply it lost after delivering the
      // command too (timeout, dropped socket), so an invite's OFFLINE is
      // unknown, never failed.
      if (action === "invite" && code === "OFFLINE")
        throw new InviteOutcomeUnknownError();
      throw new UserFacingError(
        (typeof code === "string" && Object.hasOwn(messages, code)
          ? messages[code]
          : undefined) ??
          "The bot could not complete that request. Refresh its status before retrying.",
      );
    }
    if (
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
      throw new Error();
    const reply: DotaLobbyBotReply = {
      state: body.state,
      lobbyId: typeof body.lobbyId === "string" ? body.lobbyId : undefined,
      matchId: typeof body.matchId === "string" ? body.matchId : undefined,
    };
    // A malformed list or count is unknown: left out, never read as "not
    // invited" or "none sent".
    if (options.withPlayers) {
      const players = parseBotPlayers(body.players);
      if (players) reply.players = players;
    }
    if (action === "invite") {
      const invited = parseInvitedCount(body.invited);
      if (invited !== undefined) reply.invited = invited;
    }
    return reply;
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    // A lost answer may still have reached Dota: unknown, never failed.
    if (action === "invite") throw new InviteOutcomeUnknownError();
    throw new UserFacingError(
      "The lobby bot could not be reached. Refresh its status before retrying; the request may have reached Dota.",
    );
  }
}

// The worker's bot read is a garnish on a result scan that has its own
// OpenDota budget: never let an offline relay eat that budget.
const BOT_STATUS_TIMEOUT_MS = 3_000;
const BOT_STATUS_MIN_BUDGET_MS = 1_000;

/**
 * Server-side, for the scheduled result scan (there is no viewer): what the
 * lobby bot knows about this in-house game — in particular the Dota match id
 * it saw when the game launched, which it keeps after it leaves the running
 * game. Also read by "Game over", which waits for an unlaunched bot lobby to
 * be started or released (botHoldsUnlaunchedLobby).
 * One status read, bounded by the caller's deadline.
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
    return await callLobbyBot(inhouseLobbySpec(lobby), undefined, {
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
