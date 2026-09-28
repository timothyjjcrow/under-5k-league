import { describe, expect, it } from "vitest";
import {
  checkinCountsText,
  checkinPrompt,
  checkinSide,
  sideNeedsCover,
  standinSeatText,
  type CheckinSideBooking,
} from "./checkin-side";

const roster = [
  { userId: "cap", name: "Cap" },
  { userId: "p1", name: "Ana" },
  { userId: "p2", name: "Bo" },
  { userId: "p3", name: "Cy" },
  { userId: "p4", name: "Di" },
];

function side(
  over: Partial<Parameters<typeof checkinSide>[0]> = {},
) {
  return checkinSide({
    viewerId: "p1",
    teamName: "Roshan's Revenge",
    captain: { id: "cap", name: "Cap" },
    roster,
    bookings: [],
    rows: [],
    teamSize: 5,
    showNames: false,
    ...over,
  });
}

const cover = (
  standinUserId: string,
  replacingUserId: string | null,
): CheckinSideBooking => ({
  standinUserId,
  standinName: standinUserId === "sub" ? "Sub" : "Other",
  replacingUserId,
  replacingName: roster.find((m) => m.userId === replacingUserId)?.name ?? null,
});

describe("checkinSide: who the viewer is here", () => {
  it("is the captain for the side's captain, with no captain named to them", () => {
    const s = side({ viewerId: "cap" });
    expect(s?.role).toBe("captain");
    expect(s?.captainName).toBeNull();
    expect(s?.standinFor).toBeUndefined();
  });

  it("is a player with their captain's name", () => {
    const s = side();
    expect(s?.role).toBe("player");
    expect(s?.captainName).toBe("Cap");
    expect(s?.teamName).toBe("Roshan's Revenge");
  });

  it("is a standin, told whose seat they fill", () => {
    const s = side({ viewerId: "sub", bookings: [cover("sub", "p4")] });
    expect(s?.role).toBe("standin");
    expect(s?.standinFor).toBe("Di");
    expect(s?.captainName).toBe("Cap");
  });

  it("is a standin in an open seat (a short roster)", () => {
    const s = side({
      viewerId: "sub",
      roster: roster.slice(0, 4),
      bookings: [cover("sub", null)],
    });
    expect(s?.role).toBe("standin");
    expect(s?.standinFor).toBeNull();
  });

  it("is nobody when a standin has their seat, or they aren't on the side", () => {
    expect(side({ bookings: [cover("sub", "p1")] })).toBeNull();
    expect(side({ viewerId: "stranger" })).toBeNull();
  });

  it("ignores a stale booking for a player who left the roster", () => {
    // Nobody named "gone" is on the roster, so the standin isn't playing.
    const s = side({
      viewerId: "sub",
      bookings: [{ ...cover("sub", null), replacingUserId: "gone", replacingName: "Gone" }],
    });
    expect(s).toBeNull();
  });
});

describe("checkinSide: the side's count", () => {
  it("counts in, out and no reply over the match-night roster", () => {
    const s = side({
      rows: [
        { userId: "cap", status: "IN" },
        { userId: "p1", status: "IN" },
        { userId: "p2", status: "IN" },
        { userId: "p3", status: "OUT" },
        // Another side's row, and a garbage status, count for nothing.
        { userId: "enemy", status: "IN" },
        { userId: "p4", status: "MAYBE" },
      ],
    });
    expect(s?.counts).toEqual({ in: 3, out: 1, noReply: 1, openSeats: 0, of: 5 });
  });

  it("counts a standin's own answer instead of the covered player's", () => {
    const s = side({
      bookings: [cover("sub", "p3")],
      rows: [
        { userId: "p3", status: "OUT" },
        { userId: "sub", status: "IN" },
      ],
    });
    expect(s?.counts).toEqual({ in: 1, out: 0, noReply: 4, openSeats: 0, of: 5 });
  });

  it("shows a short side's empty seat, out of the season's side size", () => {
    const s = side({ roster: roster.slice(0, 4) });
    expect(s?.counts).toEqual({ in: 0, out: 0, noReply: 4, openSeats: 1, of: 5 });
  });
});

describe("checkinSide: names", () => {
  const rows = [
    { userId: "cap", status: "IN" },
    { userId: "p2", status: "OUT" },
    { userId: "sub", status: "IN" },
  ];

  it("names nobody unless the viewer may see named answers", () => {
    const s = side({ rows });
    expect(s).not.toBeNull();
    expect(s?.names).toBeNull();
  });

  it("lists in, out, covered and no reply, with the viewer as you", () => {
    const s = side({
      viewerId: "cap",
      showNames: true,
      bookings: [cover("sub", "p3")],
      rows,
    });
    expect(s?.names).toEqual({
      in: ["you", "Sub (standin)"],
      out: ["Bo"],
      covered: [{ name: "Cy", by: "Sub" }],
      noReply: ["Ana", "Di"],
    });
  });

  it("names a standin in an open seat among the in, with no one covered", () => {
    const s = side({
      viewerId: "cap",
      showNames: true,
      roster: roster.slice(0, 4),
      bookings: [cover("sub", null)],
      rows,
    });
    expect(s?.names?.covered).toEqual([]);
    expect(s?.names?.in).toEqual(["you", "Sub (standin)"]);
  });
});

