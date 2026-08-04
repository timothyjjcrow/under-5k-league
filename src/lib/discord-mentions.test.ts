import { describe, it, expect } from "vitest";
import { mentionsOf } from "./discord-mentions";

describe("mentionsOf", () => {
  it("wraps the snowflakes it was given", () => {
    expect(
      mentionsOf(["123456789012345678", "223456789012345678"]),
    ).toEqual({ users: ["123456789012345678", "223456789012345678"] });
  });

  // The whole point of the helper: a call site that inlined this would build
  // { users: [undefined] } the first time it met an unlinked player, and
  // Discord rejects the payload — silently, because every send is best-effort.
  it("drops nulls and undefined rather than sending them", () => {
    expect(
      mentionsOf(["123456789012345678", null, undefined, ""]),
    ).toEqual({
      users: ["123456789012345678"],
    });
  });

  it("dedupes — the same captain can be named twice by one message", () => {
    expect(
      mentionsOf(["123456789012345678", "123456789012345678"]),
    ).toEqual({ users: ["123456789012345678"] });
  });

  // undefined, NOT { users: [] } — an empty allowlist is a payload difference
  // for no reason, and returning undefined means a league where nobody has
  // linked sends byte-for-byte what it sent before mentions existed.
  it.each([[[]], [[null, undefined]], [[""]]])(
    "is undefined when nobody is reachable (%j)",
    (ids) => {
      expect(mentionsOf(ids as (string | null | undefined)[])).toBeUndefined();
    },
  );
});
