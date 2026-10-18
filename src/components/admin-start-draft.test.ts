import { describe, expect, it } from "vitest";
import {
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

// The Start-draft confirm's Discord line says "of N signed-up players", and
// the same confirm counts readiness over PLAYER signups only. A funnel over
// every active signup (standins too) made it read "0 of 62 ready" and then
// "of 65 signed-up players". Wherever the line is built, the funnel behind
// it must be the players-only one.
describe("the Start-draft confirm's Discord line", () => {
  const builders = sourceFiles(["src/**/*.{ts,tsx}"], 300)
    .filter((f) => f.path !== "src/lib/discord-reach.ts")
    .map((f) => ({ path: f.path, code: stripLineComments(f.text) }))
    .filter((f) => f.code.includes("discordReachWarning("));

  it("finds where the line is built (guard is not vacuous)", () => {
    expect(builders.map((f) => f.path)).toContain(
      "src/components/admin-start-draft.tsx",
    );
  });

  it("counts PLAYER signups only, like the readiness counts beside it", () => {
    for (const f of builders) {
      expect(
        f.code,
        `${f.path} builds the Start-draft Discord line from a funnel that ` +
          `counts standins too; pass { playersOnly: true }.`,
      ).toMatch(/getDiscordReachFunnel\([^)]*\{\s*playersOnly: true\s*\}\)/);
    }
  });
});
