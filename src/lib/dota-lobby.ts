/**
 * The three kinds of bot job: a season match, a 5v5 inhouse game and a 1v1
 * mid duel (docs/features/inhouse-duels.md).
 */
export type LobbyKind = "season" | "inhouse" | "duel";
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
  /**
   * In-house games only: each side's players' display names for the bot's
   * lobby chat ("where to sit"), in the same order as `radiant` and `dire`,
   * one per id, each through `lobbyChatName`. Display only: the bot never
   * checks, logs or matches by them, and a season spec has none. An older bot
   * ignores the keys.
   */
  radiantNames?: string[];
  direNames?: string[];
};

/**
 * A Steam persona name is at most 32 characters, so a lobby chat line never
 * needs more of one; it also keeps ten names well inside the bot's 8 KiB
 * request cap.
 */
export const LOBBY_CHAT_NAME_MAX = 32;

/**
 * Characters that would garble a chat line or reorder the text around a name:
 * control characters and the Unicode bidi embeddings, overrides and isolates.
 */
const CHAT_NAME_STRIP = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * A player's name as the bot may say it in Dota lobby chat: the display name
 * the site shows, with control and bidi characters removed, runs of
 * whitespace as one space, at most `LOBBY_CHAT_NAME_MAX` code points (never
 * half of one, though a cut may split a joined emoji such as a flag; the bot
 * cuts shorter anyway), and "Player" when nothing is left.
 */
export function lobbyChatName(name: string | null | undefined): string {
  // Whitespace first: a newline or tab is a control character too, and
  // stripping it would join the words it separated.
  // A stripped character between two spaces would leave both: fold again.
  const clean = (name ?? "")
    .replace(/\s+/gu, " ")
    .replace(CHAT_NAME_STRIP, "")
    .replace(/ {2,}/g, " ")
    .trim();
  const chars = Array.from(clean);
  const capped =
    chars.length > LOBBY_CHAT_NAME_MAX
      ? chars.slice(0, LOBBY_CHAT_NAME_MAX).join("").trimEnd()
      : clean;
  return capped || "Player";
}

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
  /**
   * The bot was asked to leave this game's lobby and hasn't yet: a started
   * game's bot leaves only once Dota shows the game's end. Only when this key
   * is the bot's active claim; absent otherwise (and from an older bot).
   */
  releasing?: true;
  /**
   * Dota showed this game's end, and the game was played (not "not scored").
   * Never for a failed launch; absent otherwise (and from an older bot).
   */
  over?: true;
  /**
   * The bot left this launched game while it still runs (its early leave,
   * docs/DOTA-LOBBY-BOT.md): the game is running and the bot is free for the
   * next one. Only with state `started`; the job keeps its match id, and
   * still reads `over` once Dota shows the game's end. Never a failed launch
   * or the game's end by itself. Absent otherwise (and from a bot that never
   * leaves early, the default).
   */
  left?: true;
};

/**
 * The bot reply's lifecycle flags, read strictly: only the boolean `true`
 * counts. Anything else (absent, "true", 1, false) is unknown, so absent.
 * `left` counts only on a `started` job, the one state the bot sends it with.
 */
export function parseLobbyLifecycle(body: {
  state?: unknown;
  releasing?: unknown;
  over?: unknown;
  left?: unknown;
}): Pick<DotaLobbyStatus, "releasing" | "over" | "left"> {
  return {
    ...(body.releasing === true ? { releasing: true as const } : {}),
    ...(body.over === true ? { over: true as const } : {}),
    ...(body.left === true && body.state === "started"
      ? { left: true as const }
      : {}),
  };
}

/**
 * A Dota lobby or match id as the bot passes Valve's ids through: digits, no
 * leading zero, at most twenty. Anything else is dropped, never shown.
 */
export function parseLobbyDigits(value: unknown): string | undefined {
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value)
    ? value
    : undefined;
}

/**
 * How often the lobby-bot panel re-reads the bot while it sets up a lobby,
 * and while a playable game has no bot lobby yet. The route serves every
 * panel of a game from one short-lived bot read (the status cache in
 * dota-lobby-service.ts), so faster panels don't multiply the bot's reads.
 */
