import { describe, expect, it } from "vitest";
import {
  INHOUSE_NIGHT_LENGTH_MS,
  INHOUSE_NIGHT_MAX_LEAD_DAYS,
  INHOUSE_NIGHT_NOTE_MAX,
  currentInhouseNight,
  discordEventUrl,
  inhouseNightCalendarEvent,
  inhouseNightChange,
  inhouseNightEvent,
  inhouseNightGoogleCalendarUrl,
  inhouseNightNote,
  inhouseNightPhase,
  inhouseNightTimeProblem,
  nextInhouseNight,
  parseInhouseNight,
  serializeInhouseNight,
  type InhouseNight,
} from "./inhouse-night";

const NOW = Date.parse("2026-10-07T20:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SITE = "https://ggd2l.example";

function night(overrides: Partial<InhouseNight> = {}): InhouseNight {
  return {
    id: "night-1",
    startsAtMs: NOW + 2 * DAY,
    note: "First one: come try it",
    createdAtMs: NOW - HOUR,
    revision: 2,
    discordEventId: "1234567890123456789",
    ...overrides,
  };
}

describe("storing a night", () => {
  it("round-trips through its Setting value", () => {
    expect(parseInhouseNight(serializeInhouseNight(night()))).toEqual(night());
    expect(
      parseInhouseNight(serializeInhouseNight(night({ note: "", discordEventId: null }))),
    ).toEqual(night({ note: "", discordEventId: null }));
  });

  it("reads nothing from a missing, broken or foreign value", () => {
    expect(parseInhouseNight(null)).toBeNull();
    expect(parseInhouseNight("")).toBeNull();
    expect(parseInhouseNight("{not json")).toBeNull();
    expect(parseInhouseNight("[]")).toBeNull();
    const stored = JSON.parse(serializeInhouseNight(night()));
    expect(parseInhouseNight(JSON.stringify({ ...stored, v: 2 }))).toBeNull();
    expect(parseInhouseNight(JSON.stringify({ ...stored, id: "" }))).toBeNull();
    expect(parseInhouseNight(JSON.stringify({ ...stored, startsAt: "soon" }))).toBeNull();
    expect(parseInhouseNight(JSON.stringify({ ...stored, revision: -1 }))).toBeNull();
    expect(parseInhouseNight(JSON.stringify({ ...stored, revision: 1.5 }))).toBeNull();
  });

  it("drops an event id that isn't a Discord snowflake rather than linking it", () => {
    const stored = JSON.parse(serializeInhouseNight(night()));
    expect(
      parseInhouseNight(JSON.stringify({ ...stored, discordEventId: "../evil" }))?.discordEventId,
    ).toBeNull();
  });
});

describe("a night's phase", () => {
  it("is upcoming, then on for the live window, then over", () => {
    const n = night({ startsAtMs: NOW });
    expect(inhouseNightPhase(n, NOW - 1)).toBe("upcoming");
    expect(inhouseNightPhase(n, NOW)).toBe("on");
    expect(inhouseNightPhase(n, NOW + INHOUSE_NIGHT_LENGTH_MS - 1)).toBe("on");
    expect(inhouseNightPhase(n, NOW + INHOUSE_NIGHT_LENGTH_MS)).toBe("over");
  });

  it("stops showing once the night is over", () => {
    const n = night({ startsAtMs: NOW });
    expect(currentInhouseNight(n, NOW + HOUR)).toBe(n);
    expect(currentInhouseNight(n, NOW + INHOUSE_NIGHT_LENGTH_MS)).toBeNull();
    expect(currentInhouseNight(null, NOW)).toBeNull();
  });
});

describe("what an admin may save", () => {
  it("needs a future start inside the lead limit", () => {
    expect(inhouseNightTimeProblem(NOW, NOW)).toMatch(/future/);
    expect(inhouseNightTimeProblem(NOW - 1, NOW)).toMatch(/future/);
    expect(inhouseNightTimeProblem(Number.NaN, NOW)).toMatch(/future/);
    expect(inhouseNightTimeProblem(NOW + HOUR, NOW)).toBeNull();
    expect(inhouseNightTimeProblem(NOW + INHOUSE_NIGHT_MAX_LEAD_DAYS * DAY, NOW)).toBeNull();
    expect(
      inhouseNightTimeProblem(NOW + INHOUSE_NIGHT_MAX_LEAD_DAYS * DAY + 1, NOW),
    ).toMatch(/60 days/);
  });

  it("keeps the note to one trimmed line and refuses one too long", () => {
    expect(inhouseNightNote("  Bring\\n  friends  ")).toEqual({ note: "Bring\\n friends" });
    expect(inhouseNightNote(" Bring\n\n  friends ")).toEqual({ note: "Bring friends" });
    expect(inhouseNightNote("")).toEqual({ note: "" });
    expect(inhouseNightNote("x".repeat(INHOUSE_NIGHT_NOTE_MAX))).toEqual({
      note: "x".repeat(INHOUSE_NIGHT_NOTE_MAX),
    });
    expect(inhouseNightNote("x".repeat(INHOUSE_NIGHT_NOTE_MAX + 1))).toEqual({
      error: `Keep the note to ${INHOUSE_NIGHT_NOTE_MAX} characters (it's ${INHOUSE_NIGHT_NOTE_MAX + 1}).`,
    });
  });
});

describe("what a save does", () => {
  const upcoming = night();
  const input = { startsAtMs: upcoming.startsAtMs, note: upcoming.note };

  it("moves or re-notes an upcoming night, and says when nothing changed", () => {
    expect(inhouseNightChange(upcoming, input, NOW)).toBe("unchanged");
    expect(inhouseNightChange(upcoming, { ...input, note: "new" }, NOW)).toBe("note");
    expect(inhouseNightChange(upcoming, { ...input, startsAtMs: input.startsAtMs + HOUR }, NOW)).toBe("moved");
  });

  it("starts a new night when none is stored or the stored one has started", () => {
    expect(inhouseNightChange(null, input, NOW)).toBe("new");
    const on = night({ startsAtMs: NOW - HOUR });
    expect(inhouseNightChange(on, { startsAtMs: NOW + 7 * DAY, note: "" }, NOW)).toBe("new");
    const over = night({ startsAtMs: NOW - DAY });
    expect(inhouseNightChange(over, { startsAtMs: over.startsAtMs, note: over.note }, NOW)).toBe("new");
  });

  it("gives a new night a fresh id and no event; a move keeps both and bumps the revision", () => {
    const fresh = nextInhouseNight(null, { startsAtMs: NOW + DAY, note: "" }, NOW, () => "fresh");
    expect(fresh).toEqual({
      id: "fresh",
      startsAtMs: NOW + DAY,
      note: "",
      createdAtMs: NOW,
      revision: 0,
      discordEventId: null,
    });
    const moved = nextInhouseNight(upcoming, { startsAtMs: NOW + 3 * DAY, note: "x" }, NOW, () => "unused");
    expect(moved).toEqual({
      ...upcoming,
      startsAtMs: NOW + 3 * DAY,
      note: "x",
      revision: upcoming.revision + 1,
    });
    const after = nextInhouseNight(
      night({ startsAtMs: NOW - DAY }),
      { startsAtMs: NOW + DAY, note: "" },
      NOW,
      () => "next",
    );
    expect(after).toMatchObject({ id: "next", revision: 0, discordEventId: null });
  });
});

describe("the night elsewhere", () => {
  it("describes the Discord event within Discord's limits", () => {
    const fields = inhouseNightEvent(night({ note: "n".repeat(2_000) }), SITE, "GGD2L");
    expect(fields.name).toBe("GGD2L inhouse night");
    expect(fields.description.length).toBeLessThanOrEqual(1000);
    expect(fields.location).toBe(`${SITE}/inhouse`);
    expect(fields.endsAt.getTime() - fields.startsAt.getTime()).toBe(INHOUSE_NIGHT_LENGTH_MS);
    expect(
      inhouseNightEvent(night(), "https://" + "a".repeat(120) + ".example", "GGD2L").location.length,
    ).toBeLessThanOrEqual(100);
  });

  it("links the event the way Discord shares it", () => {
    expect(discordEventUrl("111", "222")).toBe("https://discord.com/events/111/222");
  });

  it("adds the night to Google Calendar and to an .ics file", () => {
    const n = night({ startsAtMs: Date.parse("2026-10-10T03:00:00.000Z") });
    const google = new URL(inhouseNightGoogleCalendarUrl(n, SITE, "GGD2L"));
    expect(google.origin + google.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(google.searchParams.get("action")).toBe("TEMPLATE");
    expect(google.searchParams.get("dates")).toBe("20261010T030000Z/20261010T060000Z");
    expect(google.searchParams.get("text")).toBe("GGD2L inhouse night");
    expect(google.searchParams.get("details")).toContain(`${SITE}/inhouse`);

    const event = inhouseNightCalendarEvent(n, SITE, "GGD2L");
    expect(event).toMatchObject({
      uid: "inhouse-night-night-1@ggd2l.example",
      sequence: n.revision,
      durationMinutes: INHOUSE_NIGHT_LENGTH_MS / 60_000,
      summary: "GGD2L inhouse night",
      url: `${SITE}/inhouse`,
    });
    expect(event.stamp.getTime()).toBe(n.createdAtMs);
    expect(event.start.getTime()).toBe(n.startsAtMs);
  });
});
