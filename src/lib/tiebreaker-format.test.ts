import { describe, expect, it } from "vitest";
import { tiebreakerArchiveIntro } from "./tiebreaker-format";

describe("tiebreakerArchiveIntro", () => {
  it("describes the games as they were played", () => {
    expect(tiebreakerArchiveIntro([1, 1, 1])).toBe(
      "Best-of-one knockout games settled playoff qualification and seed order.",
    );
    // Seasons archived before the BO1 brackets kept their series.
    expect(tiebreakerArchiveIntro([3, 3])).toBe(
      "Best-of-three series settled playoff qualification and seed order.",
    );
    expect(tiebreakerArchiveIntro([1, 3])).toBe(
      "Tiebreaker games settled playoff qualification and seed order.",
    );
    expect(tiebreakerArchiveIntro([])).toBe(
      "Tiebreaker games settled playoff qualification and seed order.",
    );
  });
});