export const LOBBY_PANEL_POLL_MS = 3_000;

/**
 * How often it re-reads once Dota reports the game running: enough to show
 * the game's end (`over`) and a pending release within seconds. The first
 * "started" answer moves the inhouse lobby to IN_PROGRESS (the guarded READY
 * write), and the worker's own bot read does it too, so no tab has to be open.
 */
export const LOBBY_PANEL_STARTED_POLL_MS = 15_000;

/**
 * How often the admin's bot line (/inhouse, "Bot online") re-checks the bot's
 * health while its tab is visible. One admin's tabs only, and loopback on the
 * box, so a fast line costs next to nothing.
 */
export const LOBBY_RECOVERY_POLL_MS = 15_000;

/**
 * The panel's refresh interval for a bot lobby state, or null when it should
 * not refresh at all. With no bot lobby yet (or one the bot let go), a
 * playable game keeps reading at the setup rate: any captain or admin can
 * press Create, and every other panel of the game must see that lobby, its
 * seats and Start without a reload (on 2026-10-17 only the presser's panel
 * moved, so the admins and the other captain never saw a lobby). A game that
 * is no longer playable, or that Dota showed over, has nothing left to wait
 * for.
 *
 * Before the bot has answered there is no state: the first read is still in
 * flight, or it failed (`unanswered`: a bot restarting refuses connections
 * for half a minute). A failed panel tries again at the running-game rate,
 * so it recovers by itself instead of waiting for "Refresh bot status".
 */
export function lobbyPanelPollMs(
  state: DotaLobbyStatus["state"] | undefined,
  playable: boolean,
  over = false,
  unanswered = false,
): number | null {
  if (over) return null;
  if (!state) return unanswered ? LOBBY_PANEL_STARTED_POLL_MS : null;
  if (state === "idle" || state === "released")
    return playable ? LOBBY_PANEL_POLL_MS : null;
  return state === "started" ? LOBBY_PANEL_STARTED_POLL_MS : LOBBY_PANEL_POLL_MS;
}

/**
 * Whether "Who's in the lobby" shows for this bot state: while the lobby is
 * ready and while Dota is starting the game, the two states the bot reports
 * seats in. Only with a list that parsed (`players`).
 */
export function lobbyListVisible(state: DotaLobbyStatus["state"] | undefined) {
  return state === "ready" || state === "starting";
}

/** The panel's status line for each bot state. */
const LOBBY_STATE_LABELS = {
  idle: "No bot lobby yet",
  creating: "Creating lobby…",
  ready: "Lobby ready",
  starting: "Dota is starting the game…",
  started: "Game started",
  blocked: "Lobby needs attention",
  released: "Bot released",
} as const satisfies Record<DotaLobbyStatus["state"], string>;

/**
 * The panel's status line: a pending release first (the bot is still in the
 * lobby, so its state alone would read as if Release did nothing), then a game
 * Dota showed over, then the state's own label.
 */
export function lobbyStatusLabel(
  status: Pick<DotaLobbyStatus, "state" | "releasing" | "over" | "left">,
): string {
  if (status.releasing) return "Leaving the Dota lobby…";
  if (status.over) return "Game over in Dota";
  if (status.left && status.state === "started")
    return "Game running — the bot has left it";
  return LOBBY_STATE_LABELS[status.state];
}

/**
 * The line under a running game the bot has left (`left`): the bot is free
 * for the next game, and the game's end still comes from Dota.
 */
export const LOBBY_LEFT_NOTE =
  "The bot left this running game so it can host the next one. The game is still marked over here once Dota shows its end.";

/** The line under a game Dota showed over. */
export const LOBBY_OVER_NOTE =
  "Game over in Dota — the result records itself from OpenDota.";

/** The line under a pending release. */
export const LOBBY_RELEASING_NOTE =
  "The bot leaves the moment Dota lets it: at once on the lobby screen, or when the game ends. Nothing more to press to free the bot.";

