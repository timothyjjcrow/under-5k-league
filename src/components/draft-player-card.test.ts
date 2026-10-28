import { describe, expect, it } from "vitest";
import {
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";
import { NO_DISCORD_TITLE, PUB_QUIET_TITLE } from "@/lib/player-pool";

// SOURCE GUARDS for the draft room's scouting cards (draft-player-card.tsx,
// src/lib/draft-scout.ts). What they protect is invisible to a unit test:
// where the cards render relative to the bid controls, that the card stays
// presentational, and that the scouting reaches the room from the page
// render and never from the poll every tab in the room repeats.

const room = () =>
  stripLineComments(sourceFile("src/components/draft-room.tsx").text);
const card = () =>
  stripLineComments(sourceFile("src/components/draft-player-card.tsx").text);

/** Every index of `needle` in `text`. */
function indexesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    out.push(i);
  }
  return out;
}

describe("draft-room.tsx renders the cards where they move nothing", () => {
  it("one card on the block, below the bid controls, and one in the pool", () => {
    const src = room();
    const cards = indexesOf(src, "<DraftPlayerCard");
    expect(cards).toHaveLength(2);
    const live = src.indexOf("const lotStale");
    const zone = src.indexOf("ref={bannerRef}", live);
    const zoneEnd = src.indexOf("paused the auction", zone);
    const primer = src.indexOf("<AuctionPrimer", zoneEnd);
    expect(live).toBeGreaterThan(-1);
    expect(zone).toBeGreaterThan(live);
    expect(zoneEnd).toBeGreaterThan(zone);
    expect(primer).toBeGreaterThan(zoneEnd);
    // The lot card sits after the action zone (whose height must not change
    // between polls) and before the primer; the bid trail comes after it.
    const [lotCard, poolCard] = cards;
    expect(lotCard).toBeGreaterThan(zoneEnd);
    expect(lotCard).toBeLessThan(primer);
    expect(src.indexOf("Bid trail:", lotCard)).toBeGreaterThan(lotCard);
    expect(src.indexOf("Bid trail:", lotCard)).toBeLessThan(primer);
    // The pool card belongs to the Available list.
    const list = src.indexOf("function AvailableList(");
    const listEnd = src.indexOf("\nfunction ", list + 1);
    expect(poolCard).toBeGreaterThan(list);
    expect(poolCard).toBeLessThan(listEnd);
  });

  it("the pool keeps picks and opened rows apart, through the tested helpers", () => {
    const src = room();
    const list = src.slice(
      src.indexOf("function AvailableList("),
      src.indexOf("\nfunction RecentSales("),
    );
    expect(list).toContain("aria-pressed={selected === p.userId}");
    expect(list).toContain("aria-expanded={open}");
    for (const helper of [
      "poolPanelOpenId(",
      "toggleInspected(",
      "inspectedAfterChange(",
      "poolTapHint(",
    ]) {
      expect(list).toContain(helper);
    }
    // A watcher's tap opens a card and never lines up a pick.
    const watcherRow = list.slice(
      list.indexOf("canInspect ? ("),
      list.indexOf(") : (", list.indexOf("canInspect ? (")),
    );
    expect(watcherRow).toContain("setInspected(toggleInspected(");
    expect(watcherRow).not.toContain("onPick(");
  });

  it("the lot card gets the nominee's live favorites and about text", () => {
    const src = room();
    const lotCard = src.slice(
      src.indexOf("<DraftPlayerCard"),
      src.indexOf("/>", src.indexOf("<DraftPlayerCard")),
    );
    expect(lotCard).toContain('variant="lot"');
    expect(lotCard).toContain("favoriteHeroes: state.nominatedPlayer.favoriteHeroes");
    expect(lotCard).toContain("about: nominatedAbout");
    expect(lotCard).toContain("nowMs={state.now}");
  });

  it("both cards follow one per-viewer choice, compact until they open it", () => {
    const src = room();
    // Kept in the viewer's browser, compact by default: the pool stays on a
    // phone's first screen until a viewer asks for the full card.
    expect(src).toContain(
      'const [scoutFull, setScoutFull] = usePersistedFlag("draftScoutFull", false);',
    );
    const cards = indexesOf(src, "<DraftPlayerCard");
    const props = cards.map((at) => src.slice(at, src.indexOf("/>", at)));
    expect(props[0]).toContain("full={scoutFull}");
    expect(props[0]).toContain("onFullChange={setScoutFull}");
    expect(props[1]).toContain("full={scoutFull}");
    expect(props[1]).toContain("onFullChange={onScoutFullChange}");
    expect(src).toContain("onScoutFullChange={setScoutFull}");
  });

  it("'no Discord' shows only to a viewer allowed the contact", () => {
    const src = room();
    expect(src).toMatch(
      /state\.nominatedPlayer\.showContact &&\s*!state\.nominatedPlayer\.discordName \?/,
    );
    expect(src).toContain("title={NO_DISCORD_TITLE}");
  });
});

