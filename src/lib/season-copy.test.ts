import { describe, it, expect } from "vitest";
import {
  draftPhasePresentation,
  leagueEligibilityLine,
  leaguePitch,
  mmrCeilingPhrase,
  matchNightText,
  phaseSubtitle,
  PLAYER_SIGNUPS_OPEN_UNTIL,
  seasonPhaseLabel,
  seasonPhaseTone,
} from "./season-copy";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";
import { draftReminderAnnouncement } from "./discord";

describe("phaseSubtitle", () => {
  it("asks for players while the season is short of its minimum", () => {
    const s = phaseSubtitle(SEASON_STATUS.SIGNUPS, { canDraft: false });
    expect(s).toContain("Sign up now");
  });

  // A signed-up player reads this beside their own "You're in" panel.
  it("doesn't ask a signed-up viewer to sign up again", () => {
    const s = phaseSubtitle(SEASON_STATUS.SIGNUPS, {
      canDraft: false,
      signedUp: true,
    });
    expect(s).not.toMatch(/sign up now/i);
    expect(s).toMatch(/another team/i);
  });

  // The season's team goal (minTeams) is a target, not a gate: Start draft
  // needs only two captains. Neither signup state may promise the draft is
  // waiting on a player count.
  it("never says the draft waits for a player count", () => {
    for (const signedUp of [true, false]) {
      expect(
        phaseSubtitle(SEASON_STATUS.SIGNUPS, { canDraft: false, signedUp }),
      ).not.toMatch(/once enough players|minimum/i);
    }
  });

  // The hero renders this directly beneath a "Ready to draft" badge. Claiming
  // the draft is still waiting on players, next to a badge saying it isn't, is
  // the same below-the-minimum assumption that had the progress bar reading
  // "sold out" — and this is the FIRST sentence a visitor reads.
  it("stops claiming the draft is waiting once the minimum is met", () => {
    const s = phaseSubtitle(SEASON_STATUS.SIGNUPS, { canDraft: true });
    expect(s).not.toMatch(/once enough players/i);
    expect(s).toMatch(/signups stay open/i);
  });

  // An admin can close signups (Close signups, or Start draft) before draft
  // night, so neither Home nor the draft-night reminder may promise draft
  // night or the auction; both say PLAYER_SIGNUPS_OPEN_UNTIL.
  it("says signups stay open until an admin closes them, as the reminder does", () => {
    const s = phaseSubtitle(SEASON_STATUS.SIGNUPS, { canDraft: true });
    expect(s).toContain(`signups stay open ${PLAYER_SIGNUPS_OPEN_UNTIL}`);
    expect(s).not.toMatch(/until draft night|until the auction/i);
    expect(
      draftReminderAnnouncement({
        seasonName: "Season 3",
        draftAtMs: 1_800_000_000_000,
        playerSignupsOpen: true,
        playerCount: 14,
        captains: [],
        unconfirmed: [],
      }).content,
    ).toContain(`Player signups stay open ${PLAYER_SIGNUPS_OPEN_UNTIL}.`);
  });

  it("says signups are open in BOTH signup states", () => {
    for (const canDraft of [true, false]) {
      expect(phaseSubtitle(SEASON_STATUS.SIGNUPS, { canDraft })).toMatch(
        /sign ?up/i,
      );
    }
  });

  it("covers every phase and nothing else", () => {
    for (const status of Object.values(SEASON_STATUS)) {
      expect(phaseSubtitle(status)).not.toBe("");
    }
    expect(phaseSubtitle("NOT_A_PHASE")).toBe("");
  });

  // canDraft is meaningless outside SIGNUPS; passing it must not leak into
  // another phase's copy.
  it("ignores canDraft and signedUp in the other phases", () => {
    for (const status of Object.values(SEASON_STATUS)) {
      if (status === SEASON_STATUS.SIGNUPS) continue;
      expect(phaseSubtitle(status, { canDraft: true, signedUp: true })).toBe(
        phaseSubtitle(status, { canDraft: false }),
      );
    }
  });

  it("describes each auction state inside the DRAFT phase honestly", () => {
    expect(
      phaseSubtitle(SEASON_STATUS.DRAFT, {
        draftStatus: DRAFT_STATUS.NOT_STARTED,
      }),
    ).toMatch(/being prepared/i);
    expect(
      phaseSubtitle(SEASON_STATUS.DRAFT, {
        draftStatus: DRAFT_STATUS.IN_PROGRESS,
      }),
    ).toMatch(/bidding/i);
    expect(
      phaseSubtitle(SEASON_STATUS.DRAFT, {
        draftStatus: DRAFT_STATUS.PAUSED,
      }),
    ).toMatch(/paused/i);
    expect(
      phaseSubtitle(SEASON_STATUS.DRAFT, {
        draftStatus: DRAFT_STATUS.COMPLETE,
      }),
    ).toMatch(/rosters are set/i);
  });

  it("does not congratulate a champion when COMPLETE has none", () => {
    const copy = phaseSubtitle(SEASON_STATUS.COMPLETE, {
      hasChampion: false,
    });
    expect(copy).toMatch(/no champion/i);
    expect(copy).not.toMatch(/congratulations/i);
  });
});

