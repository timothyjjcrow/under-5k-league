import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(),
}));

import {
  announceMatchNightPollResult,
  closeMatchNightPoll,
  createMatchNightPoll,
  deleteMatchNightPoll,
  setMatchNightPollClosing,
} from "@/app/actions/admin-match-night-poll";
import { castMatchNightBallot } from "@/app/actions/match-night-poll";
import { getSessionUser, requireAdmin, requireUser } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { slotKey, slotLabel, type PollSlot } from "@/lib/match-night-poll";
import { LEAGUE_LOCALE } from "@/lib/zoned-time";
import {
  castBallot,
  closePollNow,
  createPoll,
  loadHomePoll,
  setPollClosesAt,
} from "@/lib/match-night-poll-service";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { SIGN_IN_REQUIRED } from "@/lib/sign-in";
import {
  makePlayer,
  makeSeason,
  makeUser,
  ON_POSTGRES,
  raceAll,
  raceN,
  sessionFor,
} from "./factories";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SUN_18: PollSlot = { day: 0, minute: 18 * 60 };
const WED_20: PollSlot = { day: 3, minute: 20 * 60 };
const SAT_17: PollSlot = { day: 6, minute: 17 * 60 };
const SUN = slotKey(SUN_18);
const WED = slotKey(WED_20);
const SAT = slotKey(SAT_17);
const label = (slot: PollSlot) =>
  slotLabel(slot, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE);

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(key, v);
  }
  return data;
}

