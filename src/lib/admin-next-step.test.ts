import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { REPO_ROOT } from "../../test/support/source-files";
import {
  DRAFT_DONE_NEEDS_SCHEDULE_TITLE,
  adminNextStep,
  phaseAdvance,
  START_REGULAR_SEASON,
  type AdminPhaseInput,
} from "./admin-next-step";
import { DRAFT_STATUS, SEASON_PHASE_ORDER, SEASON_STATUS } from "./constants";

const base: AdminPhaseInput = {
  seasonStatus: SEASON_STATUS.SIGNUPS,
  draftStatus: null,
  playerCount: 0,
  minPlayers: 10,
  teamCount: 0,
  regularMatchCount: 0,
  untimedRegularCount: 0,
  pendingRegularResults: 0,
  playoffMatchCount: 0,
  unfinishedPlayoffCount: 0,
  hasChampion: false,
};
const at = (o: Partial<AdminPhaseInput>) => adminNextStep({ ...base, ...o });

describe("adminNextStep — signups", () => {
  it("counts down to the draft threshold rather than demanding an action", () => {
    const s = at({ playerCount: 4, minPlayers: 10 });
    expect(s.tone).toBe("waiting");
    expect(s.title).toContain("6 more");
  });

  it("asks for captains once the pool is deep enough", () => {
    expect(at({ playerCount: 10, minPlayers: 10 }).title).toMatch(/captains/i);
  });

  it("points at Start draft once captains exist, and names the way back", () => {
    const s = at({ playerCount: 10, minPlayers: 10, teamCount: 4 });
    expect(s.title).toMatch(/Start draft/);
    // The old Start-draft confirm claimed the decision was irreversible; the
    // roadmap must not repeat that.
    expect(s.detail).toMatch(/Abort draft/);
  });

  it("puts unlinked Discord on the pre-draft checklist — the last cheap moment to chase it", () => {
    const s = at({
      playerCount: 10,
      minPlayers: 10,
      teamCount: 4,
      unlinkedDiscordCount: 3,
    });
    expect(s.detail).toMatch(/3 signed-up players haven't linked Discord/);
    const one = at({
      playerCount: 10,
      minPlayers: 10,
      teamCount: 4,
      unlinkedDiscordCount: 1,
    });
    expect(one.detail).toMatch(/1 signed-up player hasn't linked Discord/);
  });

  it("says nothing about Discord when everyone linked (or the count wasn't supplied)", () => {
    expect(
      at({
        playerCount: 10,
        minPlayers: 10,
        teamCount: 4,
        unlinkedDiscordCount: 0,
      }).detail,
    ).not.toMatch(/Discord/);
    expect(
      at({ playerCount: 10, minPlayers: 10, teamCount: 4 }).detail,
    ).not.toMatch(/Discord/);
  });
});

describe("adminNextStep — unverified captain MMR", () => {
  const ready = { playerCount: 10, minPlayers: 10, teamCount: 4 };

  it("names the unverified captains on the SIGNUPS Start-draft step and points at the fix", () => {
    const s = at({ ...ready, unverifiedCaptainMmrNames: ["Ana", "Bo"] });
    expect(s.title).toMatch(/Start draft/);
    expect(s.detail).toContain(
      "Also: Ana, Bo have unverified MMR that sets draft budgets.",
    );
    expect(s.detail).toContain(
      "Check each with Edit medal & MMR on the Captains & draft card first",
    );
    const one = at({ ...ready, unverifiedCaptainMmrNames: ["Ana"] });
    expect(one.detail).toContain("Ana has unverified MMR");
    expect(one.detail).toContain("Check it with Edit medal & MMR");
  });

  it("keeps the note on the DRAFT-phase pre-start banner too", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.DRAFT,
      draftStatus: DRAFT_STATUS.NOT_STARTED,
      unverifiedCaptainMmrNames: ["Ana"],
    });
    expect(s.title).toMatch(/Start draft/);
    expect(s.detail).toContain("Ana has unverified MMR");
  });

  it("warns without blocking: the step is still the Start-draft action", () => {
    const s = at({ ...ready, unverifiedCaptainMmrNames: ["Ana"] });
    expect(s.tone).toBe("action");
    expect(s.title).toBe("Next step: Start draft.");
  });

  it("says nothing when every captain is verified (or the list wasn't supplied)", () => {
    const base = at(ready).detail;
    expect(at({ ...ready, unverifiedCaptainMmrNames: [] }).detail).toBe(base);
    expect(base).not.toMatch(/unverified/);
  });

  it("caps a long list so the banner stays readable", () => {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    expect(at({ ...ready, unverifiedCaptainMmrNames: names }).detail).toContain(
      "A, B, C, D, E, F +2 more have unverified MMR",
    );
  });

  it("never appears once the auction has started, when budgets are fixed", () => {
    for (const draftStatus of [
      DRAFT_STATUS.IN_PROGRESS,
      DRAFT_STATUS.PAUSED,
      DRAFT_STATUS.COMPLETE,
    ]) {
      expect(
        at({
          seasonStatus: SEASON_STATUS.DRAFT,
          draftStatus,
          unverifiedCaptainMmrNames: ["Ana"],
        }).detail,
      ).not.toMatch(/unverified/);
    }
  });

  it("uses no em-dash in its own copy", () => {
    const withNote = at({ ...ready, unverifiedCaptainMmrNames: ["Ana"] }).detail;
    const note = withNote.slice(at(ready).detail.length);
    expect(note).not.toContain("—");
  });
});

