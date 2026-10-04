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

// The streaming site's player loads only when a visitor presses play: an
// iframe that came with the page would hand every visitor's address and
// cookies to the streaming site, whether or not they watch (broadcast.ts).
describe("the stream player", () => {
  const player = stripLineComments(
    sourceFile("src/components/stream-player.tsx").text,
  );

  it("is the app's only iframe", () => {
    const files = sourceFiles("src/**/*.tsx", 80);
    const framed = files
      .filter((f) => /<iframe\b/i.test(stripLineComments(f.text)))
      .map((f) => f.path);
    expect(framed).toEqual(["src/components/stream-player.tsx"]);
  });

  it("creates its iframe only from a press of play, at the tested address", () => {
    // No address until the button sets one, and the iframe needs one.
    expect(player).toContain("useState<string | null>(null)");
    expect(player).toMatch(/\{src \? \(\s*<iframe\s+src=\{src\}/);
    expect(player.match(/<iframe\b/g)).toHaveLength(1);
    expect(player.match(/setSrc\(/g)).toHaveLength(1);
    expect(player).toMatch(
      /onClick=\{\(\) =>\s*setSrc\(streamEmbedSrc\(embed, window\.location\.hostname\)\)\s*\}/,
    );
  });

  it("appears inside the live window and keeps playing past its end", () => {
    expect(player).toContain("useWatchState(watch)");
    expect(player).toContain('if (src === null && state !== "live") return null;');
  });

  it("stands on the match scoreboard and on Home's lone This week card", () => {
    const scoreboard =
      folderSourceFiles("src/app/matches/[id]", 5).find((f) =>
        f.path.endsWith("/scoreboard.tsx"),
      )?.text ?? "";
    const home = sourceFile("src/components/home/this-week.tsx").text;
    for (const site of [scoreboard, home]) {
      expect(site).toContain("<StreamPlayer");
      expect(site).toContain("streamEmbed(stream)");
    }
    // One stream can't play under two matches at once.
    expect(home).toContain(
      "const embed = stream && focus.length === 1 ? streamEmbed(stream) : null;",
    );
    expect(sourceFile("src/components/schedule-weeks.tsx").text).not.toContain(
      "<StreamPlayer",
    );
  });
});
