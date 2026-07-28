import { describe, it, expect } from "vitest";
import { escapeDiscordText } from "./discord-escape";

describe("escapeDiscordText", () => {
  it("leaves ordinary names untouched — the common case must not be mangled", () => {
    expect(escapeDiscordText("Puppey")).toBe("Puppey");
    expect(escapeDiscordText("Team Liquid")).toBe("Team Liquid");
  });

  it("defuses formatting and fake mentions", () => {
    expect(escapeDiscordText("**boss**")).toBe("\\*\\*boss\\*\\*");
    expect(escapeDiscordText("@everyone")).toBe("\\@everyone");
    expect(escapeDiscordText("<t:0:R>")).toBe("\\<t:0:R\\>");
  });

  // The reason this had to leave inhouse-board.ts: Discord does NOT suppress
  // masked links in webhook messages the way it does for user-typed ones, so a
  // persona like this arrives as a live link that looks league-authored.
  it("kills a masked link", () => {
    const out = escapeDiscordText("[free mmr](https://evil.test)");
    expect(out).not.toContain("](");
    expect(out).not.toContain("https://");
  });

  it("stops a bare url auto-linking", () => {
    expect(escapeDiscordText("https://evil.test/free")).not.toContain(
      "https://",
    );
    expect(escapeDiscordText("www.evil.test")).not.toContain("www.");
  });

  it("strips newlines — a name must never forge an extra line", () => {
    expect(escapeDiscordText("evil\nplayer")).not.toContain("\n");
    expect(escapeDiscordText("a\r\n\tb")).toBe("a b");
  });

  // Announcements pass no maxLen: clipping a team name in a result post is
  // worse than a long line. Only fixed-height surfaces (the board's rack) do.
  it("does NOT truncate unless asked", () => {
    const long = "x".repeat(200);
    expect(escapeDiscordText(long)).toHaveLength(200);
    expect(escapeDiscordText(long, 32)).toHaveLength(32);
    expect(escapeDiscordText(long, 32).endsWith("…")).toBe(true);
  });

  it("strips newlines BEFORE truncating — ordering is load-bearing", () => {
    // Were it the other way round, the newline could survive inside the kept
    // prefix and forge a row on a surface that counts lines.
    expect(escapeDiscordText(`${"a".repeat(10)}\n${"b".repeat(40)}`, 20)).not.toContain(
      "\n",
    );
  });
});
