import { describe, expect, it } from "vitest";
import {
  returningReminderMessage,
  type ReturningPlayers,
} from "./returning-players";

const players = (notBack: ReturningPlayers["notBack"]): ReturningPlayers => ({
  previousSeasonName: "Season 1",
  previous: 40,
  back: 40 - notBack.length,
  notBack,
});
const OPTS = { seasonName: "Season 2", signedUp: 31, signupUrl: "https://ggd2l.test/me" };

describe("returningReminderMessage", () => {
  it("says the progress and that answers carry over, then names who isn't back", () => {
    const text = returningReminderMessage(
      players([
        { name: "Ana", discordId: "123456789012345678" },
        { name: "Bo", discordId: null },
      ]),
      OPTS,
    );
    expect(text).toContain("**Season 2 signups are open**: 31 players in so far");
    expect(text).toContain("Played in Season 1? Your roles, heroes and MMR carry over");
    expect(text).toContain("<https://ggd2l.test/me>");
    // Linked players are mentioned (the admin's paste pings them); the rest
    // are named.
    expect(text).toMatch(/\n<@123456789012345678>, Bo$/);
  });

  it("never turns a name into a mention or a link", () => {
    const text = returningReminderMessage(
      players([{ name: "@everyone http://x.example", discordId: "not-an-id" }]),
      OPTS,
    );
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("http://");
    expect(text).not.toContain("<@not-an-id>");
  });

  it("stays under Discord's 2,000 characters and counts the rest", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `Player number ${i}`,
      discordId: null,
    }));
    const text = returningReminderMessage(players(many), OPTS) ?? "";
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/ and \d+ more$/);
  });

  it("has nothing to say once everyone is back", () => {
    expect(returningReminderMessage(players([]), OPTS)).toBeNull();
  });
});
