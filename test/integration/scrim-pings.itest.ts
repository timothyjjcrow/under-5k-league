/**
 * Scrim pings go to the people who have to act, and only them: every other
 * active captain when a time is posted, the posting captain when it is
 * claimed, and the captain(s) who didn't cancel a booking. The claim's toast
 * and ping also say which overlapping open times the booking withdrew.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { requireUser } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import type { ActionResult } from "@/lib/action-result";
import { SEASON_STATUS } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import {
  cancelScrim as cancelScrimAction,
  createScrim as createScrimAction,
  joinScrim as joinScrimAction,
} from "@/app/actions/scrims";
import { createScrim, joinScrim } from "@/lib/scrim-service";
import { makeCaptain, makeSeason, makeUser, sessionFor } from "./factories";

const empty: ActionResult = {};
const HOUR = 60 * 60 * 1000;
const NIGHT = () => new Date(Date.now() + 3 * 24 * HOUR);

function fd(values: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  return form;
}

async function league(count = 3) {
  const season = await makeSeason({
    status: SEASON_STATUS.REGULAR_SEASON,
    teamSize: 5,
  });
  const captains = [];
  for (let index = 0; index < count; index += 1) {
    const captain = await makeCaptain(
      season.id,
      `Captain ${index + 1}`,
      100,
      index,
    );
    const discordId = `90000000000000000${index + 1}`;
    await prisma.user.update({
      where: { id: captain.user.id },
      data: { discordId },
    });
    captains.push({ ...captain, discordId });
  }
  return { season, captains };
}

function actAs(user: { id: string; steamId: string; name: string; role: string }) {
  vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
}

function sends() {
  return vi.mocked(sendDiscordMessage).mock.calls;
}

function mentioned(call: ReturnType<typeof sends>[number]) {
  return [...(call[1]?.users ?? [])].sort();
}

beforeEach(() => {
  vi.mocked(sendDiscordMessage).mockClear();
});

describe("scrim pings (integration)", () => {
  it("pings every other active captain when a time is posted", async () => {
    const { captains } = await league(4);
    const [poster, other, third, withdrawn] = captains;
    await prisma.team.update({
      where: { id: withdrawn.team.id },
      data: { withdrawn: true },
    });
    const night = NIGHT();
    actAs(poster.user);

    const result = await createScrimAction(
      empty,
      fd({ scheduledAt: "picked", scheduledAtTs: String(night.getTime()) }),
    );

    expect(result?.ok).toBe(true);
    expect(sends()).toHaveLength(1);
    const [content] = sends()[0];
    expect(content).toContain(`**${poster.team.name}** posted a scrim time`);
    expect(content).toContain(`<t:${Math.floor(night.getTime() / 1000)}:F>`);
    expect(mentioned(sends()[0])).toEqual(
      [other.discordId, third.discordId].sort(),
    );
  });

  it("still reports a committed post as posted when the ping list can't be read", async () => {
    const { season, captains } = await league(3);
    const [poster] = captains;
    const night = NIGHT();
    actAs(poster.user);
    const realFindMany = prisma.team.findMany.bind(prisma.team);
    let failed = false;
    // Fail only the post-commit "other captains" read (the one that
    // excludes the host team); every other team read goes through.
    const read = vi
      .spyOn(prisma.team, "findMany")
      .mockImplementation(((args: Parameters<typeof prisma.team.findMany>[0]) => {
        const where = args?.where as { id?: { not?: string } } | undefined;
        if (where?.id?.not === poster.team.id) {
          failed = true;
          return Promise.reject(
            new Error("connect failed: postgresql://league:hunter2@db.internal/ld2l"),
          );
        }
        return realFindMany(args);
      }) as unknown as typeof prisma.team.findMany);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await createScrimAction(
        empty,
        fd({ scheduledAt: "picked", scheduledAtTs: String(night.getTime()) }),
      );

      expect(failed).toBe(true);
      expect(result?.ok).toBe(true);
      expect(result?.error).toBeUndefined();
      expect(
        await prisma.scrim.count({
          where: { seasonId: season.id, hostTeamId: poster.team.id },
        }),
      ).toBe(1);
      expect(sends()).toHaveLength(0);
      expect(logged).toHaveBeenCalledWith("[scrims] SCRIM_PING_LIST_FAILED");
      expect(JSON.stringify(logged.mock.calls.map(String))).not.toContain(
        "hunter2",
      );
    } finally {
      read.mockRestore();
      logged.mockRestore();
    }
  });

  it("pings only the posting captain on a claim, and says what the booking withdrew", async () => {
    const { captains } = await league(3);
    const [host, joiner, bystander] = captains;
    const night = NIGHT();
    const hostOther = new Date(night.getTime() + 2 * HOUR);
    const offer = await createScrim(host.user.id, night, 3);
    await createScrim(host.user.id, hostOther, 1);
    await createScrim(joiner.user.id, new Date(night.getTime() + HOUR), 1);
    // Outside the window: stays open and is never reported.
    await createScrim(host.user.id, new Date(night.getTime() + 6 * HOUR), 1);
    await createScrim(bystander.user.id, new Date(night.getTime() + HOUR), 1);
    vi.mocked(sendDiscordMessage).mockClear();
    actAs(joiner.user);

    const result = await joinScrimAction(empty, fd({ scrimId: offer.id }));

    expect(result?.ok).toBe(true);
    expect(result?.message).toBe(
      `Scrim booked. Captain 1 (${host.team.name}) hosts and will send you the lobby details on Discord. ` +
        "Your other open time within four hours of it was withdrawn. " +
        `${host.team.name}'s other open time within four hours of it was withdrawn.`,
    );
    expect(sends()).toHaveLength(1);
    const [content] = sends()[0];
    expect(content).toContain(`**${joiner.team.name}** claimed your scrim time`);
    expect(content).toContain("You host");
    expect(content).toContain("**Captain 2**");
    expect(content).toContain(
      `Your other open time within four hours (<t:${Math.floor(hostOther.getTime() / 1000)}:f>) was withdrawn.`,
    );
    expect(content).toContain(`/scrims/${offer.id}>`);
    expect(mentioned(sends()[0])).toEqual([host.discordId]);
  });

  it("pings the other captain on a cancel, both on an admin cancel, and nobody for your own open time", async () => {
    const { captains } = await league(2);
    const [host, opponent] = captains;
    const night = NIGHT();

    const booked = await createScrim(host.user.id, night, 1);
    await joinScrim(opponent.user.id, booked.id);
    vi.mocked(sendDiscordMessage).mockClear();
    actAs(opponent.user);
    expect(
      (await cancelScrimAction(empty, fd({ scrimId: booked.id })))?.ok,
    ).toBe(true);
    expect(sends()).toHaveLength(1);
    expect(sends()[0][0]).toContain(
      `**Captain 2** cancelled the **${host.team.name}** vs **${opponent.team.name}** scrim on`,
    );
    expect(mentioned(sends()[0])).toEqual([host.discordId]);

    const second = await createScrim(host.user.id, new Date(night.getTime() + 24 * HOUR), 1);
    await joinScrim(opponent.user.id, second.id);
    const admin = await makeUser("League Admin", "ADMIN");
    vi.mocked(sendDiscordMessage).mockClear();
    actAs(admin);
    expect(
      (await cancelScrimAction(empty, fd({ scrimId: second.id })))?.ok,
    ).toBe(true);
    expect(sends()).toHaveLength(1);
    expect(sends()[0][0]).toContain("An admin cancelled the");
    expect(mentioned(sends()[0])).toEqual(
      [host.discordId, opponent.discordId].sort(),
    );

    const ownOpen = await createScrim(host.user.id, new Date(night.getTime() + 48 * HOUR), 1);
    vi.mocked(sendDiscordMessage).mockClear();
    actAs(host.user);
    expect(
      (await cancelScrimAction(empty, fd({ scrimId: ownOpen.id })))?.ok,
    ).toBe(true);
    expect(sends()).toHaveLength(0);
  });
});
