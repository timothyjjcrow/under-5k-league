import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, SEASON_STATUS } from "@/lib/constants";
import { maybeAnnounceUpcomingWeek } from "@/lib/reminder-service";
import { markAnnouncementFailed } from "@/lib/announcement-marker";
import { SETTING_KEYS, setSetting, weekReminderKey } from "@/lib/settings";
import { LEAGUE_ANNOUNCEMENT_STATUS } from "@/lib/league-announcement-outbox";
import { makeSeason, makeTeam, makeUser } from "./factories";

// The week reminder end to end: the real service, the durable outbox and
// HTTP to a stand-in for Discord. A 14-team night is seven fixtures at one
// kickoff with up to seventy players owing a check-in, more than one post can
// carry, and one post used to list four fixtures and ping nobody in the rest.

type Posted = { content: string; users: string[]; parse: unknown };

let server: Server;
let base: string;
let posted: Posted[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      posted.push({
        content: body.content,
        users: body.allowed_mentions?.users ?? [],
        parse: body.allowed_mentions?.parse,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "1379001234567890123" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  delete process.env.VERCEL_ENV;
  posted = [];
  await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, `${base}/api/webhooks/1111/tok-secret`);
});

/** Fourteen teams of five, seven fixtures at one kickoff, nobody answered. */
async function fourteenTeamNight() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const kickoff = new Date(Date.now() + 4 * 3600_000);
  const discordIds: string[] = [];
  const matchIds: string[] = [];
  const teams = [];
  for (let t = 0; t < 14; t += 1) {
    const team = await makeTeam(season.id, `Team ${String(t + 1).padStart(2, "0")} With A Long Name`, t);
    teams.push(team);
    for (let p = 0; p < 5; p += 1) {
      const user = await makeUser(`Player ${t + 1}-${p + 1}`);
      const discordId = (BigInt("800000000000000000") + BigInt(t * 10 + p)).toString();
      await prisma.user.update({ where: { id: user.id }, data: { discordId } });
      await prisma.teamMember.create({
        data: { seasonId: season.id, teamId: team.id, userId: user.id, price: 0 },
      });
      discordIds.push(discordId);
    }
  }
  for (let t = 0; t < 14; t += 2) {
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: teams[t].id,
        awayTeamId: teams[t + 1].id,
        scheduledAt: kickoff,
      },
    });
    matchIds.push(match.id);
  }
  return { season, kickoff, discordIds, matchIds };
}

describe("week reminder posts (end to end)", () => {
  it("posts a 14-team night in numbered parts that ping every waiting player once", async () => {
    const { season, kickoff, discordIds, matchIds } = await fourteenTeamNight();

    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);

    expect(posted.length).toBeGreaterThan(1);
    posted.forEach((post, index) => {
      expect(post.content.length).toBeLessThanOrEqual(2_000);
      expect(post.parse).toEqual([]);
      expect(post.users.length).toBeLessThanOrEqual(100);
      // Each part allowlists exactly the players it shows.
      const visible = [...post.content.matchAll(/<@(\d{17,20})>/g)].map((m) => m[1]);
      expect(new Set(post.users)).toEqual(new Set(visible));
      expect(post.content.split("\n")[0]).toMatch(
        index === 0
          ? new RegExp(`^⏰ \\*\\*Week 1 matches coming up — check in!\\*\\* \\(1/${posted.length}\\)$`)
          : new RegExp(`^⏰ \\*\\*Week 1 matches, continued\\*\\* \\(${index + 1}/${posted.length}\\)$`),
      );
    });
    const pinged = posted.flatMap((post) => post.users);
    expect(pinged).toHaveLength(discordIds.length);
    expect(new Set(pinged)).toEqual(new Set(discordIds));
    const all = posted.map((post) => post.content).join("\n");
    for (const matchId of matchIds) {
      expect(all.split(`/matches/${matchId}>`).length - 1).toBe(1);
    }

    // One outbox row per part, delivered, under the one claim.
    const markerKey = weekReminderKey(season.id, 1, kickoff.getTime());
    const rows = await prisma.leagueAnnouncement.findMany({
      where: { markerKey },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows).toHaveLength(posted.length);
    expect(rows.map((row) => row.status)).toEqual(
      rows.map(() => LEAGUE_ANNOUNCEMENT_STATUS.SENT),
    );
    expect(new Set(rows.map((row) => row.markerEventId)).size).toBe(1);
    rows.slice(1).forEach((row, index) => {
      expect(row.dedupeKey).toBe(`${rows[0].dedupeKey}:${index + 2}`);
    });
    const marker = await prisma.setting.findUnique({ where: { key: markerKey } });
    expect(marker?.value).toMatch(/^sent:/);
  });

  it("a retry after a part failed to queue sends only the missing parts", async () => {
    const { season, kickoff } = await fourteenTeamNight();
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    const firstRun = posted.map((post) => post.content);
    expect(firstRun.length).toBeGreaterThan(1);

    // As if every part from the second on had failed to queue: their rows
    // never existed, and the claim was stamped failed with its event id.
    const markerKey = weekReminderKey(season.id, 1, kickoff.getTime());
    const rows = await prisma.leagueAnnouncement.findMany({
      where: { markerKey },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    await prisma.leagueAnnouncement.deleteMany({
      where: { id: { in: rows.slice(1).map((row) => row.id) } },
    });
    const marker = await prisma.setting.findUniqueOrThrow({ where: { key: markerKey } });
    expect(
      await markAnnouncementFailed({
        key: markerKey,
        value: marker.value,
        eventId: rows[0].markerEventId!,
      }),
    ).toBe(true);

    posted = [];
    expect(await maybeAnnounceUpcomingWeek(season)).toBe(true);
    // Part 1 was already delivered under the same event id, so the retry
    // finds its row and sends only the rest, in order.
    expect(posted.map((post) => post.content)).toEqual(firstRun.slice(1));
    expect(
      await prisma.leagueAnnouncement.count({ where: { markerKey } }),
    ).toBe(firstRun.length);
  });
});
