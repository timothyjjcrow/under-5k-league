// What each link preview picture shows (the opengraph-image routes beside the
// match, team, player and season pages), read from the database. Every rule
// here is a tested pure function shared with the pages or the preview text
// (og-image.ts, link-preview.ts, player-card.ts, playoff-status.ts,
// standings); the drawing is src/components/og-card.tsx. Crests and avatars
// come through fetchOgImage's allowlist, and one that can't be fetched is
// drawn as initials.

import { seedsFromFirstRound } from "./bracket-view";
import { resolveChampionPresentation } from "./champion-presentation";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import {
  loadMatchPreviewFacts,
  loadPlayerCardFacts,
} from "./link-preview-metadata";
import { seriesWinnerSide } from "./link-preview";
import { fetchOgImage, loadRankMedal } from "./og-assets";
import {
  capNames,
  fitPictureFacts,
  matchCardStatus,
  playerPictureText,
  type InhouseNightCardData,
  type MatchCardData,
  type PlayerCardData,
  type SeasonCardData,
  type TeamCardData,
} from "./og-image";
import { projectPlayoffField } from "./playoff-field";
import { playoffStatusChip, playoffStatuses } from "./playoff-status";
import { prisma } from "./prisma";
import { rankMedalName } from "./rank";
import { seasonPhaseLabel } from "./season-copy";
import { ordinalPlace } from "./tale-of-the-tape";
import { seriesRecordText } from "./team-matches";
import { hashHue, seasonTeamHues } from "./team-hues";
import { formatLeagueTime } from "./zoned-time";
import {
  currentInhouseNight,
  inhouseNightHeadcountText,
  inhouseNightPhase,
} from "./inhouse-night";
import {
  inhouseNightHeadcountFor,
  readInhouseNightRsvps,
} from "./inhouse-night-rsvp-service";
import { readInhouseNight } from "./inhouse-night-service";
import { leagueMatchTimeParts } from "./match-time";

/**
 * A season's crest hues, the colours its pages paint (the root layout's
 * stylesheet spaces every season's teams around the wheel the same way).
 */
async function seasonHues(seasonId: string): Promise<(teamId: string) => number> {
  const teams = await prisma.team.findMany({
    where: { seasonId },
    select: { id: true, seasonId: true, createdAt: true },
  });
  const hues = seasonTeamHues(
    teams.map(({ createdAt, ...team }) => ({
      ...team,
      createdAtMs: createdAt.getTime(),
    })),
  );
  return (teamId) => hues.get(teamId) ?? hashHue(teamId);
}

/** A fixture's picture: both teams, the round, and the kickoff, score or result. */
export async function loadMatchCard(
  id: string,
  nowMs: number,
): Promise<MatchCardData | null> {
  const facts = await loadMatchPreviewFacts(id);
  if (!facts) return null;
  const { match, round } = facts;
  const [hue, homeLogo, awayLogo] = await Promise.all([
    seasonHues(match.seasonId),
    fetchOgImage(match.homeTeam.logoUrl),
    fetchOgImage(match.awayTeam.logoUrl),
  ]);
  const names = { home: match.homeTeam.name, away: match.awayTeam.name };
  const completed = match.status === MATCH_STATUS.COMPLETED;
  const started =
    completed ||
    match.status === MATCH_STATUS.LIVE ||
    match.homeScore + match.awayScore > 0;
  return {
    seasonName: match.season.name,
    round,
    grandFinal: match.phase === MATCH_PHASE.FINAL,
    home: { name: names.home, hue: hue(match.homeTeamId), logo: homeLogo },
    away: { name: names.away, hue: hue(match.awayTeamId), logo: awayLogo },
    score: started ? { home: match.homeScore, away: match.awayScore } : null,
    winner: completed ? seriesWinnerSide(match) : null,
    status: matchCardStatus(
      match,
      names,
      match.scheduledAt ? formatLeagueTime(match.scheduledAt) : null,
      nowMs,
    ),
  };
}

/**
 * A team's picture: its crest and name, its season in a few chips (the
 * champion's title, the record, the table place or playoff seed, where its
 * playoff run stands) and the roster, captain first.
 */
export async function loadTeamCard(
  id: string,
  nowMs: number,
): Promise<TeamCardData | null> {
  const team = await prisma.team.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      withdrawn: true,
      seasonId: true,
      captainId: true,
      captain: { select: { name: true } },
      season: {
        select: { name: true, status: true, championTeamId: true },
      },
      members: {
        select: { userId: true, user: { select: { name: true } } },
        orderBy: [{ price: "desc" }, { id: "asc" }],
      },
    },
  });
  if (!team) return null;
  const [teams, matches, logo, hue] = await Promise.all([
    prisma.team.findMany({
      where: { seasonId: team.seasonId },
      select: { id: true, withdrawn: true },
    }),
    prisma.match.findMany({ where: { seasonId: team.seasonId } }),
    fetchOgImage(team.logoUrl),
    seasonHues(team.seasonId),
  ]);

  // The team page's own rules: the champion as public pages may name it,
  // the seed once a bracket exists, else the table place once a result does.
  const { championTeamId } = resolveChampionPresentation(team.season, matches);
  const postseason =
    team.season.status === SEASON_STATUS.PLAYOFFS ||
    team.season.status === SEASON_STATUS.COMPLETE;
  const standings = projectPlayoffField(teams, matches).standings;
  const rank = standings.findIndex((row) => row.teamId === id) + 1;
  const row = standings[rank - 1];
  const played = matches.some((m) => m.status === MATCH_STATUS.COMPLETED);
  const seed = postseason
    ? seedsFromFirstRound(
        matches.filter(
          (m) => m.phase === MATCH_PHASE.PLAYOFF || m.phase === MATCH_PHASE.FINAL,
        ),
      ).get(id)
    : undefined;
  const playoff = postseason
    ? (playoffStatuses(teams, matches, championTeamId, nowMs).get(id) ?? null)
    : null;

  const facts: string[] = [];
  if (played && row) facts.push(seriesRecordText(row));
  if (seed) facts.push(`Seed ${seed}`);
  else if (played && rank > 0) facts.push(`${ordinalPlace(rank)} of ${teams.length}`);
  if (playoff && playoff.kind !== "champion") facts.push(playoffStatusChip(playoff));
  if (team.withdrawn && playoff?.kind !== "missed") facts.push("Withdrawn");

  return {
    seasonName: team.season.name,
    team: { name: team.name, hue: hue(team.id), logo },
    facts,
    goldFact: championTeamId === team.id ? "Champion" : null,
    captain: team.captain.name,
    roster: capNames(
      team.members
        .filter((member) => member.userId !== team.captainId)
        .map((member) => member.user.name),
      5,
    ),
  };
}