/**
 * "Release bot…": a captain or admin, while the bot holds a lobby (ready,
 * blocked or started), not while a release is already pending (a second
 * press would change nothing), not for a running game the bot has already
 * left (`left`), and not once Dota showed the game over: the
 * bot leaves at the postgame by itself, and a release after that answers
 * that the lobby can't.
 */
export function releaseOpen(
  view: Pick<DotaLobbyView, "canRelease"> & {
    status: Pick<DotaLobbyStatus, "state" | "releasing" | "over" | "left">;
  },
): boolean {
  return (
    view.canRelease &&
    !view.status.releasing &&
    !view.status.over &&
    // A game the bot has left holds nothing to release.
    !view.status.left &&
    (view.status.state === "ready" ||
      view.status.state === "blocked" ||
      view.status.state === "started")
  );
}

/**
 * "Start game with bot": a captain or admin on a playable game
 * (`canControl`), the lobby ready, and no release pending: the bot refuses to
 * start a lobby it is leaving.
 */
export function startOpen(
  view: Pick<DotaLobbyView, "canControl"> & {
    status: Pick<DotaLobbyStatus, "state" | "releasing">;
  },
): boolean {
  return (
    view.canControl && view.status.state === "ready" && !view.status.releasing
  );
}

/**
 * The other game the bot is hosting while this one has no bot lobby, or null.
 * Only while this game's own job is idle or released: once it has a lobby the
 * bot is this game's.
 */
export function lobbyBusyElsewhere(
  view: Pick<DotaLobbyView, "busyElsewhere"> & {
    status: Pick<DotaLobbyStatus, "state">;
  },
): BotBusyElsewhere | null {
  const state = view.status.state;
  return (state === "idle" || state === "released") && view.busyElsewhere
    ? view.busyElsewhere
    : null;
}

/** The status line while the bot is another game's (see lobbyBusyElsewhere). */
export function lobbyBusyLabel(busy: BotBusyElsewhere): string {
  if (busy.duel)
    return busy.unstarted
      ? "The bot is holding a 1v1 lobby that hasn't started"
      : busy.closed
        ? "The bot is still leaving a finished 1v1"
        : "The bot is hosting a 1v1";
  const game = busy.game ? `game ${busy.game}` : "another game";
  return busy.closed
    ? `The bot is still leaving finished ${game}`
    : `The bot is hosting ${game}`;
}

/**
 * A 1v1's line while the bot is another game's: there is no hand-hosted
 * 1v1, and the site asks the bot for this lobby by itself once it is free
 * (the join's create, then the worker's retry each pass).
 */
export const DUEL_BOT_WAITING_NOTE =
  "Waiting for the lobby bot — it makes your lobby as soon as it's free.";

/**
 * The line under it. A game still being played keeps the one bot until the
 * bot leaves it: a few minutes after that game is under way where early
 * leave is on (DOTA-LOBBY-BOT.md#early-leave), else at its end in Dota.
 * Create comes back on this card by itself then (the panel keeps reading),
 * and the card's by-hand steps, unfolded, are for starting sooner. A closed
 * game is freed by this game's Create. A 1v1 is never hosted by hand: it
 * waits for the bot.
 */
export function lobbyBusyNote(
  busy: BotBusyElsewhere,
  canControl: boolean,
  kind: LobbyKind = "inhouse",
): string {
  if (busy.closed)
    return canControl
      ? "Press “Create Dota lobby”: it frees the bot from that game first."
      : "A captain's “Create Dota lobby” frees the bot from that game first.";
  if (kind === "duel") return DUEL_BOT_WAITING_NOTE;
  return "The bot is free again once it leaves that game, usually a few minutes after it starts (or when it ends), and “Create Dota lobby” comes back here then. To start sooner, host this game by hand with the steps on this card.";
}

/**
 * "Create Dota lobby": a captain or admin on a playable game whose job has no
 * lobby, unless the bot is hosting another game still being played (its
 * Create would only answer BUSY). A closed game's hold stays creatable:
 * Create frees the bot from it.
 */
