import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InhouseState } from "@/lib/inhouse-service";
import { ResultCard } from "./result-card";

type LastResult = NonNullable<InhouseState["lastResult"]>;

const base = {
  lobbyId: "game-1",
  winnerSide: "Dire" as const,
  radiantScore: 21,
  direScore: 34,
  myTeamWon: true,
  eloDelta: 14,
};
const player = (userId: string, eloDelta: number | null, isCaptain = false) => ({
  userId,
  name: `Name ${userId}`,
  isCaptain,
  eloDelta,
});
const full: LastResult = {
  ...base,
  teams: [
    { isRadiant: true, won: false, players: [player("r1", -14, true), player("r2", null)] },
    { isRadiant: false, won: true, players: [player("d1", 14, true), player("me", 14)] },
  ],
  mvp: { userId: "me", name: "Name me", hero: "Lion" },
};

const render = (result: LastResult, queued: string[] = [], runItBack = true) =>
  renderToStaticMarkup(
    createElement(ResultCard, {
      result,
      viewerId: "me",
      queuedUserIds: queued,
      runItBack: runItBack ? () => {} : null,
      pending: false,
      onDismiss: () => {},
    }),
  );

describe("ResultCard", () => {
  it("shows the headline, both sides with their Elo changes, and the MVP", () => {
    const html = render(full);
    expect(html).toContain("Victory for you,");
    expect(html).toContain("+14 Elo");
    expect(html).toContain("Dire win 21–34");
    expect(html).toContain("Lion");
    for (const name of ["Name r1", "Name r2", "Name d1", "Name me"])
      expect(html).toContain(name);
    expect(html).toContain("-14");
    expect(html).toContain("Run it back →");
    expect(html).toContain('aria-label="Dismiss result banner"');
  });

  it("shows nothing for an unknown Elo change: never a zero", () => {
    const html = render({
      ...full,
      teams: [
        { isRadiant: true, won: false, players: [player("r2", null)] },
        { isRadiant: false, won: true, players: [] },
      ],
      mvp: null,
    });
    expect(html).toContain("Name r2");
    expect(html).not.toMatch(/>[+-]?0</);
    expect(html).not.toContain("MVP");
  });

  it("counts the game's players who are back in the queue", () => {
    expect(render(full, ["r1", "d1", "someone-else"])).toContain(
      "2 of that game’s 4 are back in the queue.",
    );
    expect(render(full)).not.toContain("back in the queue");
  });

  it("drops Run it back where a join would be refused", () => {
    expect(render(full, [], false)).not.toContain("Run it back");
  });

  // During a release an old slot answers the room for about 90 seconds, and
  // its lastResult has no `teams` or `mvp`. e2e/inhouse-storage.spec.ts
  // serves that shape too.
  it("renders an old slot's result (no teams, no MVP) as the headline alone", () => {
    const html = render(base as unknown as LastResult, ["r1"]);
    expect(html).toContain("Victory for you,");
    expect(html).toContain("Dire win 21–34");
    expect(html).toContain('aria-label="Dismiss result banner"');
    expect(html).not.toContain("back in the queue");
  });
});
