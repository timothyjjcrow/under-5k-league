import { describe, expect, it } from "vitest";
import {
  canEditTeamIdentity,
  carriedTeamIdentity,
  carriedTeamIdentityNote,
  logoPreviewNote,
  normalizeTeamName,
  teamIdentityPostIsThrottled,
  teamIdentitySummary,
  teamNameKey,
  TEAM_NAME_MAX_LENGTH,
  isGeneratedTeamNameFor,
  teamNameAfterCaptainChange,
  uniqueDefaultTeamName,
} from "./team-identity";
import { SEASON_STATUS } from "./constants";

describe("normalizeTeamName", () => {
  it("keeps a name on one trimmed line", () => {
    expect(normalizeTeamName("  Radiant \n\t Raccoons  ")).toBe("Radiant Raccoons");
    expect(normalizeTeamName("Tab\u0007Team")).toBe("Tab Team");
    expect(normalizeTeamName("   ")).toBe("");
  });

  it("caps the length without leaving a trailing space", () => {
    const name = normalizeTeamName(`${"a".repeat(TEAM_NAME_MAX_LENGTH - 1)} bcd`);
    expect(name).toHaveLength(TEAM_NAME_MAX_LENGTH - 1);
    expect(name.endsWith(" ")).toBe(false);
  });

  it("treats names that read the same as the same name", () => {
    expect(teamNameKey(" Zai's   TEAM")).toBe(teamNameKey("zai's team"));
    expect(teamNameKey("Zai's Team")).not.toBe(teamNameKey("Zai's Team 2"));
  });

  // A captain can rename all season; a name that only LOOKS like another
  // team's must still count as that team's name.
  it.each([
    "Radiant Raccoons\u200B",
    "Radiant\u200B Raccoons",
    "\uFEFFRadiant Raccoons",
    "Radiant\u200D Raccoons",
    "Radiant \u2800Raccoons",
    "Radiant\u3164 Raccoons",
    "Radi\u00ADant Raccoons",
    "Radiant \u202ERaccoons\u202C",
    "\uFF32adiant Raccoons",
  ])("sees through invisible and look-alike characters: %j", (name) => {
    expect(teamNameKey(name)).toBe(teamNameKey("Radiant Raccoons"));
  });

  it.each([
    ["Cyrillic а", "R\u0430diant Raccoons"],
    ["Cyrillic о", "Radiant Racc\u043E\u043Ens"],
    ["Cyrillic capitals", "R\u0410DI\u0410NT R\u0410CCOONS"],
    ["Greek capital omicron", "RADIANT RACC\u039F\u039FNS"],
    ["an accent", "R\u00E1diant Raccoons"],
    ["a combining accent", "Ra\u0301diant Raccoons"],
  ])("gives a name spelled with %s the Latin name's key", (_, name) => {
    expect(teamNameKey(name)).toBe(teamNameKey("Radiant Raccoons"));
  });

  it("still tells different Latin names apart", () => {
    expect(teamNameKey("Radiant Raccoons")).not.toBe(teamNameKey("Radiant Racoons"));
    expect(teamNameKey("Dire Straits")).not.toBe(teamNameKey("Dire Straights"));
  });

  it("keeps a name in another script its own", () => {
    expect(teamNameKey("Рыцари")).not.toBe(teamNameKey("Рыцарь"));
    expect(normalizeTeamName("Рыцари Света")).toBe("Рыцари Света");
  });

  it("cuts a stack of combining marks down to three", () => {
    expect(normalizeTeamName(`Z${"\u0301".repeat(20)}algo`)).toBe(
      `Z${"\u0301".repeat(3)}algo`,
    );
  });

  // A 59-character name ending in an emoji used to be cut through the
  // emoji's surrogate pair, storing half a character.
  it("never cuts an emoji in half at the length limit", () => {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const cut = normalizeTeamName(`${"a".repeat(TEAM_NAME_MAX_LENGTH - 1)}\u{1F600}`);
    expect(cut).toBe("a".repeat(TEAM_NAME_MAX_LENGTH - 1));
    expect(cut).not.toMatch(loneSurrogate);
    const joined = normalizeTeamName(
      `${"a".repeat(TEAM_NAME_MAX_LENGTH - 3)}\u{1F468}\u200D\u{1F469}`,
    );
    expect(joined).toBe(`${"a".repeat(TEAM_NAME_MAX_LENGTH - 3)}\u{1F468}`);
    const whole = `${"a".repeat(TEAM_NAME_MAX_LENGTH - 2)}\u{1F600}`;
    expect(normalizeTeamName(whole)).toBe(whole);
  });

  it("drops invisible characters from the stored name", () => {
    expect(normalizeTeamName("Radiant\u200B Raccoons\u2060")).toBe("Radiant Raccoons");
    expect(normalizeTeamName("Radiant \u202ERaccoons")).toBe("Radiant Raccoons");
  });

  it("keeps emoji sequences whole", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Squad";
    expect(normalizeTeamName(family)).toBe(family);
    expect(normalizeTeamName("\u2764\uFE0F Hearts")).toBe("\u2764\uFE0F Hearts");
    expect(teamNameKey("\u2764\uFE0F Hearts")).toBe(teamNameKey("\u2764 Hearts"));
  });

  it.each([
    "\u200B\u200B\u200B",
    "\u200D",
    "\u3164",
    "\u2800 \u2800",
    "\uFE0F",
    "\u0301",
  ])("treats a name with nothing visible in it as no name: %j", (name) => {
    expect(normalizeTeamName(name)).toBe("");
  });
});

