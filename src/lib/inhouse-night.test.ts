import { describe, expect, it } from "vitest";
import { sourceFiles } from "../../test/support/source-files";
import {
  oauthLandingPath,
  packOauthCookie,
  randomOauthValue,
  unpackOauthCookie,
} from "./discord-oauth";
import { safeReturnPath } from "./return-path";
import { signInHref } from "./sign-in";
import {
  INHOUSE_NIGHT_INVITE_PATH,
  INHOUSE_NIGHT_LENGTH_MS,
  INHOUSE_NIGHT_LINK_DISCORD_PATH,
  INHOUSE_NIGHT_MAX_LEAD_DAYS,
  INHOUSE_NIGHT_NOTE_MAX,
  currentInhouseNight,
  discordEventUrl,
  inhouseNightCalendarEvent,
  inhouseNightChange,
  inhouseNightEvent,
  inhouseNightGoogleCalendarUrl,
  inhouseNightHeadcount,
  inhouseNightHeadcountSources,
  inhouseNightHeadcountText,
  inhouseNightInviteAction,
  inhouseNightNote,
  inhouseNightPhase,
  inhouseNightPreviewText,
  inhouseNightRsvpControlKind,
  inhouseNightRsvpNeedsDiscord,
  inhouseNightRsvpOpen,
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

describe("saying I'm in", () => {
  it("is open until the night starts; after that the queue is the way in", () => {
    const n = night();
    expect(inhouseNightRsvpOpen(n, NOW)).toBe(true);
    expect(inhouseNightRsvpOpen(n, n.startsAtMs - 1)).toBe(true);
    expect(inhouseNightRsvpOpen(n, n.startsAtMs)).toBe(false);
    expect(inhouseNightRsvpOpen(n, n.startsAtMs + INHOUSE_NIGHT_LENGTH_MS)).toBe(false);
  });
});

describe("who's coming", () => {
  const A = "100000000000000001";
  const B = "100000000000000002";
  const C = "100000000000000003";

  it("adds Discord's Interested to the site's I'm in, a linked player once", () => {
    // Site: A (linked), B (linked) and one unlinked player. Discord: A, C.
    const count = inhouseNightHeadcount([A, null, B], [A, C]);
    expect(count).toEqual({ site: 3, discordOnly: 1 });
    expect(inhouseNightHeadcountText(count)).toBe("4 coming");
    expect(inhouseNightHeadcountSources(count)).toBe("3 on the site, 1 on Discord");
  });

  it("counts a Discord member listed twice once", () => {
    expect(inhouseNightHeadcount([], [C, C])).toEqual({ site: 0, discordOnly: 1 });
  });

  it("says only the site's count when Discord's list couldn't be read", () => {
    const count = inhouseNightHeadcount([A, null], null);
    expect(count).toEqual({ site: 2, discordOnly: null });
    expect(inhouseNightHeadcountText(count)).toBe("2 said I'm in");
    expect(inhouseNightHeadcountSources(count)).toBeNull();
    expect(inhouseNightHeadcountText(inhouseNightHeadcount([], null))).toBeNull();
  });

  it("says nothing while nobody is coming, and names one source alone without a split", () => {
    expect(inhouseNightHeadcountText(inhouseNightHeadcount([], []))).toBeNull();
    const siteOnly = inhouseNightHeadcount([null], []);
    expect(inhouseNightHeadcountText(siteOnly)).toBe("1 coming");
    expect(inhouseNightHeadcountSources(siteOnly)).toBeNull();
    const discordOnly = inhouseNightHeadcount([], [A, B]);
    expect(inhouseNightHeadcountText(discordOnly)).toBe("2 coming");
    expect(inhouseNightHeadcountSources(discordOnly)).toBeNull();
  });
});

describe("I'm in needs a linked Discord", () => {
  it("asks only a player without one, and only where accounts can be linked", () => {
    expect(inhouseNightRsvpNeedsDiscord({ linkingConfigured: true, linked: false })).toBe(true);
    expect(inhouseNightRsvpNeedsDiscord({ linkingConfigured: true, linked: true })).toBe(false);
    // A preview or a bare checkout can't link anyone, and nobody could say it.
    expect(inhouseNightRsvpNeedsDiscord({ linkingConfigured: false, linked: false })).toBe(false);
  });

  it("links through the account link, which comes back to the invite", () => {
    expect(INHOUSE_NIGHT_LINK_DISCORD_PATH).toBe("/api/auth/discord?next=%2Finhouse%3Fimin%3D1");
    const next = new URL(INHOUSE_NIGHT_LINK_DISCORD_PATH, "https://ggd2l.test").searchParams.get(
      "next",
    );
    expect(safeReturnPath(next)).toBe(INHOUSE_NIGHT_INVITE_PATH);
    // The return path rides Discord's round trip in the OAuth cookie, query
    // and all, and a full success lands back on the invite.
    const packed = packOauthCookie(randomOauthValue(), randomOauthValue(), "player-1", next);
    expect(unpackOauthCookie(packed)?.next).toBe(INHOUSE_NIGHT_INVITE_PATH);
    expect(oauthLandingPath("linked", INHOUSE_NIGHT_INVITE_PATH)).toBe(INHOUSE_NIGHT_INVITE_PATH);
    expect(oauthLandingPath("joined", INHOUSE_NIGHT_INVITE_PATH)).toBe(INHOUSE_NIGHT_INVITE_PATH);
    expect(oauthLandingPath("taken", INHOUSE_NIGHT_INVITE_PATH)).toBe("/me?discord=taken");
  });

  it("offers the link only to a player who isn't in, and never hides taking it back", () => {
    const kind = (input: Partial<Parameters<typeof inhouseNightRsvpControlKind>[0]>) =>
      inhouseNightRsvpControlKind({
        open: true,
        signedIn: true,
        mine: false,
        needsDiscord: false,
        ...input,
      });
    expect(kind({})).toBe("toggle");
    expect(kind({ needsDiscord: true })).toBe("link");
    // In without a link (from before the rule): the pressed toggle, so they
    // can take it back, before the night and once it's on.
    expect(kind({ needsDiscord: true, mine: true })).toBe("toggle");
    expect(kind({ needsDiscord: true, mine: true, open: false })).toBe("toggle");
    expect(kind({ signedIn: false })).toBe("sign-in");
    expect(kind({ open: false })).toBe("none");
    expect(kind({ open: false, needsDiscord: true })).toBe("none");
  });

  it("has every I'm in on the bar and the card follow the rule, and the invite ask, not bounce", () => {
    const [night] = sourceFiles("src/components/inhouse-night.tsx", 1);
    // Both controls (Home's bar and /inhouse's card) are told whether the
    // viewer must link, from the one loader, and the control decides by the
    // one rule.
    expect(night.text.match(/<InhouseNightRsvpControl\b/g)).toHaveLength(2);
    expect(night.text.match(/needsDiscord=\{needsDiscord\}/g)).toHaveLength(2);
    expect(night.text.match(/inhouseNightNeedsDiscordFor\(/g)).toHaveLength(2);
    expect(night.text).toMatch(/needsDiscord,\n\s*\}\);/);
    expect(night.text).toContain("inhouseNightRsvpControlKind({");
    const [invite] = sourceFiles("src/components/inhouse-night-invite.tsx", 1);
    expect(invite.text).toContain('action === "link"');
    // Reading the address to scrub `imin` is fine; going anywhere is not.
    expect(invite.text).not.toMatch(
      /location\.(assign|replace)\(|location\.href\s*=(?!=)|router\.(push|replace)\(/,
    );
  });
});

describe("the invite link", () => {
  const act = (input: Partial<Parameters<typeof inhouseNightInviteAction>[0]>) =>
    inhouseNightInviteAction({
      param: "1",
      phase: "upcoming",
      signedIn: true,
      mine: false,
      needsDiscord: false,
      ...input,
    });

  it("says I'm in for a signed-in player who isn't on the list yet", () => {
    expect(act({})).toBe("rsvp");
    expect(act({ mine: true })).toBe("already-in");
  });

  it("sends a signed-out player through sign-in, and the sign-in comes back to it", () => {
    expect(act({ signedIn: false })).toBe("sign-in");
    expect(safeReturnPath(INHOUSE_NIGHT_INVITE_PATH)).toBe("/inhouse?imin=1");
    expect(signInHref(INHOUSE_NIGHT_INVITE_PATH)).toBe("/login?next=%2Finhouse%3Fimin%3D1");
  });

  it("sends a signed-in player without a linked Discord to link it first", () => {
    expect(act({ needsDiscord: true })).toBe("link");
    // Already in (from before the rule), on, or signed out: as before.
    expect(act({ needsDiscord: true, mine: true })).toBe("already-in");
    expect(act({ needsDiscord: true, phase: "on" })).toBe("join");
    expect(act({ needsDiscord: true, signedIn: false })).toBe("sign-in");
  });

  it("joins the queue once the night is on, signed in or not", () => {
    expect(act({ phase: "on" })).toBe("join");
    expect(act({ phase: "on", signedIn: false })).toBe("join");
    expect(act({ phase: "on", mine: true })).toBe("join");
  });

  it("does nothing without the invite or without a night to answer it", () => {
    expect(act({ param: undefined })).toBe("none");
    expect(act({ param: null })).toBe("none");
    expect(act({ param: "yes" })).toBe("none");
    expect(act({ phase: null })).toBe("none");
    expect(act({ phase: "over" })).toBe("none");
  });

  it("unfurls as the night: when, who's coming, the note, and what the link does", () => {
    expect(
      inhouseNightPreviewText({
        when: "Fri, Oct 9, 8:00 PM Eastern",
        phase: "upcoming",
        note: "All ranks welcome.",
        headcount: "12 coming",
      }),
    ).toEqual({
      title: "Inhouse night · Fri, Oct 9, 8:00 PM Eastern",
      description:
        "All ranks welcome. 12 coming. Open this to say you're in, then queue up when it starts. Inhouse 5v5s: the lobby fires at ten players and captains draft the teams.",
    });
    const on = inhouseNightPreviewText({
      when: "Fri, Oct 9, 8:00 PM Eastern",
      phase: "on",
      note: "",
      headcount: null,
    });
    expect(on.title).toBe("Inhouse night is on");
    // A note typed without a full stop doesn't run into the next sentence.
    expect(
      inhouseNightPreviewText({ when: "x", phase: "upcoming", note: "come try it", headcount: null })
        .description,
    ).toMatch(/^come try it\. Open this/);
    expect(on.description).toMatch(/^It's on now: open this to join the queue\./);
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
