import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
const CHANGE_KEYS = ["resultChangedAt", "publicGameRevision"];
test.use({ actionTimeout: 10_000 });
test.afterAll(async () => { await db.$disconnect(); });

type Fixture = {
  seasonId: string; seasonName: string; matchId: string; homeId: string; homeName: string;
  awayId: string; awayName: string; users: { id: string; steamId: string; name: string; role: string }[];
  teamSize: number; gameId: string; oldName: string;
};

async function withFixture(request: APIRequestContext, history: boolean, run: (fixture: Fixture) => Promise<void>) {
  const suffix = randomUUID();
  const prefix = `lineup-browser-${suffix}`;
  const label = suffix.slice(0, 6);
  const active = await db.season.findFirstOrThrow({ where: { isActive: true } });
  const seasonId = history ? `${prefix}-season` : active.id;
  const seasonName = history ? `Participation history ${label}` : active.name;
  const teamSize = history ? 5 : active.teamSize;
  const homeId = `${prefix}-home`, awayId = `${prefix}-away`, matchId = `${prefix}-match`, gameId = `${prefix}-game`;
  const homeName = `Lineup Home ${label}`, awayName = `Lineup Away ${label}`, oldName = `Original purchase ${label}`;
  const users = Array.from({ length: teamSize * 2 + 2 }, (_, i) => ({
    id: `${prefix}-user-${i}`, steamId: `76561190000992${String(i).padStart(3, "0")}`,
    name: `Lineup ${label} player ${i + 1}`, role: i === teamSize * 2 + 1 ? "ADMIN" : "USER",
  }));
  const savedSettings = await db.setting.findMany({ where: { key: { in: CHANGE_KEYS } } });
  try {
    await db.$transaction(async (tx) => {
      if (history) await tx.season.create({ data: { id: seasonId, name: seasonName, isActive: false, status: "COMPLETE", teamSize, championTeamId: homeId } });
      await tx.user.createMany({ data: users });
      await tx.team.createMany({ data: [
        { id: homeId, seasonId, name: homeName, captainId: users[0].id },
        { id: awayId, seasonId, name: awayName, captainId: users[teamSize].id },
      ] });
      await tx.registration.createMany({ data: users.slice(0, teamSize * 2 + 1).map((user, i) => ({ seasonId, userId: user.id, mmr: 2800, roles: "4,5", type: i === teamSize * 2 ? "STANDIN" : "PLAYER" })) });
      await tx.teamMember.createMany({ data: users.slice(0, teamSize * 2).filter((_, i) => !history || i !== 1).map((user) => {
        const i = users.indexOf(user);
        return { seasonId, teamId: i < teamSize ? homeId : awayId, userId: user.id, isCaptain: i === 0 || i === teamSize };
      }) });
      await tx.match.create({ data: { id: matchId, seasonId, homeTeamId: homeId, awayTeamId: awayId, week: 98, bestOf: 3,
        status: history ? "COMPLETED" : "SCHEDULED", scheduledAt: new Date(Date.now() + 86400_000),
        ...(history ? { homeScore: 2, awayScore: 0, winnerTeamId: homeId } : {}),
      } });
      if (!history) {
        await tx.matchAvailability.createMany({ data: users.slice(0, teamSize * 2).filter((_, i) => i !== teamSize - 1).map((user) => ({ matchId, userId: user.id, status: "IN", scheduleRevision: 0 })) });
      } else {
        const players = users.slice(0, teamSize * 2).map((user, i) => ({ userId: user.id, teamId: i < teamSize ? homeId : awayId,
          accountId: 290000000 + i, heroId: i + 1, isRadiant: i < teamSize, kills: 5, deaths: 2, assists: 10, gpm: 500, netWorth: 15000, lastHits: 200,
        }));
        await tx.game.create({ data: { id: gameId, matchId, dotaMatchId: "9900019201", radiantWin: true,
          durationSecs: 2400, startTime: Math.floor(Date.now() / 1000) - 86400, radiantTeamId: homeId, direTeamId: awayId,
          winnerTeamId: homeId, players: JSON.stringify(players), participantSource: JSON.stringify(players), participantVersion: 1, participantComplete: true,
          participants: { create: players.map((player, sourceLineIndex) => ({ ...player, sourceLineIndex })) },
        } });
        const draft = await tx.draftRun.create({ data: { seasonId, runNumber: 1, provenance: "COMMAND", status: "COMPLETE", startedAt: new Date(), endedAt: new Date(),
          poolSnapshot: JSON.stringify({ privateMarker: prefix }), openingTeamsSnapshot: JSON.stringify({ privateMarker: prefix }),
        } });
        const lot = await tx.draftLot.create({ data: { runId: draft.id, sequence: 1, provenance: "COMMAND", openingKind: "MANUAL", nominatedUserId: users[1].id,
          nomineeSnapshot: JSON.stringify({ version: 1, name: oldName }), nominatorSnapshot: JSON.stringify({ version: 1, name: homeName }),
          acceptedBidsSnapshot: JSON.stringify({ version: 1, provenance: "COMMAND", bids: [{ bidId: `${prefix}-bid`, teamId: homeId, teamName: homeName, amount: 47, at: new Date().toISOString() }] }),
          status: "SOLD", soldTeamId: homeId, soldTeamNameSnapshot: homeName, soldPrice: 47, soldAt: new Date(),
        } });
        await tx.rosterTenure.create({ data: { seasonId, teamId: homeId, userId: users[1].id, sourceMembershipId: `${prefix}-released-membership`,
          joinedAt: new Date(Date.now() - 7 * 86400_000), endedAt: new Date(), closedAt: new Date(), startProvenance: "COMMAND", endProvenance: "COMMAND",
          acquisitionKind: "AUCTION", acquisitionPrice: 47, playerNameSnapshot: oldName, teamNameSnapshot: homeName, draftLotId: lot.id,
        } });
      }
    });
    expect((await request.post("/api/test/cache")).ok()).toBe(true);
    await run({ seasonId, seasonName, matchId, homeId, homeName, awayId, awayName, users, teamSize, gameId, oldName });
  } finally {
    await db.$transaction(async (tx) => {
      await tx.adminAction.deleteMany({ where: { actorId: { in: users.map((user) => user.id) } } });
      await tx.setting.deleteMany({ where: { key: { startsWith: `outPing:${matchId}:` } } });
      if (history) await tx.season.deleteMany({ where: { id: seasonId } });
      else {
        await tx.match.deleteMany({ where: { id: matchId } });
        await tx.team.deleteMany({ where: { id: { in: [homeId, awayId] } } });
      }
      await tx.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    });
    try { expect((await request.post("/api/test/cache")).ok()).toBe(true); }
    finally {
      await db.$transaction(async (tx) => {
        await tx.setting.deleteMany({ where: { key: { in: CHANGE_KEYS } } });
        if (savedSettings.length) await tx.setting.createMany({ data: savedSettings });
      });
    }
  }
}

