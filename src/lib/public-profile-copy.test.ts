import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relative: string) =>
  readFileSync(path.resolve(process.cwd(), relative), "utf8");

const login = source("src/app/login/page.tsx");
const me = source("src/app/me/page.tsx");
const steam = source("src/components/ui.tsx");
const discord = source("src/components/discord-setup.tsx");
const footer = source("src/components/site-footer.tsx");
const profile = source("src/app/players/[id]/page.tsx");

describe("public profile explanations", () => {
  it("keeps retired policy links out of account and global navigation surfaces", () => {
    for (const text of [login, me, steam, footer]) {
      expect(text).not.toContain('href="/privacy"');
      expect(text).not.toContain('href="/terms"');
    }
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
    expect(`${steam}\n${me}\n${discord}`).not.toContain(
      "Only to get your name and profile",
    );
    expect(`${me}\n${discord}`).not.toContain("only ever read your username");
    expect(me).not.toContain("captains see these");
    expect(me).not.toContain(
      'placeholder="Why you\'re here, your goals, availability',
    );
    expect(profile).not.toContain(
      "Signup details, availability, and recent activity",
    );
  });
});