describe("checkinCountsText", () => {
  it("leaves out the parts that are zero", () => {
    expect(
      checkinCountsText({ in: 3, out: 1, noReply: 1, openSeats: 0, of: 5 }),
    ).toBe("3 of 5 in · 1 out · 1 no reply");
    expect(
      checkinCountsText({ in: 5, out: 0, noReply: 0, openSeats: 0, of: 5 }),
    ).toBe("5 of 5 in");
    expect(
      checkinCountsText({ in: 0, out: 0, noReply: 3, openSeats: 2, of: 5 }),
    ).toBe("0 of 5 in · 3 no reply · 2 open seats");
    expect(
      checkinCountsText({ in: 0, out: 0, noReply: 4, openSeats: 1, of: 5 }),
    ).toBe("0 of 5 in · 4 no reply · 1 open seat");
  });

  it("says ready during a live series", () => {
    expect(
      checkinCountsText({ in: 4, out: 1, noReply: 0, openSeats: 0, of: 5 }, true),
    ).toBe("4 of 5 ready · 1 out");
  });
});

describe("sideNeedsCover", () => {
  it("is true for a player out with no cover or an empty seat", () => {
    const base = { in: 4, out: 0, noReply: 1, openSeats: 0, of: 5 };
    expect(sideNeedsCover(base)).toBe(false);
    expect(sideNeedsCover({ ...base, out: 1 })).toBe(true);
    expect(sideNeedsCover({ ...base, openSeats: 1 })).toBe(true);
  });
});

describe("standinSeatText", () => {
  it("names the seat and the team", () => {
    expect(standinSeatText("Roshan's Revenge", "Di")).toBe(
      "You're standing in for Di on Roshan's Revenge.",
    );
    expect(standinSeatText("Roshan's Revenge", null)).toBe(
      "You're filling an open seat on Roshan's Revenge.",
    );
  });
});

describe("checkinPrompt", () => {
  it("keeps the answered lines word for word", () => {
    for (const role of ["captain", "standin", "player"] as const) {
      expect(checkinPrompt({ myRsvp: "IN", role })).toBe(
        "You're confirmed ✓ — change it here if plans shift.",
      );
      expect(checkinPrompt({ myRsvp: "IN", role, remainingGames: true })).toBe(
        "You're ready for the remaining games ✓ — change it here if plans shift.",
      );
    }
  });

  it("never tells a captain to let their captain know", () => {
    const captain = checkinPrompt({
      myRsvp: null,
      role: "captain",
      teamName: "Roshan's Revenge",
    });
    expect(captain).toBe(
      "You're captaining Roshan's Revenge. Check in, then see who's missing.",
    );
    expect(captain).not.toMatch(/captain know/);
    expect(
      checkinPrompt({
        myRsvp: null,
        role: "captain",
        teamName: "Roshan's Revenge",
        remainingGames: true,
      }),
    ).toBe("You're captaining Roshan's Revenge. Say you're ready, then see who's missing.");
    // A caller with no side to show keeps the short captain line.
    expect(checkinPrompt({ myRsvp: null, role: "captain" })).toBe(
      "Can you make it? Let your team know.",
    );
  });

  it("names the captain a player or standin should tell", () => {
    expect(
      checkinPrompt({ myRsvp: null, role: "player", captainName: "Cap" }),
    ).toBe("Can you make it? Let your captain, Cap, know.");
    expect(
      checkinPrompt({ myRsvp: null, role: "standin", captainName: "Cap" }),
    ).toBe("Can you make it? Let Cap know.");
    expect(checkinPrompt({ myRsvp: null, role: "player" })).toBe(
      "Can you make it? Let your captain know.",
    );
  });

  it("says who lines up cover once someone can't make it", () => {
    expect(checkinPrompt({ myRsvp: "OUT", role: "player" })).toBe(
      "You're marked unavailable — a standin can be lined up.",
    );
    expect(checkinPrompt({ myRsvp: "OUT", role: "captain" })).toBe(
      "You're marked unavailable — line up a standin for your seat.",
    );
    expect(checkinPrompt({ myRsvp: "OUT", role: "standin" })).toBe(
      "You're marked unavailable — your captain can line up someone else.",
    );
  });
});