async function login(page: Page, user: Fixture["users"][number], path: string) {
  const params = new URLSearchParams({ steamId: user.steamId, name: user.name, redirect: path });
  if (user.role === "ADMIN") params.set("admin", "1");
  await page.goto(`/api/auth/dev?${params}`);
}

// This deliberately exercises existing production actions through their real
// forms. Direct writes only establish suite-owned starting states (incl LIVE).
test("players check in, captains confirm, and midseries cover keeps earlier lineup facts private and intact", async ({ page, request, browser }) => {
  test.setTimeout(90_000);
  await withFixture(request, false, async (f) => {
    const noErrors = trackPageErrors(page);
    const path = `/matches/${f.matchId}`;
    await login(page, f.users[0], path);
    const own = () => page.getByRole("region", { name: `${f.homeName} playing lineup`, exact: true });
    await expect(own().getByRole("checkbox")).toHaveCount(f.teamSize);
    await expect(own().getByRole("button", { name: "Confirm playing lineup" })).toBeDisabled();
    await expect(own()).toContainText(`${f.users[f.teamSize - 1].name} · Awaiting check-in`);

    await login(page, f.users[f.teamSize - 1], path);
    await page.getByRole("button", { name: "✓ I'm in", exact: true }).click();
    await expect(page.getByText("You're confirmed ✓ — change it here if plans shift.", { exact: true })).toBeVisible();
    await login(page, f.users[0], path);
    await expect(own().getByRole("combobox")).toHaveCount(0);
    await own().getByRole("button", { name: "Confirm playing lineup" }).click();
    await expect(own()).toContainText("Confirmed · revision 1");
    const original = await db.matchLineup.findFirstOrThrow({ where: { matchId: f.matchId, teamId: f.homeId }, include: { seats: true } });
    expect(original.seats).toHaveLength(f.teamSize);
    expect(original.seats.filter((seat) => seat.position != null)).toHaveLength(0);

    const publicContext = await browser.newContext();
    try {
      const publicPage = await publicContext.newPage();
      const response = await publicPage.goto(`http://localhost:3212${path}`);
      const publicPlan = publicPage.getByRole("region", { name: "Playing lineups", exact: true });
      await expect(publicPlan).toContainText(f.users[0].name);
      await expect(publicPlan.getByRole("checkbox")).toHaveCount(0);
      await expect(publicPlan).not.toContainText("Checked in");
      await expect(publicPlan).not.toContainText("Awaiting check-in");
      expect(await response!.text()).not.toContain("availabilityAt");
    } finally { await publicContext.close(); }

    await db.match.update({ where: { id: f.matchId }, data: { status: "LIVE" } });
    await page.reload();
    await expect(page.getByRole("button", { name: "✓ Ready for the next game", exact: true })).toHaveCount(1);
    const firstGamePlayers = JSON.stringify(f.users.slice(0, f.teamSize * 2).map((user, i) => ({
      userId: user.id, teamId: i < f.teamSize ? f.homeId : f.awayId, accountId: 290000000 + i,
      heroId: i + 1, isRadiant: i < f.teamSize, kills: 5, deaths: 2, assists: 10, gpm: 500, netWorth: 15000, lastHits: 200,
    })));
    await db.game.create({ data: { id: f.gameId, matchId: f.matchId, dotaMatchId: "9900019202", radiantWin: true,
      durationSecs: 2400, startTime: Math.floor(Date.now() / 1000), radiantTeamId: f.homeId, direTeamId: f.awayId,
      winnerTeamId: f.homeId, players: firstGamePlayers,
    } });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Game 1", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "✓ Ready for the next game", exact: true })).toHaveCount(1);
    await page.getByRole("combobox", { name: "Standin to bring in", exact: true }).selectOption(f.users[f.teamSize * 2].id);
    await page.getByRole("combobox", { name: "Player they cover", exact: true }).selectOption(f.users[1].id);
    await page.getByRole("button", { name: "Assign standin", exact: true }).click();
    await expect(own()).toContainText("Previous plan superseded");
    await login(page, f.users[f.teamSize * 2], path);
    await page.getByRole("button", { name: "✓ Ready for the next game", exact: true }).click();
    await expect(page.getByText("You're ready for the remaining games ✓ — change it here if plans shift.", { exact: true })).toBeVisible();
    await login(page, f.users[0], path);
    await expect(own()).toContainText("offer acceptance is unknown");
    await own().getByRole("button", { name: "Confirm playing lineup" }).click();
    await expect(own()).toContainText("Confirmed · revision 2");
    const replacement = await db.matchLineup.findFirstOrThrow({ where: { matchId: f.matchId, teamId: f.homeId, activeKey: { not: null } }, include: { seats: true } });
    expect(replacement.seats.some((seat) => seat.userId === f.users[f.teamSize * 2].id && seat.acceptanceStatusSnapshot === "UNKNOWN")).toBe(true);
    expect(replacement.seats.every((seat) => seat.position == null)).toBe(true);
    expect(await db.matchLineupSeat.findMany({ where: { lineupId: original.id }, orderBy: { id: "asc" } })).toEqual([...original.seats].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await db.matchLineup.findUniqueOrThrow({ where: { id: original.id } })).supersededAt).not.toBeNull();
    expect((await db.game.findUniqueOrThrow({ where: { id: f.gameId } })).players).toBe(firstGamePlayers);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await own().scrollIntoViewIfNeeded();
      await expectNoHorizontalOverflow(page, `playing lineup at ${width}px`);
    }
    noErrors();
  });
});

