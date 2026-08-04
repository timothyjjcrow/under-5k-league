import { describe, it, expect } from "vitest";
import {
  newsMessage,
  rescheduleMessage,
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
  captainAssignedMessage,
  playerOutMessage,
  rescheduleDeclinedMessage,
  rescheduleProposedMessage,
  standinAssignedMessage,
  standinRemovedMessage,
  teamWithdrewMessage,
  weekReminderMessage,
  weeklyHonorsMessage,
  type InhouseBetSlip,
} from "./discord";

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
            waitingOn: [{ name: "x", discordId: "456" }],
          },
        ],
      }),
    ).toContain("<@456>");
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
