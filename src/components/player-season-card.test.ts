import { describe, expect, it } from "vitest";
import { jsxElements, propValue } from "../../test/support/jsx-elements";
import {
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

/**
 * The season card in a profile's header is drawn from playerCardFacts and
 * nothing else, the same facts the profile's link picture is drawn from, so
 * the card a player posts is the card their profile shows. These pin the
 * wiring no render test sees: the page folds its reads through the rule, the
 * header hands the result to the card, and the card reads only that.
 */

const page = sourceFile("src/app/players/[id]/page.tsx");
const header = sourceFile("src/components/profile-header.tsx");
const card = sourceFile("src/components/player-season-card.tsx");

describe("the profile's season card", () => {
  it("is computed once by the page, by playerCardFacts, and handed to the header", () => {
    const text = stripLineComments(page.text);
    expect(text.match(/\bplayerCardFacts\(/g)).toHaveLength(1);
    expect(text).toMatch(/const card = playerCardFacts\(/);
    const headers = jsxElements(page).filter((el) => el.tag === "ProfileHeader");
    expect(headers).toHaveLength(1);
    expect(propValue(headers[0].attributes.get("card"))).toBe("card");
  });

  it("is rendered by the header from that prop, with the name row's badges", () => {
    const text = stripLineComments(header.text);
    const cards = jsxElements(header).filter(
      (el) => el.tag === "PlayerSeasonCard",
    );
    expect(cards).toHaveLength(1);
    expect(propValue(cards[0].attributes.get("facts"))).toBe("card");
    // The role line leaves a live Captain or Standin to the name row.
    expect(propValue(cards[0].attributes.get("roleText"))).toMatch(
      /^profileCardRoleText\(card, \{\s*captain: isCaptain,\s*standin: isStandin,?\s*\}\)$/,
    );
    expect(text).toContain("playerCardHasContent(card) ? (");
    // The titles beside the name are the card's titles.
    expect(text).toContain("championTitles(card.titles)");
    expect(text).toMatch(/card: PlayerCardFacts;/);
  });

  it("is the one place the header shows a medal or an MMR", () => {
    // The card owns both now; a second copy in the name or facts row would
    // say the same thing twice (and the MMR rule would live in two places).
    const text = stripLineComments(header.text);
    expect(text).not.toMatch(/<RankMedal\b/);
    expect(text).not.toMatch(/\.mmr\b/);
    expect(text).not.toMatch(/rankTier/);
  });

  it("reads only its facts: nothing about contact, and no database", () => {
    const text = stripLineComments(card.text);
    expect(text).not.toMatch(
      /discord|steam|profileUrl|fhUnavailable|contact|visibility|prisma|user\./i,
    );
    expect(text).toMatch(/facts: PlayerCardFacts;/);
    // Everything it shows comes off `facts` (or the role text made from it).
    const reads = [...text.matchAll(/\bfacts\.([a-zA-Z]+)/g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(
      new Set(["rankTier", "mmr", "grade", "team", "season", "heroes"]),
    );
  });

  it("is used nowhere it isn't handed playerCardFacts' result", () => {
    // Today the profile header is the only caller; a new one has to come
    // here and say where its facts come from.
    const callers = sourceFiles(["src/**/*.tsx"], 150).filter((f) =>
      jsxElements(f).some((el) => el.tag === "PlayerSeasonCard"),
    );
    expect(callers.map((f) => f.path)).toEqual([
      "src/components/profile-header.tsx",
    ]);
  });
});
