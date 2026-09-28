import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  newsMessage,
  rescheduleMessage,
  adminRetimeMessage,
  signupMessage,
  signupsOpenMessage,
  draftStartedAnnouncement,
  draftCompleteAnnouncement,
  regularSeasonStartedMessage,
  freeAgentSignedMessage,
  inhouseLobbyMessage,
  inhouseQueueMessage,
  inhouseResultMessage,
  inhouseResultVoidedMessage,
  matchResultMessage,
  playerReleasedMessage,
  playoffsStartedMessage,
  playoffRoundSetMessage,
  playoffsReturnedToRegularMessage,
  resultNudgeMessage,
  championMessage,
  maskWebhookUrl,
  rolePrefix,
  joinLink,
  webhookIdOf,
  webhookApiUrl,
  draftCancelledMessage,
  draftAbortedMessage,
  draftRescheduledMessage,
  draftScheduledMessage,
  draftReminderAnnouncement,
  captainAssignedMessage,
  playerAwayMessage,
  playerBackInMessage,
  playerOutMessage,
  rescheduleDeclinedMessage,
  rescheduleProposedMessage,
  standinAssignedMessage,
  standinRemovedMessage,
  teamWithdrewMessage,
  teamIdentityChangedMessage,
  weekReminderAnnouncement,
  weekReminderMessage,
  weeklyHonorsMessage,
  materializeAllowedMentions,
  deleteWebhookMessage,
  patchWebhookMessage,
  postWebhookMessage,
} from "./discord";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.VERCEL_ENV;
});

describe("Discord mention materialization", () => {
  it("adds every allowlisted user and role that is absent from the message", () => {
    expect(
      materializeAllowedMentions("Captain, please respond.", {
        users: ["123456789012345678", "223456789012345678"],
        roles: ["323456789012345678"],
      }),
    ).toBe(
      "<@123456789012345678> <@223456789012345678> <@&323456789012345678> Captain, please respond.",
    );
  });

  it("does not duplicate modern, legacy, or role mention tokens", () => {
    const content =
      "<@123456789012345678> <@!223456789012345678> <@&323456789012345678> Match found";
    expect(
      materializeAllowedMentions(content, {
        users: ["123456789012345678", "223456789012345678"],
        roles: ["323456789012345678"],
      }),
    ).toBe(content);
    expect(
      materializeAllowedMentions(
        materializeAllowedMentions("Match found", {
          users: ["123456789012345678"],
          roles: ["323456789012345678"],
        }),
        {
          users: ["123456789012345678"],
          roles: ["323456789012345678"],
        },
      ),
    ).toBe("<@123456789012345678> <@&323456789012345678> Match found");
  });

  it("deduplicates ids and refuses to interpolate malformed values", () => {
    expect(
      materializeAllowedMentions("@everyone stays inert", {
        users: [
          " 123456789012345678 ",
          "123456789012345678",
          "not-an-id",
          "1><@everyone",
        ],
        roles: ["223456789012345678", "223456789012345678"],
      }),
    ).toBe(
      "<@123456789012345678> <@&223456789012345678> @everyone stays inert",
    );
  });
});

describe("discord message formatters", () => {
  it("counts down remaining signups", () => {
    const msg = signupMessage("Zai", 17, 20);
    expect(msg).toContain("**Zai**");
    expect(msg).toContain("17 players");
    expect(msg).toContain("3 more to start");
  });

  it("celebrates when signups hit the threshold", () => {
    expect(signupMessage("Zai", 20, 20)).toContain("enough to start");
    expect(signupMessage("Zai", 25, 20)).toContain("enough to start");
  });

  it("uses singular for the first signup", () => {
    expect(signupMessage("Zai", 1, 20)).toContain("1 player in");
  });

  it("announces a season opening with its match night and the signup link", () => {
    const msg = signupsOpenMessage("Season 9", "Sundays at 6:00 PM PT");
    expect(msg).toContain("**Season 9 signups are open!**");
    expect(msg).toContain("Match night: Sundays at 6:00 PM PT.");
    expect(msg).toMatch(/Sign up: <[^>]+\/me>$/);
  });

  it("leaves the match night out until one is announced", () => {
    const msg = signupsOpenMessage("Season 9", null);
    expect(msg).not.toContain("Match night");
    expect(msg).toContain("signups are open!** Sign up: <");
  });


  it("announces the start of the Regular season with its schedule", () => {
    const msg = regularSeasonStartedMessage("Season *One*");
    expect(msg).toContain("Season \\*One\\*");
    expect(msg).toMatch(/Regular season is live/i);
    expect(msg).toContain("/schedule");
  });

  it("announces a decided series with the winner and links its match page", () => {
    const msg = matchResultMessage({
      matchId: "m42",
      homeName: "A",
      awayName: "B",
      homeScore: 0,
      awayScore: 2,
      label: "Week 3",
      hasGames: true,
    });
    expect(msg).toContain("**Week 3:**");
    expect(msg).toContain("A 0–2 B");
    expect(msg).toContain("**B** take the series!");
    // Ends with the match page, angle-bracketed so Discord doesn't unfurl it.
    expect(msg).toMatch(/Box score: <https?:\/\/[^>]+\/matches\/m42>$/);
    expect(msg).not.toMatch(/eliminated|advance/);
  });

  it("adds at most one broken-record line, with the holder's name escaped", () => {
    const base = {
      matchId: "m9",
      homeName: "A",
      awayName: "B",
      homeScore: 2,
      awayScore: 0,
      label: "Week 4",
      hasGames: true,
    };
    const msg = matchResultMessage({
      ...base,
      record: {
        emoji: "🔪",
        holderName: "[free mmr](https://evil.test)",
        mark: "17 kills",
        heroName: "Razor",
        previousMark: "14 kills",
      },
    });
    const lines = msg.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Box score: <[^>]+\/matches\/m9>$/);
    expect(lines[1]).toMatch(/^🔪 New league record: \*\*.+\*\*, 17 kills on Razor \(old mark 14 kills\)$/);
    expect(lines[1]).not.toContain("](");
    expect(
      matchResultMessage({
        ...base,
        record: { emoji: "💰", holderName: "Carry", mark: "32.1k net worth", heroName: null, previousMark: "30.0k net worth" },
      }),
    ).toContain("**Carry**, 32.1k net worth (old mark 30.0k net worth)");
    // No record, no second line: the post is byte-for-byte what it was.
    expect(matchResultMessage({ ...base, record: null })).toBe(matchResultMessage(base));
    expect(matchResultMessage(base)).not.toContain("\n");
  });

  it("promises a box score only when a game was imported", () => {
    const base = {
      matchId: "m8",
      homeName: "A",
      awayName: "B",
      homeScore: 2,
      awayScore: 0,
      label: "Week 2",
    };
    // An admin's manual score for a played series (private match data, or a
    // ticketless lobby) has no games: its page reads "no games recorded".
    const manual = matchResultMessage({ ...base, hasGames: false });
    expect(manual).toContain("**A** take the series!");
    expect(manual).toMatch(/Match page: <[^>]+\/matches\/m8>$/);
    expect(manual).not.toContain("Box score");
    // A forfeit ruling on a series that already had an imported game does.
    expect(
      matchResultMessage({ ...base, forfeit: true, hasGames: true }),
    ).toMatch(/Box score: <[^>]+\/matches\/m8>$/);
  });

  it("handles draws", () => {
    const msg = matchResultMessage({
      matchId: "m1",
      homeName: "A",
      awayName: "B",
      homeScore: 1,
      awayScore: 1,
      label: "Week 4",
    });
    expect(msg).toContain("a draw");
    expect(msg).toMatch(/\/matches\/m1>$/);
  });

  it("names the playoff round and says who advances and who is out", () => {
    const semi = matchResultMessage({
      matchId: "m9",
      homeName: "A",
      awayName: "B",
      homeScore: 2,
      awayScore: 1,
      label: "Semifinal",
      knockout: { nextRound: "Grand final" },
    });
    expect(semi).toContain("**Semifinal:** A 2–1 B");
    expect(semi).toContain(
      "**A** advance to the grand final; B are eliminated.",
    );
    expect(semi).not.toContain("Playoffs");

    const quarter = matchResultMessage({
      matchId: "m5",
      homeName: "A",
      awayName: "B",
      homeScore: 0,
      awayScore: 2,
      label: "Quarterfinal",
      forfeit: true,
      knockout: { nextRound: "Semifinals" },
    });
    expect(quarter).toContain(
      "**B** advance to the semifinals by forfeit; A are eliminated.",
    );
    // A ruled result may have no box score to show.
    expect(quarter).toMatch(/Match page: <[^>]+\/matches\/m5>$/);

    const unnamed = matchResultMessage({
      matchId: "m6",
      homeName: "A",
      awayName: "B",
      homeScore: 2,
      awayScore: 0,
      label: "Round 1",
      knockout: { nextRound: null },
    });
    expect(unnamed).toContain("**A** advance; B are eliminated.");
    expect(
      matchResultMessage({
        matchId: "m7",
        homeName: "A",
        awayName: "B",
        homeScore: 2,
        awayScore: 0,
        label: "Round 1",
        knockout: { nextRound: "Round 2" },
      }),
    ).toContain("**A** advance to Round 2;");
  });

  it("leaves the grand final's crowning to the champion post", () => {
    const msg = matchResultMessage({
      matchId: "m10",
      homeName: "A",
      awayName: "B",
      homeScore: 3,
      awayScore: 1,
      label: "Grand final",
    });
    expect(msg).toContain("**Grand final:** A 3–1 B — **A** take the series!");
    expect(msg).not.toMatch(/champion|eliminated|advance/i);
  });

  it("labels tiebreaker results, reminders, and logistics as tiebreakers", () => {
    const fixture = {
      homeName: "A",
      awayName: "B",
      week: 6,
      isPlayoff: false,
      isTiebreaker: true,
      whenMs: Date.parse("2026-09-12T20:00:00Z"),
    };
    expect(matchResultMessage({ ...fixture, matchId: "m1", label: "Tiebreaker", homeScore: 2, awayScore: 1 }))
      .toContain("**Tiebreaker:** A 2–1 B");
    expect(weekReminderMessage({ ...fixture, fixtures: [] }))
      .toContain("Tiebreaker week 6 matches");
    expect(rescheduleMessage(fixture)).toContain("Tiebreaker week 6:");
    expect(rescheduleProposedMessage({ ...fixture, proposerName: "Captain" }))
      .toContain("tiebreaker match");
    expect(rescheduleDeclinedMessage({ ...fixture, declinerName: "Captain" }))
      .toContain("tiebreaker match");
    expect(playerOutMessage({ ...fixture, playerName: "Player" }))
      .toContain("tiebreaker match");
    expect(standinAssignedMessage({ ...fixture, standinName: "Cover", replacedName: "Player", teamName: "A" }))
      .toContain("tiebreaker match");
    expect(standinRemovedMessage({ ...fixture, standinName: "Cover", teamName: "A" }))
      .toContain("tiebreaker match");
  });

  it("lists every playoff pairing", () => {
    const msg = playoffsStartedMessage("Season 1", [
      { home: "A", away: "D" },
      { home: "B", away: "C" },
    ]);
    expect(msg).toContain("A vs D");
    expect(msg).toContain("B vs C");
    expect(msg).toContain("/schedule");
  });

  it("gives each playoff pairing its seeds and a reader-local kickoff", () => {
    const whenMs = Date.parse("2026-10-03T01:00:00Z");
    const msg = playoffsStartedMessage("Season 1", [
      { home: "A", away: "D", homeSeed: 1, awaySeed: 4, whenMs },
      { home: "B", away: "C", homeSeed: 2, awaySeed: 3, whenMs: null },
    ]);
    expect(msg).toContain(`• (1) A vs (4) D — <t:${whenMs / 1000}:f>`);
    // No kickoff yet: no dangling separator.
    expect(msg).toContain("• (2) B vs (3) C\n");
  });

  it("announces when a bracket is withdrawn for a standings correction", () => {
    const msg = playoffsReturnedToRegularMessage("Season 1");
    expect(msg).toContain("Season 1");
    expect(msg).toMatch(/bracket is void/i);
    expect(msg).toMatch(/Regular season/i);
    expect(msg).toContain("/schedule");
  });

  it("announces the next playoff round with reader-local kickoffs", () => {
    const msg = playoffRoundSetMessage({
      seasonName: "Season 7",
      roundName: "Grand final",
      fixtures: [{ home: "Alpha", away: "Delta", whenMs: 1_800_000_000_000 }],
    });
    expect(msg).toContain("**Season 7 grand final is set!**");
    expect(msg).toContain(
      "• **Alpha** vs **Delta** — <t:1800000000:F> (<t:1800000000:R>)",
    );
    expect(msg).toMatch(/\nBracket: <[^>]+\/schedule>$/);
  });

  it("agrees the verb with a plural round and says when a kickoff is unset", () => {
    const msg = playoffRoundSetMessage({
      seasonName: "Season 7",
      roundName: "Semifinals",
      fixtures: [
        { home: "A", away: "D", whenMs: null },
        { home: "B", away: "C", whenMs: 1_800_000_000_000 },
      ],
    });
    expect(msg).toContain("**Season 7 semifinals are set!**");
    expect(msg).toContain("• **A** vs **D** — kickoff time still to be set");
    expect(msg.split("\n")).toHaveLength(4);
  });

  it("asks the captains to report a fixture whose games were never found", () => {
    const msg = resultNudgeMessage({
      matchId: "m1",
      homeName: "Alpha",
      awayName: "Delta",
      label: "Week 3",
      homeScore: 0,
      awayScore: 0,
      gamesFound: 0,
    });
    expect(msg).toContain(
      "We couldn't find the games for **Alpha** vs **Delta** (Week 3).",
    );
    expect(msg).toMatch(/Captains: report them on the match page: <[^>]+\/matches\/m1>$/);
  });

  it("names the score a part-played series is stuck at", () => {
    const msg = resultNudgeMessage({
      matchId: "m2",
      homeName: "Alpha",
      awayName: "Delta",
      label: "Semifinal",
      homeScore: 1,
      awayScore: 0,
      gamesFound: 1,
    });
    expect(msg).toContain("**Alpha** vs **Delta** (Semifinal) is stuck at 1–0");
    expect(msg).toContain("report the missing games");
    expect(msg).toMatch(/<[^>]+\/matches\/m2>$/);
  });

  it("crowns the champion", () => {
    const msg = championMessage("Season 1", "Zai's Team", "season/one");
    expect(msg).toContain("**Zai's Team**");
    expect(msg).toContain("champions");
    // Straight to the season page (old /recap?season= posts redirect there).
    expect(msg).toContain("/seasons/season%2Fone>");
    expect(msg).not.toContain("/recap");
  });

  it("escapes a season name in the champion announcement", () => {
    const msg = championMessage(
      "[Season](https://evil.test)",
      "Team",
      "season-1",
    );
    expect(msg).not.toContain("[Season](https://evil.test)");
    expect(msg).toContain("\\[Season\\]\\(");
    expect(msg).not.toContain("(https://evil.test)");
  });

  it("announces a free-agent signing", () => {
    const msg = freeAgentSignedMessage("Late Joiner", "Short Squad");
    expect(msg).toContain("**Late Joiner**");
    expect(msg).toContain("**Short Squad**");
    expect(msg).toContain("/teams");
  });

  it("announces a release", () => {
    const msg = playerReleasedMessage("Ghoster", "Short Squad");
    expect(msg).toContain("**Ghoster**");
    expect(msg).toContain("released from **Short Squad**");
  });
});