async function openPoll(
  createdById: string,
  closesAt = new Date(Date.now() + 3 * DAY),
  question = "When should match night be?",
) {
  const outcome = await createPoll({
    question,
    slots: [WED_20, SAT_17, SUN_18],
    closesAt,
    createdById,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.poll;
}

async function ballotOf(pollId: string, userId: string) {
  const row = await prisma.matchNightBallot.findUnique({
    where: { pollId_userId: { pollId, userId } },
  });
  return row ? (JSON.parse(row.ranking) as string[]) : null;
}

let admin: Awaited<ReturnType<typeof makeUser>>;
let season: Awaited<ReturnType<typeof makeSeason>>;

/** A player signed up for the active season: the only kind who may vote. */
function makeVoter(name: string) {
  return makePlayer(season.id, name, 3000);
}

beforeEach(async () => {
  season = await makeSeason({ name: "Season 10" });
  admin = await makeUser("Poll Admin", "ADMIN");
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
  vi.mocked(requireUser).mockReset();
  vi.mocked(getSessionUser).mockReset();
  vi.mocked(getSessionUser).mockResolvedValue(sessionFor(admin));
  vi.mocked(sendDiscordMessage).mockReset();
  vi.mocked(sendDiscordMessage).mockResolvedValue(true);
});
afterEach(() => setRaceHook(null));

describe("voting", () => {
  it("saves a voter's times, replaces them on a recast, and keeps one ballot per voter", async () => {
    const poll = await openPoll(admin.id);
    const voter = await makeVoter("Voter");

    expect(
      await castBallot({ pollId: poll.id, userId: voter.id, availability: [SUN, WED] }),
    ).toMatchObject({ ok: true, availability: [WED, SUN], dropped: 0 });
    expect(
      await castBallot({ pollId: poll.id, userId: voter.id, availability: [SAT] }),
    ).toMatchObject({ ok: true, availability: [SAT] });

    expect(await prisma.matchNightBallot.count()).toBe(1);
    expect(await ballotOf(poll.id, voter.id)).toEqual([SAT]);
    const stamped = await prisma.matchNightPoll.findUniqueOrThrow({
      where: { id: poll.id },
    });
    expect(stamped.lastBallotAt).not.toBeNull();
  });

  it("drops slots the poll doesn't offer and says how many, but refuses a ballot of only those", async () => {
    const poll = await openPoll(admin.id);
    const voter = await makeVoter("Voter");
    expect(
      await castBallot({
        pollId: poll.id,
        userId: voter.id,
        availability: ["5@600", WED, WED, 42],
      }),
    ).toMatchObject({ ok: true, availability: [WED], dropped: 2 });
    expect(
      await castBallot({ pollId: poll.id, userId: voter.id, availability: ["5@600"] }),
    ).toEqual({
      ok: false,
      error: "None of the times you picked are in this poll. Reload and pick again.",
    });
    expect(await ballotOf(poll.id, voter.id)).toEqual([WED]);
  });

  it("stores an empty list as 'none of these work'", async () => {
    const poll = await openPoll(admin.id);
    const voter = await makeVoter("Voter");
    expect(
      await castBallot({ pollId: poll.id, userId: voter.id, availability: [] }),
    ).toMatchObject({ ok: true, availability: [] });
    expect(await ballotOf(poll.id, voter.id)).toEqual([]);
  });

  it("refuses a ballot once the closing time has passed", async () => {
    const poll = await openPoll(admin.id, new Date(Date.now() + HOUR));
    const voter = await makeVoter("Voter");
    expect(
      await castBallot({
        pollId: poll.id,
        userId: voter.id,
        availability: [SUN],
        now: new Date(Date.now() + 2 * HOUR),
      }),
    ).toEqual({ ok: false, error: "Voting on this poll has closed." });
    expect(await prisma.matchNightBallot.count()).toBe(0);
  });

  // The claim, not a read, enforces the deadline: here the voter reads an
  // open poll, then an admin closes it before the ballot's transaction.
  // Without `closesAt` in the claim's WHERE the ballot lands after the close.
  // The seam sits before the transaction opens, so this runs on SQLite too.
  it("refuses a ballot when voting closes between the voter's read and write", async () => {
    const poll = await openPoll(admin.id);
    const voter = await makeVoter("Voter");
    let fired = false;
    setRaceHook(
      onceAt("matchNightPoll.castBallot.afterRead", async () => {
        fired = true;
        expect(await closePollNow({ pollId: poll.id })).toMatchObject({ ok: true });
      }),
    );
    expect(
      await castBallot({ pollId: poll.id, userId: voter.id, availability: [SUN] }),
    ).toEqual({ ok: false, error: "Voting on this poll has closed." });
    expect(fired).toBe(true);
    expect(await prisma.matchNightBallot.count()).toBe(0);
  });

  it("raced against Close voting now, a ballot either counts or is refused, never lands after", async () => {
    for (let attempt = 0; attempt < (ON_POSTGRES ? 8 : 1); attempt++) {
      await prisma.matchNightPoll.deleteMany();
      const poll = await openPoll(admin.id);
      const voters = await Promise.all(
        Array.from({ length: 4 }, (_, i) => makeVoter(`Racer ${attempt}-${i}`)),
      );
      const results = await raceAll<unknown>([
        () => closePollNow({ pollId: poll.id }),
        ...voters.map((voter) => () =>
          castBallot({ pollId: poll.id, userId: voter.id, availability: [SUN] }),
        ),
      ]);
      expect(results[0]).toMatchObject({ ok: true });
      // Each voter's answer is the truth: an accepted ballot is stored, and a
      // refused one left nothing behind.
      for (const [index, voter] of voters.entries()) {
        const ok = (results[index + 1] as { ok: boolean }).ok;
        expect(await ballotOf(poll.id, voter.id)).toEqual(ok ? [SUN] : null);
      }
    }
  });

  it("the action asks a signed-out visitor to sign in, and validates the times", async () => {
    const poll = await openPoll(admin.id);
    vi.mocked(requireUser).mockRejectedValue(new Error("UNAUTHORIZED"));
    expect(
      await castMatchNightBallot(null, form({ pollId: poll.id, availability: `["${SUN}"]` })),
    ).toEqual({ error: SIGN_IN_REQUIRED });

    const voter = await makeVoter("Voter");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(voter));
    expect(
      await castMatchNightBallot(null, form({ pollId: poll.id, availability: "nope" })),
    ).toEqual({ error: "Your times didn't come through. Reload and try again." });
    expect(
      await castMatchNightBallot(null, form({ pollId: poll.id, availability: "[]" })),
    ).toMatchObject({ error: expect.stringContaining("None of these work for me") });

    const saved = await castMatchNightBallot(
      null,
      form({ pollId: poll.id, availability: JSON.stringify([SUN, "9@9", SAT]) }),
    );
    expect(saved?.message).toMatch(/^Saved 2 times: Sat 5 PM, Sun 6 PM \(.+ time\)\./);
    expect(saved?.message).toContain("1 time isn't in this poll and was left off.");

    expect(
      await castMatchNightBallot(null, form({ pollId: poll.id, none: "1" })),
    ).toEqual({ message: expect.stringContaining("none of these times work") });
    expect(await ballotOf(poll.id, voter.id)).toEqual([]);
  });
});

describe("who may vote", () => {
  const refusal = {
    ok: false,
    error: "Only players signed up for the league can vote in this poll.",
  };

  it("refuses an account with no signup, a withdrawn or removed one, or one from an old season", async () => {
    const poll = await openPoll(admin.id);
    const outsider = await makeUser("Outsider");
    expect(
      await castBallot({ pollId: poll.id, userId: outsider.id, availability: [SUN] }),
    ).toEqual(refusal);

    for (const status of ["WITHDRAWN", "REMOVED"]) {
      const quitter = await makeVoter(`Quit ${status}`);
      await prisma.registration.updateMany({
        where: { userId: quitter.id },
        data: { status },
      });
      expect(
        await castBallot({ pollId: poll.id, userId: quitter.id, availability: [SUN] }),
      ).toEqual(refusal);
    }

    // Signed up last season only: the active season is the electorate.
    const old = await makeSeason({ name: "Season 9", isActive: false });
    const veteran = await makePlayer(old.id, "Veteran", 3000);
    expect(
      await castBallot({ pollId: poll.id, userId: veteran.id, availability: [SUN] }),
    ).toEqual(refusal);

    expect(await prisma.matchNightBallot.count()).toBe(0);
    // The refused claim rolled back with the transaction.
    expect(
      (await prisma.matchNightPoll.findUniqueOrThrow({ where: { id: poll.id } }))
        .lastBallotAt,
    ).toBeNull();
  });

  it("lets standins and roster or captain seats vote", async () => {
    const poll = await openPoll(admin.id);
    const standin = await makeUser("Standin");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: standin.id, type: "STANDIN", status: "ACTIVE" },
    });
    // A captain and a rostered player with no signup row (legacy imports and
    // repaired seasons): the roster seat is authoritative.
    const captain = await makeUser("Captain");
    const team = await prisma.team.create({
      data: { seasonId: season.id, name: "Team", captainId: captain.id, budget: 100, draftOrder: 1 },
    });
    const rostered = await makeUser("Rostered");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: rostered.id },
    });
    for (const voter of [standin, captain, rostered]) {
      expect(
        await castBallot({ pollId: poll.id, userId: voter.id, availability: [SUN] }),
      ).toMatchObject({ ok: true });
    }
    expect(await prisma.matchNightBallot.count()).toBe(3);
  });

  it("uses the most recent season's signups in the offseason", async () => {
    const poll = await openPoll(admin.id);
    const voter = await makeVoter("Last season");
    await prisma.season.update({ where: { id: season.id }, data: { isActive: false } });
    const older = await makeSeason({ name: "Season 8", isActive: false });
    await prisma.season.update({
      where: { id: older.id },
      data: { createdAt: new Date(season.createdAt.getTime() - DAY) },
    });
    const ancient = await makePlayer(older.id, "Ancient", 3000);
    expect(
      await castBallot({ pollId: poll.id, userId: voter.id, availability: [SUN] }),
    ).toMatchObject({ ok: true });
    expect(
      await castBallot({ pollId: poll.id, userId: ancient.id, availability: [SUN] }),
    ).toEqual(refusal);
  });

  it("stops counting a ballot once its voter withdraws or is removed, and counts it again if they sign back up", async () => {
    const poll = await openPoll(admin.id);
    // Two for Sunday, two for Saturday: Saturday wins only if the two
    // Saturday ballots of players who left keep counting.
    const [a, b, quitter, removed] = await Promise.all(
      ["A", "B", "Quitter", "Removed"].map((name) => makeVoter(name)),
    );
    for (const voter of [a, b]) {
      await castBallot({ pollId: poll.id, userId: voter.id, availability: [SUN] });
    }
    for (const voter of [quitter, removed]) {
      await castBallot({ pollId: poll.id, userId: voter.id, availability: [SAT, SUN] });
    }
    await prisma.registration.updateMany({
      where: { userId: quitter.id },
      data: { status: "WITHDRAWN" },
    });
    await prisma.registration.updateMany({
      where: { userId: removed.id },
      data: { status: "REMOVED" },
    });
    const now = Date.now();
    const seen = await loadHomePoll({ id: admin.id, role: "ADMIN" }, now);
    expect(seen?.ballots).toBe(2);
    // The two who left aren't counted among those who could vote either.
    expect(seen?.electorate?.size).toBe(2);
    expect(seen?.results?.counts[SUN]).toBe(2);
    expect(seen?.results?.counts[SAT]).toBe(0);
    // The player who left sees the poll as any non-voter does: no ballot,
    // no vote, and no count while voting is open.
    expect(await loadHomePoll({ id: quitter.id, role: "USER" }, now)).toMatchObject({
      canVote: false,
      myAvailability: null,
      results: null,
    });
    // The rows are kept: signing up again counts the ballot again.
    expect(await prisma.matchNightBallot.count()).toBe(4);
    await prisma.registration.updateMany({
      where: { userId: quitter.id },
      data: { status: "ACTIVE" },
    });
    const back = await loadHomePoll({ id: quitter.id, role: "USER" }, now);
    expect(back).toMatchObject({ canVote: true, ballots: 3, myAvailability: [SAT, SUN] });
    expect(back?.electorate?.size).toBe(3);
    expect(back?.results?.counts[SAT]).toBe(1);
    // Closing reports the count Home shows, not every stored row.
    expect(await closePollNow({ pollId: poll.id })).toMatchObject({ ok: true, ballots: 3 });
  });

  it("tells Home who votes, and whether this viewer can", async () => {
    const poll = await openPoll(admin.id);
    const voter = await makeVoter("Voter");
    const outsider = await makeUser("Outsider");
    const now = Date.now();
    expect(await loadHomePoll({ id: voter.id, role: "USER" }, now)).toMatchObject({
      canVote: true,
      // The turnout's denominator: the one signed-up player.
      electorate: { seasonName: "Season 10", signupsOpen: true, size: 1 },
    });
    expect(await loadHomePoll({ id: outsider.id, role: "USER" }, now)).toMatchObject({
      canVote: false,
    });
    expect(await loadHomePoll(null, now)).toMatchObject({ canVote: false });
    // An admin without a signup doesn't vote either.
    expect(await loadHomePoll({ id: admin.id, role: "ADMIN" }, now)).toMatchObject({
      canVote: false,
    });
    await prisma.season.update({ where: { id: season.id }, data: { status: "COMPLETE" } });
    expect(await loadHomePoll(null, now)).toMatchObject({
      electorate: { seasonName: "Season 10", signupsOpen: false },
    });
    expect(poll.id).toBeTruthy();
  });
});

