import { describe, expect, it } from "vitest";
import {
  accountNextSteps,
  discordCardCtas,
  discordLinkNote,
  fullPlayerChoiceOpen,
  mergeAccountRefresh,
  rejoinPausedByDraft,
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
