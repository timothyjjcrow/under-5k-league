import { describe, expect, it } from "vitest";
import {
  accountNextSteps,
  discordCardCtas,
  discordLinkNote,
  favoriteHeroSuggestions,
  fullPlayerChoiceOpen,
  mergeAccountRefresh,
  mmrLeadLine,
  mmrPreviewLine,
  mmrRulesLine,
  rejoinPausedByDraft,
  returningJoinPlan,
  signupSummary,
  withdrawConfirmText,
  type AccountStepInput,
  type DiscordCardInput,
} from "./account-page";

const base: AccountStepInput = {
  signedUp: true,
  draftConfirmation: "none",
  isCaptain: false,
  discordLinked: true,
  discordHandle: true,
  discordLinkable: true,
  membership: "member",
  matchDataPrivate: false,
};
const keys = (input: Partial<AccountStepInput>) =>
  accountNextSteps({ ...base, ...input }).map((s) => s.key);

describe("accountNextSteps", () => {
  it("is empty for a signed-up player who is linked, in the server and public", () => {
    expect(keys({})).toEqual([]);
  });

  it("asks to link Discord until an OAuth link exists", () => {
    expect(keys({ discordLinked: false, membership: null })).toEqual([
      "link-discord",
    ]);
  });

  it("does not let a typed handle stand in for a link", () => {
    expect(
      keys({ discordLinked: false, discordHandle: true, membership: null }),
    ).toEqual(["link-discord"]);
  });

  it("accepts a typed handle where the league can't link Discord", () => {
    expect(
      keys({
        discordLinked: false,
        discordHandle: true,
        discordLinkable: false,
        membership: null,
      }),
    ).toEqual([]);
    const [step] = accountNextSteps({
      ...base,
      discordLinked: false,
      discordHandle: false,
      discordLinkable: false,
      membership: null,
    });
    expect(step.label).toBe("Add your Discord so captains can reach you");
  });

  it("counts a linked account as done only once it is in the server", () => {
    expect(keys({ membership: "not-member" })).toEqual(["join-server"]);
    expect(keys({ membership: "pending" })).toEqual(["accept-rules"]);
    expect(keys({ membership: "member" })).toEqual([]);
  });

  it("never flags a linked account whose membership is unknown", () => {
    expect(keys({ membership: null })).toEqual([]);
  });

  it("puts the draft confirmation first and points up to it", () => {
    const steps = accountNextSteps({
      ...base,
      draftConfirmation: "needed",
      discordLinked: false,
      matchDataPrivate: true,
    });
    expect(steps.map((s) => s.key)).toEqual([
      "confirm-draft",
      "link-discord",
      "match-data",
    ]);
    expect(steps[0]).toMatchObject({ href: "#draft-commitment", arrow: "up" });
    expect(steps[1]).toMatchObject({ href: "#profile-discord", arrow: "down" });
    expect(steps[2]).toMatchObject({ href: "#profile-dota", arrow: "down" });
  });

  it("says when the draft time changed after a confirmation", () => {
    const [step] = accountNextSteps({ ...base, draftConfirmation: "changed" });
    expect(step.label).toMatch(/draft time changed/);
  });

  it("addresses a captain's team rather than a captain", () => {
    const [player] = accountNextSteps({ ...base, discordLinked: false });
    const [captain] = accountNextSteps({
      ...base,
      discordLinked: false,
      isCaptain: true,
    });
    expect(player.label).toMatch(/captains can reach you/);
    expect(captain.label).toMatch(/your team can reach you/);
  });

  it("leaves Discord alone before someone signs up, but still flags private match data", () => {
    expect(
      keys({ signedUp: false, discordLinked: false, membership: null }),
    ).toEqual([]);
    expect(
      keys({
        signedUp: false,
        draftConfirmation: "needed",
        discordLinked: false,
        matchDataPrivate: true,
      }),
    ).toEqual(["match-data"]);
  });

  it("gives every step a distinct label, so no two controls share a name", () => {
    const all = [
      ...accountNextSteps({
        ...base,
        draftConfirmation: "needed",
        discordLinked: false,
        matchDataPrivate: true,
      }),
      ...accountNextSteps({ ...base, membership: "not-member" }),
      ...accountNextSteps({ ...base, membership: "pending" }),
    ].map((s) => s.label);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("signupSummary", () => {
  it("summarises a full signup", () => {
    expect(
      signupSummary({
        type: "PLAYER",
        mmr: 3200,
        roles: "2,3",
        favoriteHeroes: "Pudge, Lion, Sniper",
        wantsCaptain: true,
      }),
    ).toBe("Full player · 3200 MMR · Mid, Offlane · 3 heroes · Captain volunteer");
  });

  it("leaves out empty answers and an unknown MMR", () => {
    expect(
      signupSummary({
        type: "PLAYER",
        mmr: 0,
        roles: "",
        favoriteHeroes: "",
        wantsCaptain: false,
      }),
    ).toBe("Full player");
  });

  it("says 'Any position' when every role is ticked and counts one hero", () => {
    expect(
      signupSummary({
        type: "STANDIN",
        mmr: 2100,
        roles: "1,2,3,4,5",
        favoriteHeroes: "Axe",
        wantsCaptain: false,
      }),
    ).toBe("Standin · 2100 MMR · Any position · 1 hero");
  });

  it("never calls a standin a captain volunteer", () => {
    expect(
      signupSummary({
        type: "STANDIN",
        mmr: 0,
        roles: null,
        favoriteHeroes: null,
        wantsCaptain: true,
      }),
    ).toBe("Standin");
  });

  it("counts hero names it doesn't recognise too", () => {
    expect(
      signupSummary({
        type: "PLAYER",
        mmr: 0,
        roles: "1",
        favoriteHeroes: "Pudge, Not A Hero",
        wantsCaptain: false,
      }),
    ).toBe("Full player · Carry · 2 heroes");
  });
});

describe("discordLinkNote", () => {
  it("maps known callback codes and never echoes an unknown one", () => {
    expect(discordLinkNote(undefined, null)).toBeNull();
    expect(discordLinkNote("linked", null)?.tone).toBe("success");
    expect(discordLinkNote("taken", null)?.tone).toBe("danger");
    const generic = discordLinkNote("error", null);
    expect(discordLinkNote("<script>", null)).toEqual(generic);
    // Inherited keys must fall back to the generic note, not an empty one.
    expect(discordLinkNote("__proto__", null)).toEqual(generic);
    expect(discordLinkNote("toString", null)).toEqual(generic);
  });

  it("lets the live membership answer beat the callback's report", () => {
    const joined = discordLinkNote("joined", null);
    expect(discordLinkNote("join_failed", "member")).toEqual(joined);
    expect(discordLinkNote("joined_pending", "member")).toEqual(joined);
    expect(discordLinkNote("join_failed", "pending")).toEqual(
      discordLinkNote("joined_pending", null),
    );
    expect(discordLinkNote("join_failed", null)?.text).toMatch(
      /couldn't add you/,
    );
  });
});

describe("discordCardCtas", () => {
  const card: DiscordCardInput = {
    linked: false,
    membership: null,
    linkAvailable: true,
    autoJoins: true,
    hasInvite: true,
  };
  const ctas = (input: Partial<DiscordCardInput>) =>
    discordCardCtas({ ...card, ...input });

  it("offers one-click linking with the invite beside it", () => {
    expect(ctas({})).toEqual({
      primary: { kind: "oauth", label: "Link Discord & join the server" },
      secondary: { kind: "invite", label: "Use the invite instead" },
    });
  });

  it("never promises the one-click join without a bot", () => {
    expect(ctas({ autoJoins: false })).toEqual({
      primary: { kind: "oauth", label: "Link Discord" },
      secondary: { kind: "invite", label: "Join the server" },
    });
  });

  it("falls back to the invite where linking isn't set up", () => {
    expect(ctas({ linkAvailable: false })).toEqual({
      primary: { kind: "invite", label: "Join the server" },
      secondary: null,
    });
    expect(ctas({ linkAvailable: false, hasInvite: false })).toEqual({
      primary: null,
      secondary: null,
    });
  });

  it("keeps an invite beside the one-click join for a linked non-member", () => {
    expect(ctas({ linked: true, membership: "not-member" })).toEqual({
      primary: { kind: "oauth", label: "Join the server" },
      secondary: { kind: "invite", label: "Use the invite instead" },
    });
    expect(
      ctas({ linked: true, membership: "not-member", autoJoins: false }),
    ).toEqual({
      primary: { kind: "invite", label: "Join the server" },
      secondary: null,
    });
  });

  it("sends a pending member to Discord and asks nothing once they're in", () => {
    expect(ctas({ linked: true, membership: "pending" })).toEqual({
      primary: { kind: "invite", label: "Open Discord" },
      secondary: null,
    });
    expect(ctas({ linked: true, membership: "member" })).toEqual({
      primary: null,
      secondary: null,
    });
  });

  it("never asks someone to join on an unknown membership, unless the callback said so", () => {
    expect(ctas({ linked: true, membership: null })).toEqual({
      primary: null,
      secondary: null,
    });
    expect(
      ctas({ linked: true, membership: null, param: "join_failed" }).primary,
    ).toEqual({ kind: "invite", label: "Join the server" });
    expect(
      ctas({ linked: true, membership: null, param: "joined_pending" })
        .primary,
    ).toEqual({ kind: "invite", label: "Open Discord" });
    // The live answer wins over the one-shot report.
    expect(
      ctas({ linked: true, membership: "member", param: "join_failed" }),
    ).toEqual({ primary: null, secondary: null });
  });

  it("never gives two buttons in one state the same name", () => {
    const states: Partial<DiscordCardInput>[] = [
      {},
      { autoJoins: false },
      { linkAvailable: false },
      { linked: true, membership: "not-member" },
      { linked: true, membership: "not-member", autoJoins: false },
      { linked: true, membership: "pending" },
      { linked: true, membership: null, param: "join_failed" },
    ];
    for (const state of states) {
      const { primary, secondary } = ctas(state);
      expect(primary).not.toBeNull();
      if (secondary) expect(secondary.label).not.toBe(primary?.label);
    }
  });
});

describe("mergeAccountRefresh", () => {
  it("reports what each provider did in one toast", () => {
    expect(
      mergeAccountRefresh(
        { message: "Profile refreshed from Steam" },
        { message: "Medal: Legend 3" },
      ),
    ).toEqual({ message: "Profile refreshed from Steam · Medal: Legend 3" });
  });

  it("keeps the good half when one provider fails", () => {
    expect(
      mergeAccountRefresh(
        { message: "Profile refreshed from Steam" },
        { error: "Couldn't reach OpenDota (rate limited?) — wait a minute and try again" },
      ),
    ).toEqual({
      message:
        "Profile refreshed from Steam · Couldn't reach OpenDota (rate limited?) — wait a minute and try again",
    });
  });

  it("says a double cooldown once, and joins other double failures", () => {
    expect(
      mergeAccountRefresh(
        { error: "Your Steam profile was refreshed recently — wait about a minute before trying again." },
        { error: "Your OpenDota profile was refreshed recently — wait about a minute before trying again." },
      ),
    ).toEqual({
      error:
        "Your Steam and Dota info were refreshed recently — wait about a minute before trying again.",
    });
    expect(
      mergeAccountRefresh({ error: "Steam down" }, { error: "OpenDota down" }),
    ).toEqual({ error: "Steam down · OpenDota down" });
  });
});

describe("fullPlayerChoiceOpen", () => {
  const open = (
    seasonStatus: string,
    existing: { type: string; status: string } | null,
    draftStatus: string | null = null,
  ) => fullPlayerChoiceOpen({ seasonStatus, draftStatus, existing });
  const player = (status: string) => ({ type: "PLAYER", status });
  const standin = (status: string) => ({ type: "STANDIN", status });

  it("is open to everyone during signups", () => {
    expect(open("SIGNUPS", null)).toBe(true);
    expect(open("SIGNUPS", standin("ACTIVE"))).toBe(true);
    expect(open("SIGNUPS", player("WITHDRAWN"))).toBe(true);
  });

  it("stays closed to newcomers and standins once signups close", () => {
    for (const phase of ["DRAFT", "REGULAR_SEASON", "PLAYOFFS"]) {
      expect(open(phase, null)).toBe(false);
      expect(open(phase, standin("ACTIVE"))).toBe(false);
      expect(open(phase, standin("WITHDRAWN"))).toBe(false);
    }
  });

  it("lets a withdrawn full player undo it, except while the auction runs", () => {
    expect(open("DRAFT", player("WITHDRAWN"), null)).toBe(true);
    expect(open("DRAFT", player("WITHDRAWN"), "NOT_STARTED")).toBe(true);
    expect(open("DRAFT", player("WITHDRAWN"), "IN_PROGRESS")).toBe(false);
    expect(open("DRAFT", player("WITHDRAWN"), "PAUSED")).toBe(false);
    expect(open("DRAFT", player("WITHDRAWN"), "COMPLETE")).toBe(true);
    expect(open("REGULAR_SEASON", player("WITHDRAWN"), "COMPLETE")).toBe(true);
  });

  it("keeps an active full player's choice, and never reopens an admin removal", () => {
    expect(open("DRAFT", player("ACTIVE"), "IN_PROGRESS")).toBe(true);
    expect(open("PLAYOFFS", player("ACTIVE"), "COMPLETE")).toBe(true);
    expect(open("DRAFT", player("REMOVED"))).toBe(false);
  });

  it("pauses a withdrawn full player's return only while the auction runs", () => {
    const paused = (existing: { type: string; status: string }, draftStatus: string) =>
      rejoinPausedByDraft({ seasonStatus: "DRAFT", draftStatus, existing });
    expect(paused(player("WITHDRAWN"), "IN_PROGRESS")).toBe(true);
    expect(paused(player("WITHDRAWN"), "PAUSED")).toBe(true);
    expect(paused(player("WITHDRAWN"), "NOT_STARTED")).toBe(false);
    expect(paused(player("ACTIVE"), "IN_PROGRESS")).toBe(false);
    expect(paused(standin("WITHDRAWN"), "IN_PROGRESS")).toBe(false);
  });
});

describe("withdrawConfirmText", () => {
  const text = (type: string, seasonStatus: string, draftStatus: string | null = null) =>
    withdrawConfirmText({ type, seasonStatus, draftStatus });

  it("always starts with the question and names the pool left", () => {
    expect(text("PLAYER", "SIGNUPS")).toMatch(/^Withdraw from this season\? You'll leave the draft pool/);
    expect(text("STANDIN", "REGULAR_SEASON")).toMatch(/standin pool/);
  });

  it("says a player can come back, but not during the draft", () => {
    expect(text("PLAYER", "SIGNUPS")).toMatch(/not while the draft is running/);
    expect(text("PLAYER", "DRAFT", "NOT_STARTED")).toMatch(/not while the draft is running/);
    expect(text("PLAYER", "DRAFT", "IN_PROGRESS")).toMatch(/can't rejoin until the draft finishes/);
    expect(text("PLAYER", "DRAFT", "PAUSED")).toMatch(/can't rejoin until the draft finishes/);
  });

  it("speaks of the free-agent pool once the draft is over", () => {
    expect(text("PLAYER", "DRAFT", "COMPLETE")).toMatch(/free-agent pool/);
    expect(text("PLAYER", "REGULAR_SEASON", "COMPLETE")).toMatch(/free-agent pool/);
    expect(text("PLAYER", "PLAYOFFS", null)).toMatch(/free-agent pool/);
  });

  it("tells a standin they can re-register until the season ends", () => {
    expect(text("STANDIN", "PLAYOFFS")).toMatch(/until the season ends/);
    expect(text("STANDIN", "DRAFT", "IN_PROGRESS")).toMatch(/until the season ends/);
  });
});

describe("MMR field copy", () => {
  // Legend 3 (tier 53): star band 3388–3541, padded to 2965–3964.
  const LEGEND_3 = 53;

  it("leads with the medal and what a blank does", () => {
    expect(mmrLeadLine(LEGEND_3)).toBe(
      "Your Legend 3 medal ≈ 2965–3964 MMR. Leave it blank and we'll list you at 2965, or type your exact MMR.",
    );
    expect(mmrLeadLine(null)).toBe(
      "Type your MMR, or leave it blank if you're not sure.",
    );
    // A window whose floor is 0: a blank stays unknown, so don't promise a number.
    expect(mmrLeadLine(11)).toMatch(/^Your Herald 1 medal ≈ 0–\d+ MMR\. Type your exact MMR/);
    // Divine 1's window (4220–5219) runs past the ceiling: the display
    // stops at it. A window that starts above it has no lead line at all.
    expect(mmrLeadLine(71)).toMatch(/≈ 4220–5000 MMR\./);
    expect(mmrLeadLine(80)).toBeNull();
  });

  it("keeps the ceiling and names the admin review above the soft limit", () => {
    expect(mmrRulesLine(0)).toBe(
      "We don't take anyone over 5000 MMR, or with a Divine 3 or higher medal.",
    );
    expect(mmrRulesLine(4500)).toMatch(
      /Above 4500 you can still sign up, and an admin reviews your signup\.$/,
    );
  });

  // A soft limit at the ceiling flags nobody: "over 5000 … Above 5000 an
  // admin reviews" contradicted itself on the live form.
  it("drops a soft limit at or above the ceiling", () => {
    expect(mmrRulesLine(5000)).toBe(mmrRulesLine(0));
    expect(mmrRulesLine(6000)).toBe(mmrRulesLine(0));
  });

  const preview = (typed: string, extra: Partial<Parameters<typeof mmrPreviewLine>[0]> = {}) =>
    mmrPreviewLine({
      typed,
      rankTier: LEGEND_3,
      storedMmr: null,
      frozen: false,
      ...extra,
    })?.text ?? null;

  it("shows the number a new signup will be listed at, as the server would store it", () => {
    expect(preview("3300")).toBe("You'll be listed at 3300 MMR.");
    expect(preview("")).toBe(
      "Left blank, you'll be listed at 2965 MMR, your medal's low end.",
    );
    expect(preview("4400")).toBe(
      "4400 is outside your medal's range, so you'll be listed at 2965 MMR.",
    );
    expect(preview("3300", { rankTier: null })).toBe("You'll be listed at 3300 MMR.");
    expect(preview("", { rankTier: null })).toBe("You'll be listed at an unknown MMR.");
  });

  it("clears an implausible claim to unknown when the medal's floor is 0", () => {
    expect(preview("4000", { rankTier: 11 })).toMatch(
      /^4000 doesn't fit your medal, so you'll be listed at an unknown MMR/,
    );
  });

  it("warns over the ceiling and stays quiet on input the browser refuses", () => {
    expect(
      mmrPreviewLine({ typed: "5200", rankTier: LEGEND_3, storedMmr: null, frozen: false }),
    ).toEqual({
      tone: "danger",
      text: "Over 5000 MMR: this league can't take the signup.",
    });
    expect(preview("0")).toBeNull();
    expect(preview("3.5")).toBeNull();
    expect(preview("-1")).toBeNull();
  });

  it("never re-clamps an unchanged stored number, and freezes it during the auction", () => {
    // An admin correction outside the window survives an unchanged resubmit.
    expect(preview("4400", { storedMmr: 4400 })).toBe("You're listed at 4400 MMR.");
    expect(preview("", { storedMmr: 0 })).toBe("You're listed at an unknown MMR.");
    // A changed number is judged like a new one.
    expect(preview("4401", { storedMmr: 4400 })).toMatch(/listed at 2965 MMR/);
    expect(preview("1500", { storedMmr: 4400, frozen: true })).toBe(
      "The draft is running, so you stay listed at 4400 MMR until it ends.",
    );
  });
});

describe("favoriteHeroSuggestions", () => {
  const snapshot = (heroIds: number[]) =>
    JSON.stringify({
      recentWins: 5,
      recentLosses: 5,
      totalGames: 900,
      lastPlayedAt: 1_700_000_000,
      topHeroes: heroIds.map((heroId, i) => ({
        heroId,
        games: 100 - i,
        wins: 50,
      })),
    });

  it("offers the top three most-played heroes while no favorite is saved", () => {
    // Axe (2), Pudge (14), Lion (26), Sniper (35)
    expect(favoriteHeroSuggestions("", snapshot([2, 14, 26, 35]))).toEqual([
      2, 14, 26,
    ]);
    expect(favoriteHeroSuggestions(null, snapshot([14]))).toEqual([14]);
  });

  it("offers nothing once favorites are saved, or without a snapshot", () => {
    expect(favoriteHeroSuggestions("Axe", snapshot([2, 14]))).toEqual([]);
    expect(favoriteHeroSuggestions("", null)).toEqual([]);
    expect(favoriteHeroSuggestions("", "not json")).toEqual([]);
    expect(favoriteHeroSuggestions("", snapshot([]))).toEqual([]);
  });

  it("skips a hero id the static table doesn't know", () => {
    expect(favoriteHeroSuggestions("", snapshot([9999, 2]))).toEqual([2]);
  });
});

describe("returningJoinPlan", () => {
  // Legend 3 (tier 53): the medal window is 2965–3964.
  const LEGEND_3 = 53;
  const lastSeason = {
    type: "PLAYER",
    mmr: 3600,
    roles: "1,2",
    favoriteHeroes: "",
    wantsCaptain: true,
  };
  const plan = (
    extra: Partial<Parameters<typeof returningJoinPlan>[0]> = {},
    previous: Partial<typeof lastSeason> = {},
  ) =>
    returningJoinPlan({
      seasonName: "Season 10",
      previous: { ...lastSeason, ...previous },
      rankTier: LEGEND_3,
      playerChoiceOpen: true,
      ...extra,
    });

  it("offers a former full player one Join button with last season's answers", () => {
    expect(plan()).toEqual({
      summary: "Full player · 3600 MMR · Carry, Mid · Captain volunteer",
      mmrLine: "You'll be listed at 3600 MMR.",
      buttons: [{ type: "PLAYER", label: "Join Season 10", primary: true }],
      note: null,
    });
  });

  it("gives a former standin two choices instead of pre-setting Standin", () => {
    const standin = plan({}, { type: "STANDIN" });
    expect(standin?.buttons.map((b) => [b.type, b.label])).toEqual([
      ["PLAYER", "Join as a full player"],
      ["STANDIN", "Join as a standin"],
    ]);
    // Standins never enter the captain pool, whatever last season stored.
    expect(standin?.summary).not.toContain("Captain");
  });

  it("offers only the standin signup once full-player signups are closed", () => {
    const closed = plan({ playerChoiceOpen: false });
    expect(closed?.buttons).toEqual([
      { type: "STANDIN", label: "Join Season 10 as a standin", primary: true },
    ]);
    expect(closed?.note).toMatch(/full-player signups are closed/i);
    expect(plan({ playerChoiceOpen: false }, { type: "STANDIN" })?.note).toBeNull();
  });

  it("shows the MMR that will be saved against today's medal", () => {
    // Last season's number no longer fits the current medal: the clamp
    // saveRegistration applies is said before the tap, not after.
    expect(plan({}, { mmr: 4400 })?.mmrLine).toBe(
      "4400 is outside your medal's range, so you'll be listed at 2965 MMR.",
    );
    expect(plan({}, { mmr: 0 })?.mmrLine).toBe(
      "Left blank, you'll be listed at 2965 MMR, your medal's low end.",
    );
    expect(plan({ rankTier: null }, { mmr: 0 })?.mmrLine).toBe(
      "You'll be listed at an unknown MMR.",
    );
  });

  it("offers no one-tap join the signup checks would refuse", () => {
    // Over the ceiling last season, or a medal that is over it now.
    expect(plan({ rankTier: null }, { mmr: 5400 })).toBeNull();
    expect(plan({ rankTier: 80 })).toBeNull();
  });
});
