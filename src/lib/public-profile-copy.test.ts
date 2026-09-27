import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";

const source = (relative: string) =>
  readFileSync(path.resolve(process.cwd(), relative), "utf8");

const me = source("src/app/me/page.tsx");

/**
 * Every application source file. The retired links and the misleading
 * phrases below were first found on /login, /me, the footer and the Steam
 * button, but copy moves between files, so the bans cover everything.
 */
const ALL_SOURCE = sourceFiles("src/**/*.{ts,tsx,mjs}", 300);
const filesWith = (text: string) =>
  ALL_SOURCE.filter((f) => f.text.includes(text)).map((f) => f.path);

describe("public profile explanations", () => {
  it("still reads the account and navigation surfaces it was written for", () => {
    const paths = ALL_SOURCE.map((f) => f.path);
    for (const file of [
      "src/app/login/page.tsx",
      "src/app/me/page.tsx",
      "src/components/ui.tsx",
      "src/components/discord-setup.tsx",
      "src/components/site-footer.tsx",
      "src/app/players/[id]/page.tsx",
    ]) {
      expect(paths).toContain(file);
    }
  });

  it("keeps retired policy links out of every page and component", () => {
    // /privacy and /terms no longer exist, so a link to either is a 404.
    expect(filesWith('href="/privacy"')).toEqual([]);
    expect(filesWith('href="/terms"')).toEqual([]);
  });

  it("says once that the signup is public and rejects misleading provider copy", () => {
    // One blanket statement covers every field on the form (it replaced a
    // per-category list plus a "shown publicly" line under each field). The
    // medal is named because it is public without being on the form.
    const notice = me.replace(/\s+/g, " ");
    for (const disclosure of [
      "Everything on this form, and your medal, is public in the player pool and on your profile.",
      "Your Discord is only shown to league admins and players signed up this season.",
      "Keep contact, health and availability details out of the text boxes.",
      "Joining lets the league refresh your public Steam and Dota data.",
    ]) {
      expect(notice).toContain(disclosure);
    }
    for (const misleading of [
      "Only to get your name and profile",
      "only ever read your username",
      "captains see these",
      'placeholder="Why you\'re here, your goals, availability',
      "Signup details, availability, and recent activity",
    ]) {
      expect(filesWith(misleading), misleading).toEqual([]);
    }
  });
});
