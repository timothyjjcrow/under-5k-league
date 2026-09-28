import { prisma } from "./prisma";
import { createPublicSnapshot } from "./public-cache";
import { seasonTeamHues, teamHueStyleSheet } from "./team-hues";

// Every team's id, season and creation time: all a season's crest hues need.
// Public and tiny, so it shares the 60-second public snapshot cache; a team
// created in the meantime shows its fallback hue until the next refresh.
const getTeamHueRows = createPublicSnapshot("team-hues-v1", async () => {
  const rows = await prisma.team.findMany({
    select: { id: true, seasonId: true, createdAt: true },
  });
  // Cached values are JSON: keep the time as a number.
  return rows.map(({ createdAt, ...row }) => ({
    ...row,
    createdAtMs: createdAt.getTime(),
  }));
});

/** The crest-hue stylesheet the root layout publishes for every page. */
export async function getTeamHueStyleSheet(): Promise<string> {
  return teamHueStyleSheet(seasonTeamHues(await getTeamHueRows(null)));
}
