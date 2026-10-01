import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecordWatchLine } from "@/lib/records";
import {
  sourceFile,
  stripLineComments,
} from "../../../../test/support/source-files";
import { RecordWatch } from "./record-watch";

const DIR = "src/app/matches/[id]";
const CARD = (name: string) =>
  stripLineComments(sourceFile(`${DIR}/${name}`).text);

const line = (overrides: Partial<RecordWatchLine>): RecordWatchLine => ({
  userId: "u1",
  key: "kills",
  title: "Most kills",
  emoji: "🔪",
  best: 18,
  record: 21,
  gap: 3,
  ...overrides,
});
const names = new Map([
  ["u1", "Techies Player1"],
  ["u2", "The Player4"],
]);
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("the Record watch card", () => {
  it("lists each player's line with a link to their profile", () => {
    const html = renderToStaticMarkup(
      createElement(RecordWatch, {
        lines: [
          line({}),
          line({
            userId: "u2",
            key: "gpm",
            title: "Highest GPM",
            emoji: "⚡",
            best: 790,
            record: 800,
            gap: 10,
          }),
        ],
        names,
      }),
    );
    expect(html).toMatch(/<h2[^>]*>Record watch<\/h2>/);
    expect(html.match(/<li\b/g)).toHaveLength(2);
    expect(html).toContain('href="/players/u1"');
    expect(html).toContain('href="/players/u2"');
    expect(text(html)).toContain(
      "Techies Player1🔪 Most kills · Career best 18 kills · record 21, 3 short",
    );
    expect(text(html)).toContain(
      "Highest GPM · Career best 790 GPM · record 800, 10 short",
    );
    expect(html).toContain('<span aria-hidden="true">🔪 </span>');
    expect(html).toContain('href="/records"');
  });

  it("wraps a long name and a long line instead of widening the page", () => {
    const html = renderToStaticMarkup(
      createElement(RecordWatch, { lines: [line({})], names }),
    );
    expect(html).toMatch(/<a class="[^"]*max-w-full[^"]*\[overflow-wrap:anywhere\]/);
    expect(html).toContain('<p class="text-muted [overflow-wrap:anywhere]">');
  });

  it("renders nothing without a line", () => {
    expect(
      renderToStaticMarkup(createElement(RecordWatch, { lines: [], names })),
    ).toBe("");
  });
});

describe("the Record watch hand-off", () => {
  it("sits after the tale of the tape and before the Matchup card", () => {
    const preview = CARD("match-preview.tsx");
    const tape = preview.indexOf("<TaleOfTheTape");
    const watch = preview.indexOf("<RecordWatch ");
    expect(tape).toBeGreaterThan(-1);
    expect(watch).toBeGreaterThan(tape);
    expect(preview.indexOf("<MatchupCard")).toBeGreaterThan(watch);
    // The players expected tonight: standins in, the covered players out.
    expect(preview).toContain(
      "recordWatchLines(recordBook, [...activeNightRoster])",
    );
  });

  it("reads the book once in the page body, for an upcoming fixture only", () => {
    const page = CARD("page.tsx");
    expect(page).toMatch(
      /const recordBook =\s*games\.length === 0 && match\.status !== "COMPLETED" && match\.season\.isActive\s*\? await loadRecordWatchBook\(\)\s*: null;/,
    );
    expect(page).toMatch(/<MatchPreview[\s\S]*?recordBook=\{recordBook\}/);
    // The book comes from /records' own cached read and mapping.
    expect(CARD("load.ts")).toContain(
      "recordWatchBook(toRecordGames(await getAllGamesForRecords()))",
    );
  });

  it("keeps the card props-only and out of the jump bar", () => {
    const card = CARD("record-watch.tsx");
    expect(card).not.toMatch(/prisma|await\s|async\s|getAllGamesForRecords/);
    expect(CARD("match-preview.tsx")).not.toMatch(
      /getAllGamesForRecords|loadRecordWatchBook/,
    );
    expect(CARD("page.tsx")).not.toMatch(/record-watch"|"match-records?"/);
  });
});
