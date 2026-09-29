import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Fixed-layout tables size their columns from <col> widths, and a
 * display:none cell drops out of its row: every cell after it slides one
 * <col> left. So at each breakpoint the visible cells must land on cols that
 * have a width, and the cols left over at the end must be w-0, or a phone
 * squeezes a real column to nothing (the /meta Win % bug) or hands an empty
 * track part of the row. StandingsTable has its own rendered test.
 */
const TABLE_SOURCES = [
  "src/components/hero-meta-table.tsx",
  "src/app/inhouse/page.tsx",
];
const BREAKPOINTS = ["", "sm", "md", "lg", "xl"] as const;

type Table = { cols: string[]; headers: string[]; firstRow: string[] };

function tablesIn(source: string): Table[] {
  const tables: Table[] = [];
  for (const group of source.matchAll(/<colgroup>([\s\S]*?)<\/colgroup>/g)) {
    const cols = [...group[1].matchAll(/<col\b([^>]*?)\/>/g)].map(
      (m) => /className="([^"]*)"/.exec(m[1])?.[1] ?? "",
    );
    const after = source.slice(group.index! + group[0].length);
    const head = /<thead\b[^>]*>([\s\S]*?)<\/thead>/.exec(after)?.[1] ?? "";
    const headers = [...head.matchAll(/<(?:th|SortHeader)\b([^>]*)>/g)].map(
      (m) => m[1],
    );
    const body = /<tbody\b[\s\S]*?<tr\b[\s\S]*?>([\s\S]*?)<\/tr>/.exec(after)?.[1] ?? "";
    const firstRow = [...body.matchAll(/<t[dh]\b([^>]*)>/g)].map((m) => m[1]);
    tables.push({ cols, headers, firstRow });
  }
  return tables;
}

/** Whether a cell with these attributes is shown at breakpoint `at`. */
function shownAt(attrs: string, at: number): boolean {
  if (!/(^|[\s"(])hidden(\s|")/.test(attrs)) return true;
  return BREAKPOINTS.slice(1, at + 1).some((bp) =>
    new RegExp(`(^|\\s)${bp}:table-cell(\\s|"|$)`).test(attrs),
  );
}

/** The width class a <col> resolves to at breakpoint `at` ("auto" if none). */
function widthAt(classes: string, at: number): string {
  let width = "auto";
  for (const token of classes.split(/\s+/)) {
    const m = /^(?:(sm|md|lg|xl):)?w-(.+)$/.exec(token);
    if (!m) continue;
    const index = BREAKPOINTS.indexOf((m[1] ?? "") as (typeof BREAKPOINTS)[number]);
    if (index <= at) width = m[2];
  }
  return width;
}

describe("fixed-layout tables put every visible cell on a sized <col>", () => {
  for (const file of TABLE_SOURCES) {
    const tables = tablesIn(readFileSync(file, "utf8"));

    it(`${file}: finds its tables`, () => {
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        expect(table.headers).toHaveLength(table.cols.length);
        expect(table.firstRow).toHaveLength(table.cols.length);
      }
    });

    tables.forEach((table, n) => {
      it(`${file}: table ${n + 1} at every breakpoint`, () => {
        BREAKPOINTS.forEach((bp, at) => {
          const shown = table.headers.filter((attrs) => shownAt(attrs, at));
          const rowShown = table.firstRow.filter((attrs) => shownAt(attrs, at));
          const where = `${bp || "base"}`;
          expect(rowShown.length, `${where}: body cells vs headers`).toBe(shown.length);
          table.cols.forEach((col, i) => {
            const width = widthAt(col, at);
            if (i < shown.length) {
              expect(width, `${where}: col ${i + 1} holds a visible cell`).not.toBe("0");
            } else {
              expect(width, `${where}: col ${i + 1} is empty`).toBe("0");
            }
          });
        });
      });
    });
  }
});
