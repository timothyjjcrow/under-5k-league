import { beforeEach, describe, expect, it, vi } from "vitest";

// setAvailability had ZERO integration coverage (only its pure helpers were
// tested) while being the one mutation every rostered player runs weekly.
// Stub the request-scope bits and drive the real action against the test DB.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(), requireAdmin: vi.fn() }));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { setAvailability } from "@/app/actions/availability";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MATCH_STATUS } from "@/lib/constants";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  sessionFor,
} from "./factories";

function rsvpForm(matchId: string, status: string): FormData {
  const fd = new FormData();
  fd.set("matchId", matchId);
  fd.set("status", status);
  return fd;
}

/** Two rostered teams + one scheduled match; returns a home roster player. */
async function setupMatch() {
  const season = await makeSeason({ teamSize: 3 });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const player = await makeUser("Roster Player");
  await prisma.teamMember.create({
    data: {
      seasonId: season.id,
      teamId: home.id,
      userId: player.id,
      isCaptain: false,
      price: 0,
    },
  });
  const [match] = await generateRegularSchedule(season.id);
  return { season, home, away, match, player };
}

describe("setAvailability", () => {
  beforeEach(() => vi.mocked(requireUser).mockReset());

  it("records a rostered player's RSVP and flips it on resubmit", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
    expect(res?.message).toMatch(/confirmed/i);
    let row = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: player.id } },
    });
    expect(row?.status).toBe("IN");

    const out = await setAvailability({}, rsvpForm(match.id, "OUT"));
    expect(out?.message).toMatch(/unavailable/i);
    row = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: match.id, userId: player.id } },
    });
    expect(row?.status).toBe("OUT");
  });

  it("refuses a non-participant", async () => {
    const { match } = await setupMatch();
    const rando = await makeUser("Rando");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(rando));

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
    expect(res?.error).toMatch(/not playing/i);
  });

  it("refuses a COMPLETED match", async () => {
    const { match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.COMPLETED, homeScore: 2, awayScore: 0 },
    });

    const res = await setAvailability({}, rsvpForm(match.id, "IN"));
    expect(res?.error).toMatch(/already finished/i);
  });

  it("refuses an archived season's match — an RSVP is about the active season", async () => {
    // An OUT here would ping a captain (with a mention) about a fixture nobody
    // is playing; the season turned over and this match is history.
    const { season, match, player } = await setupMatch();
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });

    const res = await setAvailability({}, rsvpForm(match.id, "OUT"));
    expect(res?.error).toMatch(/archived season/i);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });
});
