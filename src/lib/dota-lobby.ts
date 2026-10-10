export type LobbyKind = "season" | "inhouse";
export type LobbyAction = "create" | "start" | "release";

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

export type DotaLobbyView = {
  enabled: boolean;
  canControl: boolean;
  canRelease: boolean;
  name: string;
  password: string;
  leagueId: number;
  radiantName: string;
  direName: string;
  status: DotaLobbyStatus;
};

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