describe("canEditTeamIdentity", () => {
  const base = {
    captainId: "cap",
    seasonIsActive: true,
    seasonStatus: SEASON_STATUS.REGULAR_SEASON,
  };

  it("lets the team's captain and any admin edit, and nobody else", () => {
    expect(canEditTeamIdentity({ ...base, viewer: { id: "cap", role: "USER" } })).toBe(true);
    expect(canEditTeamIdentity({ ...base, viewer: { id: "boss", role: "ADMIN" } })).toBe(true);
    expect(canEditTeamIdentity({ ...base, viewer: { id: "other", role: "USER" } })).toBe(false);
    expect(canEditTeamIdentity({ ...base, viewer: null })).toBe(false);
  });

  it("stays open all season, from signups to playoffs", () => {
    for (const seasonStatus of [
      SEASON_STATUS.SIGNUPS,
      SEASON_STATUS.DRAFT,
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.PLAYOFFS,
    ]) {
      expect(
        canEditTeamIdentity({ ...base, seasonStatus, viewer: { id: "cap", role: "USER" } }),
      ).toBe(true);
    }
  });

  it("closes once the season is complete or archived, even for admins", () => {
    const admin = { id: "boss", role: "ADMIN" };
    expect(
      canEditTeamIdentity({ ...base, seasonStatus: SEASON_STATUS.COMPLETE, viewer: admin }),
    ).toBe(false);
    expect(canEditTeamIdentity({ ...base, seasonIsActive: false, viewer: admin })).toBe(false);
  });
});

describe("teamIdentitySummary", () => {
  const change = {
    previousName: "Zai's Team",
    name: "Radiant Raccoons",
    nameChanged: true,
    logoChanged: false,
    logoUrl: null,
    byCaptain: false,
  };

  it("names the old and new team", () => {
    expect(teamIdentitySummary(change)).toBe(
      `Renamed team "Zai's Team" → "Radiant Raccoons"`,
    );
  });

  it("says what happened to the logo and who did it", () => {
    expect(
      teamIdentitySummary({
        ...change,
        logoChanged: true,
        logoUrl: "https://cdn.example/r.png",
        byCaptain: true,
      }),
    ).toBe(`Renamed team "Zai's Team" → "Radiant Raccoons" with a custom logo (as captain)`);
    expect(
      teamIdentitySummary({
        ...change,
        previousName: "Radiant Raccoons",
        nameChanged: false,
        logoChanged: true,
      }),
    ).toBe(`Set "Radiant Raccoons" to the generated crest`);
  });
});

