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
