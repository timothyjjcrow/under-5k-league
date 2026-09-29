import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getDraftState } from "@/lib/draft-service";
import { DRAFT_STATUS, SEASON_STATUS } from "@/lib/constants";
import { DRAFT_PRESENCE } from "@/lib/draft-presence";
import {
  readCaptainPresence,
  recordCaptainPresence,
} from "@/lib/draft-presence-service";
import { draftPresenceKey } from "@/lib/settings";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  resetDb,
  startDraftState,
} from "./factories";

// "In the room" for draft captains: the tick route records a captain's poll
// (throttled through claimThrottle), and getDraftState reads it back onto each
// team as captainInRoom while the waiting room is open or the auction runs.

beforeEach(async () => {
  await resetDb();
});

async function twoCaptainSeason(status: string = SEASON_STATUS.DRAFT) {
  const season = await makeSeason({ teamSize: 3, status });
  const a = await makeCaptain(season.id, "Captain A", 100, 0);
  const b = await makeCaptain(season.id, "Captain B", 100, 1);
  await makePlayer(season.id, "Player 1", 3000);
  await makePlayer(season.id, "Player 2", 2900);
  return { season, a, b };
}

function inRoom(
  state: Awaited<ReturnType<typeof getDraftState>>,
  teamId: string,
) {
  return state?.teams.find((t) => t.id === teamId)?.captainInRoom;
}

describe("draft presence — who is in the room", () => {
  it("marks only the captains whose polls were recorded, in the waiting room", async () => {
    const { season, a, b } = await twoCaptainSeason();
    await recordCaptainPresence(season.id, a.user.id);

    const state = await getDraftState(season.id, null);
    expect(inRoom(state, a.team.id)).toBe(true);
    expect(inRoom(state, b.team.id)).toBe(false);
  });

  it("keeps showing presence once the auction is live", async () => {
    const { season, a, b } = await twoCaptainSeason();
    await startDraftState(season.id);
    await recordCaptainPresence(season.id, b.user.id);

    const state = await getDraftState(season.id, null, {
      resolveDeadlines: false,
    });
    expect(state?.status).toBe(DRAFT_STATUS.IN_PROGRESS);
    expect(inRoom(state, a.team.id)).toBe(false);
    expect(inRoom(state, b.team.id)).toBe(true);
  });

  it("counts a captain away once their last poll is older than the window", async () => {
    const { season, a } = await twoCaptainSeason();
    const stale = new Date(
      Date.now() - (DRAFT_PRESENCE.AWAY_SECONDS + 5) * 1000,
    ).toISOString();
    await prisma.setting.create({
      data: { key: draftPresenceKey(season.id, a.user.id), value: stale },
    });

    const state = await getDraftState(season.id, null);
    expect(inRoom(state, a.team.id)).toBe(false);
  });

  it("a fresh poll brings an away captain back", async () => {
    const { season, a } = await twoCaptainSeason();
    const stale = new Date(
      Date.now() - (DRAFT_PRESENCE.AWAY_SECONDS + 5) * 1000,
    ).toISOString();
    await prisma.setting.create({
      data: { key: draftPresenceKey(season.id, a.user.id), value: stale },
    });

    await recordCaptainPresence(season.id, a.user.id);
    const state = await getDraftState(season.id, null);
    expect(inRoom(state, a.team.id)).toBe(true);
  });

  it("writes at most once per throttle window", async () => {
    const { season, a } = await twoCaptainSeason();
    const key = draftPresenceKey(season.id, a.user.id);
    const t0 = Date.now();

    await recordCaptainPresence(season.id, a.user.id, t0);
    const first = await prisma.setting.findUnique({ where: { key } });
    expect(first?.value).toBe(new Date(t0).toISOString());

    // Polls inside the window leave the stored time alone.
    await recordCaptainPresence(season.id, a.user.id, t0 + 5_000);
    await recordCaptainPresence(
      season.id,
      a.user.id,
      t0 + (DRAFT_PRESENCE.WRITE_SECONDS - 1) * 1000,
    );
    expect((await prisma.setting.findUnique({ where: { key } }))?.value).toBe(
      first?.value,
    );

    // The first poll after it moves the time forward.
    const later = t0 + (DRAFT_PRESENCE.WRITE_SECONDS + 1) * 1000;
    await recordCaptainPresence(season.id, a.user.id, later);
    expect((await prisma.setting.findUnique({ where: { key } }))?.value).toBe(
      new Date(later).toISOString(),
    );
  });

  it("stops reporting presence once the draft is complete", async () => {
    const { season, a } = await twoCaptainSeason();
    await startDraftState(season.id);
    await prisma.draft.update({
      where: { seasonId: season.id },
      data: {
        status: DRAFT_STATUS.COMPLETE,
        nominatorTeamId: null,
        nominationEndsAt: null,
      },
    });
    await recordCaptainPresence(season.id, a.user.id);

    const state = await getDraftState(season.id, null, {
      resolveDeadlines: false,
    });
    expect(state?.status).toBe(DRAFT_STATUS.COMPLETE);
    for (const team of state?.teams ?? []) {
      expect(team.captainInRoom).toBeNull();
    }
  });

  it("keeps each season's presence separate", async () => {
    const { season, a } = await twoCaptainSeason();
    const other = await makeSeason({ isActive: false, name: "Old Season" });
    await recordCaptainPresence(other.id, a.user.id);

    const here = await readCaptainPresence(prisma, season.id, [a.user.id]);
    expect(here.has(a.user.id)).toBe(false);
    const there = await readCaptainPresence(prisma, other.id, [a.user.id]);
    expect(there.has(a.user.id)).toBe(true);
  });
});