describe("draft scheduling", () => {
  it("describes every non-captain roster return after an aborted draft", () => {
    const msg = draftAbortedMessage("Season 2", 3, 2);
    expect(msg).toContain("3 non-captain roster member(s) returned");
    expect(msg).toContain("2 unplayed fixture(s) were cleared");
    expect(msg).toContain("back in Signups");
  });

  it("announces the scheduled draft night reader-local", () => {
    const msg = draftScheduledMessage("Season 2", 1_800_000_000_000);
    expect(msg).toContain("Season 2");
    expect(msg).toContain("<t:1800000000:F>");
    expect(msg).toContain("/me");
  });

  it("expires confirmations and links reconfirmation after a reschedule", () => {
    const msg = draftRescheduledMessage("Season 2", 1_800_000_000_000);
    expect(msg).toContain("moved");
    expect(msg).toContain("Previous confirmations expired");
    expect(msg).toContain("<t:1800000000:F>");
    expect(msg).toContain("/me");
  });

  it("announces when the scheduled night is cleared", () => {
    const msg = draftCancelledMessage("Season 2");
    expect(msg).toContain("was cleared");
    expect(msg).toContain("post a new time");
  });

  it("tells a newly assigned captain where to review responsibilities", () => {
    expect(captainAssignedMessage("Dendi", "Dendi's Team", "123")).toContain(
      "<@123>",
    );
    const fallback = captainAssignedMessage("Den*di", "Team [A]");
    expect(fallback).toContain("**Den\\*di**");
    expect(fallback).toContain("Team \\[A\\]");
    expect(fallback).toContain("/me");
  });

  it("signupMessage appends draft night only when one is set", () => {
    expect(signupMessage("Dendi", 3, 20, 1_800_000_000_000)).toContain(
      "Draft night: <t:1800000000:F>",
    );
    expect(signupMessage("Dendi", 3, 20)).not.toContain("Draft night");
    expect(signupMessage("Dendi", 3, 20, null)).not.toContain("Draft night");
  });
});

