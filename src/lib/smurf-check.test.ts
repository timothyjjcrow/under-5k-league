import { describe, expect, it } from "vitest";
import { sourceFile, stripLineComments } from "../../test/support/source-files";
import type { PubScout } from "./pub-scout";
import { PUB_SCOUT_VERSION } from "./pub-scout";
import type { PubStats } from "./pub-stats";
import {
  parseSmurfSignals,
  serializeSmurfSignals,
  smurfInhouseRefusal,
  smurfMinGames,
  smurfRefusesInhouse,
  smurfRefusesSignup,
  smurfSignalPhrase,
  smurfSignals,
  smurfSignalsFromStored,
  smurfSignupRefusal,
  smurfSuggestedMmr,
  type SmurfSignal,
} from "./smurf-check";

function scout(over: Partial<PubScout> = {}): PubScout {
  return {
    v: PUB_SCOUT_VERSION,
    games: 100,
    firstAt: 1_790_000_000,
    lastAt: 1_793_000_000,
    ranked: 90,
    unranked: 5,
    turbo: 5,
    recentWins: 10,
    recentLosses: 10,
    form: "WLWLWLWLWL",
    core: 40,
    support: 40,
    coreAverages: null,
    supportAverages: null,
    positions: [8, 8, 8, 8, 8],
    partyKnown: 90,
    party: 10,
    abandons: 0,
    lobbyMmr: null,
    lobbyGames: 0,
    lobbyRanked: false,
    regions: [],
    regionGames: 0,
    heroes: [],
    heroCount: 30,
    ...over,
  };
}

function pub(over: Partial<PubStats> = {}, scoutOver?: Partial<PubScout>): PubStats {
  return {
    recentWins: 50,
    recentLosses: 50,
    totalGames: 3000,
    lastPlayedAt: 1_793_000_000,
    topHeroes: [],
    scout: scout(scoutOver),
    ...over,
  };
}

const keys = (signals: SmurfSignal[]) => signals.map((s) => s.key);

describe("smurfMinGames — the games an account should have for its medal", () => {
  it("expects more games the higher the medal", () => {
    expect(smurfMinGames(null)).toBe(150);
    expect(smurfMinGames(0)).toBe(150);
    expect(smurfMinGames(45)).toBe(150);
    expect(smurfMinGames(51)).toBe(300);
    expect(smurfMinGames(65)).toBe(500);
    expect(smurfMinGames(72)).toBe(800);
    expect(smurfMinGames(80)).toBe(800);
  });
});

