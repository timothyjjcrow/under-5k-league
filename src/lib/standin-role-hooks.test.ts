import { describe, expect, it } from "vitest";
import {
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

// SOURCE GUARDS for the Discord Standin role (standin-role-service.ts). The
// automatic pass only runs where something calls it, and nothing fails when
// a call site goes missing: the role just drifts until an admin presses Sync.
// test/integration/standin-role.itest.ts drives the actions, the auction's
// last sale and the passes themselves; these pin the two sites a behavioural
// test can't reach (the worker step and the OAuth callback's default deps)
// and the shape of the rest.

/** One top-level function's text, from its declaration to the next one. */
function fn(src: string, name: string): string {
  const at = src.search(new RegExp(`\\n(export )?(async )?function ${name}\\b`));
  if (at === -1) return "";
  const rest = src.slice(at + 1);
  const next = rest.search(/\n(export |async function |function |const |type )/);
  return next === -1 ? rest : rest.slice(0, next);
}

const code = (path: string) => stripLineComments(sourceFile(path).text);

describe("who runs the automatic Standin role pass", () => {
  it("every admin action, through refresh() and refreshGames()", () => {
    const src = code("src/app/actions/admin-shared.ts");
    expect(fn(src, "refresh")).toContain("refreshStandinRole()");
    expect(fn(src, "refreshGames")).toContain("refreshStandinRole()");
  });

  it("the player actions, through registration.ts's refresh()", () => {
    const src = code("src/app/actions/registration.ts");
    expect(fn(src, "refresh")).toContain("refreshStandinRole()");
  });

  it("the auction's completion, whichever request closes the last lot", () => {
    const src = code("src/lib/draft-service.ts");
    expect(fn(src, "announceDraftComplete")).toContain("refreshStandinRole()");
  });

  it("the Discord link callback, for the new account, skipping the absentee wait", () => {
    const src = code("src/lib/discord-link-service.ts");
    expect(src).toMatch(
      /syncStandinRole: \(discordId\) =>\s*refreshStandinRole\(\{ retryNow: \[discordId\] \}\)/,
    );
    expect(fn(src, "handleDiscordCallback")).toContain(
      "deps.syncStandinRole?.(profile.discordId)",
    );
  });

  it("the worker, after the import or lot that may change the season", () => {
    const src = code("src/lib/result-sync-service.ts");
    expect(src).toMatch(
      /syncStandinRoleFromWorker\(\s*league\.imported > 0 \|\| draft\.advanced \|\| playoff,/,
    );
  });
});

describe("how the Standin role reaches Discord", () => {
  it("only through discord-roles.ts's setStandinRole, never a raw request", () => {
    const service = code("src/lib/standin-role-service.ts");
    expect(service).not.toMatch(/\bfetch\(/);
    expect(service).toContain("setStandinRole(");
    // And no other file writes the role or its ledger.
    const writers = sourceFiles("src/**/*.{ts,tsx}", 300).filter(
      (f) =>
        f.path !== "src/lib/standin-role-service.ts" &&
        f.path !== "src/lib/discord-roles.ts" &&
        /setStandinRole\(|STANDIN_ROLE_STATE/.test(stripLineComments(f.text)) &&
        f.path !== "src/lib/settings.ts",
    );
    expect(writers.map((f) => f.path)).toEqual([]);
  });

  it("is off wherever Discord writes are", () => {
    const roles = code("src/lib/discord-roles.ts");
    expect(fn(roles, "getStandinRoleConfig")).toContain(
      "if (!discordMutationsAllowed()) return null;",
    );
  });
});