describe("draftReminderAnnouncement", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const base = {
    seasonName: "Season 3",
    draftAtMs: 1_800_000_000_000,
    playerSignupsOpen: true,
    playerCount: 14,
    captains: [
      { name: "Dendi", discordId: "111111111111111111" },
      { name: "Puppey", discordId: null },
    ],
    unconfirmed: [
      { name: "Miracle-", discordId: "222222222222222222" },
      { name: "N0tail", discordId: null },
    ],
  };
  const visibleMentions = (content: string) =>
    [...content.matchAll(/<@(\d{17,20})>/g)].map((m) => m[1]);

  it("renders the whole reminder reader-local, with counts and both links", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example");
    const announcement = draftReminderAnnouncement(base);
    expect(announcement.content).toBe(
      [
        "⏰ **Draft night reminder: the Season 3 draft is scheduled for <t:1800000000:F> (<t:1800000000:R>).**",
        "**14** players signed up, **2** captains designated. Player signups stay open until the auction starts.",
        "Captains, be in the draft room before the auction starts: <@111111111111111111>, Puppey",
        "Still to confirm this draft time (2): <@222222222222222222>, N0tail. Confirm on the signup page.",
        "Draft room: <https://league.example/draft> · Signup page: <https://league.example/me>",
      ].join("\n"),
    );
    // Only the linked captain and the linked straggler; exactly the visible tokens.
    expect(announcement.mentionUserIds).toEqual([
      "111111111111111111",
      "222222222222222222",
    ]);
    expect(announcement.content).not.toContain("1800000000000");
  });

  it("says truthfully whether player signups are still open", () => {
    const open = draftReminderAnnouncement(base).content;
    expect(open).toContain("Player signups stay open until the auction starts.");
    const closed = draftReminderAnnouncement({
      ...base,
      playerSignupsOpen: false,
    }).content;
    expect(closed).toContain(
      "Player signups are closed; standins can still sign up.",
    );
    expect(closed).not.toContain("stay open");
  });

  it("uses singular counts and drops lines that have nobody in them", () => {
    const msg = draftReminderAnnouncement({
      ...base,
      playerCount: 1,
      captains: [{ name: "Solo", discordId: null }],
      unconfirmed: [],
    }).content;
    expect(msg).toContain("**1** player signed up, **1** captain designated.");
    expect(msg).not.toContain("Still to confirm");

    const bare = draftReminderAnnouncement({
      ...base,
      playerCount: 0,
      captains: [],
      unconfirmed: [],
    });
    expect(bare.content).toContain("**0** players signed up, **0** captains designated.");
    expect(bare.content).not.toContain("Captains, be in");
    expect(bare.content.split("\n")).toHaveLength(3); // header, counts, links
    expect(bare.mentionUserIds).toEqual([]);
  });

  it("never mentions an id that isn't a real snowflake", () => {
    const announcement = draftReminderAnnouncement({
      ...base,
      captains: [{ name: "Typo", discordId: "123" }],
      unconfirmed: [{ name: "Blank", discordId: "   " }],
    });
    expect(announcement.content).not.toContain("<@123>");
    expect(announcement.content).toContain("Typo");
    expect(announcement.content).toContain("Blank");
    expect(announcement.mentionUserIds).toEqual([]);
  });

  it("caps the unconfirmed list and pings only the names it shows", () => {
    const unconfirmed = Array.from({ length: 25 }, (_, i) => ({
      name: `Player ${i + 1}`,
      discordId: (BigInt("700000000000000000") + BigInt(i)).toString(),
    }));
    const announcement = draftReminderAnnouncement({ ...base, unconfirmed });
    expect(announcement.content).toContain("Still to confirm this draft time (25):");
    expect(announcement.content).toContain("+5 more. Confirm on the signup page.");
    expect(announcement.content).toContain(`<@${unconfirmed[19].discordId}>`);
    expect(announcement.content).not.toContain(`<@${unconfirmed[20].discordId}>`);
    expect(announcement.mentionUserIds).not.toContain(unconfirmed[20].discordId);
    expect(new Set(announcement.mentionUserIds)).toEqual(
      new Set(visibleMentions(announcement.content)),
    );
  });

  it("packs captains first under Discord's 2,000-character limit", () => {
    const captains = Array.from({ length: 60 }, (_, i) => ({
      name: `A Very Long Captain Persona Number ${i + 1}`,
      discordId: i % 2 ? null : (BigInt("600000000000000000") + BigInt(i)).toString(),
    }));
    const unconfirmed = Array.from({ length: 10 }, (_, i) => ({
      name: `Straggler ${i + 1}`,
      discordId: (BigInt("500000000000000000") + BigInt(i)).toString(),
    }));
    const announcement = draftReminderAnnouncement({
      ...base,
      playerCount: 200,
      captains,
      unconfirmed,
    });
    const delivered = materializeAllowedMentions(announcement.content, {
      users: announcement.mentionUserIds,
    });
    // Every allowlisted id is already visible, so transport materialization
    // can't prepend anyone who was packed out of the body.
    expect(delivered).toBe(announcement.content);
    expect(delivered.length).toBeLessThanOrEqual(2_000);
    expect(delivered).toMatch(/Captains, be in the draft room before the auction starts: .* \+\d+ more/);
    expect(new Set(announcement.mentionUserIds)).toEqual(
      new Set(visibleMentions(delivered)),
    );
    // Captains ate most of the budget; the stragglers get what is left.
    expect(delivered).toMatch(
      /Still to confirm this draft time \(10\): .* \+\d+ more\. Confirm on the signup page\./,
    );
    expect(announcement.mentionUserIds).not.toContain(unconfirmed[9].discordId);
    expect(delivered).toContain("/draft>");
  });

  it("collapses stragglers to a count when no name fits", () => {
    const straggler = { name: "Late", discordId: "500000000000000001" };
    // The longest captain persona that still leaves the post deliverable
    // leaves no room for even one straggler's mention.
    let announcement = draftReminderAnnouncement(base);
    for (let len = 1_900; len > 0; len -= 1) {
      announcement = draftReminderAnnouncement({
        ...base,
        captains: [{ name: "C".repeat(len), discordId: null }],
        unconfirmed: [straggler],
      });
      if (announcement.content.includes("C".repeat(len))) break;
    }
    expect(announcement.content.length).toBeLessThanOrEqual(2_000);
    expect(announcement.content).toContain(
      "1 player is still to confirm this draft time. Confirm on the signup page.",
    );
    expect(announcement.mentionUserIds).toEqual([]);
  });

  it("falls back to a deliverable post that names nobody", () => {
    const announcement = draftReminderAnnouncement({
      ...base,
      seasonName: "S".repeat(2_100),
    });
    expect(announcement.content.length).toBeLessThanOrEqual(2_000);
    expect(announcement.content).toContain("<t:1800000000:F>");
    expect(announcement.mentionUserIds).toEqual([]);
  });

  it("uses no em-dashes in any variant", () => {
    const variants = [
      draftReminderAnnouncement(base),
      draftReminderAnnouncement({ ...base, playerSignupsOpen: false }),
      draftReminderAnnouncement({ ...base, captains: [], unconfirmed: [] }),
      draftReminderAnnouncement({ ...base, seasonName: "S".repeat(2_100) }),
      draftReminderAnnouncement({
        ...base,
        unconfirmed: Array.from({ length: 30 }, (_, i) => ({
          name: `P${i}`,
          discordId: null,
        })),
      }),
    ];
    for (const { content } of variants) {
      expect(content).not.toContain("—");
    }
  });
});

describe("draftStartedAnnouncement", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const captains = [
    { name: "Dendi", discordId: "111111111111111111" },
    { name: "Puppey", discordId: null },
    { name: "Typo", discordId: "123" },
  ];
  const visibleMentions = (content: string) =>
    [...content.matchAll(/<@(\d{17,20})>/g)].map((m) => m[1]);

  it("links the room and mentions only the linked captains", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example");
    const announcement = draftStartedAnnouncement({
      seasonName: "Season 1",
      captains,
    });
    expect(announcement.content).toBe(
      [
        "🔨 **The Season 1 draft is LIVE!** Watch the auction: <https://league.example/draft>",
        "Captains <@111111111111111111>, Puppey, Typo: you're on the clock. If your nomination timer runs out, the site nominates for you.",
      ].join("\n"),
    );
    // A captain without a real snowflake is named, never pinged.
    expect(announcement.mentionUserIds).toEqual(["111111111111111111"]);
    expect(announcement.content).not.toContain("—");
  });

  it("still says what to do when no captain is known", () => {
    const announcement = draftStartedAnnouncement({
      seasonName: "Season 1",
      captains: [],
    });
    expect(announcement.content).toContain("/draft>");
    expect(announcement.content).toMatch(
      /\nCaptains, you're on the clock\. .* the site nominates for you\.$/,
    );
    expect(announcement.mentionUserIds).toEqual([]);
  });

  it("packs captains under Discord's limit and pings only the ones shown", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      name: `A Very Long Captain Persona Number ${i + 1}`,
      discordId: i % 3 ? null : (BigInt("600000000000000000") + BigInt(i)).toString(),
    }));
    const announcement = draftStartedAnnouncement({
      seasonName: "Season 1",
      captains: many,
    });
    const delivered = materializeAllowedMentions(announcement.content, {
      users: announcement.mentionUserIds,
    });
    expect(delivered).toBe(announcement.content);
    expect(delivered.length).toBeLessThanOrEqual(2_000);
    expect(delivered).toMatch(
      / \+\d+ more: you're on the clock\. If your nomination timer runs out, the site nominates for you\.$/,
    );
    expect(new Set(announcement.mentionUserIds)).toEqual(
      new Set(visibleMentions(delivered)),
    );
    expect(announcement.mentionUserIds).not.toContain(many[117].discordId);
  });

  it("falls back to a deliverable post that names nobody", () => {
    const announcement = draftStartedAnnouncement({
      seasonName: "S".repeat(2_100),
      captains,
    });
    expect(announcement.content.length).toBeLessThanOrEqual(2_000);
    expect(announcement.mentionUserIds).toEqual([]);
  });

  it("escapes a captain name", () => {
    const content = draftStartedAnnouncement({
      seasonName: "Season 1",
      captains: [{ name: "[free mmr](https://evil.test)\nfake line", discordId: null }],
    }).content;
    expect(content).not.toContain("](");
    expect(content.split("\n")).toHaveLength(2);
  });
});

describe("draftCompleteAnnouncement", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const teams = [
    {
      name: "Radiant Rejects",
      captainName: "Dendi",
      players: [
        { name: "Miracle", discordId: "222222222222222222", price: 9 },
        { name: "N0tail", discordId: null, price: 1 },
      ],
      openSeats: 0,
    },
    {
      name: "Dire Straits",
      captainName: "Puppey",
      players: [{ name: "Typo", discordId: "123", price: 3 }],
      openSeats: 1,
    },
  ];
  const visibleMentions = (content: string) =>
    [...content.matchAll(/<@(\d{17,20})>/g)].map((m) => m[1]);

  it("lists every team and mentions each linked drafted player once", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example");
    const announcement = draftCompleteAnnouncement({
      seasonName: "Season 3",
      teams,
    });
    expect(announcement.content).toBe(
      [
        "✅ **The Season 3 draft is complete! Here are the teams:**",
        "**Radiant Rejects** (captain Dendi): <@222222222222222222> $9, N0tail $1",
        "**Dire Straits** (captain Puppey, 1 open seat): Typo $3",
        "Open seats get filled with free agents, and standins cover until then. Every roster: <https://league.example/teams>",
      ].join("\n"),
    );
    // Captains are named, never pinged; a fake snowflake is named, never pinged.
    expect(announcement.mentionUserIds).toEqual(["222222222222222222"]);
    // No automatic "a steal!" tag on $1 lots, and no em dashes.
    expect(announcement.content).not.toMatch(/steal/i);
    expect(announcement.content).not.toContain("—");
  });

  it("drops the open-seats note when every roster is full, and says so for an empty team", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example");
    const content = draftCompleteAnnouncement({
      seasonName: "Season 3",
      teams: [
        { name: "Solo", captainName: "Lone", players: [], openSeats: 0 },
      ],
    }).content;
    expect(content).toContain("**Solo** (captain Lone): no players bought");
    expect(content.split("\n").at(-1)).toBe(
      "Every roster: <https://league.example/teams>",
    );
  });

  it("packs whole teams under Discord's limit and pings only the players shown", () => {
    let id = BigInt("700000000000000000");
    const many = Array.from({ length: 16 }, (_, t) => ({
      name: `A Rather Long Team Name Number ${t + 1}`,
      captainName: `Captain Persona ${t + 1}`,
      players: Array.from({ length: 6 }, (_, p) => {
        id += BigInt(1);
        return {
          name: `Player ${t + 1}-${p + 1} with a long persona`,
          discordId: p % 2 ? null : id.toString(),
          price: p + 1,
        };
      }),
      openSeats: 0,
    }));
    const announcement = draftCompleteAnnouncement({
      seasonName: "Season 3",
      teams: many,
    });
    const delivered = materializeAllowedMentions(announcement.content, {
      users: announcement.mentionUserIds,
    });
    // Every allowlisted id is already in the text, so nothing is prepended.
    expect(delivered).toBe(announcement.content);
    expect(delivered.length).toBeLessThanOrEqual(2_000);
    expect(delivered).toMatch(/…and \d+ more teams on the teams page\./);
    expect(delivered).toContain("/teams>");
    expect(new Set(announcement.mentionUserIds)).toEqual(
      new Set(visibleMentions(delivered)),
    );
    const lastPlayer = many.at(-1)!.players[0].discordId!;
    expect(announcement.mentionUserIds).not.toContain(lastPlayer);
  });

  it("falls back to a deliverable post that names nobody", () => {
    const announcement = draftCompleteAnnouncement({
      seasonName: "S".repeat(2_100),
      teams,
    });
    expect(announcement.content.length).toBeLessThanOrEqual(2_000);
    expect(announcement.mentionUserIds).toEqual([]);
  });

  it("completing again after an undo names everyone and pings nobody", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://league.example");
    const announcement = draftCompleteAnnouncement({
      seasonName: "Season 3",
      teams,
      again: true,
    });
    expect(announcement.content).toBe(
      [
        "✅ **The Season 3 draft is complete again. Here are the updated teams:**",
        "**Radiant Rejects** (captain Dendi): Miracle $9, N0tail $1",
        "**Dire Straits** (captain Puppey, 1 open seat): Typo $3",
        "Open seats get filled with free agents, and standins cover until then. Every roster: <https://league.example/teams>",
      ].join("\n"),
    );
    expect(announcement.mentionUserIds).toEqual([]);
  });
});

