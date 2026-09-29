// The one way the season-scoped pages (Leaders, Hero meta, Pick'em, Fantasy)
// decide which season they show, what they say in link previews, and which
// seasons their picker offers. Each page used to carry its own copy of all
// three, including a "No active season" screen that listed archived seasons
// as buttons instead of showing one.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Season } from "@prisma/client";
import { prisma } from "./prisma";
import { getActiveSeason } from "./season";
import { shareMetadata } from "./share-metadata";
import { singleSearchParam } from "./search-params";
import { seasonSwitcherChoices, type SeasonChoice } from "./season-choices";

/**
 * The season a season-scoped page shows. `?season=<id>` wins, and an unknown
 * id is a 404, never a quiet fallback: that would show one season's data
 * under another season's link. Without a param it is the active season, and
 * with no active season (the league between seasons) the most recent one, so
 * the page opens on that season's boards instead of an empty screen. Null
 * only when the league has no seasons at all.
 *
 * `seasonParam` is the already-normalized value (singleSearchParam), so each
 * page still rejects a repeated key itself.
 */
export async function resolveSeasonScope(
  seasonParam: string | undefined,
): Promise<Season | null> {
  if (seasonParam) {
    const season = await prisma.season.findUnique({
      where: { id: seasonParam },
    });
    if (!season) notFound();
    return season;
  }
  return (await getActiveSeason()) ?? (await latestSeason());
}

/** The most recently created season, active or not. */
export function latestSeason(): Promise<Season | null> {
  return prisma.season.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/** What counts as "this season has something to show" on each page. */
export type SeasonDataKind = "games" | "predictions" | "fantasy";

async function seasonIdsWithData(kind: SeasonDataKind): Promise<Set<string>> {
  const rows =
    kind === "fantasy"
      ? await prisma.fantasyRoster.groupBy({ by: ["seasonId"] })
      : await prisma.match.groupBy({
          by: ["seasonId"],
          where:
            kind === "games"
              ? { games: { some: {} } }
              : { predictions: { some: {} } },
        });
  return new Set(rows.map((row) => row.seasonId));
}

/**
 * The seasons a page's picker offers (see seasonSwitcherChoices): those with
 * data of the page's kind, the season being viewed and the current season.
 */
export async function loadSeasonChoices(
  kind: SeasonDataKind,
  selectedId: string,
): Promise<SeasonChoice[]> {
  const [seasons, withData] = await Promise.all([
    prisma.season.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, name: true, isActive: true },
    }),
    seasonIdsWithData(kind),
  ]);
  return seasonSwitcherChoices(
    seasons.map((season) => ({ ...season, hasData: withData.has(season.id) })),
    { selectedId },
  );
}

/**
 * Link-preview metadata for a season-scoped page. The bare address (and a
 * link to the current season) shares the page's own title; an archived
 * season's link names that season and keeps its ?season= as the canonical
 * address. A repeated or unknown season is a 404, the same as the page.
 */
export async function seasonScopeMetadata(
  rawSeason: string | string[] | undefined,
  page: {
    path: string;
    title: string;
    description: string;
    archived: (seasonName: string) => { title: string; description: string };
  },
): Promise<Metadata> {
  const seasonId = singleSearchParam(rawSeason);
  if (seasonId === null) notFound();
  const generic = () => shareMetadata(page.title, page.description, page.path);
  if (!seasonId) return generic();
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    select: { name: true, isActive: true },
  });
  if (!season) notFound();
  if (season.isActive) return generic();
  const { title, description } = page.archived(season.name);
  return shareMetadata(
    title,
    description,
    `${page.path}?${new URLSearchParams({ season: seasonId })}`,
  );
}