describe("what Home shows", () => {
  it("hides the count from a signed-in non-voter while open, and shows it to voters, admins and, once closed, everyone", async () => {
    const poll = await openPoll(admin.id);
    const [a, b, c, outsider] = await Promise.all(
      ["A", "B", "C"].map((name) => makeVoter(name)).concat(makeUser("Outsider")),
    );
    await castBallot({ pollId: poll.id, userId: a.id, availability: [SUN, WED] });
    await castBallot({ pollId: poll.id, userId: b.id, availability: [WED, SUN] });
    await castBallot({ pollId: poll.id, userId: c.id, availability: [SAT, SUN] });

    const now = Date.now();
    const hidden = await loadHomePoll({ id: outsider.id, role: "USER" }, now);
    expect(hidden).toMatchObject({ open: true, ballots: 3, myAvailability: null, results: null });
    expect(await loadHomePoll(null, now)).toMatchObject({ results: null });

    const voter = await loadHomePoll({ id: a.id, role: "USER" }, now);
    // Kept in poll order: Wednesday before Sunday.
    expect(voter?.myAvailability).toEqual([WED, SUN]);
    // All three voters can make Sunday; two can make Wednesday.
    expect(voter?.results?.winner).toBe(SUN);
    expect((await loadHomePoll({ id: admin.id, role: "ADMIN" }, now))?.results).not.toBeNull();

    await closePollNow({ pollId: poll.id });
    const after = await loadHomePoll(null, Date.now());
    expect(after).toMatchObject({ open: false });
    expect(after?.results?.winner).toBe(SUN);
    // A week later the result leaves Home.
    expect(await loadHomePoll(null, Date.now() + 8 * DAY)).toBeNull();
  });
});

