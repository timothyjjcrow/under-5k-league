import { describe, expect, it } from "vitest";
import { inhouseQueueLeadsHome } from "./home-inhouse";

describe("inhouseQueueLeadsHome", () => {
  it("leads Home while anyone is queued", () => {
    expect(inhouseQueueLeadsHome({ queued: 1, nightOn: false })).toBe(true);
    expect(inhouseQueueLeadsHome({ queued: 9, nightOn: false })).toBe(true);
  });

  it("keeps its usual place with an empty queue", () => {
    expect(inhouseQueueLeadsHome({ queued: 0, nightOn: false })).toBe(false);
    expect(inhouseQueueLeadsHome({ queued: 0, nightOn: true })).toBe(false);
  });

  it("stays put while the night is on: the night's bar prints the queue", () => {
    expect(inhouseQueueLeadsHome({ queued: 4, nightOn: true })).toBe(false);
  });
});