describe("smurfSignals — what the check finds", () => {
  it("finds nothing on an ordinary account", () => {
    expect(smurfSignals({ pub: pub(), rankTier: 55 })).toEqual([]);
  });

  it("finds nothing when nothing is known: no snapshot, or no visible games", () => {
    expect(smurfSignals({ pub: null, rankTier: 55 })).toEqual([]);
    expect(
      smurfSignals({
        pub: pub({ totalGames: 0, recentWins: 0, recentLosses: 0, scout: null }),
        rankTier: 55,
      }),
    ).toEqual([]);
    expect(smurfSignalsFromStored(null, 55)).toEqual([]);
    expect(smurfSignalsFromStored("{not json", 55)).toEqual([]);
  });

  it("flags a brand-new account whatever its medal", () => {
    // The shape of a calibration suspect: 99 games at Crusader 5.
    const found = smurfSignals({ pub: pub({ totalGames: 99 }), rankTier: 35 });
    expect(found).toEqual([
      {
        key: "young-account",
        line: "only 99 games on the account, few for a Crusader 5 medal",
      },
    ]);
    expect(smurfSignals({ pub: pub({ totalGames: 34 }), rankTier: null })[0].line).toBe(
      "only 34 games on the account",
    );
    expect(smurfSignals({ pub: pub({ totalGames: 150 }), rankTier: 35 })).toEqual([]);
  });

  it("flags a young account already at a high medal", () => {
    // 190 games at Legend 5, 363 at Divine 2: both called obvious by a
    // review before the check existed.
    expect(keys(smurfSignals({ pub: pub({ totalGames: 190 }), rankTier: 55 }))).toEqual([
      "young-account",
    ]);
    expect(keys(smurfSignals({ pub: pub({ totalGames: 363 }), rankTier: 72 }))).toEqual([
      "young-account",
    ]);
    // The same counts at a medal they fit say nothing.
    expect(smurfSignals({ pub: pub({ totalGames: 302 }), rankTier: 55 })).toEqual([]);
    expect(smurfSignals({ pub: pub({ totalGames: 190 }), rankTier: 44 })).toEqual([]);
  });

  it("flags 17 or more wins in the newest 20 matchmaking games", () => {
    const hot = smurfSignals({
      pub: pub({}, { recentWins: 17, recentLosses: 3 }),
      rankTier: 55,
    });
    expect(hot).toEqual([
      { key: "win-streak", line: "won 17 of the last 20 matchmaking games" },
    ]);
    // 16-4, the hottest any stored account was (a veteran's), says nothing.
    expect(smurfSignals({ pub: pub({}, { recentWins: 16, recentLosses: 4 }), rankTier: 55 })).toEqual([]);
    // A short window can't be a streak of 20.
    expect(smurfSignals({ pub: pub({}, { recentWins: 17, recentLosses: 0 }), rankTier: 55 })).toEqual([]);
  });

  it("flags ranked lobbies a whole medal above theirs, played mostly solo", () => {
    const lobby = { lobbyMmr: 4600, lobbyGames: 40, lobbyRanked: true };
    // Legend 5's middle is 3,773: 4,600 is about 850 over, under the line.
    expect(smurfSignals({ pub: pub({}, lobby), rankTier: 55 })).toEqual([]);
    // Legend 3's middle is 3,465: about 1,150 over.
    expect(smurfSignals({ pub: pub({}, lobby), rankTier: 53 })).toEqual([
      {
        key: "lobby-above-medal",
        line: "ranked games average about 4,600 MMR, 1,150 above a Legend 3 medal",
      },
    ]);
    // A party's lobby says more about the party.
    expect(
      smurfSignals({ pub: pub({}, { ...lobby, partyKnown: 40, party: 30 }), rankTier: 53 }),
    ).toEqual([]);
    // Unranked lobbies, too few games, or no medal: not judged.
    expect(smurfSignals({ pub: pub({}, { ...lobby, lobbyRanked: false }), rankTier: 53 })).toEqual([]);
    expect(smurfSignals({ pub: pub({}, { ...lobby, lobbyGames: 9 }), rankTier: 53 })).toEqual([]);
    expect(smurfSignals({ pub: pub({}, lobby), rankTier: null })).toEqual([]);
  });

  it("reads every finding at once", () => {
    const found = smurfSignals({
      pub: pub(
        { totalGames: 120 },
        { recentWins: 18, recentLosses: 2, lobbyMmr: 4600, lobbyGames: 40, lobbyRanked: true },
      ),
      rankTier: 53,
    });
    expect(keys(found)).toEqual(["young-account", "win-streak", "lobby-above-medal"]);
    expect(smurfSignalPhrase(found)).toBe(
      "only 120 games on the account, few for a Legend 3 medal; won 18 of the last 20 matchmaking games and ranked games average about 4,600 MMR, 1,150 above a Legend 3 medal",
    );
  });
});