test("former players retain actual appearances and auction receipts while identity correction stays admin-only", async ({ page, request }) => {
  test.setTimeout(90_000);
  await withFixture(request, true, async (f) => {
    const noErrors = trackPageErrors(page);
    await page.goto(`/players/${f.users[1].id}`);
    await expect(page.getByRole("heading", { name: "Seasons played", exact: true })).toBeVisible();
    await expect(page.getByText("1 games · 1 map wins", { exact: true })).toBeVisible();
    await expect(page.getByText("1–0–0 series", { exact: true })).toBeVisible();
    await expect(page.getByText("🏆 Championship contribution", { exact: true })).toBeVisible();
    await expect(page.getByText(/Original auction purchase: \$47/)).toBeVisible();
    expect(await db.teamMember.count({ where: { userId: f.users[1].id } })).toBe(0);

    await page.goto(`/seasons/${f.seasonId}`);
    await expect(page.getByRole("heading", { name: "Auction history", exact: true })).toBeVisible();
    await page.getByText("View 1 recorded nominations", { exact: true }).click();
    await expect(page.getByRole("link", { name: f.oldName, exact: true })).toBeVisible();
    await expect(page.getByText("$47 ·", { exact: false })).toBeVisible();
    await page.getByText("1 accepted bids", { exact: true }).click();
    await expect(page.getByText(`${f.homeName}: $47`, { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain("privateMarker");

    await page.goto("/hall-of-fame");
    await expect(page.getByRole("heading", { name: "🏆 Championship contributions", exact: true })).toBeVisible();
    await page.goto(`/matches/${f.matchId}`);
    await expect(page.getByText("Correct player attribution · Admin", { exact: true })).toHaveCount(0);
    await login(page, f.users[1], `/matches/${f.matchId}`);
    await expect(page.getByText("Correct player attribution · Admin", { exact: true })).toHaveCount(0);
    await login(page, f.users[f.teamSize * 2 + 1], `/matches/${f.matchId}`);
    await page.getByText("Correct player attribution · Admin", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Save attribution correction", exact: true })).toHaveCount(f.teamSize * 2);
    await page.setViewportSize({ width: 390, height: 900 });
    await expectNoHorizontalOverflow(page, "admin attribution at 390px");
    noErrors();
  });
});
