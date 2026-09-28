/**
 * Captains edit their own team's name and logo (Tim's call: all season until
 * it is complete, no approval step), admins can edit any team from the team
 * page or /admin, and every change is logged and announced.
 *
 * Authorization lives in ONE place — the captainId in saveTeamIdentity's
 * write — so the raced test at the bottom is what proves it: the captaincy
 * moves between the page render and the save, and the outgoing captain must
 * not rename a team that is no longer theirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { updateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getSessionUser, requireAdmin, requireUser } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import { editTeamIdentity } from "@/app/actions/teams";
import { addCaptain, renameTeam } from "@/app/actions/admin";
import { saveTeamIdentity } from "@/lib/team-identity-service";
import { teamNameKey } from "@/lib/team-identity";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { SEASON_STATUS } from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  raceAll,
  resetDb,
  sessionFor,
} from "./factories";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};
const empty: ActionResult = {};

type Actor = Awaited<ReturnType<typeof makeUser>>;
function signIn(user: Actor | null) {
  if (user) vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
  else vi.mocked(requireUser).mockRejectedValue(new Error("UNAUTHORIZED"));
}

async function league(status: string = SEASON_STATUS.REGULAR_SEASON) {
  const season = await makeSeason({ status });
  const home = await makeCaptain(season.id, "Zai", 100, 0);
  const away = await makeCaptain(season.id, "Fear", 100, 1);
  return { season, home, away };
}

const teamRow = (id: string) =>
  prisma.team.findUniqueOrThrow({
    where: { id },
    select: { name: true, logoUrl: true, captainId: true },
  });

beforeEach(async () => {
  await resetDb();
  vi.mocked(sendDiscordMessage).mockClear();
  vi.mocked(updateTag).mockClear();
});
afterEach(() => setRaceHook(null));

describe("editTeamIdentity — the captain's own team page", () => {
  it("lets the captain rename their team and set a logo, then logs and announces it", async () => {
    const { season, home } = await league();
    signIn(home.user);

    const res = await editTeamIdentity(
      empty,
      fd({
        teamId: home.team.id,
        name: "  Radiant   Raccoons ",
        logoUrl: "https://cdn.example/raccoon.png",
      }),
    );

    expect(res).toEqual({ message: "Saved Radiant Raccoons" });
    expect(await teamRow(home.team.id)).toMatchObject({
      name: "Radiant Raccoons",
      logoUrl: "https://cdn.example/raccoon.png",
    });
    const log = await prisma.adminAction.findMany();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: "renameTeam",
      actorId: home.user.id,
      actorName: "Zai",
      seasonId: season.id,
    });
    expect(log[0].summary).toBe(
      `Renamed team "Zai's Team" → "Radiant Raccoons" with a custom logo (as captain)`,
    );
    expect(vi.mocked(sendDiscordMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDiscordMessage).mock.calls[0][0]).toContain(
      "**Zai's Team** is now **Radiant Raccoons**, with a new logo",
    );
    // Record snapshots embed team names.
    expect(vi.mocked(updateTag)).toHaveBeenCalledWith("games");
  });

  it("is open from signups onward, before a single match", async () => {
    const { home } = await league(SEASON_STATUS.SIGNUPS);
    signIn(home.user);
    const res = await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Early Birds" }),
    );
    expect(res?.error).toBeUndefined();
    expect((await teamRow(home.team.id)).name).toBe("Early Birds");
  });

  it("refuses another team's captain and a plain player, changing nothing", async () => {
    const { season, home, away } = await league();
    const player = await makeUser("Just A Player");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: player.id, type: "PLAYER", status: "ACTIVE", mmr: 3000 },
    });

    for (const intruder of [away.user, player]) {
      signIn(intruder);
      const res = await editTeamIdentity(
        empty,
        fd({ teamId: home.team.id, name: "Hijacked", logoUrl: "https://cdn.example/x.png" }),
      );
      expect(res?.error).toMatch(/Only this team's captain or an admin/);
    }
    expect(await teamRow(home.team.id)).toMatchObject({
      name: "Zai's Team",
      logoUrl: null,
    });
    expect(await prisma.adminAction.count()).toBe(0);
    expect(vi.mocked(sendDiscordMessage)).not.toHaveBeenCalled();
  });

  it("asks a signed-out visitor to sign in", async () => {
    const { home } = await league();
    signIn(null);
    const res = await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Nope" }),
    );
    expect(res?.error).toBe("Sign in required");
    expect((await teamRow(home.team.id)).name).toBe("Zai's Team");
  });

  it("lets an admin edit any team from its page, logged without the captain tag", async () => {
    const { home } = await league();
    const admin = await makeUser("Tim", "ADMIN");
    signIn(admin);
    const res = await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "My Team Sucks" }),
    );
    expect(res?.error).toBeUndefined();
    expect((await teamRow(home.team.id)).name).toBe("My Team Sucks");
    const [log] = await prisma.adminAction.findMany();
    expect(log).toMatchObject({ actorId: admin.id, actorName: "Tim" });
    expect(log.summary).toBe(`Renamed team "Zai's Team" → "My Team Sucks"`);
  });

  it("refuses once the season is complete, and on an archived season's team", async () => {
    const complete = await league(SEASON_STATUS.COMPLETE);
    signIn(complete.home.user);
    expect(
      (
        await editTeamIdentity(
          empty,
          fd({ teamId: complete.home.team.id, name: "Too Late" }),
        )
      )?.error,
    ).toMatch(/season is complete/);

    await prisma.season.update({
      where: { id: complete.season.id },
      data: { isActive: false, status: SEASON_STATUS.REGULAR_SEASON },
    });
    expect(
      (
        await editTeamIdentity(
          empty,
          fd({ teamId: complete.home.team.id, name: "Too Late" }),
        )
      )?.error,
    ).toMatch(/archived/);
    expect((await teamRow(complete.home.team.id)).name).toBe("Zai's Team");
    expect(vi.mocked(sendDiscordMessage)).not.toHaveBeenCalled();
  });

  it("refuses an expiring Discord attachment link with a way forward", async () => {
    const { home } = await league();
    signIn(home.user);
    const res = await editTeamIdentity(
      empty,
      fd({
        teamId: home.team.id,
        name: "Radiant Raccoons",
        logoUrl: "https://cdn.discordapp.com/attachments/1/2/logo.png?ex=66f00000&is=66ee0000&hm=abc&",
      }),
    );
    expect(res?.error).toMatch(/Discord image links stop working/);
    expect(await teamRow(home.team.id)).toMatchObject({
      name: "Zai's Team",
      logoUrl: null,
    });
  });

  it("refuses a logo that points at one of the site's own endpoints", async () => {
    const { home } = await league();
    signIn(home.user);
    for (const logoUrl of [
      "/api/auth/discord",
      "https://ggd2l.example/api/admin/season-export?seasonId=x",
    ]) {
      const res = await editTeamIdentity(
        empty,
        fd({ teamId: home.team.id, name: "Radiant Raccoons", logoUrl }),
      );
      expect(res?.error).toMatch(/image file/);
    }
    expect(await teamRow(home.team.id)).toMatchObject({
      name: "Zai's Team",
      logoUrl: null,
    });
    expect(vi.mocked(sendDiscordMessage)).not.toHaveBeenCalled();
  });

  it("refuses a name another team in the season already uses", async () => {
    const { home, away } = await league();
    signIn(away.user);
    const res = await editTeamIdentity(
      empty,
      fd({ teamId: away.team.id, name: "  zai's   TEAM " }),
    );
    expect(res?.error).toBe(
      "Another team is already called zai's TEAM. Pick a different name.",
    );
    expect((await teamRow(away.team.id)).name).toBe("Fear's Team");
    expect((await teamRow(home.team.id)).name).toBe("Zai's Team");
  });

  it("sees through invisible characters, and refuses a name that shows nothing", async () => {
    const { home, away } = await league();
    signIn(away.user);
    const lookAlike = await editTeamIdentity(
      empty,
      fd({ teamId: away.team.id, name: "Zai's\u200B Team\u2060" }),
    );
    expect(lookAlike?.error).toBe(
      "Another team is already called Zai's Team. Pick a different name.",
    );
    const blank = await editTeamIdentity(
      empty,
      fd({ teamId: away.team.id, name: "\u200B\u3164\u2800" }),
    );
    expect(blank?.error).toBe("Enter a team name");
    expect((await teamRow(away.team.id)).name).toBe("Fear's Team");
    expect((await teamRow(home.team.id)).name).toBe("Zai's Team");
    expect(vi.mocked(sendDiscordMessage)).not.toHaveBeenCalled();
  });

  it("keeps a name on one line", async () => {
    const { home } = await league();
    signIn(home.user);
    await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Radiant\nRaccoons\t" }),
    );
    expect((await teamRow(home.team.id)).name).toBe("Radiant Raccoons");
  });

  it("leaves the log and Discord alone when nothing changed", async () => {
    const { home } = await league();
    signIn(home.user);
    const res = await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Zai's Team", logoUrl: "" }),
    );
    expect(res).toEqual({ message: "Saved Zai's Team" });
    expect(await prisma.adminAction.count()).toBe(0);
    expect(vi.mocked(sendDiscordMessage)).not.toHaveBeenCalled();
  });

  it("announces a logo-only change under the current name", async () => {
    const { home } = await league();
    signIn(home.user);
    await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Zai's Team", logoUrl: "/teams/zai.png" }),
    );
    expect(vi.mocked(sendDiscordMessage).mock.calls[0][0]).toMatch(
      /^🎨 \*\*Zai's Team\*\* has a new logo: </,
    );
    const [log] = await prisma.adminAction.findMany();
    expect(log.summary).toBe(`Set "Zai's Team" to a custom logo (as captain)`);
  });

  it("announces every rename, and a captain's logo-only changes at most once per window, logging every one", async () => {
    const { home } = await league();
    signIn(home.user);

    const first = await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Radiant Raccoons" }),
    );
    expect(first).toEqual({ message: "Saved Radiant Raccoons" });
    // A second rename inside the window is announced too: every rename is.
    const second = await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Dire Raccoons", logoUrl: "https://cdn.example/d.png" }),
    );
    expect(second).toEqual({ message: "Saved Dire Raccoons" });
    expect(vi.mocked(sendDiscordMessage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendDiscordMessage).mock.calls[1][0]).toContain(
      "**Radiant Raccoons** is now **Dire Raccoons**",
    );
    // A logo-only change inside the window is saved and logged, not posted.
    const third = await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Dire Raccoons", logoUrl: "https://cdn.example/e.png" }),
    );
    expect(third).toEqual({
      message:
        "Saved Dire Raccoons. Discord already heard about a change to this team in the last 15 minutes, so this logo change wasn't posted there.",
    });
    expect((await teamRow(home.team.id)).logoUrl).toBe("https://cdn.example/e.png");
    expect(vi.mocked(sendDiscordMessage)).toHaveBeenCalledTimes(2);
    expect(await prisma.adminAction.count()).toBe(3);

    // An admin's edit is never held back.
    const admin = await makeUser("Tim", "ADMIN");
    signIn(admin);
    await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Dire Raccoons", logoUrl: "https://cdn.example/f.png" }),
    );
    expect(vi.mocked(sendDiscordMessage)).toHaveBeenCalledTimes(3);

    // Once the window has passed, the captain's next logo change posts again.
    await prisma.setting.update({
      where: { key: `teamIdentityPing:${home.team.id}` },
      data: { value: new Date(Date.now() - 16 * 60_000).toISOString() },
    });
    signIn(home.user);
    const later = await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Dire Raccoons", logoUrl: "https://cdn.example/g.png" }),
    );
    expect(later).toEqual({ message: "Saved Dire Raccoons" });
    expect(vi.mocked(sendDiscordMessage)).toHaveBeenCalledTimes(4);
  });

  it("refuses the outgoing captain when captaincy moves mid-save", async () => {
    const { season, home } = await league();
    const incoming = await makeUser("Incoming");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: home.team.id, userId: incoming.id, isCaptain: false, price: 5 },
    });
    signIn(home.user);
    let fired = false;
    setRaceHook(
      onceAt("teamIdentity.save.beforeTx", async () => {
        fired = true;
        // The rival: an admin transfers the captaincy after the outgoing
        // captain opened the form and before their save lands.
        await prisma.team.update({
          where: { id: home.team.id },
          data: { captainId: incoming.id },
        });
      }),
    );

    const res = await editTeamIdentity(
      empty,
      fd({ teamId: home.team.id, name: "Not Yours Anymore" }),
    );

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/Only this team's captain or an admin/);
    expect((await teamRow(home.team.id)).name).toBe("Zai's Team");
    expect(await prisma.adminAction.count()).toBe(0);
  });
});

describe("renameTeam — the admin override on /admin", () => {
  it("logs the old name and announces the rename on Discord", async () => {
    const { season, home } = await league();
    const admin = await makeUser("Tim", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    vi.mocked(getSessionUser).mockResolvedValue(sessionFor(admin));

    const res = await renameTeam(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        teamId: home.team.id,
        name: "My Team Sucks",
      }),
    );

    expect(res).toEqual({ message: "Saved My Team Sucks" });
    const [log] = await prisma.adminAction.findMany();
    expect(log).toMatchObject({ action: "renameTeam", actorId: admin.id });
    expect(log.summary).toBe(`Renamed team "Zai's Team" → "My Team Sucks"`);
    expect(vi.mocked(sendDiscordMessage).mock.calls[0][0]).toContain(
      "**Zai's Team** is now **My Team Sucks**",
    );
  });

  it("refuses a Discord attachment logo too", async () => {
    const { season, home } = await league();
    const admin = await makeUser("Tim", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    const res = await renameTeam(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        teamId: home.team.id,
        name: "Zai's Team",
        logoUrl: "https://media.discordapp.net/attachments/1/2/logo.png?ex=1",
      }),
    );
    expect(res?.error).toMatch(/Discord image links stop working/);
    expect((await teamRow(home.team.id)).logoUrl).toBeNull();
  });
});

describe("saveTeamIdentity — two captains racing to one name", () => {
  // The uniqueness check reads the OTHER teams and writes this one, so two
  // renames to the same name are a write-skew pair: only the Serializable
  // transaction stops both committing. Staging one rename first proves
  // nothing (the read-time check catches it), so this races them.
  // `npm run test:pg` is what runs it concurrently; SQLite runs it in turn.
  it("gives the name to exactly one of them", async () => {
    for (let round = 0; round < 5; round += 1) {
      await resetDb();
      const { home, away } = await league();
      const name = "Radiant Raccoons";
      const results = await raceAll([
        () =>
          saveTeamIdentity({
            editor: { userId: home.user.id, isAdmin: false },
            teamId: home.team.id,
            name,
          }),
        () =>
          saveTeamIdentity({
            editor: { userId: away.user.id, isAdmin: false },
            teamId: away.team.id,
            name: "  radiant RACCOONS ",
          }),
      ]);
      const names = [
        (await teamRow(home.team.id)).name,
        (await teamRow(away.team.id)).name,
      ];
      expect(
        names.filter((saved) => teamNameKey(saved) === teamNameKey(name)),
        `round ${round}: ${names.join(" / ")}`,
      ).toHaveLength(1);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    }
  });
});

describe("addCaptain — a returning captain keeps their team's identity", () => {
  async function asAdmin() {
    const admin = await makeUser("Tim", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    vi.mocked(getSessionUser).mockResolvedValue(sessionFor(admin));
  }

  /** Last season, archived, with `captain` captaining a team called `name`. */
  async function pastTeam(
    captainId: string,
    name: string,
    logoUrl: string | null,
    seasonName = "Last season",
  ) {
    const past = await makeSeason({
      name: seasonName,
      status: SEASON_STATUS.COMPLETE,
      isActive: false,
    });
    return prisma.team.create({
      data: { seasonId: past.id, name, logoUrl, captainId, budget: 100, draftOrder: 0 },
    });
  }

  const designate = (seasonId: string, userId: string) =>
    addCaptain(empty, fd({ expectedActiveSeasonId: seasonId, userId }));

  const newTeamOf = (seasonId: string, captainId: string) =>
    prisma.team.findUniqueOrThrow({
      where: { seasonId_captainId: { seasonId, captainId } },
      select: { name: true, logoUrl: true },
    });

  it("starts the new team with last season's name and logo, and says so", async () => {
    await asAdmin();
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const zai = await makePlayer(season.id, "Zai", 4000);
    await pastTeam(zai.id, "Radiant Raccoons", "https://cdn.example/raccoon.png");

    const res = await designate(season.id, zai.id);

    expect(res).toEqual({
      message:
        "Zai is now a captain. Their team keeps last time's name, Radiant Raccoons, and its logo.",
    });
    expect(await newTeamOf(season.id, zai.id)).toEqual({
      name: "Radiant Raccoons",
      logoUrl: "https://cdn.example/raccoon.png",
    });
    expect(vi.mocked(sendDiscordMessage).mock.calls[0][0]).toContain(
      "you now captain Radiant Raccoons",
    );
    const [log] = await prisma.adminAction.findMany({ where: { action: "addCaptain" } });
    expect(log.summary).toBe(
      `Designated Zai as captain of "Radiant Raccoons" (kept from their last team)`,
    );
  });

  it("uses the most recent of several past teams", async () => {
    await asAdmin();
    const zai = await makeUser("Zai");
    // Created newest-first on purpose: the season's own start decides.
    const newer = await pastTeam(zai.id, "Newer Name", null, "Season 2");
    const older = await pastTeam(zai.id, "Old Name", null, "Season 1");
    await prisma.season.update({
      where: { id: older.seasonId },
      data: { createdAt: new Date("2025-01-01T00:00:00Z") },
    });
    await prisma.season.update({
      where: { id: newer.seasonId },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    await prisma.registration.create({
      data: { seasonId: season.id, userId: zai.id, type: "PLAYER", status: "ACTIVE", mmr: 4000 },
    });

    await designate(season.id, zai.id);

    expect((await newTeamOf(season.id, zai.id)).name).toBe("Newer Name");
  });

  it("never hands another captain's team identity to a new captain", async () => {
    await asAdmin();
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const zai = await makePlayer(season.id, "Zai", 4000);
    const fear = await makePlayer(season.id, "Fear", 4000);
    const old = await pastTeam(zai.id, "Radiant Raccoons", "https://cdn.example/raccoon.png");
    // Fear played on Zai's team last season but never captained it.
    await prisma.teamMember.create({
      data: { seasonId: old.seasonId, teamId: old.id, userId: fear.id, isCaptain: false, price: 10 },
    });

    const res = await designate(season.id, fear.id);

    expect(res).toEqual({ message: "Fear is now a captain" });
    expect(await newTeamOf(season.id, fear.id)).toEqual({
      name: "Fear's Team",
      logoUrl: null,
    });
  });

  // Captain B renamed their team "Alice's Team" before the admin made Alice
  // a captain: two teams would have shared one name.
  it("numbers the default name past one another team already uses", async () => {
    await asAdmin();
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const other = await makeCaptain(season.id, "Other", 100, 0);
    await prisma.team.update({
      where: { id: other.team.id },
      data: { name: "alice's team" },
    });
    const alice = await makePlayer(season.id, "Alice", 4000);

    const res = await designate(season.id, alice.id);

    expect(res?.error).toBeUndefined();
    expect((await newTeamOf(season.id, alice.id)).name).toBe("Alice's Team 2");
  });

  it("keeps the default name when the old one is taken this season, but keeps the logo", async () => {
    await asAdmin();
    const season = await makeSeason({ status: SEASON_STATUS.SIGNUPS });
    const other = await makeCaptain(season.id, "Other", 100, 0);
    await prisma.team.update({
      where: { id: other.team.id },
      data: { name: "Radiant Raccoons" },
    });
    const zai = await makePlayer(season.id, "Zai", 4000);
    await pastTeam(zai.id, "Radiant Raccoons", "https://cdn.example/raccoon.png");

    const res = await designate(season.id, zai.id);

    expect(res?.message).toBe(
      "Zai is now a captain. Their team keeps its logo from last time.",
    );
    expect(await newTeamOf(season.id, zai.id)).toEqual({
      name: "Zai's Team",
      logoUrl: "https://cdn.example/raccoon.png",
    });
  });
});