describe("adminNextStep — draft", () => {
  it("says the auction hasn't been started when the phase moved but the draft didn't", () => {
    // Reachable: the phase buttons let an admin click "Draft" without ever
    // pressing Start draft, and then nothing at all happens.
    const s = at({ seasonStatus: SEASON_STATUS.DRAFT, draftStatus: null });
    expect(s.title).toMatch(/Start draft/);
    expect(s.detail).toMatch(/hasn't been started/i);
  });

  it("keeps the Discord chase note on the DRAFT-phase pre-start banner too", () => {
    // The auction hasn't run, so chasing joins is exactly as cheap as during
    // SIGNUPS — the note must not vanish just because the admin clicked the
    // phase button early.
    const s = at({
      seasonStatus: SEASON_STATUS.DRAFT,
      draftStatus: null,
      unlinkedDiscordCount: 2,
    });
    expect(s.detail).toMatch(/2 signed-up players haven't linked Discord/);
  });

  it("flags a PAUSED auction as the blocking state it is", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.DRAFT,
      draftStatus: DRAFT_STATUS.PAUSED,
    });
    expect(s.tone).toBe("warning");
    expect(s.title).toMatch(/PAUSED/);
  });

  it("sends a finished auction to the schedule first, then names the season start", () => {
    // The Regular season waits for fixtures, so the step names both moves
    // in order and links to the schedule card.
    const s = at({
      seasonStatus: SEASON_STATUS.DRAFT,
      draftStatus: DRAFT_STATUS.COMPLETE,
    });
    expect(s.title).toBe(
      "Next step: generate the schedule (with a first match night), then start the Regular season.",
    );
    expect(s.jump?.href).toBe("#adm-schedule");
    expect(s.detail).toContain(`“${START_REGULAR_SEASON}”`);
    expect(s.detail).toMatch(/result sync/i);
    expect(s.detail).toMatch(/week 1/);
  });

  it("points at the phase button once the schedule exists", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.DRAFT,
      draftStatus: DRAFT_STATUS.COMPLETE,
      regularMatchCount: 6,
      pendingRegularResults: 6,
    });
    expect(s.title).toBe("Next step: start the Regular season.");
    expect(s.jump?.href).toBe("#adm-season");
    expect(s.detail).toContain(`“${START_REGULAR_SEASON}”`);
    // Check-in already works in Draft once fixtures have match nights, so
    // the step must not claim it waits for the season.
    expect(s.detail).not.toMatch(/check-in/i);
  });
});

