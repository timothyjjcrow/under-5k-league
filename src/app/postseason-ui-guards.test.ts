import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("postseason UI lifecycle guards", () => {
  it("does not expose generic phase changes that bypass bracket commands", () => {
    const admin = read("src/app/admin/page.tsx");
    const policy = read("src/lib/season-phase-policy.ts");

    expect(admin).toContain("seasonPhasePolicy({");
    expect(admin).toContain("confirm={state.confirmation}");
    expect(admin).toContain("recoverablePostseasonBracket(playoff)");
    expect(policy).toContain("slots.has(match.bracketSlot)");
    expect(policy).toContain("target === SEASON_STATUS.COMPLETE");
    expect(policy).toContain("target === SEASON_STATUS.PLAYOFFS");
    expect(policy).toContain("postseasonMatchCount > 0");
    expect(policy).toContain(
      "Use Start playoffs to seed the bracket and enter Playoffs together.",
    );
    expect(policy).toContain(
      "Use Return to regular season so the existing bracket is removed safely.",
    );
    expect(policy).toContain("draftStatus !== DRAFT_STATUS.COMPLETE");
    expect(policy).toContain("Use Abort draft");
  });

  it("mirrors schedule, correction, kickoff, and playoff-start capabilities in the admin UI", () => {
    const admin = read("src/app/admin/page.tsx");

    expect(admin).toContain("const scheduleEditingOpen = postAuctionWorkOpen(");
    expect(admin).toContain("const scheduleGenerationLockedReason =");
    expect(admin).toContain("scheduleEditingOpen && openWeeks.length > 0");
    expect(admin).toContain(
      "correctionBlockedByLaterRound={hasLaterBracketRound(",
    );
    expect(admin).toContain("resultOpen && !correctionBlockedByLaterRound");
    expect(admin).toContain("const logisticsOpen = matchLogisticsOpen(");
    expect(admin).toContain("draftStatus={data.draft?.status ?? null}");
    expect(admin).toContain("disabled={startPlayoffsLockedReason != null}");
    expect(admin).toContain("season.status !== SEASON_STATUS.REGULAR_SEASON");
    expect(admin).toContain("status.pending > 0");
  });

  it("keeps team withdrawal and reinstatement visibly regular-season-only", () => {
    const admin = read("src/app/admin/page.tsx");

    expect(admin).toContain(
      "const teamWithdrawalLocked = teamWithdrawalLockedReason(season.status)",
    );
    expect(admin).toContain("Team withdrawal locked:");
    expect(admin).toContain("Reinstatement locked:");
    expect(admin).toContain("hidden={{ expectedActiveSeasonId: season.id }}");
    expect(admin).toContain("expectedActiveSeasonId: season.id,");
  });

  it("reserves champion retraction for the final's stored participant, including mismatch recovery", () => {
    const admin = read("src/app/admin/page.tsx");
    const start = admin.indexOf("const championIsFinalParticipant =");
    const end = admin.indexOf("const crownedGrandFinal =", start);
    const classification = admin.slice(start, end);

    expect(classification).toContain("championTeamId != null");
    expect(classification).toContain("championTeamId === m.homeTeamId");
    expect(classification).toContain("championTeamId === m.awayTeamId");
    expect(classification).toContain("isSoleLatestPlayoffSeries");
    expect(admin).toContain("const conflictingChampionFinal =");
    expect(admin).toContain("Retract the inconsistent champion");
    expect(admin).toContain("title-retraction controls stay hidden");
  });

  it("distinguishes missing-bracket recovery from final reconciliation", () => {
    const dashboard = read("src/app/page.tsx");
    const schedule = read("src/app/schedule/page.tsx");

    expect(dashboard).toContain(
      "const hasPostseason = championPresentation.hasPostseason",
    );
    expect(dashboard).toContain(
      "return it to Regular season, verify the table, and start a newly seeded bracket",
    );
    expect(schedule).toContain('season.status === "COMPLETE"');
    expect(schedule).toContain('"Season results"');
    expect(schedule).toContain("scheduleEditingOpen && untimedOpen.length > 0");
    expect(schedule).toContain(
      "return it to Regular season, verify the table, and use Start playoffs",
    );
  });
});

describe("postseason status semantics", () => {
  it("shows withdrawn status on both team summaries and power rankings", () => {
    const teams = read("src/app/teams/page.tsx");

    expect(teams).toContain("withdrawnTeamIds.has(row.teamId)");
    expect(teams).toContain("t.withdrawn ? (");
    expect(teams.match(/Withdrawn/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("gives the standings a row header, spoken seeds, and a semantic cut", () => {
    const standings = read("src/components/standings-table.tsx");

    expect(standings).toContain('<th scope="row"');
    expect(standings).toContain("current playoff seed");
    expect(standings).toContain("seed {row.playoffSeed}");
    expect(standings).toContain("outside the current playoff field");
    expect(standings).not.toContain('<tr aria-hidden className="bg-success');
  });

  it("labels archived standings according to the archived season phase", () => {
    const team = read("src/app/teams/[id]/page.tsx");

    expect(team).toContain("team.season.status === SEASON_STATUS.COMPLETE");
    expect(team).toContain('"Final standings →"');
    expect(team).toContain('"Standings at archive →"');
    expect(team).toContain('"Season overview →"');
  });
});
