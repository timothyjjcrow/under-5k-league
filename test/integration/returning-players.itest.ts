import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { loadReturningPlayers } from "@/lib/returning-players-service";
import { makePlayer, makeSeason, makeUser, resetDb } from "./factories";

beforeEach(resetDb);

async function signUp(seasonId: string, userId: string, status = "ACTIVE") {
  await prisma.registration.create({
    data: { seasonId, userId, type: "PLAYER", status, mmr: 3000, roles: "" },
  });
}

describe("loadReturningPlayers", () => {
  it("counts last season's players who are back and lists who isn't", async () => {
    const last = await makeSeason({
      name: "Season 1",
      status: "COMPLETE",
      isActive: false,
    });
    const back = await makePlayer(last.id, "Back", 3000);
    const away = await makePlayer(last.id, "Away", 3000);
    const withdrew = await makePlayer(last.id, "Withdrew now", 3000);
    const removedNow = await makePlayer(last.id, "Removed now", 3000);
    const removedThen = await makeUser("Removed last season");
    await signUp(last.id, removedThen.id, "REMOVED");
    await prisma.user.update({
      where: { id: away.id },
      data: { discordId: "123456789012345678" },
    });
    // Created after Season 1, so Season 1 is "last season".
    const current = await makeSeason({ name: "Season 2" });
    await signUp(current.id, back.id);
    // Anyone who withdrew or was removed this season made their own choice.
    await signUp(current.id, withdrew.id, "WITHDRAWN");
    await signUp(current.id, removedNow.id, "REMOVED");
    const fresh = await makePlayer(current.id, "New this season", 3000);

    const result = await loadReturningPlayers(current.id);
    expect(result).toEqual({
      previousSeasonName: "Season 1",
      // A signup removed last season isn't counted as last season's player.
      previous: 4,
      back: 1,
      notBack: [{ name: "Away", discordId: "123456789012345678" }],
    });
    expect(fresh.id).toBeTruthy();
  });

  it("has nothing to compare against in a league's first season", async () => {
    const first = await makeSeason({ name: "Season 1" });
    expect(await loadReturningPlayers(first.id)).toBeNull();
  });
});
