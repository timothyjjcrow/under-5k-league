import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
      /const fantasyLocked =\s*season\.fantasyLockedAt != null \|\| seasonGames > 0;/,
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
    expect(PICKEM).toMatch(/hidden=\{\{ matchId: m\.id \}\}/);
    expect(PICKEM).toMatch(/name="pickedTeamId"/);
    expect(PICKEM).not.toMatch(/hidden=\{\{ matchId: m\.id, pickedTeamId:/);
  });
});
