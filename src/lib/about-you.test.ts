import { describe, expect, it } from "vitest";
import {
  ABOUT_MAX_LENGTH,
  aboutText,
  aboutUnchanged,
  submittedAbout,
} from "./about-you";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("aboutText", () => {
  it("joins an older signup's note and goals, note first", () => {
    expect(
      aboutText({ captainNote: "Happy on 4 or 5.", statement: "Learn to lane." }),
    ).toBe("Happy on 4 or 5.\n\nLearn to lane.");
    expect(
      aboutText({ captainNote: "Pos 4", statement: "Improve" }, " · "),
    ).toBe("Pos 4 · Improve");
  });

  it("shows whichever part exists, and nothing for blanks", () => {
    expect(aboutText({ captainNote: "", statement: "Just goals" })).toBe(
      "Just goals",
    );
    expect(aboutText({ captainNote: "Just a note", statement: null })).toBe(
      "Just a note",
    );
    expect(aboutText({ captainNote: "  \n", statement: "\t" })).toBe("");
    expect(aboutText({})).toBe("");
  });

  it("shows a part repeated word for word once", () => {
    expect(aboutText({ captainNote: "Same words", statement: " Same words " })).toBe(
      "Same words",
    );
  });

  it("normalizes browser line breaks", () => {
    expect(aboutText({ captainNote: "line one\r\nline two" })).toBe(
      "line one\nline two",
    );
  });
});

describe("submittedAbout", () => {
  it("reads the merged box, trimmed, with LF line breaks", () => {
    expect(submittedAbout(form({ about: "  Mid main\r\n\r\nWants to learn  " }))).toBe(
      "Mid main\n\nWants to learn",
    );
  });

  it("joins the two old fields from a page loaded before the merge", () => {
    expect(
      submittedAbout(form({ statement: "Goals", captainNote: "Note" })),
    ).toBe("Note\n\nGoals");
  });

  it("prefers the merged box even when it is empty (the player cleared it)", () => {
    expect(submittedAbout(form({ about: "", statement: "stale" }))).toBe("");
  });

  it("clamps to the box's limit", () => {
    expect(submittedAbout(form({ about: "x".repeat(5000) }))).toHaveLength(
      ABOUT_MAX_LENGTH,
    );
  });
});

describe("aboutUnchanged", () => {
  const stored = { captainNote: "Note", statement: "Goals" };

  it("is true when the box comes back exactly as the form showed it", () => {
    expect(aboutUnchanged(submittedAbout(form({ about: aboutText(stored) })), stored)).toBe(true);
    // Browsers post the joined default back with CRLF breaks.
    expect(aboutUnchanged(submittedAbout(form({ about: "Note\r\n\r\nGoals" })), stored)).toBe(true);
  });

  it("is false once the player edits it", () => {
    expect(aboutUnchanged("Note\n\nGoals and more", stored)).toBe(false);
    expect(aboutUnchanged("", stored)).toBe(false);
  });

  it("keeps two full-length old answers untouched rather than cutting them", () => {
    const long = { captainNote: "a".repeat(1000), statement: "b".repeat(1000) };
    const shown = aboutText(long);
    expect(shown.length).toBeGreaterThan(ABOUT_MAX_LENGTH);
    expect(aboutUnchanged(submittedAbout(form({ about: shown })), long)).toBe(true);
  });
});
