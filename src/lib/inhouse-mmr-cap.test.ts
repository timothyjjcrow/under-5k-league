import { describe, expect, it } from "vitest";
import { sourceFile, stripLineComments } from "../../test/support/source-files";
import { HARD_MMR_CEILING } from "./constants";
import {
  INHOUSE_ADMIN_MMR_MAX,
  adminInhouseMmr,
  inhouseFixedMmr,
  inhouseJoinRefusal,
  inhouseJoinRefusalBeforeTyping,
} from "./inhouse-mmr-cap";

describe("inhouseJoinRefusal — the medal", () => {
  it("refuses a Divine 3 or higher medal whatever MMR the join carries", () => {
    // Divine 3/4/5 start at 5020/5220/5420 and Immortal at 5620: over the
    // ceiling by the medal alone, so a low claim can't walk past it.
    for (const rankTier of [73, 74, 75, 80]) {
      for (const mmr of [0, 3000, HARD_MMR_CEILING]) {
        expect(
          inhouseJoinRefusal({ mmr, source: "typed", rankTier }),
          `tier ${rankTier} at ${mmr}`,
        ).toMatch(/medal puts you above it/);
      }
    }
  });

  it("names the medal and the cap (the Divine 4 who joined at a typed 5,000)", () => {
    expect(inhouseJoinRefusal({ mmr: 5000, source: "typed", rankTier: 74 })).toBe(
      "Inhouses are for players up to 5,000 MMR, the same as the league: your Divine 4 medal puts you above it.",
    );
    expect(inhouseJoinRefusal({ mmr: 0, source: "signup", rankTier: 80 })).toMatch(
      /your Immortal medal/,
    );
  });

  it("lets a Divine 2 or lower medal through at an MMR up to the cap", () => {
    for (const rankTier of [11, 35, 54, 65, 71, 72]) {
      expect(
        inhouseJoinRefusal({ mmr: HARD_MMR_CEILING, source: "typed", rankTier }),
        `tier ${rankTier}`,
      ).toBeNull();
    }
  });

  it("judges the medal before the number, the reason no retyping fixes", () => {
    expect(inhouseJoinRefusal({ mmr: 9000, source: "typed", rankTier: 75 })).toMatch(
      /Divine 5 medal/,
    );
  });
});

describe("inhouseJoinRefusal — the MMR", () => {
  it("allows exactly the cap and refuses one over it", () => {
    expect(inhouseJoinRefusal({ mmr: 5000, source: "typed", rankTier: null })).toBeNull();
    expect(inhouseJoinRefusal({ mmr: 5001, source: "typed", rankTier: null })).toBe(
      "Inhouses are for players up to 5,000 MMR, the same as the league: you entered 5,001.",
    );
  });

  it("judges a typed number as typed, under a low medal too", () => {
    // The clamp would store Legend 4's floor for this claim; judging the
    // clamped number would let any claim big enough through.
    expect(inhouseJoinRefusal({ mmr: 6800, source: "typed", rankTier: 54 })).toMatch(
      /you entered 6,800/,
    );
  });

  it("never refuses an unknown MMR with no medal (Tim's call: unknown never blocks)", () => {
    expect(inhouseJoinRefusal({ mmr: 0, source: "typed", rankTier: null })).toBeNull();
    expect(inhouseJoinRefusal({ mmr: 0, source: "typed", rankTier: 0 })).toBeNull();
    expect(inhouseJoinRefusal({ mmr: 0, source: "typed", rankTier: undefined })).toBeNull();
  });

  it("says where an over-the-cap number came from", () => {
    expect(inhouseJoinRefusal({ mmr: 5200, source: "signup", rankTier: null })).toMatch(
      /your league signup has you at 5,200 MMR\.$/,
    );
    expect(inhouseJoinRefusal({ mmr: 6000, source: "last-game", rankTier: null })).toMatch(
      /your last inhouse had you at 6,000 MMR\. Type your MMR to join\.$/,
    );
    expect(inhouseJoinRefusal({ mmr: 6000, source: "admin", rankTier: null })).toBe(
      "Inhouses are for players up to 5,000 MMR, the same as the league: an admin set your inhouse MMR to 6,000.",
    );
  });

  it("is pinned to the league's hard ceiling", () => {
    expect(HARD_MMR_CEILING).toBe(5000);
    expect(
      inhouseJoinRefusal({ mmr: HARD_MMR_CEILING + 1, source: "typed", rankTier: null }),
    ).not.toBeNull();
  });
});

describe("inhouseFixedMmr — the MMR no typed number changes", () => {
  it("takes an admin's number over the league signup's", () => {
    expect(inhouseFixedMmr({ adminMmr: 4100, signupMmr: 2600 })).toEqual({
      mmr: 4100,
      source: "admin",
    });
    expect(inhouseFixedMmr({ adminMmr: 1200, signupMmr: 0 })).toEqual({
      mmr: 1200,
      source: "admin",
    });
  });

  it("falls back to the league signup's, then to nothing (the player types)", () => {
    expect(inhouseFixedMmr({ adminMmr: null, signupMmr: 2600 })).toEqual({
      mmr: 2600,
      source: "signup",
    });
    expect(inhouseFixedMmr({ adminMmr: null, signupMmr: 0 })).toBeNull();
  });

  it("reads anything saveInhouseRating never writes as no admin number", () => {
    for (const stored of [0, -5, 2.5, INHOUSE_ADMIN_MMR_MAX + 1, Number.NaN]) {
      expect(adminInhouseMmr(stored), `stored ${stored}`).toBeNull();
      expect(inhouseFixedMmr({ adminMmr: stored, signupMmr: 3000 })?.source).toBe("signup");
    }
    expect(adminInhouseMmr(null)).toBeNull();
    expect(adminInhouseMmr(undefined)).toBeNull();
    expect(adminInhouseMmr(1)).toBe(1);
    expect(adminInhouseMmr(INHOUSE_ADMIN_MMR_MAX)).toBe(INHOUSE_ADMIN_MMR_MAX);
  });
});

