export type LobbyKind = "season" | "inhouse";
export type LobbyAction = "create" | "start" | "release" | "invite";

export type DotaLobbySpec = {
  key: string;
  name: string;
  password: string;
  leagueId: number;
  gameMode: number;
  serverRegion: number;
  radiant: string[];
  dire: string[];
  radiantName: string;
  direName: string;
};

export type DotaLobbyStatus = {
  state:
    | "idle"
    | "creating"
    | "ready"
    | "starting"
    | "started"
    | "blocked"
    | "released";
  lobbyId?: string;
  matchId?: string;
  message?: string;
};

/** The two sides of the bot's Dota lobby, in its spec's order. */
export type LobbySide = "radiant" | "dire";

/**
 * Where a rostered player is in the bot's Dota lobby, in the bot's words: on
 * a side, in the lobby but on no side (where an accepted invite lands them),
 * or not in it.
 */
export const LOBBY_SEATS = ["radiant", "dire", "unassigned", "absent"] as const;
export type LobbySeat = (typeof LOBBY_SEATS)[number];

/**
 * What became of the bot's invite to a player. "sent": the Game Coordinator
 * accepted it, which it also says when the player's Dota blocks party invites
 * from non-friends and shows nothing. "offline": their Dota was closed; it
 * pops up when they open it. "failed": the send threw (Steam dropped).
 */
export const LOBBY_INVITES = ["none", "sent", "offline", "failed"] as const;
export type LobbyInvite = (typeof LOBBY_INVITES)[number];

/** One entry of the bot's `players` reply. Server only: `id` is a Steam64 id. */
export type DotaLobbyBotPlayer = {
  id: string;
  seat: LobbySeat;
  invite: LobbyInvite;
};

/**
 * One rostered player as the server resolved the game: the same pass, and the
 * same playing Steam ids, as the bot spec's sides. Server only.
 */
export type LobbyRosterEntry = {
  name: string;
  side: LobbySide;
  steamId: string;
  /** The viewer who asked. */
  self: boolean;
};

/** The browser's row for one rostered player. It never carries a Steam id. */
export type DotaLobbyPlayerView = {
  name: string;
  side: LobbySide;
  seat: LobbySeat;
  invite: LobbyInvite;
  self: boolean;
};

/**
 * Whom a viewer may ask the bot to invite: everyone missing (a captain or an
 * admin), or only themselves (anyone else on the roster).
 */
export type LobbyInviteScope = "missing" | "self";

export type DotaLobbyView = {
  enabled: boolean;
  canControl: boolean;
  canRelease: boolean;
  name: string;
  password: string;
  leagueId: number;
  radiantName: string;
  direName: string;
  /** `lobbyInviteScope`, as the route decided it for this viewer. */
  inviteScope: LobbyInviteScope | null;
  status: DotaLobbyStatus;
  /**
   * Who of the roster is where. Only from a bot that invites, while its lobby
   * is set up; absent from an older bot or a reply that didn't parse.
   */
  players?: DotaLobbyPlayerView[];
  /** An invite's reply only: how many invites the bot sent. */
  invited?: number;
};

/** The bot reports at most this many players: two sides of ten. */
const MAX_LOBBY_PLAYERS = 20;

/**
 * The bot's `players` reply, read strictly: an array of at most twenty
 * `{ id, seat, invite }` with exactly those keys, a 17-digit Steam64 id each,
 * no id twice. Anything else is unknown (`undefined`, so no list), never a
 * player "not invited".
 */
export function parseBotPlayers(value: unknown): DotaLobbyBotPlayer[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LOBBY_PLAYERS) return undefined;
  const players: DotaLobbyBotPlayer[] = [];
  const ids = new Set<string>();
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return undefined;
    const keys = Object.keys(entry);
    if (
      keys.length !== 3 ||
      !keys.every((k) => k === "id" || k === "seat" || k === "invite")
    )
      return undefined;
    const { id, seat, invite } = entry as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !/^\d{17}$/.test(id) ||
      ids.has(id) ||
      !(LOBBY_SEATS as readonly unknown[]).includes(seat) ||
      !(LOBBY_INVITES as readonly unknown[]).includes(invite)
    )
      return undefined;
    ids.add(id);
    players.push({ id, seat: seat as LobbySeat, invite: invite as LobbyInvite });
  }
  return players;
}

