import { describe, expect, it } from "vitest";
import { soundButtonState, soundToggleNext } from "./room-sound";

describe("soundButtonState", () => {
  it("says locked while the bell is wanted but the browser holds audio", () => {
    expect(soundButtonState(true, false)).toBe("locked");
  });

  it("says on only when the bell is wanted and can ring", () => {
    expect(soundButtonState(true, true)).toBe("on");
  });

  it("says muted when the viewer muted it, locked or not", () => {
    expect(soundButtonState(false, false)).toBe("muted");
    expect(soundButtonState(false, true)).toBe("muted");
  });
});

describe("soundToggleNext", () => {
  it("turns a locked bell ON: the tap unlocks it, it never mutes it", () => {
    expect(soundToggleNext(true, false)).toBe(true);
  });

  it("flips an unlocked bell and a muted one", () => {
    expect(soundToggleNext(true, true)).toBe(false);
    expect(soundToggleNext(false, true)).toBe(true);
    expect(soundToggleNext(false, false)).toBe(true);
  });
});