describe("inhouseJoinRefusalBeforeTyping — what the room shows in place of Join", () => {
  it("refuses a medal over the line with no fixed MMR", () => {
    expect(
      inhouseJoinRefusalBeforeTyping({ adminMmr: null, signupMmr: 0, rankTier: 74 }),
    ).toMatch(/Divine 4 medal/);
  });

  it("refuses a league signup's MMR over the line", () => {
    expect(
      inhouseJoinRefusalBeforeTyping({ adminMmr: null, signupMmr: 5200, rankTier: null }),
    ).toMatch(/league signup has you at 5,200/);
  });

  it("judges an admin's number, over the signup's, by the same line", () => {
    expect(
      inhouseJoinRefusalBeforeTyping({ adminMmr: 5600, signupMmr: 3000, rankTier: null }),
    ).toMatch(/an admin set your inhouse MMR to 5,600\.$/);
    // Under the line, an admin's number lets in a signup over it.
    expect(
      inhouseJoinRefusalBeforeTyping({ adminMmr: 4800, signupMmr: 5400, rankTier: null }),
    ).toBeNull();
    // The medal still refuses, whatever number an admin set.
    expect(
      inhouseJoinRefusalBeforeTyping({ adminMmr: 3000, signupMmr: 0, rankTier: 75 }),
    ).toMatch(/Divine 5 medal/);
  });

  it("offers Join to everyone else: the typed number is judged when it's sent", () => {
    expect(
      inhouseJoinRefusalBeforeTyping({ adminMmr: null, signupMmr: 0, rankTier: null }),
    ).toBeNull();
    expect(
      inhouseJoinRefusalBeforeTyping({ adminMmr: null, signupMmr: 0, rankTier: 72 }),
    ).toBeNull();
    expect(
      inhouseJoinRefusalBeforeTyping({ adminMmr: null, signupMmr: 4500, rankTier: 65 }),
    ).toBeNull();
  });
});

// The room can't render a join it would refuse only if every place reads the
// one rule over the same facts: the server's join, the page that decides
// whether to offer Join, and the controls that draw it.
describe("the MMR cap's call sites", () => {
  it("joinQueue judges the join before it writes anything", () => {
    const service = stripLineComments(sourceFile("src/lib/inhouse-service.ts").text);
    const start = service.indexOf("export async function joinQueue(");
    expect(start).toBeGreaterThan(-1);
    const body = service.slice(start, service.indexOf("\nexport ", start + 1));
    const facts = body.indexOf("await loadInhouseJoinFacts(viewer.id)");
    const fixed = body.indexOf("inhouseFixedMmr({ adminMmr, signupMmr })");
    const refusal = body.indexOf("inhouseJoinRefusal({ mmr: claimed, source, rankTier })");
    expect(facts).toBeGreaterThan(-1);
    expect(fixed).toBeGreaterThan(facts);
    expect(refusal).toBeGreaterThan(fixed);
    expect(body.indexOf("if (refusal) return { ok: false, error: refusal };")).toBeGreaterThan(refusal);
    // The positions save and the queue write both come after it.
    expect(body.indexOf("setInhouseRoles(viewer, roles)")).toBeGreaterThan(refusal);
    expect(body.indexOf("prisma.$transaction(")).toBeGreaterThan(refusal);
  });

  it("/inhouse offers Join by the same rule over the same facts", () => {
    const page = stripLineComments(sourceFile("src/app/inhouse/page.tsx").text);
    expect(page).toContain("loadInhouseJoinFacts(user.id)");
    expect(page).toContain("inhouseJoinRefusalBeforeTyping(joinFacts)");
    expect(page).toContain("inhouseFixedMmr(joinFacts)");
    expect(page.match(/joinRefusal=\{joinRefusal\}/g)).toHaveLength(1);
    // No admin MMR, signup MMR or medal read of its own to drift from
    // joinQueue's.
    expect(page).not.toMatch(/registration\.findFirst|rankTier: true|inhouseMmr: true/);
  });

  it("the room draws the reason in place of Join, and no Run it back", () => {
    const room = sourceFile("src/components/inhouse-room.tsx").text;
    expect(room).toContain("me.canJoin && !joinRefusal ?");
    // Every queue view the room renders gets it.
    const views = room.match(/<(?:QueueView|NextGameQueueCard)\b[\s\S]*?\/>/g) ?? [];
    expect(views.length).toBeGreaterThanOrEqual(3);
    for (const view of views) expect(view).toContain("joinRefusal={joinRefusal}");
    const queue = sourceFile("src/components/inhouse/queue-view.tsx").text;
    const action = queue.slice(
      queue.indexOf("function QueueAction("),
      queue.indexOf("function FixedMmrNote("),
    );
    const answered = action.indexOf("if (joinRefusal) {");
    expect(answered).toBeGreaterThan(action.indexOf("if (me.inQueue) {"));
    expect(answered).toBeLessThan(action.indexOf("const joinButton"));
    // The MMR box stops at the cap.
    expect(queue).toContain("max={HARD_MMR_CEILING}");
  });
});