/** The bot's `invited` count: an integer from 0 to 20, else unknown. */
export function parseInvitedCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_LOBBY_PLAYERS
    ? value
    : undefined;
}

/**
 * The browser's list: each rostered player with the bot's seat and invite,
 * matched by Steam id, in roster order, with no Steam id in the output. The
 * bot reports exactly the roster it was sent, so a list that doesn't match it
 * id for id is unknown (`undefined`) rather than half a list.
 */
export function lobbyPlayerViews(
  roster: readonly LobbyRosterEntry[],
  players: readonly DotaLobbyBotPlayer[] | undefined,
): DotaLobbyPlayerView[] | undefined {
  if (!players || roster.length === 0) return undefined;
  const byId = new Map(players.map((p) => [p.id, p]));
  const rosterIds = new Set(roster.map((p) => p.steamId));
  if (
    byId.size !== players.length ||
    byId.size !== rosterIds.size ||
    [...rosterIds].some((id) => !byId.has(id))
  )
    return undefined;
  return roster.map((entry) => {
    const bot = byId.get(entry.steamId)!;
    return {
      name: entry.name,
      side: entry.side,
      seat: bot.seat,
      invite: bot.invite,
      self: entry.self,
    };
  });
}

/**
 * Whom this viewer may ask the bot to invite, or null for nobody. Only a
 * playable game: a captain or an admin re-invites everyone missing; anyone
 * else on the roster asks for their own invite. The route accepts an invite
 * by this, and the panel's two buttons build on it (`reinviteMissingOpen`,
 * `selfInviteOpen`), so a button never shows where the route would refuse.
 */
export function lobbyInviteScope(viewer: {
  canControl: boolean;
  playable: boolean;
  rostered: boolean;
}): LobbyInviteScope | null {
  if (!viewer.playable) return null;
  if (viewer.canControl) return "missing";
  return viewer.rostered ? "self" : null;
}

type InviteControlsView = Pick<DotaLobbyView, "inviteScope" | "players"> & {
  status: Pick<DotaLobbyStatus, "state">;
};

/**
 * "Re-invite missing players": a captain or an admin on a playable game
 * (scope "missing"), the lobby ready, and someone on the roster not in it.
 * The bot invites only while ready and skips anyone already in the lobby.
 */
export function reinviteMissingOpen(view: InviteControlsView): boolean {
  return (
    view.inviteScope === "missing" &&
    view.status.state === "ready" &&
    !!view.players?.some((p) => p.seat === "absent")
  );
}

/**
 * "Send me an invite": a rostered player who is not a captain or an admin, on
 * a playable game (scope "self"), the lobby ready, and their own row absent.
 */
export function selfInviteOpen(view: InviteControlsView): boolean {
  return (
    view.inviteScope === "self" &&
    view.status.state === "ready" &&
    !!view.players?.some((p) => p.self && p.seat === "absent")
  );
}

const ABSENT_ROW = {
  none: () => "Not invited yet",
  sent: () => "Invite sent",
  offline: (self) =>
    `Invite waiting: pops up when ${self ? "you open" : "they open"} Dota`,
  failed: () => "Invite didn't send",
} satisfies Record<LobbyInvite, (self: boolean) => string>;

/** Dota's own names for its lobby's two sides, which is what players see there. */
const DOTA_SIDE = { radiant: "Radiant", dire: "Dire" } as const satisfies Record<
  LobbySide,
  string
>;

/**
 * One row of "Who's in the lobby": where the player is against the side they
 * belong on, in Dota's words (the lobby shows Radiant and Dire; the panel
 * above the list says which team is which). `settled` is a player in their
 * own seat, the only row that needs nothing more.
 */
