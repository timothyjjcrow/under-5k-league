import { describe, expect, it } from "vitest";
import { splitLeadingEmoji } from "./leading-emoji";

describe("splitLeadingEmoji", () => {
  it("splits the Hall of Fame board titles", () => {
    for (const [title, emoji, rest] of [
      ["🏆 Championship contributions", "🏆", "Championship contributions"],
      ["⚔️ Series wins", "⚔️", "Series wins"],
      ["🎮 Game wins", "🎮", "Game wins"],
      ["📈 Game win rate", "📈", "Game win rate"],
      ["✨ Fantasy per game", "✨", "Fantasy per game"],
      ["🎯 Fantasy total", "🎯", "Fantasy total"],
      ["🔮 Pick'em accuracy", "🔮", "Pick'em accuracy"],
    ])
      expect(splitLeadingEmoji(title)).toEqual({ emoji, rest });
  });

  it("keeps joined and modified emoji whole", () => {
    expect(splitLeadingEmoji("🕵️‍♂️ Best steal")).toEqual({
      emoji: "🕵️‍♂️",
      rest: "Best steal",
    });
    expect(splitLeadingEmoji("👍🏽 Nice")).toEqual({ emoji: "👍🏽", rest: "Nice" });
  });

  it("leaves labels without a leading emoji alone", () => {
    for (const text of [
      "Series wins",
      "Bo3",
      "Win 🏆 now",
      "🏆",
      "🏆Champions",
      "3 wins",
      "#1 seed",
      "",
    ])
      expect(splitLeadingEmoji(text)).toEqual({ emoji: null, rest: text });
  });
});
