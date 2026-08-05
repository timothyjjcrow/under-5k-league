import { describe, expect, it } from "vitest";
import { bool, clampInt, localDate, str } from "./form";

function fd(values: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

describe("str", () => {
  it("returns a present string field verbatim", () => {
    expect(str(fd({ name: "Radiant Rejects" }), "name")).toBe("Radiant Rejects");
    expect(str(fd({ name: "  padded  " }), "name")).toBe("  padded  "); // no trim
    expect(str(fd({ name: "" }), "name")).toBe(""); // empty is a real value
  });

  it("falls back for a missing field ('' by default)", () => {
    expect(str(fd(), "missing")).toBe("");
    expect(str(fd(), "missing", "default")).toBe("default");
  });

  it("falls back for a non-string entry (file uploads)", () => {
    const f = new FormData();
    f.set("upload", new Blob(["not a string"]));
    expect(str(f, "upload")).toBe("");
    expect(str(f, "upload", "fallback")).toBe("fallback");
  });
});

describe("bool", () => {
  it("accepts exactly the three truthy encodings: 'on', 'true', '1'", () => {
    expect(bool(fd({ k: "on" }), "k")).toBe(true); // checkbox default
    expect(bool(fd({ k: "true" }), "k")).toBe(true);
    expect(bool(fd({ k: "1" }), "k")).toBe(true);
  });

  it("everything else is false — including case variants and 'yes'", () => {
    expect(bool(fd(), "missing")).toBe(false);
    expect(bool(fd({ k: "" }), "k")).toBe(false);
    expect(bool(fd({ k: "off" }), "k")).toBe(false);
    expect(bool(fd({ k: "false" }), "k")).toBe(false);
    expect(bool(fd({ k: "0" }), "k")).toBe(false);
    // Strict matching, as implemented: no case folding, no natural language.
    expect(bool(fd({ k: "TRUE" }), "k")).toBe(false);
    expect(bool(fd({ k: "On" }), "k")).toBe(false);
    expect(bool(fd({ k: "yes" }), "k")).toBe(false);
  });

  it("a non-string entry is false", () => {
    const f = new FormData();
    f.set("k", new Blob(["true"]));
    expect(bool(f, "k")).toBe(false);
  });
});

describe("clampInt", () => {
  it("parses and passes through an in-range integer", () => {
    expect(clampInt(fd({ n: "5" }), "n", 0, 1, 10)).toBe(5);
    expect(clampInt(fd({ n: "1" }), "n", 0, 1, 10)).toBe(1); // bounds inclusive
    expect(clampInt(fd({ n: "10" }), "n", 0, 1, 10)).toBe(10);
  });

  it("clamps out-of-range values to the nearer bound", () => {
    expect(clampInt(fd({ n: "0" }), "n", 5, 1, 10)).toBe(1);
    expect(clampInt(fd({ n: "-3" }), "n", 5, 1, 10)).toBe(1);
    expect(clampInt(fd({ n: "999" }), "n", 5, 1, 10)).toBe(10);
  });

  it("returns the fallback for missing / unparseable values", () => {
    expect(clampInt(fd(), "missing", 7, 1, 10)).toBe(7);
    expect(clampInt(fd({ n: "" }), "n", 7, 1, 10)).toBe(7);
    expect(clampInt(fd({ n: "abc" }), "n", 7, 1, 10)).toBe(7);
    const f = new FormData();
    f.set("n", new Blob(["5"]));
    expect(clampInt(f, "n", 7, 1, 10)).toBe(7);
  });

  it("the fallback itself is NOT clamped — callers own its sanity", () => {
    // As implemented: an unparseable field returns the fallback verbatim, even
    // when it sits outside [min, max]. Pin it so a future "fix" is deliberate.
    expect(clampInt(fd(), "missing", 999, 1, 10)).toBe(999);
  });

  it("rejects decimals, exponents, and trailing junk instead of truncating", () => {
    expect(clampInt(fd({ n: "3.9" }), "n", 7, 1, 10)).toBe(7);
    expect(clampInt(fd({ n: "4px" }), "n", 7, 1, 10)).toBe(7);
    expect(clampInt(fd({ n: "1e2" }), "n", 7, 1, 10)).toBe(7);
  });
});

describe("localDate", () => {
  it("prefers the browser-computed epoch over the raw string", () => {
    const ts = Date.UTC(2026, 6, 30, 19, 0, 0);
    const d = localDate(
      fd({ night: "2026-07-30T19:00", nightTs: String(ts) }),
      "night",
      "nightTs",
    );
    expect(d?.getTime()).toBe(ts);
  });

  it("an emptied input means 'clear', whatever ts says", () => {
    const stale = String(Date.now());
    expect(localDate(fd({ night: "", nightTs: stale }), "night", "nightTs")).toBeNull();
    expect(localDate(fd({ night: "   ", nightTs: stale }), "night", "nightTs")).toBeNull();
    expect(localDate(fd(), "night", "nightTs")).toBeNull();
  });

  it("falls back to parsing the raw string for no-JS submissions", () => {
    const d = localDate(fd({ night: "2026-07-30T19:00" }), "night", "nightTs");
    expect(d).not.toBeNull();
    // Parsed in the local zone — the exact hour is host-dependent, but the
    // calendar date survives (the server-zone caveat is the field's docstring).
    expect(d?.getFullYear()).toBe(2026);
  });

  it("a non-positive or non-finite ts also falls back to the raw string", () => {
    const raw = "2026-07-30T19:00";
    expect(localDate(fd({ night: raw, nightTs: "0" }), "night", "nightTs")).not.toBeNull();
    expect(localDate(fd({ night: raw, nightTs: "-5" }), "night", "nightTs")).not.toBeNull();
    expect(
      localDate(fd({ night: raw, nightTs: "garbage" }), "night", "nightTs"),
    ).not.toBeNull();
  });

  it("unparseable raw with no usable ts is null", () => {
    expect(
      localDate(fd({ night: "not a date", nightTs: "" }), "night", "nightTs"),
    ).toBeNull();
  });
});