describe("adminNextStep — regular season", () => {
  it("requires a tiebreaker week for unresolved playoff qualification or seeds", () => {
    const result = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      unresolvedPlayoffTieCount: 2,
    });
    expect(result.title).toMatch(/schedule a tiebreaker week/i);
    expect(result.detail).toMatch(/tiebreaker week/);
    expect(result.detail).not.toMatch(/best-of-three/);
  });

  it("waits for scheduled tiebreaker results before prompting playoffs", () => {
    const result = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      unresolvedPlayoffTieCount: 2,
      pendingTiebreakerResults: 1,
    });
    expect(result.title).toBe("Tiebreaker bracket in progress.");
    expect(result.detail).toMatch(/current game in Tiebreakers/);
    expect(result.detail).toMatch(/three-team ties.*next required game automatically/);
    expect(result.tone).toBe("waiting");
  });

  it("continues an existing bracket when its next fixture has not been created", () => {
    const result = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      unresolvedPlayoffTieCount: 3,
      existingTiebreakerCount: 1,
      pendingTiebreakerResults: 0,
    });
    expect(result.title).toBe("Next step: continue the tiebreaker bracket.");
    expect(result.detail).toMatch(/Create next tiebreaker match.*Playoffs controls/);
    expect(result.detail).toMatch(/schedule the next round/);
    expect(result.detail).toMatch(/Regular season/);
    expect(result.tone).toBe("action");
  });

  it("keeps scheduled results ahead of continuation instructions", () => {
    const result = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      unresolvedPlayoffTieCount: 3,
      existingTiebreakerCount: 4,
      pendingTiebreakerResults: 1,
    });
    expect(result.title).toBe("Tiebreaker bracket in progress.");
    expect(result.tone).toBe("waiting");
  });

  it("prompts playoffs when existing tiebreaker results settle every relevant tie", () => {
    const result = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      existingTiebreakerCount: 4,
      unresolvedPlayoffTieCount: 0,
      pendingTiebreakerResults: 0,
    });
    expect(result.title).toBe("Next step: Start playoffs.");
    expect(result.tone).toBe("action");
  });

  it("asks for a schedule before anything else", () => {
    expect(at({ seasonStatus: SEASON_STATUS.REGULAR_SEASON }).title).toMatch(
      /generate the schedule/i,
    );
  });

  // A fixture with no kickoff time gets no auto-sync, weekly reminder,
  // check-in or pick'em lock — the toast that said so is long gone by the
  // time it matters.
  it("warns when no fixture has a kickoff time", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      untimedRegularCount: 15,
      pendingRegularResults: 15,
    });
    expect(s.tone).toBe("warning");
    expect(s.title).toBe("Next step: give every fixture a kickoff time.");
    expect(s.detail).toMatch(/^15 fixtures still have no kickoff time/);
    expect(s.detail).toMatch(/no pick'em lock/i);
    expect(s.jump?.href).toBe("#adm-schedule");
  });

  // Timing week 1 alone used to clear the warning while weeks 2-5 still read
  // "Time TBC".
  it("keeps warning until the last fixture has a time", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      untimedRegularCount: 1,
      pendingRegularResults: 15,
    });
    expect(s.tone).toBe("warning");
    expect(s.detail).toMatch(/^1 fixture still has no kickoff time, so it gets/);
  });

  it("warns before the season starts too, while fixtures lack a time", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.DRAFT,
      draftStatus: DRAFT_STATUS.COMPLETE,
      regularMatchCount: 6,
      untimedRegularCount: 4,
      pendingRegularResults: 6,
    });
    expect(s.title).toBe("Next step: give every fixture a kickoff time.");
    expect(s.jump?.href).toBe("#adm-schedule");
  });

  it("reports outstanding results without nagging for an action", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      pendingRegularResults: 3,
    });
    expect(s.tone).toBe("waiting");
    expect(s.title).toBe("Season running: 3 results outstanding.");
  });

  // Day one used to read "15 result(s) outstanding" for fixtures weeks away.
  it("calls only past-kickoff fixtures outstanding", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      pendingRegularResults: 12,
      outstandingRegularResults: 1,
      nextKickoff: { week: 2, label: "Wed 14 Oct, 20:00 CEST" },
    });
    expect(s.title).toBe("Season running: 1 result outstanding.");
    expect(s.detail).toMatch(/live or past kickoff/);
  });

  it("names the next kickoff while every unplayed fixture is still to come", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      pendingRegularResults: 15,
      outstandingRegularResults: 0,
      nextKickoff: { week: 1, label: "Wed 7 Oct, 20:00 CEST" },
    });
    expect(s.title).toBe(
      "Season running. Week 1 kicks off Wed 7 Oct, 20:00 CEST.",
    );
    expect(s.detail).toMatch(/^15 fixtures still to play\. Nothing to enter before kickoff/);
    expect(s.title).not.toMatch(/outstanding/);
    expect(s.tone).toBe("waiting");
  });

  it("keeps the due results in view behind the missing-kickoff warning", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      untimedRegularCount: 6,
      pendingRegularResults: 12,
      outstandingRegularResults: 2,
    });
    expect(s.title).toMatch(/kickoff time/);
    expect(s.detail).toMatch(/Also: 2 results past kickoff are still missing\.$/);
  });

  it("prompts the playoffs once every result is in — nothing else ever does", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      pendingRegularResults: 0,
    });
    expect(s.title).toMatch(/Start playoffs/);
    expect(s.tone).toBe("action");
  });
});

