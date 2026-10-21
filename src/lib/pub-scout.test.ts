import { describe, expect, it } from "vitest";
import {
  claimedRoleLean,
  parsePubScout,
  pubLobbyRead,
  pubModeRead,
  pubRegionRead,
  pubRoleRead,
  pubScoutHasReads,
  regionForCluster,
  roleClaimDiffers,
  summarizePubMatches,
  type PubScout,
} from "./pub-scout";

/** A matchmaking game: ranked All Pick, 40 minutes, on US East. */
const game = (over: Record<string, unknown> = {}) => ({
  game_mode: 22,
  lobby_type: 7,
  duration: 40 * 60,
  last_hits: 60, // 1.5 a minute: a support
  average_rank: 63,
  cluster: 122,
  ...over,
});

const times = (n: number, over: Record<string, unknown> = {}) =>
  Array.from({ length: n }, () => game(over));

describe("summarizePubMatches", () => {
  it("reads core and support from last hits a minute, leaving the middle out", () => {
    const s = summarizePubMatches([
      ...times(3, { last_hits: 280 }), // 7 a minute
      ...times(2, { last_hits: 140 }), // exactly 3.5: core
      ...times(4, { last_hits: 99 }), // just under 2.5: support
      ...times(5, { last_hits: 120 }), // 3: neither
    ]);
    expect(s).toMatchObject({ core: 5, support: 4, games: 14 });
  });

  it("judges only matchmaking games of ten minutes or more", () => {
    const s = summarizePubMatches([
      game({ duration: 9 * 60 }), // an abandon
      game({ game_mode: 23 }), // Turbo farms faster
      game({ lobby_type: 1 }), // a practice lobby: an inhouse or league game
      game({ game_mode: 18 }), // Ability Draft
      game(),
    ]);
    expect(s.support).toBe(1);
    expect(s.core).toBe(0);
  });

  it("splits every game in the window by mode", () => {
    const s = summarizePubMatches([
      ...times(5),
      ...times(3, { lobby_type: 0 }),
      ...times(4, { game_mode: 23, lobby_type: 0 }),
      game({ lobby_type: 1 }),
      game({ game_mode: 18, lobby_type: 0 }),
    ]);
    expect(s).toMatchObject({ games: 14, ranked: 5, unranked: 3, turbo: 4 });
    expect(pubModeRead(s)).toEqual([
      { key: "ranked", label: "ranked", games: 5, percent: 36 },
      { key: "turbo", label: "Turbo", games: 4, percent: 29 },
      { key: "unranked", label: "unranked", games: 3, percent: 21 },
      { key: "other", label: "other modes", games: 2, percent: 14 },
    ]);
  });

  it("averages lobby medals as MMR over matchmaking games only", () => {
    // Ancient 3's band is 4158–4311 and Legend 3's 3388–3541: their middles
    // average to 3850. Turbo's lobby never counts.
    const s = summarizePubMatches([
      game({ average_rank: 63 }),
      game({ average_rank: 53 }),
      game({ average_rank: 80, game_mode: 23 }),
      game({ average_rank: null }),
    ]);
    expect(s.lobbyGames).toBe(2);
    expect(s.lobbyMmr).toBe(Math.round((4158 + 77 + (3388 + 77)) / 2));
  });

  it("counts servers by region through the cluster's tens", () => {
    const s = summarizePubMatches([
      ...times(6, { cluster: 122 }),
      ...times(2, { cluster: 129 }), // a new US East cluster
      ...times(3, { cluster: 111 }),
      game({ cluster: 404 }), // unknown: never counted
      game({ cluster: 133, game_mode: 23 }), // Turbo: matchmaking games only
    ]);
    expect(s.regionGames).toBe(11);
    expect(s.regions).toEqual([
      { region: 2, games: 8 },
      { region: 1, games: 3 },
    ]);
    expect(regionForCluster(404)).toBeNull();
    expect(regionForCluster(275)).toBe(3);
  });

  it("survives junk rows: they count toward the window and nothing else", () => {
    const s = summarizePubMatches([
      null,
      "x",
      { game_mode: "22", lobby_type: 7 },
      game(),
    ]);
    expect(s.games).toBe(4);
    expect(s.ranked).toBe(1);
    expect(s.support).toBe(1);
  });

  it("an empty window is all zeros", () => {
    expect(summarizePubMatches([])).toEqual({
      games: 0,
      ranked: 0,
      unranked: 0,
      turbo: 0,
      core: 0,
      support: 0,
      lobbyMmr: null,
      lobbyGames: 0,
      regions: [],
      regionGames: 0,
    });
  });
});