describe("draft-room.tsx lays desktop out in two columns from the top", () => {
  // The lot and then the teams on the left, the feed above the pool on the
  // right (Tim, 2026-10-27). One grid, placed by class, so a phone keeps the
  // viewer's DOM order.
  it("the lot spans the top two rows of the left two thirds", () => {
    const src = room();
    expect(
      indexesOf(src, "lg:grid-cols-3 lg:grid-rows-[auto_auto_auto_1fr]"),
    ).toHaveLength(1);
    const grid = src.indexOf("lg:grid-rows-[auto_auto_auto_1fr]");
    const lot = src.indexOf("{/* On the block */}");
    expect(lot).toBeGreaterThan(grid);
    expect(src.slice(lot, src.indexOf("ref={bannerRef}", lot))).toContain(
      "lg:col-span-2 lg:col-start-1 lg:row-span-2 lg:row-start-1",
    );
    // The primer, then the teams, below it on the left.
    const primer = src.indexOf("<AuctionPrimer", lot);
    expect(src.slice(src.lastIndexOf("<div", primer), primer)).toContain(
      "lg:col-span-2 lg:col-start-1 lg:row-start-3",
    );
    const rosters = src.slice(
      src.indexOf('key="rosters"'),
      src.indexOf("<TeamsGrid", src.indexOf('key="rosters"')),
    );
    expect(rosters).toContain("lg:col-span-2 lg:col-start-1 lg:row-start-4");
  });

  it("the feed sits top right, the pool under it, pinned while the teams scroll", () => {
    const src = room();
    const feed = src.slice(
      src.indexOf('key="feed"'),
      src.indexOf("<RecentSales", src.indexOf('key="feed"')),
    );
    expect(feed).toContain("lg:col-start-3 lg:row-start-1");
    const pool = src.slice(
      src.indexOf('key="pool"'),
      src.indexOf("<AvailableList", src.indexOf('key="pool"')),
    );
    // Rows 2-4, so it starts under the feed however tall the lot is, and
    // clears the 64px header and the 44px clock bar.
    expect(pool).toContain(
      "lg:sticky lg:top-[7.5rem] lg:col-start-3 lg:row-span-3 lg:row-start-2",
    );
    // Its list is sized to the window, so a 720px laptop shows all of it.
    expect(src).toContain("lg:max-h-[max(16rem,calc(100dvh_-_19.5rem))]");
  });

  it("a phone keeps the viewer's order: the pool first for a captain or admin", () => {
    const src = room();
    expect(src).toContain(
      "return watcher ? [feed, rosters, pool] : [pool, feed, rosters];",
    );
  });
});

describe("draft-player-card.tsx is presentational", () => {
  it("draws what draftCardView decides, with the profile's tiles", () => {
    const src = card();
    expect(src).toContain("draftCardView(");
    expect(src).toContain("<ScoutTileGrid");
    expect(src).toContain("<PubRecentHeroes");
  });

  it("shows the record line, tiles and findings only in the full card", () => {
    const src = card();
    const record = src.indexOf("{showFull && view.record.length > 0 ? (");
    const tiles = src.indexOf("{showFull && view.caption ? (");
    const fullBody = src.indexOf("{showFull ? (", tiles);
    const compactBody = src.indexOf(") : (", fullBody);
    for (const at of [record, tiles, fullBody, compactBody]) {
      expect(at).toBeGreaterThan(-1);
    }
    // The compact body is the segmented strip, in the profile's tones.
    const strip = src.indexOf("view.segments.map(");
    expect(strip).toBeGreaterThan(compactBody);
    expect(src.slice(compactBody)).toContain("SCOUT_TONE[seg.tone].spoken");
    expect(src.indexOf("<ScoutTileGrid")).toBeGreaterThan(tiles);
    expect(src.indexOf("<ScoutTileGrid")).toBeLessThan(fullBody);
    // "More scouting" sits in the full body, not the compact one.
    const more = src.indexOf("More scouting:");
    expect(more).toBeGreaterThan(fullBody);
    expect(more).toBeLessThan(compactBody);
    // One toggle, drawn only when the full card shows more.
    expect(src).toContain("const toggle = view.hasMore ? (");
    expect(src).toContain("aria-expanded={full}");
  });

  it("holds no state, request, bell, contact or link", () => {
    const src = card();
    for (const banned of [
      "fetch(",
      "playChime",
      "issueSequence",
      "useEffect",
      "useState",
      "DiscordTag",
      "<a ",
      "<Link",
      'id="',
      "totalGames",
      "computed_mmr",
    ]) {
      expect(src, banned).not.toContain(banned);
    }
  });
});

describe("the scouting reaches the room from the page, never the poll", () => {
  it("/draft loads the map only while the auction runs, and passes it in", () => {
    const src = stripLineComments(sourceFile("src/app/draft/page.tsx").text);
    expect(indexesOf(src, "loadDraftScoutInfo(")).toHaveLength(1);
    expect(src).toMatch(
      /draftScoutWanted\(status\) \? loadDraftScoutInfo\(season\) : null/,
    );
    expect(src).toContain("scout={scout}");
  });

  it("the draft engine never reads the pub snapshots", () => {
    // Every tick reply goes to every tab in the room: the snapshots are
    // read once per page render (draft-scout-service.ts) instead.
    expect(sourceFile("src/lib/draft-service.ts").text).not.toContain(
      "pubStats",
    );
  });
});

describe("the shared pieces stay shared", () => {
  it("the profile card is built from the extracted pieces", () => {
    const src = stripLineComments(
      sourceFile("src/components/profile-pub-scouting.tsx").text,
    );
    const profile = src.slice(
      src.indexOf("export function ProfilePubScouting("),
      src.indexOf("export function ScoutTileGrid("),
    );
    expect(profile).toContain("<ScoutTileGrid tiles={tiles} />");
    expect(profile).toContain("<PubRecentHeroes scout={scout} />");
    expect(profile).toContain("<PubRoleAverageLines scout={scout} />");
    expect(profile).toContain("pubScoutCaption(");
  });

  it("the pool's hover texts are written once, in player-pool.ts", () => {
    const ui = sourceFiles(
      ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
      100,
    );
    for (const literal of [PUB_QUIET_TITLE, NO_DISCORD_TITLE]) {
      expect(
        ui.filter((f) => f.text.includes(literal)).map((f) => f.path),
      ).toEqual([]);
    }
  });
});
