import { describe, expect, it } from "vitest";
import {
  canEditTeamIdentity,
  carriedTeamIdentity,
  carriedTeamIdentityNote,
  defaultTeamName,
  logoPreviewNote,
  normalizeTeamName,
  teamIdentitySummary,
  teamNameKey,
  TEAM_NAME_MAX_LENGTH,
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

describe("defaultTeamName", () => {
  it("is the captain's name with 's Team", () => {
    expect(defaultTeamName("Zai")).toBe("Zai's Team");
  });
});
