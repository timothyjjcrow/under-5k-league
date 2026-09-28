import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { returningJoinPlan } from "@/lib/account-page";
import { ReturningJoinCard } from "./returning-join-card";

type Props = ComponentProps<typeof ReturningJoinCard>;

const previous = {
  type: "STANDIN",
  mmr: 3300,
  roles: "4,5",
  favoriteHeroes: "Lion",
  wantsCaptain: false,
};

function render(overrides: Partial<Props> = {}) {
  const plan = returningJoinPlan({
    seasonName: "Season 10",
    previous,
    rankTier: null,
    playerChoiceOpen: true,
  });
  if (!plan) throw new Error("expected a plan");
  return renderToStaticMarkup(
    createElement(ReturningJoinCard, {
      plan,
      seasonName: "Season 9",
      roles: previous.roles,
      hidden: { mmr: "3300", favoriteHeroes: "Lion", about: "Support main" },
      action: async () => null,
      notice: createElement("p", null, "PUBLIC NOTICE"),
      ...overrides,
    }),
  );
}

describe("ReturningJoinCard", () => {
  it("says what last season's signup was and the MMR that will be saved", () => {
    const html = render();
    expect(html).toContain("Welcome back");
    expect(html).toContain("Your Season 9 signup:");
    expect(html).toContain("Standin · 3300 MMR · Soft Support, Hard Support · 1 hero");
    expect(html).toContain("You&#x27;ll be listed at 3300 MMR.");
    // Joining is the consent, so the public notice sits beside the buttons.
    expect(html).toContain("PUBLIC NOTICE");
  });

  it("posts last season's answers, one input per role, and lets the button pick the type", () => {
    const html = render();
    expect(html).toContain('name="mmr" value="3300"');
    expect(html).toContain('name="about" value="Support main"');
    const roles = [...html.matchAll(/name="roles" value="(\d)"/g)].map((m) => m[1]);
    expect(roles).toEqual(["4", "5"]);
    // Two submit buttons carry the choice; nothing is pre-selected.
    const buttons = [...html.matchAll(/<button([^>]*)>([^<]*)</g)]
      .filter((m) => m[1].includes('name="type"'))
      .map((m) => [/value="(\w+)"/.exec(m[1])?.[1], m[2]]);
    expect(buttons).toEqual([
      ["PLAYER", "Join as a full player"],
      ["STANDIN", "Join as a standin"],
    ]);
    expect(html).not.toMatch(/checked/);
  });
});
