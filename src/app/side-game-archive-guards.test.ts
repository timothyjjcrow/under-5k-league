import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two side games — fantasy and pick'em — must stay browsable for ARCHIVED
 * seasons, and must be structurally read-only when they are.
 *
 * Both halves are load-bearing and neither can be unit-rendered (these are RSC
 * pages and vitest runs `environment: "node"` with no jsdom), so this is a
 * SOURCE guard, the same tool `dashboard-guards` and `room-source-guards` use.
 *
 * WHY IT EXISTS. FantasyRoster and Prediction rows outlive archival — they
 * cascade only on season DELETE — but both pages resolved `getActiveSeason()`
 * with no `?season=`, so each season's fantasy champion and oracle champion
 * became unreachable the instant season N+1 was created: the data survived and
 * no page in the app could render it. Two whole side games concluded with no
 * recorded winner anywhere.
 *
 * WHY READ-ONLY IS THE DANGEROUS HALF. `saveFantasyRoster` and
 * `savePrediction` resolve the ACTIVE season THEMSELVES. So a picker rendered
 * over an archived season would submit against the CURRENT one — silently
 * rewriting a live roster with a dead season's five, with no error anywhere.
 * Hiding the control visually is not enough; the branch that decides whether
 * the control exists has to be the one carrying the flag. That is why
 * `locked` folds in `readOnly` (fantasy) and `open` is forced empty
 * (pick'em) rather than each call site testing `readOnly` for itself.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");
const FANTASY = read("fantasy", "page.tsx");
const PICKEM = read("pickem", "page.tsx");
const HOME = read("page.tsx");
const FANTASY_ACTION = read("actions", "fantasy.ts");
const PICKEM_BUTTON = read("..", "components", "pickem-submit-button.tsx");
const PICK_FORM = read("..", "components", "pickem-pick-form.tsx");
const MATCH = read("matches", "[id]", "page.tsx");
const SEASON_ARCHIVE = read("seasons", "[id]", "page.tsx");

describe("side-game archive: both pages resolve ?season=", () => {
  for (const [name, src] of [
    ["fantasy", FANTASY],
    ["pickem", PICKEM],
  ] as const) {
    it(`${name} accepts a season param and 404s an unknown one`, () => {
      expect(src, `${name} takes searchParams`).toMatch(
        /type \w+SearchParams = \{ season\?: string \| string\[\] \}/,
      );
      expect(src, `${name} rejects a repeated season key`).toContain(
        "if (seasonParam === null) notFound()",
      );
      expect(
        src,
        `${name} resolves the param before the active season`,
      ).toMatch(/seasonParam\s*\n?\s*\?\s*await prisma\.season\.findUnique/);
      // An unknown id must 404, not silently fall back to the live season —
      // that would render this season's data under someone else's link.
      expect(src, `${name} notFounds an unknown season`).toMatch(
        /if \(seasonParam && !season\) notFound\(\)/,
      );
    });

    it(`${name} derives readOnly from the season, not from the viewer`, () => {
      expect(src, `${name} sets readOnly`).toMatch(
        /const readOnly = !season\.isActive;/,
      );
    });
  }
});

describe("side-game archive: an archived season is STRUCTURALLY read-only", () => {
  it("fantasy folds readOnly into `locked`, the one branch that renders the picker", () => {
    // If this regresses to `games.length > 0`, an archived season with no
    // imported games renders a live <FantasyPicker> whose submit edits the
    // CURRENT season's roster.
    expect(FANTASY).toMatch(
      /const locked =\s*readOnly \|\| !phaseOpen \|\| season\.fantasyLockedAt != null \|\| gameCount > 0;/,
    );
    // …and the picker really does hang off that flag alone.
    expect(FANTASY).toMatch(/locked \?/);
  });

  it("pickem makes the action-rendering branch unreachable when archived", () => {
    // `predictionOpen` returns true for any SCHEDULED match with a null
    // kickoff, so an archived season would otherwise render live pick buttons
    // that can only error.
    expect(PICKEM).toMatch(/const canPlay = !readOnly && phaseOpen;/);
    expect(PICKEM).toMatch(/const open = canPlay \? buckets\.open : \[\];/);
    expect(PICKEM).toMatch(/\{canPlay \? \(\s*<section/);
  });

  it("neither page offers a sign-in-to-play CTA on a closed season", () => {
    // An ask with no control behind it — the SIGNUPS-dashboard lesson.
    expect(FANTASY).toMatch(/!viewer && !locked \?/);
    expect(PICKEM).toMatch(/readOnly \? \(\s*<Badge tone="neutral">Archived/);
  });
});

describe("side-game archive: the season archive links to them", () => {
  it("/seasons/[id] carries fantasy and pick'em links", () => {
    // Without a link from the page that OWNS the season, ?season= is a URL
    // only someone who read the source would know to type.
    expect(SEASON_ARCHIVE).toMatch(
      /href=\{`\/fantasy\?season=\$\{season\.id\}`\}/,
    );
    expect(SEASON_ARCHIVE).toMatch(
      /href=\{`\/pickem\?season=\$\{season\.id\}`\}/,
    );
  });
});

describe("side-game live-state integrity", () => {
  it("the homepage honors Fantasy's durable information lock", () => {
    expect(HOME).toMatch(
      /const fantasyLocked =\s*season\.fantasyLockedAt != null \|\| gamesOnRecord > 0;/,
    );
  });

  it("a Fantasy form cannot roll into a later active season", () => {
    expect(FANTASY).toMatch(/hidden=\{\{ expectedSeasonId: season\.id \}\}/);
    expect(FANTASY_ACTION).toMatch(/season\.id !== expectedSeasonId/);
  });

  it("Pick'em transitions at kickoff and preserves void history", () => {
    expect(PICKEM).toMatch(/const voided = buckets\.voided;/);
    expect(PICKEM).toMatch(/Your void picks/);
    expect(PICKEM).toMatch(
      /<PickemDeadlineRefresh targetMs=\{nextOpenDeadline\}/,
    );
    expect(PICKEM_BUTTON).toMatch(/setPassedAt\(locksAt\)/);
  });

  it("both Pick'em choices share one pending form", () => {
    expect(PICK_FORM).toMatch(/hidden=\{\{ matchId \}\}/);
    expect(PICK_FORM).toMatch(/name="pickedTeamId"/);
    expect(PICK_FORM).not.toMatch(/hidden=\{\{ matchId, pickedTeamId/);
    expect(PICKEM).toMatch(/<PickemPickForm\s/);
  });
});

/**
 * The pick control now lives on THREE surfaces: /pickem, the dashboard's
 * This-week cards and the match preview. Three hand-rolled copies of a
 * two-button form would drift on exactly the things that matter (the one
 * pending form, aria-pressed, the kickoff disable), so there is one
 * implementation and this pins that nobody grows a second.
 */
describe("pick'em control: one implementation, gated like /pickem", () => {
  const importers = (dir: string): string[] =>
    readdirSync(join(__dirname, dir), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) =>
        readFileSync(join(__dirname, dir, f), "utf8").includes(
          'from "@/app/actions/pickem"',
        ),
      )
      .map((f) => join(dir, f));

  it("only the shared form imports savePrediction", () => {
    expect([...importers("."), ...importers("../components")]).toEqual([
      join("../components", "pickem-pick-form.tsx"),
    ]);
  });

  it("the dashboard and match preview render the shared tray off pickemControlFor", () => {
    for (const [name, src] of [
      ["dashboard", HOME],
      ["match preview", MATCH],
    ] as const) {
      expect(src, `${name} decides via pickemControlFor`).toMatch(
        /pickemControlFor\(/,
      );
      expect(src, `${name} renders PickemTray`).toMatch(/<PickemTray\s/);
    }
  });

  it("both fixture surfaces fold the active-season gate into canPlay", () => {
    // predictionOpen is true for a SCHEDULED fixture with no kickoff in ANY
    // season, and savePrediction writes to the active one only.
    expect(HOME).toMatch(
      /pickemPlayable=\{\s*season\.isActive &&\s*postAuctionWorkOpen\(/,
    );
    expect(MATCH).toMatch(
      /canPlay:\s*!!previewSeason\?\.isActive &&\s*postAuctionWorkOpen\(/,
    );
  });

  it("signed-out dashboard viewers get no picks map, so no tray", () => {
    expect(HOME).toMatch(/myPicks=\{userId \? myPicks : null\}/);
    expect(HOME).toMatch(/signedIn: myPicks != null/);
  });
});
