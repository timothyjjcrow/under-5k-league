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
      at({ playerCount: 10, minPlayers: 10, teamCount: 4, unlinkedDiscordCount: 0 })
        .detail,
    ).not.toMatch(/Discord/);
    expect(
      at({ playerCount: 10, minPlayers: 10, teamCount: 4 }).detail,
    ).not.toMatch(/Discord/);
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
  it("asks for a schedule before anything else", () => {
    expect(
      at({ seasonStatus: SEASON_STATUS.REGULAR_SEASON }).title,
    ).toMatch(/generate the schedule/i);
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
    expect(s.detail).toMatch(/Re-save the final/i);
  });

  // The state setSeasonPhase's close-out escape produces. Every playoff result
  // saves with a success toast in COMPLETE while advancing nothing, so the
  // panel has to name the one-click way back.
  it("names the way back from a season completed mid-bracket", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.COMPLETE,
      playoffMatchCount: 7,
      unfinishedPlayoffCount: 3,
      hasChampion: false,
    });
    expect(s.tone).toBe("warning");
    expect(s.detail).toMatch(/back to Playoffs/i);
  });

  it("turns a finished season into the next one, since nothing else prompts it", () => {
    const s = at({
      seasonStatus: SEASON_STATUS.COMPLETE,
      hasChampion: true,
    });
    expect(s.title).toMatch(/create the next season/i);
    // Name the control EXACTLY as the page labels it.
    expect(s.detail).toContain("Create a new season");
    // Archiving sounds destructive; say plainly that nothing is lost.
    expect(s.detail).toMatch(/kept/i);
  });
});
