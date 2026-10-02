import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlayerRecord, RecordWatchLine } from "@/lib/records";
import { sourceFile } from "../../test/support/source-files";
import { ProfileHeroesAndRecords } from "./profile-heroes-records";

const watch: RecordWatchLine = {
  userId: "u1",
  key: "kills",
  title: "Most kills",
  emoji: "🔪",
  best: 18,
  record: 21,
  gap: 3,
};
const held: PlayerRecord = {
  key: "gpm",
  title: "Highest GPM",
  emoji: "⚡",
  value: 812,
  userId: "u1",
  heroId: 1,
  matchId: "m9",
  seasonId: "s1",
  won: true,
};

const render = (
  extra: Partial<Parameters<typeof ProfileHeroesAndRecords>[0]>,
) =>
  renderToStaticMarkup(
    createElement(ProfileHeroesAndRecords, {
      showHeroes: false,
      showRecords: true,
      leagueHeroes: [],
      selfPickedHeroes: undefined,
      pubHeroes: [],
      pubCheckedLabel: null,
      heldRecords: [],
      ...extra,
    }),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("the League records card's record watch", () => {
  it("shows the record within reach as stored marks", () => {
    const html = render({ recordWatch: watch });
    expect(text(html)).toContain("Within reach");
    expect(text(html)).toContain(
      "Most kills · Career best 18 kills · record 21, 3 short",
    );
    // The emoji is decoration; the words carry it.
    expect(html).toContain('<span aria-hidden="true">🔪 </span>');
  });

  it("takes its own row under the chips and wraps a long line", () => {
    const html = render({ heldRecords: [held], recordWatch: watch });
    expect(text(html)).toContain("Highest GPM");
    expect(html.indexOf("Highest GPM")).toBeLessThan(
      html.indexOf("Within reach"),
    );
    expect(html).toMatch(/<div class="w-full min-w-0 [^"]*">/);
    expect(html).toContain('<p class="mt-0.5 [overflow-wrap:anywhere]">');
  });

  it("is absent without a line", () => {
    expect(render({ heldRecords: [held] })).not.toContain("Within reach");
    expect(render({ heldRecords: [held], recordWatch: null })).not.toContain(
      "Within reach",
    );
  });
});

describe("the profile's record hand-off", () => {
  it("reads held records and the watch from one book, and shows the card for either", () => {
    const page = sourceFile("src/app/players/[id]/page.tsx").text;
    expect(page).toContain("recordWatchBook(toRecordGames(recordRows))");
    expect(page).toContain(
      "recordBook.records.filter((r) => r.userId === id)",
    );
    expect(page).toContain("recordWatchFor(recordBook, id)");
    expect(page).toContain("recordWatch: recordWatch != null");
    expect(page).toContain("recordWatch={recordWatch}");
  });
});