const scout = (over: Partial<PubScout> = {}): PubScout => ({
  games: 100,
  ranked: 90,
  unranked: 6,
  turbo: 4,
  core: 10,
  support: 70,
  lobbyMmr: 4180,
  lobbyGames: 90,
  regions: [
    { region: 2, games: 75 },
    { region: 1, games: 20 },
    { region: 3, games: 5 },
  ],
  regionGames: 100,
  ...over,
});

describe("the reads", () => {
  it("names the side they mostly play, or both", () => {
    expect(pubRoleRead(scout())).toMatchObject({
      lean: "support",
      label: "Mostly support",
      percent: 88,
    });
    expect(pubRoleRead(scout({ core: 70, support: 10 }))).toMatchObject({
      lean: "core",
      percent: 88,
    });
    expect(pubRoleRead(scout({ core: 40, support: 40 }))).toMatchObject({
      lean: "both",
      label: "Core and support",
    });
  });

  it("shows nothing below ten games", () => {
    const thin = scout({
      games: 9,
      core: 5,
      support: 4,
      lobbyGames: 9,
      regionGames: 9,
    });
    expect(pubRoleRead(thin)).toBeNull();
    expect(pubLobbyRead(thin)).toBeNull();
    expect(pubModeRead(thin)).toBeNull();
    expect(pubRegionRead(thin)).toBeNull();
    expect(pubScoutHasReads(thin)).toBe(false);
    expect(pubScoutHasReads(null)).toBe(false);
    expect(pubScoutHasReads(scout())).toBe(true);
  });

  it("rounds the lobby to 50 MMR and names its medal", () => {
    expect(pubLobbyRead(scout())).toEqual({
      mmr: 4200,
      rankTier: 63,
      games: 90,
    });
    expect(pubLobbyRead(scout({ lobbyMmr: null, lobbyGames: 0 }))).toBeNull();
  });

  it("lists the main server and any with a fifth of games", () => {
    expect(pubRegionRead(scout())).toEqual([
      { region: 2, name: "US East", percent: 75 },
      { region: 1, name: "US West", percent: 20 },
    ]);
  });

  it("sets the read beside the signup's side", () => {
    expect(claimedRoleLean(["4", "5"])).toBe("support");
    expect(claimedRoleLean(["1", "2"])).toBe("core");
    expect(claimedRoleLean(["3", "4"])).toBe("both");
    expect(claimedRoleLean([])).toBeNull();
    const support = pubRoleRead(scout());
    const both = pubRoleRead(scout({ core: 40, support: 40 }));
    expect(roleClaimDiffers("core", support)).toBe(true);
    expect(roleClaimDiffers("support", support)).toBe(false);
    expect(roleClaimDiffers("both", support)).toBe(false);
    expect(roleClaimDiffers("core", both)).toBe(false);
    expect(roleClaimDiffers(null, support)).toBe(false);
  });
});

describe("parsePubScout", () => {
  it("round-trips the stored counts", () => {
    const s = scout();
    expect(parsePubScout(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("reads junk as unknown and drops bad regions", () => {
    expect(parsePubScout(null)).toBeNull();
    expect(parsePubScout("x")).toBeNull();
    expect(parsePubScout({ ranked: 3 })).toBeNull();
    expect(
      parsePubScout({
        ...scout(),
        lobbyMmr: -5,
        regions: [{ region: 2, games: 3 }, { region: "x" }, null],
      }),
    ).toMatchObject({
      lobbyMmr: null,
      lobbyGames: 0,
      regions: [{ region: 2, games: 3 }],
    });
  });
});