describe("adminNextStep — playoffs and completion", () => {
  it("warns when the phase is Playoffs but no bracket was ever seeded", () => {
    const s = at({ seasonStatus: SEASON_STATUS.PLAYOFFS });
    expect(s.tone).toBe("warning");
    expect(s.detail).toMatch(/Regular season.*Start playoffs/i);
  });

  it("tells the admin to leave the season in Playoffs while it runs", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.PLAYOFFS,
      playoffMatchCount: 7,
      unfinishedPlayoffCount: 2,
    });
    expect(s.detail).toMatch(/Keep the season in Playoffs/i);
  });

  it("catches a finished bracket with no champion", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.PLAYOFFS,
      playoffMatchCount: 7,
      unfinishedPlayoffCount: 0,
      hasChampion: false,
    });
    expect(s.tone).toBe("warning");
    expect(s.detail).toMatch(/result sync|grand final/i);
  });

  // Legacy rows may predate the safe phase transition. The panel must describe
  // recovery rather than treating them as ordinary completed seasons.
  it("names the way back from a legacy season completed mid-bracket", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.COMPLETE,
      playoffMatchCount: 7,
      unfinishedPlayoffCount: 3,
      hasChampion: false,
    });
    expect(s.tone).toBe("warning");
    expect(s.detail).toMatch(/back to Playoffs/i);
  });

  it("does not call COMPLETE-without-champion finished even when every row is done", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.COMPLETE,
      playoffMatchCount: 7,
      unfinishedPlayoffCount: 0,
      hasChampion: false,
    });
    expect(s.tone).toBe("warning");
    expect(s.title).toMatch(/missing.*champion/i);
    expect(s.detail).toMatch(/back to Playoffs/i);
  });

  it("routes COMPLETE-without-a-bracket through Regular season before seeding", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.COMPLETE,
      playoffMatchCount: 0,
      unfinishedPlayoffCount: 0,
      hasChampion: false,
    });
    expect(s.tone).toBe("warning");
    expect(s.detail).toMatch(/Regular season.*Start playoffs/i);
    expect(s.detail).not.toMatch(/back to Playoffs/i);
  });

  // The league rests in Season complete between seasons; the offseason is
  // only for a cancelled season or reactivating an old one, so the next step
  // no longer offers it as a peer of opening signups.
  it("points at opening the next season after a valid finish", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.COMPLETE,
      hasChampion: true,
    });
    expect(s.tone).toBe("done");
    expect(s.title).toMatch(/open the next season/i);
    // Name the control EXACTLY as the page labels it, where it now is.
    expect(s.detail).toContain("“Season handoff” at the top of this page");
    expect(s.detail).not.toMatch(/offseason/i);
    // Handing off sounds destructive; say plainly that nothing is lost.
    expect(s.detail).toMatch(/stay under Season history/i);
  });
});

