import { describe, expect, it } from "vitest";
import {
  DETECT_WINDOW_AFTER_MS,
  DETECT_WINDOW_BEFORE_MS,
  knownPlayersPerSide,
} from "./league-result-window";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("league result window", () => {
  it("accepts games from three days before to six days after kickoff", () => {
    expect(DETECT_WINDOW_BEFORE_MS).toBe(3 * DAY_MS);
    expect(DETECT_WINDOW_AFTER_MS).toBe(6 * DAY_MS);
  });

  it("needs three known players a side, or every seat of a smaller team", () => {
    expect(knownPlayersPerSide(5)).toBe(3);
    expect(knownPlayersPerSide(3)).toBe(3);
    expect(knownPlayersPerSide(2)).toBe(2);
    expect(knownPlayersPerSide(1)).toBe(1);
  });
});
