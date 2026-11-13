import { describe, expect, it } from "vitest";
import {
  folderSourceFiles,
  haystackOf,
  sourceFile,
  stripLineComments,
} from "../../test/support/source-files";
import { captainsHref, captainsMatchHref, captainsPageOpen } from "./captains";

describe("captainsPageOpen", () => {
  const active = (status: string) => ({ isActive: true, status });
  const team = { withdrawn: false };

  it("opens for a sitting captain from signups through the playoffs", () => {
    for (const status of ["SIGNUPS", "DRAFT", "REGULAR_SEASON", "PLAYOFFS"]) {
      expect(captainsPageOpen(active(status), team)).toBe(true);
    }
  });

  it("stays shut with no team, a withdrawn team, a finished or archived season", () => {
    expect(captainsPageOpen(active("REGULAR_SEASON"), null)).toBe(false);
    expect(captainsPageOpen(active("REGULAR_SEASON"), { withdrawn: true })).toBe(
      false,
    );
    expect(captainsPageOpen(active("COMPLETE"), team)).toBe(false);
    expect(
      captainsPageOpen({ isActive: false, status: "REGULAR_SEASON" }, team),
    ).toBe(false);
  });
});

describe("captainsMatchHref", () => {
  it("opens one match's controls, optionally at one card", () => {
    expect(captainsMatchHref("m1")).toBe("/captains?match=m1");
    expect(captainsMatchHref("m 2", "match-standins")).toBe(
      "/captains?match=m%202#match-standins",
    );
  });
});

describe("captainsHref", () => {
  it("keeps the open fixture and the open scrim in one link", () => {
    expect(captainsHref()).toBe("/captains");
    expect(captainsHref({ match: "m1", scrim: "s1" }, "scrim-desk")).toBe(
      "/captains?match=m1&scrim=s1#scrim-desk",
    );
    expect(captainsHref({ match: null, scrim: "s 1" })).toBe(
      "/captains?scrim=s%201",
    );
    expect(captainsHref({ match: "m1", scrim: null }, "matches")).toBe(
      "/captains?match=m1#matches",
    );
  });
});

const read = (file: string) => stripLineComments(sourceFile(file).text);
const PAGE = stripLineComments(
  haystackOf(folderSourceFiles("src/app/captains", 5)),
);

/**
 * One rule decides what waits on a captain (`captainTodos`) and one decides
 * who gets the Captains page (`captainsPageOpen`). The match page's "Waiting
 * on you" list, Home's captain line and the page must read them, never a
 * copy that drifts.
 */
