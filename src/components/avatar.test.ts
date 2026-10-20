import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "./ui";

describe("Avatar initials", () => {
  // REGRESSION (2026-10-19 mock draft): the admin captain row sets
  // `[overflow-wrap:anywhere]` for long names, and the 20px avatar inherited
  // it, so "mid or feed" rendered as an M stacked over an O.
  it("never wrap, whatever the parent allows", () => {
    const html = renderToStaticMarkup(
      createElement(Avatar, { name: "mid or feed", size: 20 }),
    );
    expect(html).toContain(">MO</span>");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("[overflow-wrap:normal]");
  });
});