describe("teamIdentityPostIsThrottled", () => {
  it("never holds back a rename, from a captain or an admin", () => {
    expect(teamIdentityPostIsThrottled({ byCaptain: true, nameChanged: true })).toBe(false);
    expect(teamIdentityPostIsThrottled({ byCaptain: false, nameChanged: true })).toBe(false);
  });

  it("throttles only a captain's change that keeps the name", () => {
    expect(teamIdentityPostIsThrottled({ byCaptain: true, nameChanged: false })).toBe(true);
    expect(teamIdentityPostIsThrottled({ byCaptain: false, nameChanged: false })).toBe(false);
  });
});

describe("logoPreviewNote", () => {
  it("explains the initials crest when there is no logo", () => {
    expect(logoPreviewNote({ logoUrl: null }, null)).toMatchObject({
      tone: "muted",
      text: expect.stringContaining("initials"),
    });
  });

  it("shows the server's own refusal, as a warning", () => {
    expect(logoPreviewNote({ error: "Team logos must use HTTPS" }, null)).toEqual({
      text: "Team logos must use HTTPS",
      tone: "danger",
    });
  });

  it("warns when the link does not load as an image", () => {
    const logo = { logoUrl: "https://cdn.example/page.html" };
    expect(logoPreviewNote(logo, "loading").tone).toBe("muted");
    expect(logoPreviewNote(logo, "loaded")).toEqual({
      text: "Logo preview.",
      tone: "muted",
    });
    expect(logoPreviewNote(logo, "failed")).toMatchObject({
      tone: "danger",
      text: expect.stringContaining("didn't load as an image"),
    });
  });
});

describe("carriedTeamIdentity", () => {
  const raccoons = {
    name: "Radiant Raccoons",
    logoUrl: "https://cdn.example/raccoon.png",
  };

  it("keeps last time's name and logo", () => {
    expect(carriedTeamIdentity(raccoons, ["Zai's Team"])).toEqual(raccoons);
  });

  it("starts fresh for a first-time captain", () => {
    expect(carriedTeamIdentity(null, [])).toEqual({ name: null, logoUrl: null });
  });

  it("never carries a generated name, but still carries the logo", () => {
    expect(
      carriedTeamIdentity({ name: "Zai's Team", logoUrl: raccoons.logoUrl }, []),
    ).toEqual({ name: null, logoUrl: raccoons.logoUrl });
    expect(
      carriedTeamIdentity({ name: "Zai's Team 2", logoUrl: null }, []).name,
    ).toBeNull();
  });

  it("gives way to a team this season that already uses the name", () => {
    expect(carriedTeamIdentity(raccoons, ["radiant  RACCOONS"]).name).toBeNull();
  });

  it("drops a logo the logo check would now refuse", () => {
    expect(
      carriedTeamIdentity(
        {
          name: "Radiant Raccoons",
          logoUrl: "https://cdn.discordapp.com/attachments/1/2/logo.png?ex=1",
        },
        [],
      ),
    ).toEqual({ name: "Radiant Raccoons", logoUrl: null });
  });
});

describe("carriedTeamIdentityNote", () => {
  it("says exactly what was kept", () => {
    expect(carriedTeamIdentityNote({ name: "Radiant Raccoons", logoUrl: "/r.png" })).toBe(
      "Their team keeps last time's name, Radiant Raccoons, and its logo.",
    );
    expect(carriedTeamIdentityNote({ name: "Radiant Raccoons", logoUrl: null })).toBe(
      "Their team keeps last time's name, Radiant Raccoons.",
    );
    expect(carriedTeamIdentityNote({ name: null, logoUrl: "/r.png" })).toBe(
      "Their team keeps its logo from last time.",
    );
    expect(carriedTeamIdentityNote({ name: null, logoUrl: null })).toBe("");
  });
});

