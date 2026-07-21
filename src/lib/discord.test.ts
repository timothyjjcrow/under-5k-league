import { describe, it, expect } from "vitest";
import {
  newsMessage,
  rescheduleMessage,
  signupMessage,
  draftStartedMessage,
  draftCompleteMessage,
  freeAgentSignedMessage,
  inhouseLobbyMessage,
  inhouseQueueMessage,
  matchResultMessage,
  playerReleasedMessage,
  playerSoldMessage,
  playoffsStartedMessage,
  championMessage,
  maskWebhookUrl,
  draftScheduledMessage,
  playerOutMessage,
  rescheduleProposedMessage,
  standinAssignedMessage,
  standinRemovedMessage,
  weekReminderMessage,
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

  it("crowns the champion", () => {
    const msg = championMessage("Season 1", "Zai's Team");
    expect(msg).toContain("**Zai's Team**");
    expect(msg).toContain("champions");
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
  it("announces the scheduled draft night reader-local", () => {
    const msg = draftScheduledMessage("Season 2", 1_800_000_000_000);
    expect(msg).toContain("Season 2");
    expect(msg).toContain("<t:1800000000:F>");
    expect(msg).toContain("/draft");
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
    const names = Array.from({ length: 10 }, (_, i) => `P${i}`);
    const msg = inhouseLobbyMessage(names);
    expect(msg).toContain("Inhouse lobby is up");
    expect(msg).toContain("P0, P1");
    expect(msg).toContain("P9");
    expect(msg).toContain("/inhouse");
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
