import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { proposeReschedule } from "@/app/actions/reschedule";
import { getSessionUser, requireUser } from "@/lib/auth";
import { SEASON_STATUS } from "@/lib/constants";
import { sendDiscordMessage } from "@/lib/discord";
import { prisma } from "@/lib/prisma";
import { makeCaptain, makeSeason, makeUser, resetDb, sessionFor } from "./factories";

const DAY = 24 * 60 * 60 * 1000;

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

let linked = 0;
async function withDiscord<T extends { id: string }>(user: T): Promise<T & { discordId: string }> {
  linked += 1;
  // An 18-digit snowflake-shaped id (no bigint literal: tsconfig is ES2017).
  const discordId = `1${String(linked).padStart(17, "0")}`;
  await prisma.user.update({ where: { id: user.id }, data: { discordId } });
  return { ...user, discordId };
}

/** The users the last post was allowed to ping. */
function lastPingedUsers(): string[] {
  const calls = vi.mocked(sendDiscordMessage).mock.calls;
  const allow = calls[calls.length - 1]?.[1] as { users?: string[] } | undefined;
  return [...(allow?.users ?? [])].sort();
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(sendDiscordMessage).mockReset();
  vi.mocked(sendDiscordMessage).mockResolvedValue(true);
});

// A ready check pinged every seat on both sides on every proposal: two
// captains trading offers rang nine phones each time. The first proposal of
// a kickoff still pings everyone; re-proposals ping only the other captain
// until the window passes or a lock moves the kickoff.
describe("ready-check pings", () => {
  it("rings the rosters once per kickoff, then only the other captain", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const home = await makeCaptain(season.id, "Home Cap", 100, 0);
    const away = await makeCaptain(season.id, "Away Cap", 100, 1);
    const proposer = await withDiscord(home.user);
    const otherCaptain = await withDiscord(away.user);
    const players = [];
    for (const [teamId, name] of [
      [home.team.id, "Home P"],
      [away.team.id, "Away P"],
    ] as const) {
      const user = await withDiscord(await makeUser(name));
      await prisma.teamMember.create({
        data: { seasonId: season.id, teamId, userId: user.id, price: 10 },
      });
      players.push(user);
    }
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: "REGULAR",
        homeTeamId: home.team.id,
        awayTeamId: away.team.id,
        scheduledAt: new Date(Date.now() + 2 * DAY),
      },
    });
    const session = sessionFor({ ...proposer, role: "USER" });
    vi.mocked(requireUser).mockResolvedValue(session);
    vi.mocked(getSessionUser).mockResolvedValue(session);
    const propose = (days: number) =>
      proposeReschedule(
        null,
        form({ matchId: match.id, optionTs: String(Date.now() + days * DAY) }),
      );
    const everyone = [otherCaptain, ...players].map((u) => u.discordId).sort();

    expect(await propose(3)).toMatchObject({ ok: true });
    expect(lastPingedUsers()).toEqual(everyone);

    // A counter-offer within the window: only the captain who owes an answer.
    expect(await propose(4)).toMatchObject({ ok: true });
    expect(lastPingedUsers()).toEqual([otherCaptain.discordId]);

    // A lock moves the kickoff (a new schedule revision): the next check is a
    // fresh question for everyone.
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduleRevision: { increment: 1 } },
    });
    expect(await propose(5)).toMatchObject({ ok: true });
    expect(lastPingedUsers()).toEqual(everyone);
  });
});