/**
 * A player's picture: their profile's season card (loadPlayerCardFacts), with
 * their avatar, the team crest in that season's colour and the medal drawn
 * from the site's own medal pictures. Null when there is no such player;
 * "unjoined" for an account that only signed in, whose preview stays the
 * league's own picture.
 */
export async function loadPlayerCard(
  id: string,
): Promise<PlayerCardData | "unjoined" | null> {
  const player = await loadPlayerCardFacts(id);
  if (player === null || player === "unjoined") return player;
  const { card } = player;
  // The team is the card's season's (never a later roster's), so its colour
  // is that season's too.
  const [avatar, teamLogo, hue, medal] = await Promise.all([
    fetchOgImage(player.avatar),
    card.team ? fetchOgImage(card.team.logoUrl) : null,
    card.team && card.season ? seasonHues(card.season.id) : null,
    loadRankMedal(card.rankTier),
  ]);
  const text = playerPictureText(card);
  const team =
    card.team && hue
      ? { name: card.team.name, hue: hue(card.team.id), logo: teamLogo }
      : null;
  const medalName = medal ? rankMedalName(card.rankTier) : null;
  return {
    name: player.name,
    avatar,
    seasonLine: text.seasonLine,
    team,
    medal: medal && medalName ? { ...medal, name: medalName } : null,
    titles: text.titles,
    // As many facts as the frame has room for beside a long name.
    facts: fitPictureFacts({
      name: player.name,
      hasTeam: team !== null,
      titles: text.titles,
      medal: medalName,
      facts: text.facts,
    }),
  };
}

/**
 * A season's picture: its name, where it is (the phase, or complete), its
 * size, and the champion's crest once the title is confirmed.
 */
export async function loadSeasonCard(id: string): Promise<SeasonCardData | null> {
  const season = await prisma.season.findUnique({
    where: { id },
    select: { name: true, status: true, isActive: true, championTeamId: true },
  });
  if (!season) return null;
  const [teams, postseason, games] = await Promise.all([
    prisma.team.findMany({
      where: { seasonId: id },
      select: { id: true, name: true, logoUrl: true },
    }),
    prisma.match.findMany({
      where: {
        seasonId: id,
        phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
      },
      select: {
        id: true,
        phase: true,
        bracketSlot: true,
        status: true,
        winnerTeamId: true,
        homeTeamId: true,
        awayTeamId: true,
      },
    }),
    prisma.game.count({ where: { match: { seasonId: id } } }),
  ]);
  const { championTeamId } = resolveChampionPresentation(season, postseason);
  const champion = teams.find((team) => team.id === championTeamId) ?? null;
  const [logo, hue] = champion
    ? await Promise.all([fetchOgImage(champion.logoUrl), seasonHues(id)])
    : [null, null];
  const complete = season.status === SEASON_STATUS.COMPLETE;
  return {
    seasonName: season.name,
    kicker: season.isActive ? "Current season" : "Season archive",
    facts: [
      complete
        ? "Season complete"
        : season.isActive
          ? seasonPhaseLabel(season.status)
          : "Archived season",
      ...(teams.length > 0 ? [`${teams.length} teams`] : []),
      ...(games > 0 ? [`${games} ${games === 1 ? "game" : "games"} played`] : []),
    ],
    champion:
      champion && hue
        ? { name: champion.name, hue: hue(champion.id), logo }
        : null,
  };
}

/**
 * The inhouse night's picture: when it is on the league's clock, the note and
 * who's coming. Null with no night set, or once the last is over: /inhouse
 * then keeps the league's own picture.
 */
export async function loadInhouseNightCard(
  nowMs: number,
): Promise<InhouseNightCardData | null> {
  const night = currentInhouseNight((await readInhouseNight()).night, nowMs);
  if (!night) return null;
  const { discordIds } = await readInhouseNightRsvps(night.id);
  const count = await inhouseNightHeadcountFor(night, discordIds);
  return {
    on: inhouseNightPhase(night, nowMs) === "on",
    ...leagueMatchTimeParts(new Date(night.startsAtMs)),
    note: night.note,
    headcount: inhouseNightHeadcountText(count),
  };
}