describe("admin controls", () => {
  it("opens a poll whose grid fills itself: every day, noon to 6 PM", async () => {
    const result = await createMatchNightPoll(
      null,
      form({
        question: "  When should Season 10 play?  ",
        closesAt: "2030-01-01T20:00",
        closesAtTs: String(Date.now() + 2 * DAY),
        announce: "on",
      }),
    );
    expect(result?.message).toContain(
      "Poll open on Home: Every day, 12 PM–6 PM, on the hour",
    );
    expect(result?.message).toContain("(49 start times)");
    expect(result?.message).toContain("It's announced on Discord.");
    const poll = await prisma.matchNightPoll.findFirstOrThrow();
    expect(poll.question).toBe("When should Season 10 play?");
    const slots = JSON.parse(poll.slots) as { day: number; minute: number }[];
    expect(slots).toHaveLength(49);
    expect(slots[0]).toEqual({ day: 1, minute: 720 });
    expect(slots.at(-1)).toEqual({ day: 0, minute: 1080 });
    expect(sendDiscordMessage).toHaveBeenCalledTimes(1);
    const post = vi.mocked(sendDiscordMessage).mock.calls[0][0];
    expect(post).toContain("Times: Every day, 12 PM–6 PM, on the hour");
    expect(post).toMatch(/\(<t:\d+:t>–<t:\d+:t> in your local time\)/);
    expect(
      await prisma.adminAction.findFirst({ where: { action: "createMatchNightPoll" } }),
    ).not.toBeNull();
  });

  it("opens a narrower grid from the ticked days and hours", async () => {
    const result = await createMatchNightPoll(
      null,
      form({
        daysPosted: "1",
        day: ["6", "0"],
        fromHour: "19",
        toHour: "20",
        closesAt: "x",
        closesAtTs: String(Date.now() + DAY),
      }),
    );
    expect(result?.message).toContain("Sat and Sun, 7 PM–8 PM, on the hour");
    expect(result?.message).toContain("It wasn't posted to Discord.");
    expect(JSON.parse((await prisma.matchNightPoll.findFirstOrThrow()).slots)).toEqual([
      { day: 6, minute: 1140 },
      { day: 6, minute: 1200 },
      { day: 0, minute: 1140 },
      { day: 0, minute: 1200 },
    ]);
  });

  it("refuses a second open poll, a past closing time and an empty grid", async () => {
    await openPoll(admin.id, undefined, "First poll");
    expect(
      await createPoll({
        question: "Second",
        slots: [SUN_18, WED_20],
        closesAt: new Date(Date.now() + DAY),
        createdById: admin.id,
      }),
    ).toEqual({
      ok: false,
      error: '"First poll" is still open. Close it before opening another poll.',
    });
    expect(
      await createMatchNightPoll(
        null,
        form({ daysPosted: "1", closesAtTs: String(Date.now() + DAY), closesAt: "x" }),
      ),
    ).toEqual({ error: "Pick at least one day." });
    await prisma.matchNightPoll.deleteMany();
    expect(
      await createPoll({
        question: "Late",
        slots: [SUN_18, WED_20],
        closesAt: new Date(Date.now() - HOUR),
        createdById: admin.id,
      }),
    ).toEqual({ ok: false, error: "Pick a closing time in the future." });
    expect(await prisma.matchNightPoll.count()).toBe(0);
  });

  it("raced, two admins opening polls leave exactly one open", async () => {
    for (let attempt = 0; attempt < (ON_POSTGRES ? 5 : 1); attempt++) {
      await prisma.matchNightPoll.deleteMany();
      const results = await raceN(3, () =>
        createPoll({
          question: `Race ${attempt}`,
          slots: [SUN_18, WED_20],
          closesAt: new Date(Date.now() + DAY),
          createdById: admin.id,
        }),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(
        await prisma.matchNightPoll.count({
          where: { closesAt: { gt: new Date() } },
        }),
      ).toBe(1);
    }
  });

  it("closes voting once: a second close changes nothing and keeps the recorded time", async () => {
    const poll = await openPoll(admin.id);
    const voter = await makeVoter("Voter");
    await castBallot({ pollId: poll.id, userId: voter.id, availability: [SUN] });
    const first = await closeMatchNightPoll(null, form({ pollId: poll.id }));
    // The toast names the winner, as the admin card's next steps follow it.
    expect(first).toEqual({
      message: expect.stringMatching(
        /^Voting closed with 1 vote\. Sundays at .+ won \(1 can play\)\. The result shows on Home for the next week\.$/,
      ),
    });
    const closedAt = (
      await prisma.matchNightPoll.findUniqueOrThrow({ where: { id: poll.id } })
    ).closesAt;
    expect(
      await closePollNow({ pollId: poll.id, now: new Date(Date.now() + HOUR) }),
    ).toEqual({ ok: false, error: "This poll has already closed." });
    expect(
      (await prisma.matchNightPoll.findUniqueOrThrow({ where: { id: poll.id } }))
        .closesAt,
    ).toEqual(closedAt);
  });

  it("reopens a closed poll with its votes, unless another poll is open", async () => {
    const old = await openPoll(admin.id, undefined, "Old poll");
    const voter = await makeVoter("Voter");
    await castBallot({ pollId: old.id, userId: voter.id, availability: [SUN] });
    await closePollNow({ pollId: old.id });

    const reopened = await setMatchNightPollClosing(
      null,
      form({ pollId: old.id, closesAt: "x", closesAtTs: String(Date.now() + DAY) }),
    );
    expect(reopened?.message).toContain("Voting reopened until");
    expect(await ballotOf(old.id, voter.id)).toEqual([SUN]);

    await closePollNow({ pollId: old.id });
    await openPoll(admin.id, undefined, "New poll");
    expect(
      await setPollClosesAt({ pollId: old.id, closesAt: new Date(Date.now() + DAY) }),
    ).toEqual({
      ok: false,
      error: '"New poll" is still open. Close it before opening another poll.',
    });
  });

  // The other half of createPoll's write-skew pair: the reopen has checked
  // that no other poll is open, then a rival opens one before the reopen
  // writes. Serializable aborts the reopen; its retry sees the rival's poll.
  it.skipIf(!ON_POSTGRES)(
    "a reopen refuses when another poll opens between its check and its write",
    async () => {
      const old = await openPoll(admin.id, undefined, "Old poll");
      await closePollNow({ pollId: old.id });
      let fired = false;
      setRaceHook(
        onceAt("matchNightPoll.setPollClosesAt.afterOpenCheck", async () => {
          fired = true;
          await openPoll(admin.id, undefined, "Rival poll");
        }),
      );
      expect(
        await setPollClosesAt({ pollId: old.id, closesAt: new Date(Date.now() + DAY) }),
      ).toEqual({
        ok: false,
        error: '"Rival poll" is still open. Close it before opening another poll.',
      });
      expect(fired).toBe(true);
      expect(
        await prisma.matchNightPoll.count({ where: { closesAt: { gt: new Date() } } }),
      ).toBe(1);
    },
  );

  it.skipIf(!ON_POSTGRES)(
    "a new poll refuses when an old one reopens between its check and its insert",
    async () => {
      const old = await openPoll(admin.id, undefined, "Old poll");
      await closePollNow({ pollId: old.id });
      let fired = false;
      setRaceHook(
        onceAt("matchNightPoll.createPoll.afterOpenCheck", async () => {
          fired = true;
          expect(
            await setPollClosesAt({ pollId: old.id, closesAt: new Date(Date.now() + DAY) }),
          ).toMatchObject({ ok: true });
        }),
      );
      expect(
        await createPoll({
          question: "New poll",
          slots: [SUN_18, WED_20],
          closesAt: new Date(Date.now() + DAY),
          createdById: admin.id,
        }),
      ).toEqual({
        ok: false,
        error: '"Old poll" is still open. Close it before opening another poll.',
      });
      expect(fired).toBe(true);
      expect(await prisma.matchNightPoll.count()).toBe(1);
    },
  );

  it("announces a closed poll's winner once, and frees the claim when Discord fails", async () => {
    const poll = await openPoll(admin.id);
    const voter = await makeVoter("Voter");
    await castBallot({ pollId: poll.id, userId: voter.id, availability: [SAT] });
    expect(
      await announceMatchNightPollResult(null, form({ pollId: poll.id })),
    ).toEqual({ error: "Voting is still open. Close it first." });
    await closePollNow({ pollId: poll.id });

    vi.mocked(sendDiscordMessage).mockResolvedValueOnce(false);
    expect(
      await announceMatchNightPollResult(null, form({ pollId: poll.id })),
    ).toMatchObject({ error: expect.stringContaining("couldn't be posted") });

    expect(
      await announceMatchNightPollResult(null, form({ pollId: poll.id })),
    ).toEqual({ message: `Announced on Discord: ${label(SAT_17)} won.` });
    expect(vi.mocked(sendDiscordMessage).mock.calls.at(-1)?.[0]).toContain(
      "1 of 1 voters can play then, next on <t:",
    );
    expect(
      await announceMatchNightPollResult(null, form({ pollId: poll.id })),
    ).toEqual({ error: "This result was already announced on Discord." });
    expect(sendDiscordMessage).toHaveBeenCalledTimes(2);
  });

  it("deletes a poll with its ballots only once its question is typed", async () => {
    const poll = await openPoll(admin.id);
    const voter = await makeVoter("Voter");
    await castBallot({ pollId: poll.id, userId: voter.id, availability: [SUN] });
    expect(
      await deleteMatchNightPoll(null, form({ pollId: poll.id, confirmationName: "delete" })),
    ).toEqual({
      error: "Type the poll's question, “When should match night be?”, to confirm deleting it.",
    });
    expect(await prisma.matchNightBallot.count()).toBe(1);
    const confirmed = form({
      pollId: poll.id,
      confirmationName: " When should match night be? ",
    });
    expect(await deleteMatchNightPoll(null, confirmed)).toEqual({
      message: "Deleted the poll and its 1 vote.",
    });
    expect(await prisma.matchNightBallot.count()).toBe(0);
    expect(await deleteMatchNightPoll(null, confirmed)).toEqual({
      error: "This poll was already deleted.",
    });
  });
});
