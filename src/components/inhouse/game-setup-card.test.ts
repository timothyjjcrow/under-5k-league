import { describe, expect, it } from "vitest";
import {
  sourceFile,
  stripLineComments,
} from "../../../test/support/source-files";

// SOURCE GUARD: vitest runs without jsdom, so the setup card's "your side"
// line (Tim, 2026-10-18) is checked in its source. Its words come from the
// tested pure inhouseViewerSideLine, fed the game's own teams and the bot
// panel's seat for the viewer, and it sits straight under the card's heading
// so a phone shows it on the first screen of the Set up stage.
describe("GameSetupCard's side line (source)", () => {
  const code = stripLineComments(
    sourceFile("src/components/inhouse/game-setup-card.tsx").text,
  );

  it("words it through inhouseViewerSideLine, from the game's teams and the panel's seat", () => {
    expect(code).toMatch(
      /inhouseViewerSideLine\(\{\s*status: lobby\.status,\s*myTeam: me\.myTeam,\s*teams: lobby\.teams,\s*seat: viewerSeat,\s*\}\)/,
    );
    expect(code).toMatch(
      /const \[viewerSeat, setViewerSeat\] = useState<LobbySeat \| null>\(null\);/,
    );
    // The panel (always mounted, even when hidden) reports the seat.
    expect(code).toMatch(
      /<DotaLobbyControls[^>]*onViewerSeat=\{setViewerSeat\}[^>]*\/>/,
    );
    expect(code).toMatch(
      /<p className="min-w-0 break-words text-sm font-semibold text-fg">\s*\{sideLine\.text\}\s*<\/p>/,
    );
    // Only through the helper: no side wording of the card's own.
    expect(code).not.toMatch(/take (?:any|a) (?:Radiant|Dire|\$\{)/);
  });

  it("names it for assistive tech and puts it under the heading, above the bot panel", () => {
    expect(code).toMatch(/\{sideLine \? \(\s*<div\s+role="status"\s+aria-label="Your side"/);
    const heading = code.indexOf(">Get into the Dota lobby<");
    const line = code.indexOf('aria-label="Your side"');
    const panel = code.indexOf("<DotaLobbyControls");
    expect(heading).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(heading);
    expect(panel).toBeGreaterThan(line);
    // One line, one name.
    expect(code.match(/aria-label="Your side"/g)).toHaveLength(1);
  });
});