describe("inhouse messages", () => {
  it("pings the queue milestone with the live count and link", () => {
    const msg = inhouseQueueMessage(8, 10);
    expect(msg).toContain("8/10");
    expect(msg).toContain("2 more players");
    expect(msg).toContain("/inhouse");
  });

  it("uses singular when one player is missing", () => {
    expect(inhouseQueueMessage(9, 10)).toContain("1 more player and");
  });

  it("announces a formed lobby with every name and the link", () => {
    const players = Array.from({ length: 10 }, (_, i) => ({
      name: `P${i}`,
      discordId: null,
    }));
    const msg = inhouseLobbyMessage(players);
    expect(msg).toContain("Inhouse match found");
    expect(msg).toContain("Accept your game");
    expect(msg).toContain("P0, P1");
    expect(msg).toContain("P9");
    expect(msg).toContain("/inhouse");
  });

  it("mentions linked players by id so the ping reaches a phone", () => {
    // A formed lobby is on a 45-second clock and the site's chime can't reach
    // a backgrounded phone. Linked players get a real mention; the rest are
    // named as plain text rather than being left out.
    const msg = inhouseLobbyMessage([
      { name: "Dendi", discordId: "111222333444555666" },
      { name: "Unlinked Guy", discordId: null },
    ]);
    expect(msg).toContain("<@111222333444555666>");
    expect(msg).toContain("Unlinked Guy");
    expect(msg).not.toContain("<@null>");
  });

  it("prefixes the role only when the league configured one", () => {
    expect(rolePrefix("999")).toBe("<@&999> ");
    expect(rolePrefix(null)).toBe("");
    expect(rolePrefix(undefined)).toBe("");
    expect(inhouseQueueMessage(4, 10, "999")).toContain("<@&999>");
    expect(inhouseQueueMessage(4, 10)).not.toContain("<@&");
    expect(
      inhouseLobbyMessage([{ name: "A", discordId: null }], "999"),
    ).toContain("<@&999>");
  });

  it("links straight into the queue, not just to the page", () => {
    // One tap from a phone notification to actually being queued.
    expect(joinLink()).toMatch(/\/inhouse\?join=1$/);
    expect(inhouseQueueMessage(4, 10)).toContain("/inhouse?join=1");
  });

  it("announces a result with score, duration, MVP, and both links", () => {
    const msg = inhouseResultMessage({
      winnerSide: "Dire",
      radiantScore: 18,
      direScore: 41,
      durationSecs: 41 * 60 + 7,
      mvpName: "Timo",
      mvpHero: "Jakiro",
      dotaMatchId: "8412345678",
    });
    expect(msg).toContain("Dire win 18–41");
    expect(msg).toContain("41:07");
    expect(msg).toContain("MVP: **Timo** (Jakiro)");
    expect(msg).toContain("/inhouse");
    expect(msg).toContain("opendota.com/matches/8412345678");
  });

  it("omits the MVP clause when nobody in the box score is a member", () => {
    const msg = inhouseResultMessage({
      winnerSide: "Radiant",
      radiantScore: 30,
      direScore: 5,
      durationSecs: 600,
      mvpName: null,
      mvpHero: null,
      dotaMatchId: "1",
    });
    expect(msg).not.toContain("MVP");
    expect(msg).toContain("Radiant win 30–5");
    expect(msg).toContain("10:00");
  });
});

