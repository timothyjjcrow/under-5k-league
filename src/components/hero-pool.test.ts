import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroPool } from "./ui";

const render = (props: Parameters<typeof HeroPool>[0]) =>
  renderToStaticMarkup(createElement(HeroPool, props));

describe("HeroPool", () => {
  it("colours every win rate by default, as team pages expect", () => {
    const html = render({ heroes: [{ heroId: 1, games: 1, wins: 1 }] });
    expect(html).toContain("1g · ");
    expect(html).toContain("100%");
    expect(html).toContain("text-success");
    expect(html).toContain("bg-success/70");
  });

  it("shows a plain W–L with no colour below minGamesForRate", () => {
    const html = render({
      heroes: [
        { heroId: 1, games: 1, wins: 1 },
        { heroId: 2, games: 2, wins: 0 },
      ],
      minGamesForRate: 3,
    });
    expect(html).toContain("1–0");
    expect(html).toContain("0–2");
    expect(html).not.toContain("%");
    expect(html).not.toMatch(/text-(success|danger)/);
    // No bar and no empty track (it read as a broken meter); a same-height
    // spacer keeps the rows even.
    expect(html).not.toContain("bar-fill");
    expect(html).not.toMatch(/rounded-full bg-surface-2/);
    expect(html).toContain('<div aria-hidden="true" class="mt-1.5 h-1"></div>');
  });

  it("keeps a wrapped KDA together with its number", () => {
    const html = render({ heroes: [{ heroId: 1, games: 1, wins: 1, kda: 4.2 }], minGamesForRate: 3 });
    expect(html).toContain('<span class="whitespace-nowrap tabular-nums"> · 4.2 KDA</span>');
  });

  it("colours a hero again once it reaches the threshold", () => {
    const html = render({
      heroes: [{ heroId: 1, games: 3, wins: 0 }],
      minGamesForRate: 3,
    });
    expect(html).toContain("0%");
    expect(html).toContain("text-danger");
    expect(html).toContain("bar-fill");
  });
});
