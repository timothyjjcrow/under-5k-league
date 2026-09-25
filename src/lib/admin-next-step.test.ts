import { describe, it, expect } from "vitest";
import { adminNextStep, type AdminPhaseInput } from "./admin-next-step";
import { DRAFT_STATUS, SEASON_STATUS } from "./constants";

const base: AdminPhaseInput = {
  seasonStatus: SEASON_STATUS.SIGNUPS,
  draftStatus: null,
  playerCount: 0,
  minPlayers: 10,
  teamCount: 0,
  regularMatchCount: 0,
  scheduledRegularCount: 0,
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

  it("keeps the draft-complete banner that everything else was modelled on", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.DRAFT,
      draftStatus: DRAFT_STATUS.COMPLETE,
    });
    expect(s.title).toMatch(/Regular season/);
    expect(s.detail).toMatch(/result sync/i);
  });
});

describe("adminNextStep — regular season", () => {
  it("requires a tiebreaker week for unresolved playoff qualification or seeds", () => {
    const result = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      scheduledRegularCount: 15,
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
      scheduledRegularCount: 15,
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
      scheduledRegularCount: 15,
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
      scheduledRegularCount: 15,
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
      scheduledRegularCount: 15,
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

  // A schedule with no kickoff times silently disables auto-sync, the weekly
  // reminder and pick'em locks for the whole season — the toast that said so is
  // long gone by the time it matters.
  it("warns when no fixture has a kickoff time", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      scheduledRegularCount: 0,
    });
    expect(s.tone).toBe("warning");
    expect(s.detail).toMatch(/pick'em never locks/i);
  });

  it("reports outstanding results without nagging for an action", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      scheduledRegularCount: 15,
      pendingRegularResults: 3,
    });
    expect(s.tone).toBe("waiting");
    expect(s.title).toContain("3 result(s)");
  });

  it("prompts the playoffs once every result is in — nothing else ever does", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.REGULAR_SEASON,
      regularMatchCount: 15,
      scheduledRegularCount: 15,
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

  it("offers a deliberate offseason or next season after a valid finish", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.COMPLETE,
      hasChampion: true,
    });
    expect(s.title).toMatch(/choose the league's next state/i);
    // Name the control EXACTLY as the page labels it.
    expect(s.detail).toContain("Season handoff");
    expect(s.detail).toContain("offseason");
    // Archiving sounds destructive; say plainly that nothing is lost.
    expect(s.detail).toMatch(/kept/i);
  });
});
