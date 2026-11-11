import { describe, expect, it } from "vitest";
import { MATCH_ANCHOR } from "./match-anchors";
import { teamWeekNotes } from "./team-week";

const counts = { in: 3, out: 0, noReply: 2, openSeats: 0, of: 5 };
const base = {
  role: "captain" as const,
  counts,
  outNames: null,
  standinsOpen: true,
  bookings: [],
  requests: { mine: 0, theirs: 0 },
  otherTeamName: "Radiant Raccoons",
  readyCheck: null,
};

describe("teamWeekNotes", () => {
  it("says nothing when nothing is waiting", () => {
    expect(teamWeekNotes(base)).toEqual([]);
  });

  it("tells the captain who is out with no cover, and where to fix it", () => {
    expect(
      teamWeekNotes({
        ...base,
        counts: { ...counts, out: 2 },
        outNames: ["Ana", "Bo"],
      }),
    ).toEqual([
      {
        key: "out",
        tone: "danger",
        text: "Ana, Bo can't make it and have no cover yet.",
        link: { anchor: MATCH_ANCHOR.standins, label: "Find a standin" },
      },
    ]);
  });

  it("counts instead of naming when the names aren't the viewer's to see", () => {
    expect(
      teamWeekNotes({ ...base, counts: { ...counts, out: 1 } })[0].text,
    ).toBe("1 player can't make it and has no cover yet.");
  });

  it("drops the cover link once bookings are closed, keeping the fact", () => {
    expect(
      teamWeekNotes({
        ...base,
        standinsOpen: false,
        counts: { ...counts, openSeats: 1 },
      }),
    ).toEqual([
      {
        key: "open-seats",
        tone: "danger",
        text: "1 open seat with nobody lined up.",
        link: null,
      },
    ]);
  });

  it("keeps a captain's jobs away from a player", () => {
    const notes = teamWeekNotes({
      ...base,
      role: "player",
      counts: { ...counts, out: 1, openSeats: 1 },
      requests: { mine: 1, theirs: 1 },
      bookings: [{ standinName: "Larry", replacingName: null }],
      readyCheck: { mine: false, options: 2 },
    });
    expect(notes.map((n) => n.key)).toEqual(["ready-check", "bookings"]);
    expect(notes[0]).toMatchObject({
      text: "A captain offered 2 new times for this match.",
      link: { anchor: MATCH_ANCHOR.reschedule, label: "Answer the ready check" },
    });
    expect(notes[1].text).toBe("Standing in: Larry in an open seat.");
    expect(
      teamWeekNotes({
        ...base,
        role: "player",
        bookings: [{ standinName: "Larry", replacingName: "Bo" }],
      })[0].text,
    ).toBe("Standing in: Larry for Bo.");
  });

  it("orders the captain's lines by who is waiting on whom", () => {
    const notes = teamWeekNotes({
      ...base,
      counts: { ...counts, out: 1 },
      outNames: ["Ana"],
      requests: { mine: 1, theirs: 2 },
      bookings: [{ standinName: "Larry", replacingName: "Bo" }],
      readyCheck: { mine: true, options: 1 },
    });
    // No "Standing in" line: a viewer with names reads cover in the card's
    // own Covered row.
    expect(notes.map((n) => n.key)).toEqual([
      "out",
      "requests-theirs",
      "ready-check",
      "requests-mine",
    ]);
    expect(notes[1].text).toBe(
      "The Radiant Raccoons captain wants 2 standins and needs your OK.",
    );
    expect(notes[2]).toMatchObject({
      text: "Your ready check is open: you offered a new time.",
      link: { label: "See the answers" },
    });
    expect(notes[3].text).toBe(
      "Waiting on the Radiant Raccoons captain's OK for your standin.",
    );
  });

  it("asks a captain who didn't propose to answer the ready check", () => {
    expect(
      teamWeekNotes({ ...base, readyCheck: { mine: false, options: 1 } })[0],
    ).toMatchObject({
      text: "A captain offered a new time for this match.",
      link: { anchor: MATCH_ANCHOR.reschedule, label: "Answer the ready check" },
    });
  });
});
