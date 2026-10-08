import { describe, expect, it } from "vitest";
import { heroPageView, type HeroPageGame } from "./hero-games";
import { heroMeta, metaLines, toMetaGame } from "./hero-meta";
import { decodeGamePlayers } from "./player-stats";
import { HEROES } from "./heroes";

const KNOWN = new Set(HEROES.map((hero) => hero.id));
// Ten real hero ids: radiant 1-5, dire 6-10.
const HERO_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const HOME = { id: "team-home", name: "Home Team" };
const AWAY = { id: "team-away", name: "Away Team" };

type LineOverrides = Record<string, unknown>;

/** A complete 5v5 box score; radiant is the home team. */
function boxScore(overrides: Record<number, LineOverrides> = {}, heroIds = HERO_IDS) {
  return JSON.stringify(
    heroIds.map((heroId, index) => ({
      accountId: 100 + index,
      heroId,
      isRadiant: index < 5,
      kills: 5,
      deaths: 2,
      assists: 7,
      personaname: `Player ${index}`,
      gpm: 500,
      netWorth: 15_000,
      lastHits: 150,
      userId: `user-${index}`,
      teamId: index < 5 ? HOME.id : AWAY.id,
      items: [1, 0, 63, 0, 0, 0],
      backpack: [0, 0, 0],
      neutral: null,
      neutralEnchantment: null,
      ...overrides[heroId],
    })),
  );
}

function game(id: string, overrides: Partial<HeroPageGame> = {}): HeroPageGame {
  return {
    id,
    matchId: `match-${id}`,
    startTime: 1_000,
    durationSecs: 2_400,
    radiantWin: true,
    players: boxScore(),
    week: 1,
    homeTeam: HOME,
    awayTeam: AWAY,
    ...overrides,
  };
}

describe("heroPageView", () => {
  it("lists the hero's games newest first, the id breaking a tie", () => {
    const view = heroPageView(1, [
      game("b", { startTime: 2_000 }),
      game("c", { startTime: 3_000 }),
      game("a", { startTime: 2_000 }),
    ], KNOWN);
    expect(view.rows.map((row) => row.gameId)).toEqual(["c", "a", "b"]);
  });

  it("reads the player's line, result, team and opponent", () => {
    const view = heroPageView(7, [game("g", { radiantWin: true })], KNOWN);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      matchId: "match-g",
      won: false,
      kills: 5,
      deaths: 2,
      assists: 7,
      userId: "user-6",
      team: AWAY,
      opponent: HOME,
      items: [1, 0, 63, 0, 0, 0],
    });
  });

  it("leaves team and opponent unknown for an unattributed line", () => {
    const players = boxScore({ 1: { teamId: null, userId: null } });
    const [row] = heroPageView(1, [game("g", { players })], KNOWN).rows;
    expect(row.team).toBeNull();
    expect(row.opponent).toBeNull();
    expect(row.personaname).toBe("Player 0");
  });

  it("counts only the games /meta counts, with /meta's own numbers", () => {
    const games = [
      game("won", { radiantWin: true }),
      game("lost", { radiantWin: false }),
      // Incomplete box score: nine lines.
      game("partial", { players: JSON.stringify(JSON.parse(boxScore()).slice(0, 9)) }),
      // An unknown hero drops the whole game.
      game("unknown", { players: boxScore({}, [1, 2, 3, 4, 5, 6, 7, 8, 9, 9_999]) }),
    ];
    const view = heroPageView(1, games, KNOWN);
    expect(view.rows.map((row) => row.gameId).sort()).toEqual(["lost", "won"]);
    const metaRow = heroMeta(
      games
        .map((g) => toMetaGame(g.radiantWin, metaLines(decodeGamePlayers(g.players), KNOWN)))
        .filter((g) => g.lines.length > 0),
    ).rows.find((row) => row.heroId === 1);
    expect(view.meta).toEqual(metaRow);
    expect(view.meta).toMatchObject({ picks: 2, wins: 1, losses: 1, winRate: 50 });
    expect(view.countedGames).toBe(2);
  });

  it("has no row and no meta for a hero nobody picked", () => {
    const view = heroPageView(50, [game("g")], KNOWN);
    expect(view.meta).toBeNull();
    expect(view.rows).toEqual([]);
    expect(view.items).toEqual([]);
    expect(view.countedGames).toBe(1);
  });

  it("tallies finished shop items once per game, leaving out consumables and recipes", () => {
    const view = heroPageView(1, [
      game("a", {
        radiantWin: true,
        // Blink twice, Power Treads, a Tango (consumable), Ghost Scepter in the backpack.
        players: boxScore({ 1: { items: [1, 1, 63, 44, 0, 0], backpack: [37, 0, 0] } }),
      }),
      game("b", {
        radiantWin: false,
        // Observer Ward (consumable) and Blink.
        players: boxScore({ 1: { items: [42, 1, 0, 0, 0, 0] } }),
      }),
    ], KNOWN);
    expect(view.itemGames).toBe(2);
    expect(view.items).toEqual([
      { itemId: 1, games: 2, wins: 1 },
      { itemId: 37, games: 1, wins: 1 },
      { itemId: 63, games: 1, wins: 1 },
    ]);
  });

  it("tallies only games whose items are stored", () => {
    const legacy = JSON.stringify(
      JSON.parse(boxScore()).map((line: Record<string, unknown>) => {
        const copy = { ...line };
        delete copy.items;
        delete copy.backpack;
        delete copy.neutral;
        delete copy.neutralEnchantment;
        return copy;
      }),
    );
    const view = heroPageView(1, [game("old", { players: legacy }), game("new")], KNOWN);
    expect(view.rows).toHaveLength(2);
    expect(view.rows.find((row) => row.gameId === "old")?.items).toBeNull();
    expect(view.itemGames).toBe(1);
    expect(view.items.find((row) => row.itemId === 1)?.games).toBe(1);
  });

  it("tallies the neutral slot apart from the shop items", () => {
    const neutralId = 1604;
    const view = heroPageView(1, [
      game("a", { players: boxScore({ 1: { neutral: neutralId, neutralEnchantment: 1583 } }) }),
      game("b", { players: boxScore({ 1: { neutral: neutralId } }) }),
    ], KNOWN);
    expect(view.neutrals).toEqual([{ itemId: neutralId, games: 2, wins: 2 }]);
    expect(view.items.some((row) => row.itemId === neutralId || row.itemId === 1583)).toBe(false);
  });

  it("ranks the hero's league players by games, then wins", () => {
    const view = heroPageView(1, [
      game("a", { radiantWin: true, players: boxScore({ 1: { userId: "user-z" } }) }),
      game("b", { radiantWin: false, players: boxScore({ 1: { userId: "user-z" } }) }),
      game("c", { radiantWin: true, players: boxScore({ 1: { userId: "user-y" } }) }),
      game("d", { radiantWin: true, players: boxScore({ 1: { userId: null } }) }),
    ], KNOWN);
    expect(view.players).toEqual([
      { userId: "user-z", games: 2, wins: 1 },
      { userId: "user-y", games: 1, wins: 1 },
    ]);
  });
});
