import { describe, expect, it } from "vitest";
import {
  sourceFile,
  stripLineComments,
} from "../../test/support/source-files";

// SOURCE GUARD: vitest runs without jsdom. The admin's bot line checks the
// bot every 15s (LOBBY_RECOVERY_POLL_MS); 2026-10-18 review: each background
// check took the button's lock, so "Check bot connection" flipped to
// "Checking bot…" every 15s and a press during a check was dropped.
describe("DotaLobbyRecovery checks (source)", () => {
  const code = stripLineComments(
    sourceFile("src/components/dota-lobby-recovery.tsx").text,
  );

  it("polls at LOBBY_RECOVERY_POLL_MS while the tab is visible", () => {
    expect(code).toMatch(
      /if \(document\.visibilityState === "visible"\) void check\(false, abort\.signal\);\s*\}, LOBBY_RECOVERY_POLL_MS\);/,
    );
  });

  it("holds the button's lock only for a press", () => {
    expect(code).toMatch(/const \[pending, setPending\] = useState\(false\);/);
    const sets = code.match(/setPending\([^)]*\)/g) ?? [];
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      const at = code.indexOf(set);
      expect(code.slice(Math.max(0, at - 16), at), set).toMatch(/if \(manual\) $/);
    }
    expect(code).toMatch(/disabled=\{pending\}/);
  });

  it("lets a press win over a background check in flight", () => {
    // A background check stands down while any check runs; a press stands
    // down only for another press, and aborts a background one.
    expect(code).toMatch(/if \(running && \(!manual \|\| running\.manual\)\) return;/);
    expect(code).toMatch(/running\?\.controller\.abort\(\);/);
    // The superseded check's answer never lands.
    expect(code).toMatch(/if \(stale\(\)\) return;/);
  });
});