describe("where the check stops a player", () => {
  const found: SmurfSignal[] = [{ key: "young-account", line: "only 99 games on the account" }];

  it("refuses a signup at admission only, unless an admin approved the account", () => {
    expect(smurfRefusesSignup({ signals: found, existingStatus: null, approved: false })).toBe(true);
    expect(smurfRefusesSignup({ signals: found, existingStatus: "WITHDRAWN", approved: false })).toBe(true);
    expect(smurfRefusesSignup({ signals: found, existingStatus: "REMOVED", approved: false })).toBe(true);
    expect(smurfRefusesSignup({ signals: found, existingStatus: "ACTIVE", approved: false })).toBe(false);
    expect(smurfRefusesSignup({ signals: found, existingStatus: null, approved: true })).toBe(false);
    expect(smurfRefusesSignup({ signals: [], existingStatus: null, approved: false })).toBe(false);
  });

  it("refuses a first inhouse only", () => {
    const base = { signals: found, playedInhouse: false, approved: false, adminMmr: null };
    expect(smurfRefusesInhouse(base)).toBe(true);
    expect(smurfRefusesInhouse({ ...base, playedInhouse: true })).toBe(false);
    expect(smurfRefusesInhouse({ ...base, approved: true })).toBe(false);
    // An admin who set their inhouse MMR has already chosen their number.
    expect(smurfRefusesInhouse({ ...base, adminMmr: 3800 })).toBe(false);
    expect(smurfRefusesInhouse({ ...base, signals: [] })).toBe(false);
  });

  it("says what it found and where to ask", () => {
    expect(smurfSignupRefusal(found)).toBe(
      "New signups get a smurf check, and yours needs an admin to look first: only 99 games on the account. Ask on this page, and an admin will set the MMR you play at.",
    );
    expect(smurfInhouseRefusal(found)).toMatch(/before your first game: only 99 games on the account\. Ask on My account/);
  });
});

describe("the stored findings", () => {
  it("round-trips, and reads garbage as none", () => {
    const found: SmurfSignal[] = [
      { key: "win-streak", line: "won 17 of the last 20 matchmaking games" },
    ];
    expect(parseSmurfSignals(serializeSmurfSignals(found))).toEqual(found);
    expect(serializeSmurfSignals([])).toBe("");
    expect(parseSmurfSignals("")).toEqual([]);
    expect(parseSmurfSignals("nope")).toEqual([]);
    expect(parseSmurfSignals('[{"key":"made-up","line":"x"},{"key":"win-streak"}]')).toEqual([]);
  });
});

describe("smurfSuggestedMmr — the Approve box's start", () => {
  it("starts where their ranked lobbies put them, when that is above the medal's floor", () => {
    const lobby = { lobbyMmr: 4580, lobbyGames: 40, lobbyRanked: true };
    expect(smurfSuggestedMmr({ pub: pub({}, lobby), medalFloor: 3388 })).toBe(4600);
    expect(smurfSuggestedMmr({ pub: pub({}, lobby), medalFloor: 4620 })).toBe(4620);
    expect(smurfSuggestedMmr({ pub: pub(), medalFloor: 3388 })).toBe(3388);
    expect(smurfSuggestedMmr({ pub: null, medalFloor: null })).toBeNull();
  });
});

describe("source guards", () => {
  it("makes no OpenDota call: the gates read the stored snapshot", () => {
    const check = stripLineComments(sourceFile("src/lib/smurf-check.ts").text);
    expect(check).not.toMatch(/\bfetch\(|from "\.\/dota"/);
  });

  it("judges a signup after the medal gate, from the stored snapshot", () => {
    const action = stripLineComments(sourceFile("src/app/actions/registration.ts").text);
    const gate = action.indexOf("const gateError = registrationGate(");
    const smurf = action.indexOf("smurfRefusesSignup(");
    expect(gate).toBeGreaterThan(0);
    expect(smurf).toBeGreaterThan(gate);
    expect(action).toMatch(/smurfSignalsFromStored\(dbUser\?\.pubStats, rankTier\)/);
  });

  it("judges every inhouse join, 5v5 and 1v1, through the one join rule", () => {
    const service = stripLineComments(sourceFile("src/lib/inhouse-service.ts").text);
    expect(service).toMatch(/smurfSignalsFromStored\(user\?\.pubStats, user\?\.rankTier\)/);
    const join = service.slice(service.indexOf("export async function joinQueue("));
    expect(join).toMatch(/smurf: \{\s*signals: smurfSignals,/);
    const duel = stripLineComments(sourceFile("src/lib/inhouse-duel-service.ts").text);
    expect(duel).toMatch(/inhouseJoinRefusalBeforeTyping\(await loadInhouseJoinFacts\(userId\)\)/);
  });
});