describe("captain surfaces share their rules", () => {
  it("decides to-dos in captainTodos, everywhere", () => {
    expect(read("src/app/matches/[id]/captain-todos.tsx")).toContain(
      "captainTodos({",
    );
    expect(read("src/lib/captains-service.ts")).toContain("captainTodos({");
    expect(read("src/components/home/captain-strip.tsx")).toContain(
      "loadCaptainTodoRows({",
    );
    expect(PAGE).toContain("loadCaptainTodoRows({");
    // The lines render through one component, and on the Captains page they
    // open that match's controls here.
    expect(read("src/app/matches/[id]/captain-todos.tsx")).toContain(
      "<CaptainTodoItem",
    );
    expect(PAGE).toMatch(/<CaptainTodoItem[\s\S]*?href=\{captainsMatchHref\(/);
  });

  it("offers the page by captainsPageOpen on the header, Home and the page", () => {
    expect(read("src/app/layout.tsx")).toContain("captainsPageOpen(season,");
    expect(read("src/app/page.tsx")).toContain("captainsPageOpen(season,");
    expect(PAGE).toContain("captainsPageOpen(snapshot.season, team)");
  });

  it("finds the captain by Team.captainId, never a roster row's isCaptain", () => {
    expect(read("src/lib/captains-service.ts")).toContain(
      "seasonId_captainId: { seasonId, captainId: userId }",
    );
    expect(read("src/app/layout.tsx")).toContain(
      "myTeam?.team.captainId === user.id",
    );
    expect(read("src/app/page.tsx")).toContain("team.captainId === user.id");
  });
});

/**
 * The Captains page draws the site's existing controls, so each keeps the
 * rule and the server check it already has. A control rebuilt here instead
 * would be a second copy of a rule, free to drift from the card it copies.
 */
describe("the Captains page reuses the site's own controls", () => {
  it("draws the match page's Captain tools and its moved-by-ready-check card", () => {
    expect(PAGE).toContain('from "@/app/matches/[id]/captain-tools"');
    expect(PAGE).toMatch(/<CaptainTools\s+match=\{match\}\s+viewer=\{viewer\}/);
    expect(PAGE).toContain('<RescheduleSection match={match} viewer={viewer} part="moved" />');
    expect(PAGE).toContain("<LiveSeriesCheckin match={match} viewer={viewer} />");
  });

  it("points at standins, the reschedule and reporting with the match page's shortcuts", () => {
    // One rule (captainJumps) for the scoreboard and the fixture header here,
    // each jump gated like the card it lands on.
    expect(PAGE).toMatch(
      /captainJumps\(\{[\s\S]*?\.\.\.captainCardsOpen\(match, draftStatus\),/,
    );
    expect(read("src/app/matches/[id]/scoreboard.tsx")).toContain("captainJumps({");
    expect(PAGE).toContain('aria-label="Captain shortcuts"');
  });

  it("asks check-ins and the Remind button the match page's questions", () => {
    expect(PAGE).toContain("<CheckinBanner");
    expect(PAGE).toMatch(/matchCheckinOpen\(\s*match\.season\.status,/);
    expect(PAGE).toContain("<CheckinNudgeControl matchId={match.id} nudge={nudge} />");
    const service = read("src/lib/captains-service.ts");
    expect(service).toMatch(/\.unansweredUserIds\.filter\(\s*\(id\) => id !== viewerId,?\s*\)/);
    expect(service).toContain("matchNightRoster(");
    expect(service).toContain("await getWebhookUrl()");
    expect(service).toContain("checkinNudgeBlockedSince(");
  });

  it("draws /scrims' own forms, with its join rule", () => {
    for (const control of ["<ScrimPostForm />", "<ScrimJoinButton", "<ScrimCancelButton"]) {
      expect(PAGE).toContain(control);
      expect(read("src/app/scrims/page.tsx")).toContain(control);
    }
    expect(PAGE).toContain("scrimJoinCheck({");
    // A live scrim can't be cancelled (cancelScrim refuses it).
    expect(PAGE).toContain("seasonOpen && s.status !== SCRIM_STATUS.LIVE");
  });

  it("manages a booked scrim with the scrim page's controls and its one rule", () => {
    const scrimPage = read("src/app/scrims/[id]/page.tsx");
    for (const control of [
      "<ScrimLobbyCard",
      "<ScrimLineups",
      "<ScrimResultTools scrimId={scrim.id} />",
      "<ScrimEndSeriesForm",
    ]) {
      expect(PAGE).toContain(control);
      expect(scrimPage).toContain(control);
    }
    // Who gets which control is decided once, for both pages.
    expect(PAGE).toContain("scrimManageView({");
    expect(scrimPage).toContain("scrimManageView({");
    expect(scrimPage).not.toMatch(/const (canCancel|canEndSeries|mutable) =/);
    expect(PAGE).toContain("scrimNextStep({");
    // The password goes only where the rule allows it.
    expect(PAGE).toMatch(
      /view\.seesPassword \? scrimLobbyPassword\(scrim\.id\) : null/,
    );
    expect(scrimPage).toMatch(/manage\.seesPassword\s*\?/);
    // Only the team's own booking opens: the page checks the side itself.
    expect(PAGE).toContain("host.id !== teamId && away.id !== teamId");
    // Picking a scrim keeps the fixture open, and picking a fixture the scrim.
    expect(PAGE).toContain("{ match: matchId, scrim: s.id }");
    expect(PAGE).toContain("{ match: m.id, scrim: scrimId }");
  });

  it("keeps a captain on the page for cover, and reads ?scrim= safely", () => {
    expect(PAGE).toContain("coverHref={`#${MATCH_ANCHOR.standins}`}");
    expect(read("src/components/checkin-banner.tsx")).toContain(
      "coverHref ?? matchAnchorPath(matchId, MATCH_ANCHOR.standins)",
    );
    expect(PAGE).toContain("singleSearchParam(query.scrim)");
  });

  it("shows the draft budget the team page shows", () => {
    expect(PAGE).toContain("draftBudgetsForDisplay({");
    expect(read("src/app/teams/[id]/page.tsx")).toContain(
      "draftBudgetsForDisplay({",
    );
  });

  it("edits the team with the team page's form and rule, and its coaches", () => {
    expect(PAGE).toContain("canEditTeamIdentity({");
    expect(PAGE).toContain("action={editTeamIdentity}");
    expect(read("src/app/teams/[id]/page.tsx")).toContain("action={editTeamIdentity}");
    expect(PAGE).toContain("<TeamCoachesCard");
    expect(read("src/app/scrims/page.tsx")).toContain("<TeamCoachesCard");
  });

  it("refreshes after a scrim action, which revalidates only named paths", () => {
    expect(read("src/app/actions/scrims.ts")).toContain(
      "revalidatePath(CAPTAINS_HREF);",
    );
  });
});