describe("inhouseResultVoidedMessage", () => {
  it("says the result no longer stands and links the match the void erases", () => {
    const msg = inhouseResultVoidedMessage({ dotaMatchId: "8412345678" });
    expect(msg).toContain("result has been voided");
    expect(msg).toContain("off the ladder");
    expect(msg).not.toMatch(/cred|slip|stake|wager/i);
    // The correction has to be tie-able to the post it corrects, and the void
    // NULLS dotaMatchId — after this message nothing in the database can say
    // which game it was.
    expect(msg).toContain("<https://www.opendota.com/matches/8412345678>");
    // …and the link is bracketed, so the correction can't unfurl a preview
    // card on top of the result post it is amending.
    expect(msg).not.toMatch(/[^<]https:\/\//);
  });

  it("drops the link when there is no match id", () => {
    const msg = inhouseResultVoidedMessage({ dotaMatchId: null });
    expect(msg).not.toContain("opendota");
    // No dangling " " where the link would have been.
    expect(msg).toBe(msg.trim());
  });
});

describe("playerOutMessage / rescheduleProposedMessage", () => {
  it("announces a fresh OUT with the fixture and reader-local kickoff", () => {
    const msg = playerOutMessage({
      playerName: "Dendi",
      homeName: "Radiant Raccoons",
      awayName: "Dire Wolves",
      week: 4,
      isPlayoff: false,
      whenMs: 1_800_000_000_000,
    });
    expect(msg).toContain("Dendi");
    expect(msg).toContain("week 4");
    expect(msg).toContain("<t:1800000000:F>");
    expect(msg).toContain("standin");
  });

  it("omits the kickoff line when the match is unscheduled, labels playoffs", () => {
    const msg = playerOutMessage({
      playerName: "Puppey",
      homeName: "A",
      awayName: "B",
      week: 9,
      isPlayoff: true,
      whenMs: null,
    });
    expect(msg).toContain("playoff match");
    expect(msg).not.toContain("<t:");
    expect(msg).not.toContain("week 9");
  });

  it("tells the captain a player who said OUT can make it after all", () => {
    const msg = playerBackInMessage({
      playerName: "Dendi",
      homeName: "Radiant Raccoons",
      awayName: "Dire Wolves",
      week: 4,
      isPlayoff: false,
      whenMs: 1_800_000_000_000,
      matchId: "m1",
    });
    expect(msg).toContain(
      "**Dendi** can make the week 4 match after all — **Radiant Raccoons** vs **Dire Wolves** (<t:1800000000:F>).",
    );
    expect(msg).toContain("No need to find cover for them");
    expect(msg).toMatch(/<[^<>\s]*\/matches\/m1>$/);
    // Unscheduled and hand-built: no kickoff, no link.
    const bare = playerBackInMessage({
      playerName: "Puppey",
      homeName: "A",
      awayName: "B",
      week: 9,
      isPlayoff: true,
      whenMs: null,
    });
    expect(bare).toContain("can make the playoff match after all");
    expect(bare).not.toContain("<t:");
    expect(bare).not.toContain("/matches/");
  });

  it("pings a fresh reschedule proposal at the proposed reader-local time", () => {
    const msg = rescheduleProposedMessage({
      homeName: "A",
      awayName: "B",
      week: 2,
      isPlayoff: false,
      proposerName: "Kuroky",
      whenMs: 1_800_000_000_000,
    });
    expect(msg).toContain("Kuroky");
    expect(msg).toContain("week 2");
    expect(msg).toContain("<t:1800000000:F>");
  });
});

describe("playerAwayMessage", () => {
  const fixture = (week: number, whenMs: number | null, matchId?: string) => ({
    homeName: "Radiant Raccoons",
    awayName: "Dire Wolves",
    week,
    isPlayoff: false,
    whenMs,
    matchId,
  });

  it("sends nothing for an empty range", () => {
    expect(playerAwayMessage("Dendi", [])).toBe("");
  });

  it("is exactly the one-match OUT message for a single fixture", () => {
    // The captain reads the same words whichever way the player said it.
    const one = fixture(4, 1_800_000_000_000, "m4");
    expect(playerAwayMessage("Dendi", [one])).toBe(
      playerOutMessage({ playerName: "Dendi", ...one }),
    );
  });

  it("lists every fixture once, each with its reader-local kickoff and page", () => {
    const msg = playerAwayMessage("Dendi", [
      fixture(3, 1_800_000_000_000, "m3"),
      fixture(4, 1_800_604_800_000, "m4"),
      { ...fixture(5, null, "m5"), isPlayoff: true },
    ]);
    const lines = msg.split("\n");
    expect(lines).toHaveLength(5); // header, three fixtures, footer
    expect(lines[0]).toContain("**Dendi**");
    expect(lines[0]).toContain("3 matches");
    expect(lines[1]).toContain("Week 3 match");
    expect(lines[1]).toContain("<t:1800000000:F>");
    expect(lines[1]).toMatch(/<[^<>\s]*\/matches\/m3>/);
    expect(lines[2]).toContain("<t:1800604800:F>");
    expect(lines[3]).toContain("Playoff match");
    expect(lines[3]).not.toContain("<t:");
    expect(lines[4]).toContain("line up standins");
  });

  it("labels a tiebreaker like the one-match message does", () => {
    const msg = playerAwayMessage("Dendi", [
      { ...fixture(6, null), isTiebreaker: true },
      fixture(7, null),
    ]);
    expect(msg).toContain("Tiebreaker match");
  });

  it("stays under Discord's limit however long the range, and says what it cut", () => {
    const long = "x".repeat(32);
    const many = Array.from({ length: 40 }, (_, i) => ({
      homeName: long,
      awayName: long,
      week: i + 1,
      isPlayoff: false,
      whenMs: 1_800_000_000_000 + i * 604_800_000,
      matchId: `match-${i}`,
    }));
    const msg = playerAwayMessage(long, many);
    // Room is left for the captain mentions sendDiscordMessage prepends.
    expect(msg.length).toBeLessThanOrEqual(1_800);
    expect(msg).toMatch(/…and \d+ more/);
    const lines = msg.split("\n");
    const shown = lines.filter((l) => l.includes("/matches/")).length;
    const more = Number(/…and (\d+) more/.exec(msg)![1]);
    expect(shown + more).toBe(40);
    expect(lines[lines.length - 1]).toContain("line up standins");
  });
});

describe("weekReminderMessage", () => {
  it("lists fixtures with reader-local timestamps, check-ins, and links", () => {
    const msg = weekReminderMessage({
      week: 3,
      isPlayoff: false,
      fixtures: [
        {
          matchId: "m1",
          homeName: "Radiant Raccoons",
          awayName: "Dire Wolves",
          scheduledAt: 1_800_000_000_000,
          homeIn: 3,
          homeSize: 5,
          awayIn: 2,
          awaySize: 5,
          waitingOn: [],
        },
      ],
    });
    expect(msg).toContain("Week 3");
    // Discord timestamps carry SECONDS so every reader sees their own zone.
    expect(msg).toContain("<t:1800000000:R>");
    expect(msg).not.toContain("1800000000000");
    expect(msg).toContain("3/5 vs 2/5");
    expect(msg).toContain("/matches/m1");
  });

  it("points at pick'em only while it is open", () => {
    const open = weekReminderMessage({ week: 3, isPlayoff: false, fixtures: [], pickemOpen: true });
    expect(open).toMatch(/Pick'em closes at kickoff: <.*\/pickem>$/);
    const closed = weekReminderMessage({ week: 3, isPlayoff: false, fixtures: [] });
    expect(closed).not.toContain("pickem");
  });

  it("names the teams sitting out the week, above the RSVP line", () => {
    const msg = weekReminderMessage({
      week: 1,
      isPlayoff: false,
      fixtures: [],
      byeTeamNames: ["Team One", "[free mmr](https://evil.test)"],
    });
    expect(msg).toMatch(
      /\n💤 Bye: \*\*Team One\*\*, \*\*.+\*\* — no match this week\.\nRSVP on your match page/,
    );
    // Team names are captain-typed: the masked link must stay inert.
    expect(msg).toContain("\\[free mmr\\]");
    expect(msg).not.toContain("](");
  });

  it("leaves the bye line out of playoff and tiebreaker weeks, and when nobody rests", () => {
    for (const extra of [{ isPlayoff: true }, { isTiebreaker: true }]) {
      const msg = weekReminderMessage({
        week: 6, isPlayoff: false, fixtures: [], byeTeamNames: ["Team One"], ...extra,
      });
      expect(msg).not.toContain("Bye");
    }
    expect(weekReminderMessage({ week: 1, isPlayoff: false, fixtures: [], byeTeamNames: [] }))
      .not.toContain("Bye");
  });

  it("labels playoff rounds without a week number", () => {
    const msg = weekReminderMessage({ week: 9, isPlayoff: true, fixtures: [] });
    expect(msg).toContain("Playoff matches");
    expect(msg).not.toContain("Week 9");
  });

  it("mentions the people who owe an answer, and names the unlinked ones", () => {
    // The counts state a number into a channel; these are the players who
    // haven't checked in, i.e. exactly the ones not reading it.
    const msg = weekReminderMessage({
      week: 3,
      isPlayoff: false,
      fixtures: [
        {
          matchId: "m1",
          homeName: "A",
          awayName: "B",
          scheduledAt: 1_800_000_000_000,
          homeIn: 3,
          homeSize: 5,
          awayIn: 5,
          awaySize: 5,
          waitingOn: [
            { name: "Dendi", discordId: "111222333444555666" },
            { name: "Unlinked Guy", discordId: null },
          ],
        },
      ],
    });
    expect(msg).toContain("Still waiting on:");
    expect(msg).toContain("<@111222333444555666>");
    expect(msg).toContain("Unlinked Guy");
    expect(msg).not.toContain("<@null>");
  });

  it("says nothing when everyone has answered", () => {
    const msg = weekReminderMessage({
      week: 3,
      isPlayoff: false,
      fixtures: [
        {
          matchId: "m1",
          homeName: "A",
          awayName: "B",
          scheduledAt: 1_800_000_000_000,
          homeIn: 5,
          homeSize: 5,
          awayIn: 5,
          awaySize: 5,
          waitingOn: [],
        },
      ],
    });
    expect(msg).not.toContain("Still waiting");
  });

  it("caps a long list rather than posting a wall of mentions", () => {
    const msg = weekReminderMessage({
      week: 3,
      isPlayoff: false,
      fixtures: [
        {
          matchId: "m1",
          homeName: "A",
          awayName: "B",
          scheduledAt: 1_800_000_000_000,
          homeIn: 0,
          homeSize: 5,
          awayIn: 0,
          awaySize: 5,
          waitingOn: Array.from({ length: 10 }, (_, i) => ({
            name: `P${i}`,
            discordId: null,
          })),
        },
      ],
    });
    expect(msg).toContain("+2 more");
    expect(msg).not.toContain("P8");
  });

  it("bounds a realistic 32-team slate and allowlists only visible waiters", () => {
    const fixtures = Array.from({ length: 16 }, (_, fixtureIndex) => ({
      matchId: `match-${fixtureIndex + 1}`,
      homeName: `Long Radiant Team Name ${fixtureIndex * 2 + 1}`,
      awayName: `Long Dire Team Name ${fixtureIndex * 2 + 2}`,
      scheduledAt: 1_800_000_000_000,
      homeIn: 0,
      homeSize: 5,
      awayIn: 0,
      awaySize: 5,
      waitingOn: Array.from({ length: 10 }, (_, playerIndex) => ({
        name: `Player ${fixtureIndex + 1}-${playerIndex + 1}`,
        discordId: (
          BigInt("800000000000000000") + BigInt(fixtureIndex * 10 + playerIndex)
        ).toString(),
      })),
    }));

    const announcement = weekReminderAnnouncement({
      week: 4,
      isPlayoff: false,
      fixtures,
    });
    const delivered = materializeAllowedMentions(announcement.content, {
      users: announcement.mentionUserIds,
    });

    // Every allowed id already appears in a visible waiter row, so central
    // transport materialization cannot prepend hidden/omitted users.
    expect(delivered).toBe(announcement.content);
    expect(delivered.length).toBeLessThanOrEqual(2_000);
    const visibleMentions = [...delivered.matchAll(/<@(\d{17,20})>/g)].map(
      (match) => match[1],
    );
    expect(new Set(announcement.mentionUserIds)).toEqual(
      new Set(visibleMentions),
    );

    const shownFixtures = delivered
      .split("\n")
      .filter((line) => line.startsWith("🆚")).length;
    const summary = delivered.match(
      /…and (\d+) more fixtures? at this kickoff/,
    );
    expect(shownFixtures).toBeGreaterThan(0);
    expect(shownFixtures).toBeLessThan(fixtures.length);
    expect(summary).not.toBeNull();
    expect(shownFixtures + Number(summary?.[1])).toBe(fixtures.length);
    expect(delivered).toContain("/schedule>");

    // A player from the final summarized fixture is neither rendered nor
    // allowlisted; they cannot be materialized anonymously ahead of the body.
    const hiddenId = fixtures.at(-1)!.waitingOn[0].discordId!;
    expect(delivered).not.toContain(`<@${hiddenId}>`);
    expect(announcement.mentionUserIds).not.toContain(hiddenId);
  });
});

describe("rescheduleMessage", () => {
  it("announces the agreed time as a Discord timestamp (reader-local)", () => {
    const msg = rescheduleMessage({
      homeName: "A",
      awayName: "B",
      week: 3,
      isPlayoff: false,
      whenMs: 1784167200500, // sub-second ms must floor, not round up
    });
    expect(msg).toContain("Week 3");
    expect(msg).toContain("**A** vs **B**");
    expect(msg).toContain("<t:1784167200:F>");
  });

  it("labels playoff matches", () => {
    expect(
      rescheduleMessage({
        homeName: "A",
        awayName: "B",
        week: 9,
        isPlayoff: true,
        whenMs: 1784167200000,
      }),
    ).toContain("Playoffs");
  });
});

describe("newsMessage", () => {
  it("announces the title with a body snippet and /news link", () => {
    const msg = newsMessage("Week 3 moved", "Matches now play Thursday.");
    expect(msg).toContain("**Week 3 moved**");
    expect(msg).toContain("Matches now play Thursday.");
    expect(msg).toContain("/news");
  });

  it("flattens whitespace and truncates long bodies", () => {
    const msg = newsMessage("T", `line one\n\nline two ${"x".repeat(300)}`);
    expect(msg).toContain("line one line two");
    expect(msg).toContain("…");
    expect(msg.length).toBeLessThan(300);
  });

  it("deep-links to a specific post when given an id", () => {
    expect(newsMessage("T", "b", "abc123")).toContain("/news#abc123");
    expect(newsMessage("T", "b")).toMatch(/\/news(?!#)/);
  });

  it("hoists a GIF URL onto its own trailing line so it survives truncation", () => {
    const gif = "https://media.giphy.com/media/xyz/giphy.gif";
    const msg = newsMessage("Big win", `We did it! ${gif}`, "p1");
    const lines = msg.split("\n");
    // GIF sits on the last line (past the /news link), out of the snippet.
    expect(lines[lines.length - 1]).toBe(gif);
    expect(msg).toContain("We did it!");
    // Even when the body is long enough to truncate, the GIF is preserved.
    const long = newsMessage("T", `${"x".repeat(300)} ${gif}`);
    expect(long).toContain(gif);
    expect(long).toContain("…");
  });
});

describe("maskWebhookUrl", () => {
  const real =
    "https://discord.com/api/webhooks/1379001234567890123/aB3xY-secretTOKENvalue_should_never_leak";

  it("never reveals the secret token", () => {
    const masked = maskWebhookUrl(real);
    expect(masked).not.toContain("secretTOKEN");
    expect(masked).not.toContain("aB3xY");
    expect(masked).toContain("••••");
  });

  it("shows only a short id fingerprint, not the full id", () => {
    const masked = maskWebhookUrl(real);
    expect(masked).not.toContain("1379001234567890123");
    expect(masked).toContain("1379");
  });

  it("returns empty for a missing webhook", () => {
    expect(maskWebhookUrl(null)).toBe("");
    expect(maskWebhookUrl(undefined)).toBe("");
    expect(maskWebhookUrl("")).toBe("");
  });

  it("falls back to a generic label for unexpected shapes", () => {
    expect(maskWebhookUrl("https://example.com/not-a-webhook")).toBe(
      "configured",
    );
  });
});

describe("webhookIdOf", () => {
  it("extracts the webhook id, never the token", () => {
    expect(
      webhookIdOf("https://discord.com/api/webhooks/1379001234567890123/tok"),
    ).toBe("1379001234567890123");
  });

  it("is stable across a token regeneration — the id doesn't change", () => {
    const base = "https://discord.com/api/webhooks/1379001234567890123/";
    expect(webhookIdOf(`${base}oldToken`)).toBe(webhookIdOf(`${base}newToken`));
  });

  it("distinguishes a webhook pointed at a different channel", () => {
    expect(webhookIdOf("https://discord.com/api/webhooks/111/t")).not.toBe(
      webhookIdOf("https://discord.com/api/webhooks/222/t"),
    );
  });

  it("returns null for nothing and for non-webhook URLs", () => {
    expect(webhookIdOf(null)).toBeNull();
    expect(webhookIdOf(undefined)).toBeNull();
    expect(webhookIdOf("https://example.com/hook")).toBeNull();
  });
});

describe("webhookApiUrl", () => {
  const token = "aB3xY-secret";

  it("pins an unversioned URL to v10 (the default is still deprecated v6)", () => {
    expect(webhookApiUrl(`https://discord.com/api/webhooks/123/${token}`)).toBe(
      `https://discord.com/api/v10/webhooks/123/${token}`,
    );
  });

  it("upgrades an older pinned version", () => {
    expect(
      webhookApiUrl(`https://discord.com/api/v9/webhooks/123/${token}`),
    ).toBe(`https://discord.com/api/v10/webhooks/123/${token}`);
  });

  it("is idempotent", () => {
    const once = webhookApiUrl(`https://discord.com/api/webhooks/123/${token}`);
    expect(webhookApiUrl(once)).toBe(once);
  });

  it("handles the discordapp.com alias the save form still accepts", () => {
    expect(
      webhookApiUrl(`https://discordapp.com/api/webhooks/123/${token}`),
    ).toBe(`https://discordapp.com/api/v10/webhooks/123/${token}`);
  });

  it("preserves the token exactly — a mangled credential is a silent 401", () => {
    expect(
      webhookApiUrl(`https://discord.com/api/webhooks/123/${token}`),
    ).toContain(token);
  });

  it("leaves an unrecognised URL alone rather than corrupting it", () => {
    expect(webhookApiUrl("https://example.com/hook")).toBe(
      "https://example.com/hook",
    );
  });
});

describe("Discord transport diagnostics", () => {
  it("revalidates the general announcement sink immediately before fetch", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/discord.ts"),
      "utf8",
    );
    const body = (name: string) => {
      const start = source.indexOf(`async function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf("\n}\n", start));
    };
    // sendTo is the boolean wrapper; postTo is the one network sink, and it
    // keeps Discord's status for the league queue.
    expect(body("sendTo")).toContain("postTo(url, content, mentions)");
    expect(body("sendTo")).not.toContain("fetch(");
    const sink = body("postTo");
    expect(sink).toContain("const target = runtimeWebhookUrl(url)");
    expect(sink).toContain("fetch(webhookApiUrl(target)");
    expect(sink).not.toContain("fetch(webhookApiUrl(url)");
  });

  it("rejects untrusted transport targets before any network request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const target = "https://league.example/internal/admin";

    await expect(
      postWebhookMessage(target, { content: "test" }),
    ).resolves.toBeNull();
    await expect(
      patchWebhookMessage(target, "message-1", { content: "test" }),
    ).resolves.toBe("failed");
    await expect(deleteWebhookMessage(target, "message-1")).resolves.toBe(
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("makes no webhook mutation request from a Vercel preview", async () => {
    process.env.VERCEL_ENV = "preview";
    const fetch = vi.spyOn(globalThis, "fetch");
    const target =
      "https://discord.com/api/webhooks/1379001234567890123/safe-test-token";

    await expect(
      postWebhookMessage(target, { content: "test" }),
    ).resolves.toBeNull();
    await expect(
      patchWebhookMessage(target, "message-1", { content: "test" }),
    ).resolves.toBe("failed");
    await expect(deleteWebhookMessage(target, "message-1")).resolves.toBe(
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not copy provider errors or webhook credentials into logs", async () => {
    const token = "credential-that-must-not-be-logged";
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error(`failed request with ${token}`),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      await postWebhookMessage(
        `https://discord.com/api/webhooks/1379001234567890123/${token}`,
        { content: "test" },
      ),
    ).toBeNull();
    expect(warning).toHaveBeenCalledWith("[discord] webhook post failed");
    expect(JSON.stringify(warning.mock.calls)).not.toContain(token);
  });
});

describe("standinAssignedMessage", () => {
  it("tells the standin whose seat they fill, where, and when (reader-local)", () => {
    const msg = standinAssignedMessage({
      standinName: "Sub Sam",
      replacedName: "Home Carry",
      teamName: "Roshan's Rejects",
      homeName: "Roshan's Rejects",
      awayName: "Dire Straits",
      week: 4,
      isPlayoff: false,
      whenMs: 1_760_000_000_000,
    });
    expect(msg).toContain("Sub Sam");
    expect(msg).toContain("Home Carry");
    expect(msg).toContain("Roshan's Rejects");
    expect(msg).toContain("week 4");
    expect(msg).toContain("<t:1760000000:F>");
  });

  it("omits the kickoff for unscheduled matches and says playoff when it is one", () => {
    const msg = standinAssignedMessage({
      standinName: "Sub Sam",
      replacedName: "Away Mid",
      teamName: "Dire Straits",
      homeName: "Roshan's Rejects",
      awayName: "Dire Straits",
      week: 8,
      isPlayoff: true,
      whenMs: null,
    });
    expect(msg).toContain("playoff match");
    expect(msg).not.toContain("<t:");
  });
});

describe("standinRemovedMessage", () => {
  it("stands the substitute down by name", () => {
    const msg = standinRemovedMessage({
      standinName: "Sub Sam",
      teamName: "Dire Straits",
      homeName: "Roshan's Rejects",
      awayName: "Dire Straits",
      week: 4,
      isPlayoff: false,
    });
    expect(msg).toContain("Sub Sam");
    expect(msg).toContain("no longer standing in");
    // No reason given: the post is exactly what it always was.
    expect(msg).toMatch(/— stand down\.$/);
  });

  it("says in a few words why the booking ended", () => {
    const base = {
      standinName: "Sub Sam",
      teamName: "Dire Straits",
      homeName: "Roshan's Rejects",
      awayName: "Dire Straits",
      week: 4,
      isPlayoff: false,
    };
    expect(standinRemovedMessage({ ...base, reason: "TEAM_WITHDREW" })).toMatch(
      /— stand down \(a team withdrew from the season\)\.$/,
    );
    expect(
      standinRemovedMessage({ ...base, reason: "ADMIN_CANCELLED" }),
    ).toContain("stand down (an admin cancelled the booking).");
    expect(
      standinRemovedMessage({ ...base, reason: "CAPTAIN_CANCELLED" }),
    ).toContain("stand down (the team's captain cancelled the booking).");
  });
});

describe("no message unfurls a link preview", () => {
  // A bare URL makes Discord render a full preview card — our own og:image and
  // blurb — which on a one-line ping is ~10x the height of the message and
  // pushes everything else off screen. <angle brackets> keep it clickable and
  // kill the card. The one deliberate exception is a news post's media URL,
  // which is bare so the GIF DOES embed.
  const BARE = /(?<![<(])https?:\/\//;

  it("wraps every site link in angle brackets", () => {
    const messages = [
      signupMessage("Zai", 3, 20),
      draftScheduledMessage("S1", 1_800_000_000_000),
      draftRescheduledMessage("S1", 1_800_000_000_000),
      draftCancelledMessage("S1"),
      draftReminderAnnouncement({
        seasonName: "S1",
        draftAtMs: 1_800_000_000_000,
        playerSignupsOpen: true,
        playerCount: 3,
        captains: [{ name: "A", discordId: null }],
        unconfirmed: [{ name: "B", discordId: null }],
      }).content,
      captainAssignedMessage("A", "T", "123"),
      draftStartedAnnouncement({ seasonName: "S1", captains: [] }).content,
      draftCompleteAnnouncement({
        seasonName: "S1",
        teams: [
          {
            name: "T",
            captainName: "C",
            players: [{ name: "A", discordId: null, price: 5 }],
            openSeats: 1,
          },
        ],
      }).content,
      matchResultMessage({
        matchId: "m1",
        homeName: "A",
        awayName: "B",
        homeScore: 2,
        awayScore: 0,
        label: "Week 1",
      }),
      matchResultMessage({
        matchId: "m2",
        homeName: "A",
        awayName: "B",
        homeScore: 2,
        awayScore: 0,
        label: "Semifinal",
        forfeit: true,
        knockout: { nextRound: "Grand final" },
      }),
      playoffsStartedMessage("S1", [{ home: "A", away: "B" }]),
      playoffsStartedMessage("S1", [
        { home: "A", away: "B", homeSeed: 1, awaySeed: 2, whenMs: 1_800_000_000_000 },
      ]),
      playoffsReturnedToRegularMessage("S1"),
      championMessage("S1", "T", "s1"),
      signupsOpenMessage("S1", "Sundays"),
      playoffRoundSetMessage({
        seasonName: "S1",
        roundName: "Grand final",
        fixtures: [{ home: "A", away: "B", whenMs: 1_800_000_000_000 }],
      }),
      resultNudgeMessage({
        matchId: "m1",
        homeName: "A",
        awayName: "B",
        label: "Week 1",
        homeScore: 1,
        awayScore: 0,
        gamesFound: 1,
      }),
      freeAgentSignedMessage("A", "T"),
      playerReleasedMessage("A", "T"),
      teamWithdrewMessage("T", 3),
      teamIdentityChangedMessage({
        teamId: "t1",
        previousName: "Old",
        name: "New",
        nameChanged: true,
        logoChanged: false,
      }),
      teamIdentityChangedMessage({
        teamId: "t1",
        previousName: "New",
        name: "New",
        nameChanged: false,
        logoChanged: true,
      }),
      inhouseQueueMessage(4, 10),
      inhouseQueueMessage(4, 10, "999"),
      inhouseLobbyMessage([{ name: "A", discordId: null }]),
      inhouseResultMessage({
        winnerSide: "Radiant",
        radiantScore: 1,
        direScore: 0,
        durationSecs: 60,
        mvpName: null,
        mvpHero: null,
        dotaMatchId: "1",
      }),
      playerOutMessage({
        playerName: "A",
        homeName: "H",
        awayName: "W",
        week: 1,
        isPlayoff: false,
        whenMs: null,
      }),
      playerBackInMessage({
        playerName: "A",
        homeName: "H",
        awayName: "W",
        week: 1,
        isPlayoff: false,
        whenMs: null,
        matchId: "m1",
      }),
      standinAssignedMessage({
        standinName: "S",
        replacedName: "R",
        teamName: "T",
        homeName: "H",
        awayName: "W",
        week: 1,
        isPlayoff: false,
        whenMs: null,
      }),
      standinRemovedMessage({
        standinName: "S",
        teamName: "T",
        homeName: "H",
        awayName: "W",
        week: 1,
        isPlayoff: false,
      }),
      playerAwayMessage("A", [
        { homeName: "H", awayName: "W", week: 1, isPlayoff: false, whenMs: 1_800_000_000_000, matchId: "m1" },
        { homeName: "H", awayName: "W", week: 2, isPlayoff: false, whenMs: null, matchId: "m2" },
      ]),
      rescheduleProposedMessage({
        homeName: "H",
        awayName: "W",
        week: 1,
        isPlayoff: false,
        proposerName: "P",
        whenMs: 1_800_000_000_000,
      }),
      rescheduleMessage({
        homeName: "H",
        awayName: "W",
        week: 1,
        isPlayoff: false,
        whenMs: 1_800_000_000_000,
      }),
      rescheduleDeclinedMessage({
        homeName: "H",
        awayName: "W",
        week: 1,
        isPlayoff: false,
        declinerName: "D",
        whenMs: 1_800_000_000_000,
      }),
      weeklyHonorsMessage({
        week: 1,
        playerName: "A",
        playerPoints: 10,
        heroName: "Lina",
        teamName: "T",
        teamGameWins: 2,
      }),
      weekReminderMessage({
        week: 1,
        isPlayoff: false,
        fixtures: [
          {
            matchId: "m1",
            homeName: "H",
            awayName: "W",
            scheduledAt: 1_800_000_000_000,
            homeIn: 1,
            homeSize: 5,
            awayIn: 5,
            awaySize: 5,
            waitingOn: [],
          },
        ],
      }),
      newsMessage("Title", "Body with no media"),
    ];
    for (const m of messages) {
      expect(m, `unfurls: ${m.slice(0, 80)}`).not.toMatch(BARE);
    }
  });

  it("still lets a news GIF embed — that one is deliberate", () => {
    const msg = newsMessage("T", "Look\nhttps://media.giphy.com/x.gif");
    expect(msg).toMatch(BARE); // the media line stays bare on purpose
    expect(msg).toContain("More: <"); // ...but the site link does not
  });
});

describe("no player-supplied name can inject markdown", () => {
  // Discord renders markdown in webhook messages and, unlike user-typed
  // messages, does NOT suppress masked links there. A Steam persona is chosen
  // by the player, so every formatter that interpolates one is an injection
  // point — this is the sweep that says they all go through escapeDiscordText.
  const EVIL = "[free mmr](https://evil.test)";

  const messages = () => [
    signupMessage(EVIL, 3, 10),
    signupsOpenMessage(EVIL, EVIL),
    draftCompleteAnnouncement({
      seasonName: "S1",
      teams: [
        {
          name: EVIL,
          captainName: EVIL,
          players: [{ name: EVIL, discordId: null, price: 5 }],
          openSeats: 0,
        },
      ],
    }).content,
    matchResultMessage({
      matchId: "m1",
      homeName: EVIL,
      awayName: EVIL,
      homeScore: 2,
      awayScore: 0,
      label: "Week 1",
    }),
    // The knockout line names both teams again — the winner and the loser.
    matchResultMessage({
      matchId: "m1",
      homeName: EVIL,
      awayName: EVIL,
      homeScore: 2,
      awayScore: 1,
      label: "Semifinal",
      knockout: { nextRound: "Grand final" },
    }),
    playoffsStartedMessage("Season 1", [
      { home: EVIL, away: EVIL, homeSeed: 1, awaySeed: 4, whenMs: 1_800_000_000_000 },
    ]),
    championMessage("Season 1", EVIL, "s1"),
    playoffRoundSetMessage({
      seasonName: EVIL,
      roundName: "Grand final",
      fixtures: [{ home: EVIL, away: EVIL, whenMs: null }],
    }),
    resultNudgeMessage({
      matchId: "m1",
      homeName: EVIL,
      awayName: EVIL,
      label: "Week 1",
      homeScore: 0,
      awayScore: 0,
      gamesFound: 0,
    }),
    freeAgentSignedMessage(EVIL, EVIL),
    playerReleasedMessage(EVIL, EVIL),
    teamWithdrewMessage(EVIL, 3),
    teamIdentityChangedMessage({
      teamId: "t1",
      previousName: EVIL,
      name: EVIL,
      nameChanged: true,
      logoChanged: true,
    }),
    teamIdentityChangedMessage({
      teamId: "t1",
      previousName: EVIL,
      name: EVIL,
      nameChanged: false,
      logoChanged: true,
    }),
    playerOutMessage({
      playerName: EVIL,
      homeName: EVIL,
      awayName: EVIL,
      week: 1,
      isPlayoff: false,
      whenMs: null,
    }),
    playerBackInMessage({
      playerName: EVIL,
      homeName: EVIL,
      awayName: EVIL,
      week: 1,
      isPlayoff: false,
      whenMs: null,
    }),
    standinAssignedMessage({
      standinName: EVIL,
      replacedName: EVIL,
      teamName: EVIL,
      homeName: EVIL,
      awayName: EVIL,
      week: 1,
      isPlayoff: false,
      whenMs: null,
    }),
    standinRemovedMessage({
      standinName: EVIL,
      teamName: EVIL,
      homeName: EVIL,
      awayName: EVIL,
      week: 1,
      isPlayoff: false,
    }),
    playerAwayMessage(EVIL, [
      { homeName: EVIL, awayName: EVIL, week: 1, isPlayoff: false, whenMs: null },
      { homeName: EVIL, awayName: EVIL, week: 2, isPlayoff: false, whenMs: 1_800_000_000_000, matchId: "m2" },
    ]),
    rescheduleProposedMessage({
      homeName: EVIL,
      awayName: EVIL,
      week: 1,
      isPlayoff: false,
      proposerName: EVIL,
      whenMs: 1_800_000_000_000,
    }),
    rescheduleMessage({
      homeName: EVIL,
      awayName: EVIL,
      week: 1,
      isPlayoff: false,
      whenMs: 1_800_000_000_000,
    }),
    rescheduleDeclinedMessage({
      homeName: EVIL,
      awayName: EVIL,
      week: 1,
      isPlayoff: false,
      declinerName: EVIL,
      whenMs: 1_800_000_000_000,
    }),
    weeklyHonorsMessage({
      week: 1,
      playerName: EVIL,
      playerPoints: 40,
      heroName: "Pudge",
      teamName: EVIL,
      teamGameWins: 2,
      oracle: { names: [EVIL, EVIL], correct: 1, graded: 1 },
    }),
    inhouseLobbyMessage([{ name: EVIL, discordId: null }]),
    inhouseResultMessage({
      winnerSide: "Radiant",
      radiantScore: 30,
      direScore: 10,
      durationSecs: 2000,
      mvpName: EVIL,
      mvpHero: "Pudge",
      dotaMatchId: "123",
    }),
    weekReminderMessage({
      week: 1,
      isPlayoff: false,
      fixtures: [
        {
          matchId: "m1",
          homeName: EVIL,
          awayName: EVIL,
          scheduledAt: 1_800_000_000_000,
          homeIn: 1,
          homeSize: 5,
          awayIn: 5,
          awaySize: 5,
          waitingOn: [{ name: EVIL, discordId: null }],
        },
      ],
    }),
    draftReminderAnnouncement({
      seasonName: "Season 1",
      draftAtMs: 1_800_000_000_000,
      playerSignupsOpen: true,
      playerCount: 2,
      captains: [{ name: EVIL, discordId: null }],
      unconfirmed: [{ name: EVIL, discordId: null }],
    }).content,
    adminRetimeMessage({
      clearedRsvps: 2,
      moves: [
        { matchId: "m1", homeName: EVIL, awayName: EVIL, week: 1, isPlayoff: false, whenMs: 1_800_000_000_000 },
      ],
    }),
    adminRetimeMessage({
      clearedRsvps: 0,
      moves: [
        { matchId: "m1", homeName: EVIL, awayName: EVIL, week: 1, isPlayoff: false, whenMs: 1_800_000_000_000 },
        { matchId: "m2", homeName: EVIL, awayName: EVIL, week: 2, isPlayoff: false, whenMs: null },
      ],
    }),
  ];

  it("never emits a live masked link", () => {
    for (const m of messages()) {
      expect(m, `injectable: ${m.slice(0, 80)}`).not.toContain("](");
    }
  });

  it("never lets a name forge an extra line", () => {
    const nl = "evil\nplayer";
    // header, one team line, footer
    expect(
      draftCompleteAnnouncement({
        seasonName: "S1",
        teams: [
          {
            name: nl,
            captainName: nl,
            players: [{ name: nl, discordId: null, price: 1 }],
            openSeats: 0,
          },
        ],
      }).content.split("\n"),
    ).toHaveLength(3);
    expect(teamWithdrewMessage(nl, 3)).not.toContain("\n");
    expect(
      teamIdentityChangedMessage({
        teamId: "t1",
        previousName: nl,
        name: nl,
        nameChanged: true,
        logoChanged: false,
      }),
    ).not.toContain("\n");
    expect(
      rescheduleDeclinedMessage({
        homeName: nl,
        awayName: nl,
        week: 1,
        isPlayoff: false,
        declinerName: nl,
        whenMs: 1_800_000_000_000,
      }),
    ).not.toContain("\n");
    // The reminder is genuinely multi-line — assert the COUNT is unchanged
    // rather than that there are none.
    const reminder = weekReminderMessage({
      week: 1,
      isPlayoff: false,
      fixtures: [
        {
          matchId: "m1",
          homeName: nl,
          awayName: nl,
          scheduledAt: 1_800_000_000_000,
          homeIn: 1,
          homeSize: 5,
          awayIn: 5,
          awaySize: 5,
          waitingOn: [{ name: nl, discordId: null }],
        },
      ],
    });
    expect(reminder.split("\n")).toHaveLength(4); // header, fixture, waiting, footer
    // One line per fixture: a persona newline must not forge a fixture row.
    const away = playerAwayMessage(nl, [
      { homeName: nl, awayName: nl, week: 1, isPlayoff: false, whenMs: null },
      { homeName: nl, awayName: nl, week: 2, isPlayoff: false, whenMs: null },
    ]);
    expect(away.split("\n")).toHaveLength(4); // header, two fixtures, footer
    const draftReminder = draftReminderAnnouncement({
      seasonName: "Season 1",
      draftAtMs: 1_800_000_000_000,
      playerSignupsOpen: true,
      playerCount: 2,
      captains: [{ name: nl, discordId: null }],
      unconfirmed: [{ name: nl, discordId: null }],
    }).content;
    // header, counts, captains, unconfirmed, links
    expect(draftReminder.split("\n")).toHaveLength(5);
  });

  // Escaping must not eat the one thing these messages exist to do.
  it("leaves real mention markup intact", () => {
    expect(inhouseLobbyMessage([{ name: "x", discordId: "123" }])).toContain(
      "<@123>",
    );
    expect(
      weekReminderMessage({
        week: 1,
        isPlayoff: false,
        fixtures: [
          {
            matchId: "m1",
            homeName: "H",
            awayName: "A",
            scheduledAt: 1_800_000_000_000,
            homeIn: 1,
            homeSize: 5,
            awayIn: 5,
            awaySize: 5,
            waitingOn: [{ name: "x", discordId: "456789012345678901" }],
          },
        ],
      }),
    ).toContain("<@456789012345678901>");
    const draftReminder = draftReminderAnnouncement({
      seasonName: "Season 1",
      draftAtMs: 1_800_000_000_000,
      playerSignupsOpen: true,
      playerCount: 2,
      captains: [{ name: "x", discordId: "456789012345678901" }],
      unconfirmed: [{ name: "y", discordId: "556789012345678901" }],
    }).content;
    expect(draftReminder).toContain("<@456789012345678901>");
    expect(draftReminder).toContain("<@556789012345678901>");
  });

  it("leaves ordinary names alone", () => {
    expect(
      draftCompleteAnnouncement({
        seasonName: "S1",
        teams: [
          {
            name: "Team Liquid",
            captainName: "Puppey",
            players: [{ name: "Miracle", discordId: null, price: 40 }],
            openSeats: 0,
          },
        ],
      }).content,
    ).toContain("**Team Liquid** (captain Puppey): Miracle $40");
  });
});

describe("match-page deep links", () => {
  // The people these messages mention are by definition NOT on the site — the
  // link must land them on the match page (Standins card / check-in banner),
  // not the front door, and it must be <bracketed> so the alert can't unfurl
  // a preview card over itself.
  it("playerOutMessage links the match page when a matchId is given", () => {
    const msg = playerOutMessage({
      playerName: "Dendi",
      homeName: "H",
      awayName: "W",
      week: 4,
      isPlayoff: false,
      whenMs: null,
      matchId: "m1",
    });
    expect(msg).toMatch(/<[^<>\s]*\/matches\/m1>/);
  });

  it("playerOutMessage stays link-free without one — hand-built calls", () => {
    const msg = playerOutMessage({
      playerName: "Dendi",
      homeName: "H",
      awayName: "W",
      week: 4,
      isPlayoff: false,
      whenMs: null,
    });
    expect(msg).not.toContain("/matches/");
  });

  it("standinAssignedMessage links the check-in page when a matchId is given", () => {
    const msg = standinAssignedMessage({
      standinName: "S",
      replacedName: "R",
      teamName: "T",
      homeName: "H",
      awayName: "W",
      week: 4,
      isPlayoff: false,
      whenMs: null,
      matchId: "m1",
    });
    expect(msg).toMatch(/<[^<>\s]*\/matches\/m1>/);
  });

  it("standinAssignedMessage stays link-free without one", () => {
    const msg = standinAssignedMessage({
      standinName: "S",
      replacedName: "R",
      teamName: "T",
      homeName: "H",
      awayName: "W",
      week: 4,
      isPlayoff: false,
      whenMs: null,
    });
    expect(msg).not.toContain("/matches/");
  });
});

describe("freeAgentSignedMessage addresses the signed player", () => {
  // A signing is a season-long obligation (every remaining match night), so
  // the message ends by naming the player's next move: check in on /schedule.
  // The address line names them a SECOND time — a player being told something,
  // not just announced.
  it("ends by pointing the player at their new schedule", () => {
    const msg = freeAgentSignedMessage("Late Joiner", "Short Squad");
    expect(msg).toContain("/schedule");
    expect(msg.split("Late Joiner")).toHaveLength(3); // named exactly twice
  });
});

describe("weeklyHonorsMessage", () => {
  it("names the Player of the Week score impact points, as /leaders does", () => {
    const message = weeklyHonorsMessage({
      week: 4,
      playerName: "Winner",
      playerPoints: 134.2,
      heroName: "Lina",
      teamName: "Team",
      teamGameWins: 2,
    });
    expect(message).toContain("134.2 impact points on Lina");
    expect(message).not.toMatch(/fantasy/i);
  });

  const base = {
    week: 4,
    playerName: "Winner",
    playerPoints: 50,
    heroName: "Lina",
    teamName: "Team",
    teamGameWins: 2,
  };

  it("adds the pick'em oracle inside the same post, before the link", () => {
    const lines = weeklyHonorsMessage({
      ...base,
      oracle: { names: ["Seer"], correct: 3, graded: 3 },
    }).split("\n");
    expect(lines).toContain(
      "🔮 Pick'em Oracle of the Week: **Seer** (3 of 3 picks right)",
    );
    expect(lines.at(-1)).toMatch(/^Full leaderboards: /);
  });

  it("lists every tied oracle, then caps a long tie", () => {
    expect(
      weeklyHonorsMessage({
        ...base,
        oracle: { names: ["A", "B", "C"], correct: 2, graded: 2 },
      }),
    ).toContain(
      "🔮 Pick'em Oracles of the Week: **A**, **B** and **C** (2 of 2 picks right each)",
    );
    expect(
      weeklyHonorsMessage({
        ...base,
        oracle: {
          names: ["A", "B", "C", "D", "E", "F", "G"],
          correct: 1,
          graded: 1,
        },
      }),
    ).toContain("**A**, **B**, **C**, **D**, **E** and 2 more (1 of 1");
  });

  it("leaves the line out when there is no oracle", () => {
    expect(weeklyHonorsMessage(base)).not.toMatch(/Oracle/);
    expect(
      weeklyHonorsMessage({ ...base, oracle: { names: [], correct: 0, graded: 0 } }),
    ).not.toMatch(/Oracle/);
  });
});

describe("weeklyHonorsMessage corrections", () => {
  it("clearly labels a corrected award", () => {
    const message = weeklyHonorsMessage({
      week: 3,
      playerName: "New winner",
      playerPoints: 42,
      heroName: "Lina",
      teamName: "New team",
      teamGameWins: 2,
      corrected: true,
    });
    expect(message).toMatch(/^🏅 \*\*Correction: Week 3 honors/);
  });

  it("explicitly withdraws an award when a corrected week has no eligible games", () => {
    const message = weeklyHonorsMessage({
      week: 3,
      playerName: null,
      playerPoints: 0,
      heroName: null,
      teamName: null,
      teamGameWins: 0,
      corrected: true,
    });
    expect(message).toMatch(/previous honors are withdrawn/i);
  });
});

describe("adminRetimeMessage", () => {
  const move = (i: number, whenMs: number | null = 1_800_000_000_000 + i * 60_000) => ({
    matchId: `m${i}`,
    homeName: `Home ${i}`,
    awayName: `Away ${i}`,
    week: 3,
    isPlayoff: false,
    whenMs,
  });

  it("names one moved fixture, its reader-local time and the reset", () => {
    const msg = adminRetimeMessage({ moves: [move(1)], clearedRsvps: 4 });
    expect(msg).toContain("Kickoff moved");
    expect(msg).toContain("Week 3: **Home 1** vs **Away 1** now plays <t:1800000060:F>");
    expect(msg).toContain("4 cleared");
    expect(msg).toMatch(/\/matches\/m1>$/);
  });

  it("says so when the kickoff was cleared", () => {
    const msg = adminRetimeMessage({ moves: [move(1, null)], clearedRsvps: 0 });
    expect(msg).toContain("**Home 1** vs **Away 1** is unscheduled for now (set by an admin)");
    expect(msg).not.toContain("<t:");
    expect(msg).not.toContain("Check-ins were reset");
  });

  it("lists a week move and caps a long cascade", () => {
    const msg = adminRetimeMessage({
      moves: Array.from({ length: 14 }, (_, i) => move(i)),
      clearedRsvps: 0,
    });
    expect(msg).toContain("14 matches have new kickoffs");
    expect(msg.match(/<t:\d+:F>/g)?.length).toBe(10);
    expect(msg).toContain("…and 4 more");
    expect(msg.length).toBeLessThan(2000);
    expect(msg).toMatch(/\/schedule>$/);
  });

  it("labels playoff and tiebreaker fixtures", () => {
    expect(adminRetimeMessage({ moves: [{ ...move(1), isPlayoff: true }], clearedRsvps: 0 }))
      .toContain("Playoffs:");
    expect(adminRetimeMessage({ moves: [{ ...move(1), isTiebreaker: true }], clearedRsvps: 0 }))
      .toContain("Tiebreaker week 3:");
  });
});

describe("teamIdentityChangedMessage", () => {
  it("names the old and new team and links the team page", () => {
    const msg = teamIdentityChangedMessage({
      teamId: "team-1",
      previousName: "w4tkins's Team",
      name: "My Team Sucks",
      nameChanged: true,
      logoChanged: false,
    });
    expect(msg).toContain("**w4tkins's Team** is now **My Team Sucks**");
    expect(msg).toMatch(/<https?:\/\/[^>]+\/teams\/team-1>$/);
    expect(msg).not.toContain("logo");
  });

  it("mentions a logo that changed with the name", () => {
    expect(
      teamIdentityChangedMessage({
        teamId: "team-1",
        previousName: "Old",
        name: "New",
        nameChanged: true,
        logoChanged: true,
      }),
    ).toContain("**Old** is now **New**, with a new logo");
  });

  it("announces a logo-only change under the current name", () => {
    expect(
      teamIdentityChangedMessage({
        teamId: "team-1",
        previousName: "Radiant Raccoons",
        name: "Radiant Raccoons",
        nameChanged: false,
        logoChanged: true,
      }),
    ).toMatch(/^🎨 \*\*Radiant Raccoons\*\* has a new logo: </);
  });
});