export function createOpen(
  view: Pick<DotaLobbyView, "canControl" | "busyElsewhere"> & {
    status: Pick<DotaLobbyStatus, "state">;
  },
): boolean {
  const busy = lobbyBusyElsewhere(view);
  return (
    view.canControl &&
    (view.status.state === "idle" || view.status.state === "released") &&
    !(busy && !busy.closed)
  );
}

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
  /**
   * The game can still use the bot (an in-house game with its teams locked
   * and not finished; a season match open for play), whoever views it. The
   * panel keeps reading a playable game that has no bot lobby yet.
   */
  playable: boolean;
  status: DotaLobbyStatus;
  /**
   * Who of the roster is where. Only from a bot that invites, while its lobby
   * is set up; absent from an older bot or a reply that didn't parse.
   */
  players?: DotaLobbyPlayerView[];
  /** An invite's reply only: how many invites the bot sent. */
  invited?: number;
  /**
   * The one bot holds ANOTHER game's lobby while this game has none (state
   * idle or released): which game, as players know it (`#1234`, or null for
   * a season match or the other league's game), and whether the site has
   * already closed it. Absent otherwise, or when the bot's health can't be
   * read.
   */
  busyElsewhere?: BotBusyElsewhere;
};

/** See `DotaLobbyView.busyElsewhere`. */
export type BotBusyElsewhere = {
  /** `#1234` for this league's in-house game, null for any other job. */
  game: string | null;
  /** The site closed that game: Create frees the bot from it (BUSY's self-heal). */
  closed: boolean;
  /** That job is one of this league's 1v1s: the panel names "a 1v1". */
  duel?: true;
  /**
   * That 1v1's game hasn't started (READY, no startedAt), and this panel is a
   * 5v5's: the 5v5 comes first, so its Create frees the bot from that lobby
   * (`closed` is true) and the 1v1 waits for the bot again.
   */
  unstarted?: true;
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
  status: Pick<DotaLobbyStatus, "state" | "releasing">;
};

/**
 * "Re-invite missing players": a captain or an admin on a playable game
 * (scope "missing"), the lobby ready with no release pending, and someone on
 * the roster not in it. The bot invites only while ready, refuses a lobby it
 * is leaving, and skips anyone already in the lobby.
 */
export function reinviteMissingOpen(view: InviteControlsView): boolean {
  return (
    view.inviteScope === "missing" &&
    view.status.state === "ready" &&
    !view.status.releasing &&
    !!view.players?.some((p) => p.seat === "absent")
  );
}

/**
 * "Send me an invite": a rostered player who is not a captain or an admin, on
 * a playable game (scope "self"), the lobby ready with no release pending,
 * and their own row absent.
 */