describe("uniqueDefaultTeamName", () => {
  it("is the captain's name with 's Team", () => {
    expect(uniqueDefaultTeamName("Zai", [])).toBe("Zai's Team");
    expect(uniqueDefaultTeamName("Zai", ["Radiant Raccoons"])).toBe("Zai's Team");
  });

  // Captain B renamed their team "Alice's Team", then the admin made Alice a
  // captain: two teams would share one name in standings and Discord.
  it("numbers past a name another team already reads as", () => {
    expect(uniqueDefaultTeamName("Alice", ["alice's  TEAM"])).toBe("Alice's Team 2");
    expect(
      uniqueDefaultTeamName("Alice", ["Alice's Team", "Alice's Team 2"]),
    ).toBe("Alice's Team 3");
    // A look-alike spelling is taken too (Cyrillic "А" and "е").
    expect(uniqueDefaultTeamName("Alice", ["\u0410lic\u0435's Team"])).toBe(
      "Alice's Team 2",
    );
  });

  it("keeps a numbered long name within the length limit", () => {
    const long = "x".repeat(TEAM_NAME_MAX_LENGTH);
    const first = uniqueDefaultTeamName(long, []);
    const second = uniqueDefaultTeamName(long, [first]);
    expect(second.length).toBeLessThanOrEqual(TEAM_NAME_MAX_LENGTH);
    expect(second.endsWith(" 2")).toBe(true);
    expect(teamNameKey(second)).not.toBe(teamNameKey(first));
  });
});

describe("isGeneratedTeamNameFor", () => {
  it("is true only for the name addCaptain gave this captain", () => {
    expect(isGeneratedTeamNameFor("Zai's Team", "Zai")).toBe(true);
    expect(isGeneratedTeamNameFor("Zai's Team 3", "Zai")).toBe(true);
    expect(isGeneratedTeamNameFor("Zai's Team 1", "Zai")).toBe(false);
    expect(isGeneratedTeamNameFor("Zai's Squad", "Zai")).toBe(false);
    expect(isGeneratedTeamNameFor("Mira's Team", "Zai")).toBe(false);
  });
});

describe("teamNameAfterCaptainChange", () => {
  it("keeps a name somebody chose", () => {
    expect(
      teamNameAfterCaptainChange("Radiant Raccoons", "Zai", "Mira", []),
    ).toBe("Radiant Raccoons");
    // Another captain's generated name is a chosen name for this team.
    expect(teamNameAfterCaptainChange("Bob's Team", "Zai", "Mira", [])).toBe(
      "Bob's Team",
    );
  });

  it("moves the outgoing captain's generated name to the new captain", () => {
    expect(teamNameAfterCaptainChange("Zai's Team", "Zai", "Mira", [])).toBe(
      "Mira's Team",
    );
    expect(teamNameAfterCaptainChange("zai's  TEAM", "Zai", "Mira", [])).toBe(
      "Mira's Team",
    );
    // The numbered form addCaptain used when "Zai's Team" was taken.
    expect(teamNameAfterCaptainChange("Zai's Team 2", "Zai", "Mira", [])).toBe(
      "Mira's Team",
    );
  });

  it("numbers the new name past the other teams' names", () => {
    expect(
      teamNameAfterCaptainChange("Zai's Team", "Zai", "Mira", ["Mira's Team"]),
    ).toBe("Mira's Team 2");
  });

  it("recognises a long generated name that was cut to fit its number", () => {
    const long = "x".repeat(TEAM_NAME_MAX_LENGTH);
    const numbered = uniqueDefaultTeamName(long, [uniqueDefaultTeamName(long, [])]);
    expect(teamNameAfterCaptainChange(numbered, long, "Mira", [])).toBe(
      "Mira's Team",
    );
  });
});
