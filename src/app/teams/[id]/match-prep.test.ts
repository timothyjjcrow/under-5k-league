import { describe, expect, it } from "vitest";
import {
  sourceFile,
  stripLineComments,
} from "../../../../test/support/source-files";

// The team page is a server component with no render test (no jsdom), so
// the rules of its "Match prep" card are pinned at the source: who gets it,
// and that its lines and jumps come from the tested rules.
const PAGE = stripLineComments(sourceFile("src/app/teams/[id]/page.tsx").text);
const CARD = stripLineComments(
  sourceFile("src/app/teams/[id]/match-prep.tsx").text,
);
const SERVICE = stripLineComments(
  sourceFile("src/lib/team-week-service.ts").text,
);

describe("team page match prep", () => {
  it("renders only for the team's own captain and roster, on an unfinished series", () => {
    expect(PAGE).toMatch(
      /const prepMatch =\s*viewer &&\s*team\.season\.isActive &&\s*!team\.withdrawn &&\s*featuredMatch &&\s*featuredMatch\.status !== "COMPLETED" &&\s*\(viewer\.id === team\.captainId \|\| memberIds\.includes\(viewer\.id\)\)/,
    );
    // Streamed, so its reads never hold up the public page.
    expect(PAGE).toMatch(
      /\{prepMatch && viewer \? \(\s*<Suspense fallback=\{null\}>\s*<MatchPrep/,
    );
  });

  it("reads the side through the check-in banner's loader, so the counts agree", () => {
    expect(SERVICE).toContain(
      "await loadCheckinSide({ matchId: match.id, viewer: input.viewer })",
    );
    expect(SERVICE).toContain("if (!side) return null;");
    // Requests are a captain's to answer: nobody else's page reads them.
    expect(SERVICE).toMatch(/captain\s*\? prisma\.standinRequest\.findMany/);
    expect(SERVICE).toContain("notes: teamWeekNotes({");
  });

  it("links each line and jump to the match page's own cards and gates", () => {
    expect(CARD).toContain(
      "captainCardsOpen({ status: match.status, season }, draftStatus)",
    );
    expect(CARD).toMatch(/const jumps = captain\s*\? captainJumps\(\{/);
    expect(CARD).toContain("href={matchAnchorPath(match.id, note.link.anchor)}");
    expect(CARD).toContain("href={matchAnchorPath(match.id, jump.anchor)}");
    // Named answers only where the loader gave them (captains and admins).
    expect(CARD).toMatch(/const names = side\.names\s*\?/);
  });
});