export function selfInviteOpen(view: InviteControlsView): boolean {
  return (
    view.inviteScope === "self" &&
    view.status.state === "ready" &&
    !view.status.releasing &&
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

/**
 * Dota's own names for its lobby's two sides, which is what players see there
 * (the panel's rows and the setup card's "your side" line both use them).
 */
export const DOTA_SIDE = { radiant: "Radiant", dire: "Dire" } as const satisfies Record<
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
 * The viewer's own seat in the bot's seat report: what the setup card's "your
 * side" line is told. Null without a report (an older bot, a reply that
 * didn't parse, a lobby that isn't set up) or for a viewer off the roster.
 */
export function viewerLobbySeat(
  players: readonly Pick<DotaLobbyPlayerView, "seat" | "self">[] | null | undefined,
): LobbySeat | null {
  return players?.find((p) => p.self)?.seat ?? null;
}

/**
 * The in-house panel's line on how the bot keeps the sides right (Tim's call,
 * 2026-10-18): it sends a rostered player on the wrong side, and anyone not in
 * the game who takes a slot, back to unassigned, and may say in Dota's lobby
 * chat who goes where. In-house only: a season lobby's bot moves nobody.
 */
export const INHOUSE_SEAT_RULE_NOTE =
  "The bot moves anyone on the wrong side, and anyone not in this game, back to unassigned, and may post in lobby chat who goes where.";

/** "ten" for a full in-house lobby, else the count itself. */
function seatCount(n: number): string {
  return n === 10 ? "ten" : String(n);
}

/**
 * The seat summary above an in-house panel's buttons while its lobby is ready:
 * how many of the roster sit on their own side, or, once all of them do, the
 * "All ten seated" state. `start` is true only for a viewer who sees "Start
 * game with bot" (`canStart`: `startOpen`, on a panel that may start), whose
 * button it highlights; everyone else is told a captain starts it, so nobody
 * else gets a Start prompt. A 1v1's (kind "duel") says "Both seated" or
 * names whom it waits for (`duelSeatSummary`).
 *
 * Null for a season lobby (scope: in-house games and 1v1s), for a game that is no
 * longer playable (nobody will start it: admin recovery's panel of a closed
 * game), while the lobby isn't ready or a release is pending (the bot refuses
 * Start then), and without a seat list (no bot that invites, or a reply that
 * didn't parse): an unknown seat is never counted as seated or as missing.
 */
export function lobbySeatSummary(input: {
  kind: LobbyKind;
  playable: boolean;
  status: Pick<DotaLobbyStatus, "state" | "releasing"> | undefined;
  players:
    | readonly (Pick<DotaLobbyPlayerView, "side" | "seat"> & { name?: string })[]
    | null
    | undefined;
  canStart: boolean;
}): { allSeated: boolean; start: boolean; text: string } | null {
  const { kind, playable, status, players, canStart } = input;
  if (
    kind === "season" ||
    !playable ||
    status?.state !== "ready" ||
    status.releasing ||
    !players?.length
  )
    return null;
  const total = players.length;
  const seated = players.filter((p) => p.seat === p.side).length;
  if (kind === "duel") return duelSeatSummary(players, canStart);
  if (seated === total)
    return {
      allSeated: true,
      start: canStart,
      text: canStart
        ? `All ${seatCount(total)} seated — press “Start game with bot”.`
        : `All ${seatCount(total)} seated — waiting for a captain to start the game.`,
    };
  return {
    allSeated: false,
    start: false,
    text: canStart
      ? `${seated} of ${total} on their side. Start works once all ${seatCount(total)} are.`
      : `${seated} of ${total} on their side.`,
  };
}

/**
 * A 1v1's seat summary: "Both seated" (Start highlighted for whoever has
 * it: either player or an admin), or whom the lobby still waits for, by name.
 */
function duelSeatSummary(
  players: readonly (Pick<DotaLobbyPlayerView, "side" | "seat"> & { name?: string })[],
  canStart: boolean,
): { allSeated: boolean; start: boolean; text: string } {
  const waiting = players.filter((p) => p.seat !== p.side);
  if (waiting.length === 0)
    return {
      allSeated: true,
      start: canStart,
      text: canStart
        ? "Both seated — press “Start game with bot”."
        : "Both seated — waiting for a player to start the game.",
    };
  const names = waiting.map((p) => p.name || "a player").join(" and ");
  return {
    allSeated: false,
    start: false,
    text: `Waiting for ${names} to sit on their side.`,
  };
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
 * Nor does a release already pending (`releasing`): the bot is leaving on its
 * own, the press releases it again, and a closed game's bot is freed by
 * Create's BUSY self-heal, so nothing is stranded.
 */
export function botHoldsUnlaunchedLobby(
  status: DotaLobbyStatus | null,
): boolean {
  if (status?.releasing) return false;
  return (
    status?.state === "creating" ||
    status?.state === "ready" ||
    status?.state === "starting"
  );
}

/**
 * "Game over"'s refusal while the bot holds the game's lobby unlaunched, or
 * null when it doesn't. A ready lobby names the panel's two buttons, which
 * both show then; while the bot is still creating or starting the lobby
 * neither does, so the copy says to wait instead.
 */
export function botGameOverRefusal(status: DotaLobbyStatus | null): string | null {
  if (!botHoldsUnlaunchedLobby(status)) return null;
  return status?.state === "ready"
    ? "The lobby bot is still holding this game's Dota lobby. A captain can press “Start game with bot” or “Release bot…” in the bot panel, then mark the game over."
    : "The lobby bot is still setting up or starting this game's Dota lobby. Try again in a minute.";
}