export function lobbyPlayerRow(
  player: Pick<DotaLobbyPlayerView, "side" | "seat" | "invite" | "self">,
): { text: string; settled: boolean } {
  const own = DOTA_SIDE[player.side];
  switch (player.seat) {
    case "radiant":
    case "dire":
      return player.seat === player.side
        ? { text: `On ${own}`, settled: true }
        : {
            text: `On ${DOTA_SIDE[player.seat]}: belongs on ${own}`,
            settled: false,
          };
    case "unassigned":
      return { text: `In the lobby: needs a ${own} slot`, settled: false };
    case "absent":
      return { text: ABSENT_ROW[player.invite](player.self), settled: false };
  }
}

/**
 * What to do when no invite popup appears. Dota drops invites from
 * non-friends silently when its block is ticked (live test, 2026-10-10), so
 * the player unticks it and then needs a new invite: from the button this
 * viewer has, or from a captain.
 */
export function noPopupHelp(scope: LobbyInviteScope | null): string {
  const again =
    scope === "self"
      ? "then press Send me an invite"
      : scope === "missing"
        ? "then press Re-invite missing players"
        : "then ask a captain to re-invite you";
  return `No popup? Untick “Block party invites from non-friends” in Dota's settings, ${again}, or join through Play → Custom Lobbies with this name and password.`;
}

/**
 * An invite whose answer never came (timed out or lost): it may have reached
 * Dota, so it is unknown, never failed.
 */
export function inviteUnknownToast(scope: LobbyInviteScope): string {
  return scope === "self"
    ? "Your invite may have gone out. Check the list before asking again."
    : "The invites may have gone out. Check the list before sending again.";
}

/**
 * The toast for an invite the bot answered. `players` is the reply's list
 * (undefined when it had none). Nothing sent means everyone is in, or the
 * bot held back a resend: it skips anyone invited in the last 30 seconds or
 * five times already. A count that didn't parse is unknown.
 */
export function inviteResultToast(input: {
  scope: LobbyInviteScope;
  invited: number | undefined;
  players: readonly Pick<DotaLobbyPlayerView, "seat" | "self">[] | undefined;
}): { type: "success" | "info"; message: string } {
  const { scope, invited, players } = input;
  const self = scope === "self";
  if (invited === undefined)
    return { type: "info", message: inviteUnknownToast(scope) };
  if (invited > 0)
    return {
      type: "success",
      message: self
        ? "Invite sent. Accept it in Dota, then take a slot on your side."
        : `Sent ${invited} invite${invited === 1 ? "" : "s"}. Each player accepts theirs in Dota.`,
    };
  const missing = players?.filter(
    (p) => p.seat === "absent" && (!self || p.self),
  );
  if (missing && missing.length === 0)
    return {
      type: "info",
      message: self
        ? "You're already in the lobby."
        : "Everyone is already in the lobby.",
    };
  return {
    type: "info",
    message: self
      ? "No new invite: you had one in the last 30 seconds, or five already. Check Dota, or join with the lobby name and password."
      : "No new invites: everyone missing had one in the last 30 seconds, or five already. They can still join with the lobby name and password.",
  };
}

/** Valve's lobby protocol uses uint32 league IDs; never coerce partial input. */
export function parseLobbyLeagueId(
  value: string | undefined | null,
): number | null {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return id <= 0xffffffff ? id : null;
}

/**
 * Is the lobby bot, online, still holding this game's Dota lobby without
 * having launched it? Then the game can't be over yet (or it was played
 * somewhere else, and the bot still has to be released): every other game's
 * Create answers BUSY until the bot lets go, and its Release works now. Only a
 * definite answer counts — no bot, an unreachable one or a game it never
 * hosted is `null` and never blocks. Nor does "blocked": the bot also reports
 * it whenever it is offline from Steam, when Release can't work either, and
 * admin recovery treats a game marked over as closed and can release it later.
 */
export function botHoldsUnlaunchedLobby(
  status: DotaLobbyStatus | null,
): boolean {
  return (
    status?.state === "creating" ||
    status?.state === "ready" ||
    status?.state === "starting"
  );
}