// Valve asks for a league ticket at least 15 days before the event, so a
// missing ticket has to be on the admin's screen from the first signup — by
// the time the season starts, the window has passed.
describe("adminNextStep — league ticket", () => {
  const ticketless = (o: Partial<AdminPhaseInput>) =>
    at({ ...o, hasLeagueTicket: false });

  it("warns from the first signup, before anything else is ready", () => {
    const s = ticketless({ playerCount: 2, minPlayers: 10 });
    expect(s.tone).toBe("waiting");
    expect(s.ticketWarning).toMatch(/no Dota league ticket/);
    expect(s.ticketWarning).toMatch(/about 15 days/);
    expect(s.ticketWarning).toMatch(/results can't be imported/);
  });

  it("warns on the Start draft steps, while the draft runs, and when it is done", () => {
    for (const draftStatus of [
      null,
      DRAFT_STATUS.NOT_STARTED,
      DRAFT_STATUS.IN_PROGRESS,
      DRAFT_STATUS.PAUSED,
    ]) {
      expect(
        ticketless({ seasonStatus: SEASON_STATUS.DRAFT, draftStatus })
          .ticketWarning,
      ).toBeTruthy();
    }
    expect(
      ticketless({ playerCount: 10, minPlayers: 10, teamCount: 4 })
        .ticketWarning,
    ).toBeTruthy();
  });

  it("repeats it on the start-of-season steps", () => {
    const moveToRegular = ticketless({
      seasonStatus: SEASON_STATUS.DRAFT,
      draftStatus: DRAFT_STATUS.COMPLETE,
    });
    expect(moveToRegular.title).toMatch(/Regular season/);
    expect(moveToRegular.ticketWarning).toBeTruthy();
    const schedule = ticketless({ seasonStatus: SEASON_STATUS.REGULAR_SEASON });
    expect(schedule.title).toMatch(/generate the schedule/i);
    expect(schedule.ticketWarning).toBeTruthy();
    // The step itself is unchanged — the warning rides beside it.
    expect(moveToRegular.detail).toBe(
      at({
        seasonStatus: SEASON_STATUS.DRAFT,
        draftStatus: DRAFT_STATUS.COMPLETE,
      }).detail,
    );
  });

  it("says nothing when the season has a ticket, or the caller didn't say", () => {
    for (const seasonStatus of [
      SEASON_STATUS.SIGNUPS,
      SEASON_STATUS.DRAFT,
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.PLAYOFFS,
    ]) {
      expect(
        at({ seasonStatus, hasLeagueTicket: true }).ticketWarning,
      ).toBeUndefined();
      expect(at({ seasonStatus }).ticketWarning).toBeUndefined();
    }
  });

  // The warning renders in the same banner as the step's detail, so the
  // detail must not also promise that results import themselves.
  it("never promises results import themselves beside the warning", () => {
    const running = {
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 10,
      untimedRegularCount: 0,
    };
    const steps = [
      { ...running, pendingRegularResults: 3, outstandingRegularResults: 1 },
      { ...running, pendingRegularResults: 3, outstandingRegularResults: 0 },
      {
        seasonStatus: SEASON_STATUS.PLAYOFFS,
        playoffMatchCount: 3,
        unfinishedPlayoffCount: 2,
      },
    ];
    for (const o of steps) {
      const without = ticketless(o);
      expect(without.ticketWarning).toBeTruthy();
      expect(without.detail).not.toMatch(/import themselves/);
      expect(without.detail).toMatch(/by hand|doesn't import/);
      // With a ticket the promise stands.
      expect(at({ ...o, hasLeagueTicket: true }).detail).toMatch(
        /import themselves/,
      );
    }
  });

  it("drops it once the season is complete", () => {
    expect(
      ticketless({ seasonStatus: SEASON_STATUS.COMPLETE, hasChampion: true })
        .ticketWarning,
    ).toBeUndefined();
  });
});

// The line renders under the page title, away from the controls it names, so
// every step that asks for something links to the card that holds it.
describe("adminNextStep — links to the control", () => {
  it("points each action at the card that holds its control", () => {
    expect(at({ playerCount: 10, minPlayers: 10 }).jump?.href).toBe(
      "#adm-captains",
    );
    expect(
      at({ playerCount: 10, minPlayers: 10, teamCount: 4 }).jump?.href,
    ).toBe("#adm-captains");
    expect(
      at({ seasonStatus: SEASON_STATUS.DRAFT, draftStatus: DRAFT_STATUS.IN_PROGRESS })
        .jump?.href,
    ).toBe("/draft");
    expect(at({ seasonStatus: SEASON_STATUS.REGULAR_SEASON }).jump?.href).toBe(
      "#adm-schedule",
    );
    expect(
      at({
        seasonStatus: SEASON_STATUS.REGULAR_SEASON,
        regularMatchCount: 15,
      }).jump?.href,
    ).toBe("#adm-playoffs");
    expect(at({ seasonStatus: SEASON_STATUS.PLAYOFFS }).jump?.href).toBe(
      "#adm-season",
    );
    // Playoff series and their result controls live in the Playoffs card.
    for (const unfinishedPlayoffCount of [0, 2]) {
      expect(
        at({
          seasonStatus: SEASON_STATUS.PLAYOFFS,
          playoffMatchCount: 3,
          unfinishedPlayoffCount,
        }).jump?.href,
      ).toBe("#adm-playoffs");
    }
  });

  it("links nothing while there is nothing to do", () => {
    expect(at({ playerCount: 2, minPlayers: 10 }).jump).toBeUndefined();
    expect(
      at({ seasonStatus: SEASON_STATUS.COMPLETE, hasChampion: true }).jump,
    ).toBeUndefined();
  });
});

describe("phaseAdvance — the phase card's one forward button", () => {
  it("names the two plain phase moves by what they do", () => {
    expect(phaseAdvance(SEASON_STATUS.SIGNUPS)).toMatchObject({
      target: SEASON_STATUS.DRAFT,
      label: "Close signups",
    });
    expect(phaseAdvance(SEASON_STATUS.DRAFT)).toMatchObject({
      target: SEASON_STATUS.REGULAR_SEASON,
      label: START_REGULAR_SEASON,
    });
  });

  it("says Close signups does not start the auction", () => {
    expect(phaseAdvance(SEASON_STATUS.SIGNUPS)?.hint).toMatch(
      /without starting the auction/,
    );
  });

  it("leaves the moves that change other data to their own commands", () => {
    for (const status of [
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.PLAYOFFS,
      SEASON_STATUS.COMPLETE,
    ]) {
      expect(phaseAdvance(status)).toBeNull();
    }
  });

  it("only ever moves one stage forward", () => {
    for (const status of SEASON_PHASE_ORDER) {
      const advance = phaseAdvance(status);
      if (!advance) continue;
      expect(SEASON_PHASE_ORDER.indexOf(advance.target)).toBe(
        SEASON_PHASE_ORDER.indexOf(status) + 1,
      );
    }
  });
});

// The draft room shows admins the finished auction's next step beside its
// button. It said "start the Regular season" above a "Generate the schedule
// first" button; now it takes both titles from here.
describe("the draft room's finished-auction step", () => {
  it("is titled from the same constants as the /admin banner", () => {
    const page = readFileSync(
      join(REPO_ROOT, "src/app/draft/page.tsx"),
      "utf8",
    );
    const room = readFileSync(
      join(REPO_ROOT, "src/components/draft-room.tsx"),
      "utf8",
    );
    expect(page).toMatch(
      /"needsSchedule" in regularSeasonStep\s*\?\s*\{\s*title: DRAFT_DONE_NEEDS_SCHEDULE_TITLE,/,
    );
    expect(page).toContain("title: DRAFT_DONE_START_SEASON_TITLE,");
    expect(room).toContain("{adminFinish.title}");
    expect(room).not.toMatch(/Next step: start the Regular season/);
    expect(
      at({
        seasonStatus: SEASON_STATUS.DRAFT,
        draftStatus: DRAFT_STATUS.COMPLETE,
        regularMatchCount: 0,
      }).title,
    ).toBe(DRAFT_DONE_NEEDS_SCHEDULE_TITLE);
  });
});

// Teams are captains (Start draft makes one per captain), and the signup
// banner never said so: "Waiting on signups — 19 more to go" with 3 captain
// volunteers among 31 players.
describe("the signup steps with the panel's team and captain counts", () => {
  it("says how many teams the pool makes and who offered to captain", () => {
    const s = at({
      playerCount: 31,
      minPlayers: 50,
      teamCount: 0,
      teamSize: 5,
      captainVolunteers: 3,
    });
    // The title Home repeats is unchanged.
    expect(s.title).toBe("Waiting on signups — 19 more to go.");
    expect(s.detail).toContain("Enough for 6 teams of 5.");
    expect(s.detail).toContain("Teams are captains: 0 designated, 3 more offered");
    expect(s.detail).toContain("Start draft needs only two captains");
  });

  it("keeps the old detail when the panel doesn't pass the counts", () => {
    expect(at({ playerCount: 31, minPlayers: 50 }).detail).toBe(
      "31 of 50 players registered. Share the signup link; you can designate captains at any time.",
    );
  });

  it("adds the line to Start draft only while the pool makes more teams than captains", () => {
    const fewer = at({ playerCount: 30, minPlayers: 10, teamCount: 2, teamSize: 5, captainVolunteers: 1 });
    expect(fewer.title).toBe("Next step: Start draft.");
    expect(fewer.detail).toContain("Enough for 6 teams of 5.");
    const matched = at({ playerCount: 10, minPlayers: 10, teamCount: 2, teamSize: 5, captainVolunteers: 0 });
    expect(matched.detail).not.toContain("Teams are captains");
  });
});
