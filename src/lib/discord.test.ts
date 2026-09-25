import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  newsMessage,
  rescheduleMessage,
  adminRetimeMessage,
  signupMessage,
  draftStartedMessage,
  draftCompleteMessage,
  regularSeasonStartedMessage,
  freeAgentSignedMessage,
  inhouseLobbyMessage,
  inhouseQueueMessage,
  inhouseResultMessage,
  inhouseResultVoidedMessage,
  matchResultMessage,
  playerReleasedMessage,
  playerSoldMessage,
  playoffsStartedMessage,
  playoffsReturnedToRegularMessage,
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
  playerOutMessage,
  rescheduleDeclinedMessage,
  rescheduleProposedMessage,
  standinAssignedMessage,
  standinRemovedMessage,
  teamWithdrewMessage,
  weekReminderAnnouncement,
  weekReminderMessage,
  weeklyHonorsMessage,
  materializeAllowedMentions,
  deleteWebhookMessage,
  patchWebhookMessage,
  postWebhookMessage,
  type InhouseBetSlip,
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

  it("links the draft room when the draft starts", () => {
    const msg = draftStartedMessage("Season 1");
    expect(msg).toContain("Season 1");
    expect(msg).toContain("/draft");
  });

  it("links the teams page when the draft completes", () => {
    expect(draftCompleteMessage("Season 1")).toContain("/teams");
  });

  it("announces the start of the Regular season with its schedule", () => {
    const msg = regularSeasonStartedMessage("Season *One*");
    expect(msg).toContain("Season \\*One\\*");
    expect(msg).toMatch(/Regular season is live/i);
    expect(msg).toContain("/schedule");
  });

  it("announces a decided series with the winner", () => {
    const msg = matchResultMessage({
      homeName: "A",
      awayName: "B",
      homeScore: 0,
      awayScore: 2,
      week: 3,
      isPlayoff: false,
    });
    expect(msg).toContain("Week 3");
    expect(msg).toContain("A 0–2 B");
    expect(msg).toContain("**B** take the series");
  });

  it("labels playoff results and handles draws", () => {
    const msg = matchResultMessage({
      homeName: "A",
      awayName: "B",
      homeScore: 1,
      awayScore: 1,
      week: 4,
      isPlayoff: true,
    });
    expect(msg).toContain("Playoffs:");
    expect(msg).toContain("a draw");
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
    expect(matchResultMessage({ ...fixture, homeScore: 2, awayScore: 1 }))
      .toContain("Tiebreaker week 6:");
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

  it("announces when a bracket is withdrawn for a standings correction", () => {
    const msg = playoffsReturnedToRegularMessage("Season 1");
    expect(msg).toContain("Season 1");
    expect(msg).toMatch(/bracket is void/i);
    expect(msg).toMatch(/Regular season/i);
    expect(msg).toContain("/schedule");
  });

  it("crowns the champion", () => {
    const msg = championMessage("Season 1", "Zai's Team", "season/one");
    expect(msg).toContain("**Zai's Team**");
    expect(msg).toContain("champions");
    expect(msg).toContain("/recap?season=season%2Fone");
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

  it("announces a sale with the price", () => {
    const msg = playerSoldMessage("Fly", "Fear's Team", 23);
    expect(msg).toContain("**Fly**");
    expect(msg).toContain("**Fear's Team**");
    expect(msg).toContain("$23");
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

  it("flavors min-bid steals and big spends", () => {
    expect(playerSoldMessage("A", "T", 1)).toContain("steal");
    expect(playerSoldMessage("A", "T", 75)).toContain("big spender");
    expect(playerSoldMessage("A", "T", 20)).not.toMatch(/steal|big spender/);
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

describe("inhouseResultMessage — the slips block", () => {
  const RESULT = {
    winnerSide: "Radiant" as const,
    radiantScore: 41,
    direScore: 28,
    durationSecs: 38 * 60 + 12,
    mvpName: "Kessler",
    mvpHero: "Puck",
    dotaMatchId: "8412345678",
  };

  const won = (
    name: string,
    stake: number,
    matched: number,
  ): InhouseBetSlip => ({
    name,
    stake,
    matched,
    outcome: "WON",
    delta: matched,
  });
  const lost = (
    name: string,
    stake: number,
    matched: number,
  ): InhouseBetSlip => ({
    name,
    stake,
    matched,
    outcome: "LOST",
    delta: -matched,
  });
  const voided = (
    name: string,
    stake: number,
    outcome: "VOID_LINEUP" | "VOID_LATE",
  ): InhouseBetSlip => ({ name, stake, matched: 0, outcome, delta: 0 });

  /** Everything below the headline — the block, on its own. */
  const block = (slips: InhouseBetSlip[] | null, over = {}) =>
    inhouseResultMessage({ ...RESULT, ...over, slips })
      .split("\n")
      .slice(1);

  it("sends byte-identical output to a league that doesn't bet", () => {
    // The whole point of the omission: `slips` is passed unconditionally by the
    // service, so the three ways of having no bets (never settled, nobody bet,
    // settlement threw and was swallowed) must all read exactly as this message
    // read before the economy existed.
    const before = inhouseResultMessage(RESULT);
    expect(inhouseResultMessage({ ...RESULT, slips: null })).toBe(before);
    expect(inhouseResultMessage({ ...RESULT, slips: [] })).toBe(before);
    expect(before).not.toContain("\n");
  });

  it("reports a fully-covered pot with both sides' slips", () => {
    // Worked example 1: 200 a side, every stake matched at ratio 1.0.
    expect(
      block([
        won("Kessler", 100, 100),
        won("Roo", 50, 50),
        won("Vex", 40, 40),
        won("Bo", 10, 10),
        lost("Dooley", 100, 100),
        lost("Mig", 60, 60),
        lost("Nine", 40, 40),
      ]),
    ).toEqual([
      "**Pot 400 Cred** · CONTESTED · fully covered",
      "Radiant: Kessler 100 → +100 · Roo 50 → +50 · Vex 40 → +40 · Bo 10 → +10",
      "Dire: Dooley 100 → -100 · Mig 60 → -60 · Nine 40 → -40",
    ]);
  });

  it("says how much came home when one side out-stakes the other", () => {
    // Worked example 2: the long side is matched by largest remainder, so a
    // 100 stake is live for 43. The player has to be able to read that off the
    // line without doing the division — hence stake → net, side by side.
    expect(
      block(
        [
          won("Dooley", 100, 43),
          won("Mig", 100, 43),
          won("Nine", 60, 26),
          won("Pia", 20, 8),
          lost("Ash", 100, 100),
          lost("Bo", 20, 20),
        ],
        { winnerSide: "Dire" as const },
      ),
    ).toEqual([
      "**Pot 400 Cred** · CONTESTED · 240 covered · 160 came home",
      "Dire: Dooley 100 → +43 · Mig 100 → +43 · Nine 60 → +26 · Pia 20 → +8",
      "Radiant: Ash 100 → -100 · Bo 20 → -20",
    ]);
  });

  it("phrases an uncovered pot as a verdict, not a failure", () => {
    // Even money means the side that thinks it's behind stakes nothing, so
    // M = 0 is the ten agreeing the game wasn't close. Nobody lost anything.
    expect(block([won("Ash", 100, 0), won("Bo", 50, 0)])).toEqual([
      "**Pot 150 Cred** · nobody took the other side — every stake came home",
      "Radiant: Ash 100 → 0 · Bo 50 → 0",
    ]);
  });

  it("never prints a side nobody backed", () => {
    expect(block([won("Ash", 100, 0)]).join("\n")).not.toContain("Dire:");
  });

  it("names the refunded and keeps their stake out of the pot", () => {
    // A voided stake is handed back in full and never entered a pool — count it
    // in the pot and the message advertises money that was never at risk.
    expect(
      block([
        won("Kessler", 100, 100),
        lost("Dooley", 100, 100),
        voided("Ash", 100, "VOID_LINEUP"),
        voided("Bo", 20, "VOID_LATE"),
      ]),
    ).toEqual([
      "**Pot 200 Cred** · CONTESTED · fully covered",
      "Radiant: Kessler 100 → +100",
      "Dire: Dooley 100 → -100",
      "-# Refunded: Ash 100 (lineup changed) · Bo 20 (placed after the game started)",
    ]);
  });

  it("still reports a settlement in which every bet voided", () => {
    // No pot line — there was no pot — but the two people who staked and got it
    // back find that out here rather than from a balance that moved twice.
    expect(block([voided("Ash", 100, "VOID_LATE")])).toEqual([
      "-# Refunded: Ash 100 (placed after the game started)",
    ]);
  });

  it("labels the loud pots and stays quiet on the ordinary ones", () => {
    const potOf = (slips: InhouseBetSlip[]) => block(slips)[0];
    expect(potOf([won("A", 50, 50), lost("B", 50, 50)])).toBe(
      "**Pot 100 Cred** · fully covered", // casual: no label at all
    );
    expect(potOf([won("A", 100, 100), lost("B", 100, 100)])).toContain(
      "CONTESTED",
    );
    expect(
      potOf([
        won("A", 100, 100),
        won("B", 100, 100),
        won("C", 100, 100),
        lost("D", 100, 100),
        lost("E", 100, 100),
        lost("F", 100, 100),
      ]),
    ).toContain("HIGH STAKES");
    expect(
      potOf([
        won("A", 100, 100),
        won("B", 100, 100),
        won("C", 100, 100),
        won("D", 100, 100),
        won("E", 100, 100),
        lost("F", 100, 100),
        lost("G", 100, 100),
        lost("H", 100, 100),
        lost("I", 100, 100),
        lost("J", 100, 100),
      ]),
    ).toContain("MARQUEE");
  });

  it("orders each side by stake, deterministically", () => {
    // Two equal stakes must not settle into whatever order Prisma returned the
    // rows in — the same lobby has to read the same way every time.
    const rows: InhouseBetSlip[] = [
      won("Zed", 40, 40),
      won("Ana", 100, 100),
      won("Bob", 40, 40),
    ];
    expect(block(rows)[1]).toBe(
      "Radiant: Ana 100 → +100 · Bob 40 → +40 · Zed 40 → +40",
    );
    expect(block([...rows].reverse())[1]).toBe(block(rows)[1]);
  });

  it("carries no emoji — the block is data, and every glyph is text", () => {
    const msg = block([
      won("A", 100, 100),
      lost("B", 100, 100),
      voided("C", 10, "VOID_LATE"),
    ]);
    expect(msg.join("\n")).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("inhouseResultVoidedMessage", () => {
  it("names the pot and links the match the void is about to erase", () => {
    const msg = inhouseResultVoidedMessage({
      betCount: 4,
      staked: 260,
      dotaMatchId: "8412345678",
    });
    expect(msg).toContain("4 slips");
    expect(msg).toContain("260 Cred");
    // The correction has to be tie-able to the post it corrects, and the void
    // NULLS dotaMatchId — after this message nothing in the database can say
    // which game it was.
    expect(msg).toContain("<https://www.opendota.com/matches/8412345678>");
    // …and the link is bracketed, so the correction can't unfurl a preview
    // card on top of the result post it is amending.
    expect(msg).not.toMatch(/[^<]https:\/\//);
  });

  it("says 'slip' for one, and drops the link when there is no match id", () => {
    const msg = inhouseResultVoidedMessage({
      betCount: 1,
      staked: 25,
      dotaMatchId: null,
    });
    expect(msg).toContain("1 slip,");
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
    const start = source.indexOf("async function sendTo(");
    const end = source.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    const sink = source.slice(start, end);
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
      draftStartedMessage("S1"),
      draftCompleteMessage("S1"),
      playerSoldMessage("A", "T", 5),
      matchResultMessage({
        homeName: "A",
        awayName: "B",
        homeScore: 2,
        awayScore: 0,
        week: 1,
        isPlayoff: false,
      }),
      playoffsStartedMessage("S1", [{ home: "A", away: "B" }]),
      playoffsReturnedToRegularMessage("S1"),
      championMessage("S1", "T", "s1"),
      freeAgentSignedMessage("A", "T"),
      playerReleasedMessage("A", "T"),
      teamWithdrewMessage("T", 3),
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
      inhouseResultMessage({
        winnerSide: "Radiant",
        radiantScore: 1,
        direScore: 0,
        durationSecs: 60,
        mvpName: null,
        mvpHero: null,
        dotaMatchId: "1",
        slips: [
          { name: "A", stake: 100, matched: 100, outcome: "WON", delta: 100 },
          { name: "B", stake: 100, matched: 100, outcome: "LOST", delta: -100 },
        ],
      }),
      playerOutMessage({
        playerName: "A",
        homeName: "H",
        awayName: "W",
        week: 1,
        isPlayoff: false,
        whenMs: null,
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
    playerSoldMessage(EVIL, EVIL, 5),
    matchResultMessage({
      homeName: EVIL,
      awayName: EVIL,
      homeScore: 2,
      awayScore: 0,
      week: 1,
      isPlayoff: false,
    }),
    championMessage("Season 1", EVIL, "s1"),
    freeAgentSignedMessage(EVIL, EVIL),
    playerReleasedMessage(EVIL, EVIL),
    teamWithdrewMessage(EVIL, 3),
    playerOutMessage({
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
    // The slips block interpolates a name per bettor — same injection point,
    // three renders (winning side, losing side, refunded), all of which land in
    // a channel post the league appears to have written.
    inhouseResultMessage({
      winnerSide: "Radiant",
      radiantScore: 30,
      direScore: 10,
      durationSecs: 2000,
      mvpName: null,
      mvpHero: null,
      dotaMatchId: "123",
      slips: [
        { name: EVIL, stake: 100, matched: 100, outcome: "WON", delta: 100 },
        { name: EVIL, stake: 100, matched: 100, outcome: "LOST", delta: -100 },
        { name: EVIL, stake: 10, matched: 0, outcome: "VOID_LATE", delta: 0 },
      ],
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
    expect(playerSoldMessage(nl, nl, 1)).not.toContain("\n");
    expect(teamWithdrewMessage(nl, 3)).not.toContain("\n");
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
    // The slips block is one line per SIDE, so a newline in a persona would
    // forge a row and make the message lie about who was in the game.
    const slips = inhouseResultMessage({
      winnerSide: "Radiant",
      radiantScore: 1,
      direScore: 0,
      durationSecs: 60,
      mvpName: null,
      mvpHero: null,
      dotaMatchId: "1",
      slips: [
        { name: nl, stake: 100, matched: 100, outcome: "WON", delta: 100 },
        { name: nl, stake: 100, matched: 100, outcome: "LOST", delta: -100 },
      ],
    });
    expect(slips.split("\n")).toHaveLength(4); // headline, pot, two sides
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
    expect(playerSoldMessage("Puppey", "Team Liquid", 40)).toContain(
      "**Puppey** → **Team Liquid**",
    );
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
