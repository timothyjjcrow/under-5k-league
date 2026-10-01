import { describe, expect, it } from "vitest";
import {
  folderSourceFiles,
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

// The watch link's rules live in src/lib/broadcast.ts (normalizeStreamUrl,
// matchWatchWindow, watchState), tested there. These guards pin the component
// to them and to the three places a visitor meets it.
describe("WatchLink", () => {
  const source = stripLineComments(
    sourceFile("src/components/watch-link.tsx").text,
  );

  it("decides the window in the browser, from the tested helper", () => {
    // A server snapshot other than null would hydrate one clock over another,
    // and deciding on the server would freeze a parked tab's link.
    expect(source).toMatch(
      /function getServerSnapshot\(\): number \| null \{\s*return null;\s*\}/,
    );
    expect(source).toContain("watchState(watch, now)");
  });

  it("opens the stream in a new tab without telling it where the visitor came from", () => {
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noreferrer"');
    expect(source.match(/<a\b/g)).toHaveLength(1);
  });

  it("stands on the match scoreboard, Home's This week and /schedule rows", () => {
    const scoreboard = folderSourceFiles("src/app/matches/[id]", 5).find((f) =>
      f.path.endsWith("/scoreboard.tsx"),
    );
    const sites = [
      scoreboard?.text ?? "",
      sourceFile("src/components/home/this-week.tsx").text,
      sourceFile("src/components/schedule-weeks.tsx").text,
    ];
    for (const site of sites) expect(site).toContain("<WatchLink");
    // Every server that hands a link down gates it on the one window rule
    // (playoffs and the final, active season, not decided or forfeited).
    for (const server of [
      scoreboard?.text ?? "",
      sourceFile("src/components/home/this-week.tsx").text,
      sourceFile("src/app/schedule/page.tsx").text,
    ]) {
      expect(server).toContain("matchWatchWindow(");
      expect(server).toContain("getLeagueStream()");
    }
  });
});

// An embedded player would load the streaming site in every visitor's
// browser, handing it their address and cookies whether or not they press
// play. The league links out instead.
describe("no embedded players", () => {
  it("renders no iframe anywhere in the app", () => {
    const files = sourceFiles("src/**/*.tsx", 80);
    const framed = files
      .filter((f) => /<iframe\b/i.test(stripLineComments(f.text)))
      .map((f) => f.path);
    expect(framed).toEqual([]);
  });
});
