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

  it("pins every public signup category and rejects misleading provider copy", () => {
    for (const field of [
      "participation type",
      "MMR",
      "preferred roles",
      "favorite heroes",
      "captain",
      "goals",
      "captain note",
    ]) {
      expect(me).toContain(field);
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