describe("draftPhasePresentation", () => {
  it("marks only an in-progress auction as live", () => {
    for (const status of Object.values(DRAFT_STATUS)) {
      expect(draftPhasePresentation(status).live).toBe(
        status === DRAFT_STATUS.IN_PROGRESS,
      );
    }
  });

  it("gives every auction state a useful badge and next action", () => {
    for (const status of Object.values(DRAFT_STATUS)) {
      const copy = draftPhasePresentation(status);
      expect(copy.badge).not.toBe("");
      expect(copy.action).toMatch(/→$/);
      expect(copy.teamLabel).not.toBe("");
      expect(copy.teamLabelSingular).not.toBe("");
    }
  });

  it("degrades missing or unknown rows to setup instead of claiming live play", () => {
    for (const status of [null, undefined, "BROKEN_STATE"]) {
      const copy = draftPhasePresentation(status);
      expect(copy.badge).toBe("Draft setup");
      expect(copy.live).toBe(false);
    }
  });
});

describe("seasonPhaseLabel", () => {
  it("names every phase once, without repeating the season beside it", () => {
    expect(seasonPhaseLabel(SEASON_STATUS.SIGNUPS)).toBe("Signups open");
    expect(seasonPhaseLabel(SEASON_STATUS.REGULAR_SEASON)).toBe(
      "Regular season",
    );
    expect(seasonPhaseLabel(SEASON_STATUS.PLAYOFFS)).toBe("Playoffs");
    // Every chip sits beside the season's name: "Season 7 · Complete".
    expect(seasonPhaseLabel(SEASON_STATUS.COMPLETE)).toBe("Complete");
    for (const status of Object.values(SEASON_STATUS)) {
      expect(seasonPhaseLabel(status, DRAFT_STATUS.COMPLETE)).not.toMatch(
        /^season/i,
      );
    }
  });

  // The footer used to say "Draft in progress" whatever the auction was
  // doing: before it started, while paused, and after every roster was sold.
  it("says what the auction is doing inside the draft phase", () => {
    expect(seasonPhaseLabel(SEASON_STATUS.DRAFT, null)).toBe("Draft setup");
    expect(
      seasonPhaseLabel(SEASON_STATUS.DRAFT, DRAFT_STATUS.NOT_STARTED),
    ).toBe("Draft setup");
    expect(
      seasonPhaseLabel(SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS),
    ).toBe("Draft live");
    expect(seasonPhaseLabel(SEASON_STATUS.DRAFT, DRAFT_STATUS.PAUSED)).toBe(
      "Draft paused",
    );
    expect(seasonPhaseLabel(SEASON_STATUS.DRAFT, DRAFT_STATUS.COMPLETE)).toBe(
      "Draft complete",
    );
    for (const draftStatus of Object.values(DRAFT_STATUS)) {
      expect(seasonPhaseLabel(SEASON_STATUS.DRAFT, draftStatus)).toBe(
        draftPhasePresentation(draftStatus).badge,
      );
    }
  });

  it("ignores the auction outside the draft phase", () => {
    expect(
      seasonPhaseLabel(SEASON_STATUS.REGULAR_SEASON, DRAFT_STATUS.COMPLETE),
    ).toBe("Regular season");
  });

  it("covers the offseason and unknown states", () => {
    expect(seasonPhaseLabel(null)).toBe("Between seasons");
    expect(seasonPhaseLabel(undefined)).toBe("Between seasons");
    expect(seasonPhaseLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("seasonPhaseTone", () => {
  it("gives each phase its badge colour and anything else neutral", () => {
    expect(seasonPhaseTone(SEASON_STATUS.SIGNUPS)).toBe("info");
    expect(seasonPhaseTone(SEASON_STATUS.DRAFT)).toBe("accent");
    expect(seasonPhaseTone(SEASON_STATUS.REGULAR_SEASON)).toBe("success");
    expect(seasonPhaseTone(SEASON_STATUS.PLAYOFFS)).toBe("accent");
    expect(seasonPhaseTone(SEASON_STATUS.COMPLETE)).toBe("accent");
    expect(seasonPhaseTone(null)).toBe("neutral");
    expect(seasonPhaseTone("SOMETHING_NEW")).toBe("neutral");
  });
});

describe("matchNightText", () => {
  // Every surface quoting it ends the sentence itself, so an admin's own full
  // stop printed "Wednesdays, 8pm ET.. Games are on…".
  it("trims the admin's text and drops a trailing full stop", () => {
    expect(matchNightText("Wednesdays, 8pm ET")).toBe("Wednesdays, 8pm ET");
    expect(matchNightText("  Wednesdays, 8pm ET.  ")).toBe("Wednesdays, 8pm ET");
    expect(matchNightText("Sundays 6 p.m. CET...")).toBe("Sundays 6 p.m. CET");
  });

  it("is null when the admin hasn't set one", () => {
    for (const unset of [null, undefined, "", "   ", ".", " . "]) {
      expect(matchNightText(unset)).toBeNull();
    }
  });
});

describe("the league pitch for new visitors", () => {
  it("names the league and says what a season is", () => {
    expect(leaguePitch("GGD2L")).toBe(
      "GGD2L is an amateur Dota 2 league: captains draft players in a live auction, then teams play weekly matches and playoffs.",
    );
    expect(leaguePitch("GGD2L Europe")).toMatch(/^GGD2L Europe is an amateur/);
  });

  it("states the hard MMR limit and the announced match night", () => {
    expect(leagueEligibilityLine("Sundays at 6:00 PM Pacific time")).toBe(
      "Open to players up to 5,000 MMR · Match night: Sundays at 6:00 PM Pacific time",
    );
    expect(leagueEligibilityLine("Wednesdays at 20:00 Berlin time")).toBe(
      "Open to players up to 5,000 MMR · Match night: Wednesdays at 20:00 Berlin time",
    );
  });

  // Home, How it works and the link previews describe who can join; they
  // share one phrase so the limit can't be worded three ways.
  it("words the hard MMR limit once for every surface", () => {
    expect(mmrCeilingPhrase()).toBe("up to 5,000 MMR");
    expect(leagueEligibilityLine(null)).toContain(mmrCeilingPhrase());
  });

  it("says the match night is still to come rather than inventing one", () => {
    expect(leagueEligibilityLine(null)).toBe(
      "Open to players up to 5,000 MMR · Match night to be announced",
    );
  });

  // Home said "Match night: Saturday 2PM PST" right above a poll asking
  // when match night should be, with Sunday leading.
  it("says a poll is deciding the night while one is open", () => {
    expect(leagueEligibilityLine("Saturday 2PM PST", true)).toBe(
      "Open to players up to 5,000 MMR · Match night: being decided in a player poll",
    );
    expect(leagueEligibilityLine(null, true)).toBe(
      "Open to players up to 5,000 MMR · Match night: being decided in a player poll",
    );
    expect(leagueEligibilityLine("Saturday 2PM PST", false)).toBe(
      "Open to players up to 5,000 MMR · Match night: Saturday 2PM PST",
    );
  });
});
