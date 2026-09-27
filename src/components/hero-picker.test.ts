import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroPicker } from "./hero-picker";

const render = (props: Parameters<typeof HeroPicker>[0]) =>
  renderToStaticMarkup(createElement(HeroPicker, props));

describe("HeroPicker suggestions", () => {
  it("offers most-played heroes as one-tap adds without selecting them", () => {
    // Axe (2), Pudge (14), Lion (26)
    const html = render({ name: "favoriteHeroes", suggestions: [2, 14, 26] });
    expect(html).toContain("Most played (pubs):");
    for (const hero of ["Axe", "Pudge", "Lion"]) {
      expect(html).toContain(`aria-label="Add ${hero}"`);
    }
    // Nothing is pre-selected: the submitted value stays empty.
    expect(html).toMatch(/<input type="hidden" name="favoriteHeroes" value=""\/>/);
  });

  it("hides a suggestion already picked, and the row when none are left", () => {
    const some = render({
      name: "favoriteHeroes",
      defaultValue: "Axe",
      suggestions: [2, 14],
    });
    expect(some).not.toContain('aria-label="Add Axe"');
    expect(some).toContain('aria-label="Add Pudge"');

    const none = render({ name: "favoriteHeroes", suggestions: [] });
    expect(none).not.toContain("Most played (pubs):");
  });
});
