import { describe, expect, it } from "vitest";
import { sourceFile, sourceFiles } from "../../test/support/source-files";

/**
 * The small invite credit (src/lib/invite-credit.ts) rests on wiring that the
 * pure rules' tests can't see:
 * 1. the root layout mounts InviteRefCapture, or no link remembers anything;
 * 2. only that client component writes the cookie, never a route or action a
 *    GET can reach, or an <img> on any page could claim the credit for its
 *    viewers;
 * 3. every InviteLink passes `refId`, so a signed-up player's copy is tagged
 *    (a caller for viewers who aren't signed up passes null on purpose).
 */
describe("invite credit wiring", () => {
  it("mounts the tag capture in the root layout, and the capture uses the pure rules", () => {
    expect(sourceFile("src/app/layout.tsx").text).toMatch(/<InviteRefCapture\s*\/>/);
    const capture = sourceFile("src/components/invite-ref-capture.tsx").text;
    for (const rule of [
      "inviteRefFromSearch(",
      "shouldRememberInviteRef(",
      "searchWithoutRef(",
    ]) {
      expect(capture).toContain(rule);
    }
  });

  it("writes the invite cookie only in the client capture", () => {
    const writers = sourceFiles(["src/**/*.ts", "src/**/*.tsx"], 300)
      .filter(
        (file) =>
          file.text.includes("INVITE_REF_COOKIE") &&
          /document\.cookie\s*=|\.set\(\s*INVITE_REF_COOKIE/.test(file.text),
      )
      .map((file) => file.path);
    expect(writers).toEqual(["src/components/invite-ref-capture.tsx"]);
  });

  it("tags every invite link", () => {
    const callers = sourceFiles("src/**/*.tsx", 100).filter((file) =>
      file.text.includes("<InviteLink"),
    );
    expect(callers.length).toBeGreaterThanOrEqual(2);
    for (const file of callers) {
      expect(file.text, file.path).toMatch(/<InviteLink\b[^>]*\brefId=\{/);
    }
  });
});
