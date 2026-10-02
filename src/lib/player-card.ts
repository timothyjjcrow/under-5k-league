// A player's season card: the trading-card panel in their profile's header,
// and the picture their profile link unfurls into in Discord and on X. One
// pure rule feeds both, so the card a player posts is the card their profile
// shows. Pure and tested.
//
// Every fact comes from reads the profile already makes (its picture makes
// the same reads). The card carries no contact detail of any kind, not even
// whether one exists: the picture is public and travels wherever a link is
// pasted.

import type { Achievement } from "./achievements";
import { reportVerdicts, type CareerReport, type Grade } from "./benchmarks";
import { REGISTRATION_TYPE } from "./constants";
import { heroById } from "./heroes";
import type { ProfileSeasonRow } from "./profile-seasons";
import { rankMedalTier } from "./rank";

/** How they took part in the card's season. */
export type PlayerCardRole =
  | { kind: "captain" }
  | { kind: "drafted"; price: number }
  | { kind: "free-agent" }
  | { kind: "standin" }
  | { kind: "registered" };

export type PlayerCardHero = {
  heroId: number;
  name: string;
  /** From their pub games (OpenDota), not the league's box scores. */
  pubs: boolean;
};

export type PlayerCardFacts = {
  /** The active season while they are in it (signed up, or on a roster),
   *  else their latest league season. Null when there is none to name. */
  season: { id: string; name: string; current: boolean } | null;
  role: PlayerCardRole | null;
  /** Their team that season. Null for a season spent standing in, or a
   *  signup not on a roster. */
  team: { id: string; name: string; logoUrl: string | null } | null;
  /** The team a season spent only standing in covered, by name: named in
   *  the role line, never worn (no crest, no colour). */
  stoodInFor: string | null;
  /** The Dota medal when it is known. Unknown is left out, never "Unranked". */
  rankTier: number | null;
  /** The MMR on an ACTIVE signup in the active season; null otherwise (the
   *  header's rule before the card). */
  mmr: number | null;
  /** Up to three: their most-played league heroes, then pub heroes, which
   *  say so. Never the heroes they typed as favourites. */
  heroes: PlayerCardHero[];
  /** The career report card's overall grade once it has enough graded games
   *  (reportVerdicts as a visitor sees it, so no "Work on"). */
  grade: { overall: Grade; strength: string | null } | null;
  /** Seasons they won the title in, newest first. */
  titles: { seasonId: string; seasonName: string }[];
  /** Games they were Match MVP of (the Match MVP achievement's count). */
  mvps: number;
  /** All-time league records they hold. */
  records: number;
};

/** How many heroes a card shows. */
const CARD_HEROES = 3;

export function playerCardFacts(input: {
  activeSeason: { id: string; name: string } | null;
  /** Their ACTIVE signup in the active season (the profile's `activeReg`). */
  signup: { mmr: number; type: string } | null;
  /** Their roster spot in the active season, if any. */
  membership: {
    teamId: string;
    teamName: string;
    teamLogoUrl: string | null;
    isCaptain: boolean;
  } | null;
  /** loadProfileSeasonRows: newest season first, roster team first. */
  seasonRows: readonly ProfileSeasonRow[];
  /** loadProfileSeasonRows' logos for the teams its rows name. */
  teamLogos: ReadonlyMap<string, string | null>;
  rankTier: number | null;
  /** playerHeroPool: most-played league heroes first. */
  leagueHeroes: readonly { heroId: number }[];
  /** Their stored pub top heroes (parsePubStats), most-played first. */
  pubHeroes: readonly { heroId: number }[];
  report: CareerReport;
  achievements: readonly Pick<Achievement, "key" | "count">[];
  /** How many all-time league records they hold. */
  recordsHeld: number;
}): PlayerCardFacts {
  const { activeSeason, signup, membership, seasonRows } = input;
  let season: PlayerCardFacts["season"] = null;
  let role: PlayerCardRole | null = null;
  let team: PlayerCardFacts["team"] = null;
  let stoodInFor: string | null = null;

  if (activeSeason && (signup || membership)) {
    season = { ...activeSeason, current: true };
    if (membership) {
      team = {
        id: membership.teamId,
        name: membership.teamName,
        logoUrl: membership.teamLogoUrl,
      };
      // Today's roster says whether they captain it (a handover moves the
      // armband); their tenure says how they joined.
      const row = seasonRows.find(
        (r) => r.seasonId === activeSeason.id && r.teamId === membership.teamId,
      );
      role = membership.isCaptain
        ? { kind: "captain" }
        : row?.role && row.role.kind !== "captain"
          ? row.role
          : null;
    } else {
      role =
        signup?.type === REGISTRATION_TYPE.STANDIN
          ? { kind: "standin" }
          : { kind: "registered" };
    }
  } else if (seasonRows.length > 0) {
    // Their latest season, and within it a title first, so covering for the
    // champion isn't hidden behind another row (the rows put the roster team
    // first within a season).
    const newest = seasonRows[0].seasonId;
    const row =
      seasonRows.find((r) => r.seasonId === newest && r.champion) ??
      seasonRows[0];
    season = {
      id: row.seasonId,
      name: row.seasonName,
      current: row.seasonId === activeSeason?.id,
    };
    if (row.role === null && row.stoodIn > 0) {
      role = { kind: "standin" };
      stoodInFor = row.teamName;
    } else {
      role = row.role;
      team = row.teamId
        ? {
            id: row.teamId,
            name: row.teamName,
            logoUrl: input.teamLogos.get(row.teamId) ?? null,
          }
        : null;
    }
  }

  // A card with no league games shows who they are, not what they've done.
  const played = input.leagueHeroes.length > 0;
  const heroes: PlayerCardHero[] = [];
  if (played) {
    const add = (heroId: number, pubs: boolean) => {
      const hero = heroById(heroId);
      if (!hero || heroes.length >= CARD_HEROES) return;
      if (heroes.some((h) => h.heroId === heroId)) return;
      heroes.push({ heroId, name: hero.name, pubs });
    };
    for (const h of input.leagueHeroes) add(h.heroId, false);
    for (const h of input.pubHeroes) add(h.heroId, true);
  }

  const verdicts = reportVerdicts(input.report, false);
  const titles: PlayerCardFacts["titles"] = [];
  for (const row of seasonRows) {
    if (row.champion && !titles.some((t) => t.seasonId === row.seasonId)) {
      titles.push({ seasonId: row.seasonId, seasonName: row.seasonName });
    }
  }

  return {
    season,
    role,
    team,
    stoodInFor,
    rankTier: rankMedalTier(input.rankTier) > 0 ? input.rankTier : null,
    mmr: activeSeason && signup ? signup.mmr : null,
    heroes,
    grade:
      verdicts.graded && verdicts.overall
        ? { overall: verdicts.overall, strength: verdicts.best?.label ?? null }
        : null,
    titles,
    mvps: input.achievements.find((a) => a.key === "mvp")?.count ?? 0,
    records: Math.max(0, input.recordsHeld),
  };
}

/** The role in a few words: "Captain", "Drafted for $12", "Standin",
 *  "Stood in for Dire Straits". */
export function playerCardRoleText(
  facts: Pick<PlayerCardFacts, "role" | "stoodInFor">,
): string | null {
  const { role } = facts;
  switch (role?.kind) {
    case "captain":
      return "Captain";
    case "drafted":
      return `Drafted for $${role.price}`;
    case "free-agent":
      return "Signed as a free agent";
    case "standin":
      return facts.stoodInFor ? `Stood in for ${facts.stoodInFor}` : "Standin";
    case "registered":
      return "Registered";
    default:
      return null;
  }
}

/**
 * The role line the profile's card prints. The name row already badges a
 * live Captain (today's roster) or Standin (today's signup), so the card
 * doesn't say it a second time; the picture has no name row and always says
 * it.
 */
export function profileCardRoleText(
  facts: Pick<PlayerCardFacts, "role" | "stoodInFor">,
  nameRow: { captain: boolean; standin: boolean },
): string | null {
  if (facts.role?.kind === "captain" && nameRow.captain) return null;
  if (facts.role?.kind === "standin" && nameRow.standin) return null;
  return playerCardRoleText(facts);
}

/** Badges a title list shows before the rest fold into "+N". */
const SHOWN_TITLES = 3;

/**
 * "Season 9 champion" per title, newest first: the first three (or `limit`),
 * then how many more and which (for a "+N" badge's spoken name).
 */
export function championTitles(
  titles: PlayerCardFacts["titles"],
  limit: number = SHOWN_TITLES,
): {
  shown: string[];
  more: string[];
} {
  const labels = titles.map((t) => `${t.seasonName} champion`);
  return {
    shown: labels.slice(0, limit),
    more: labels.slice(limit),
  };
}

/** "3 Match MVPs", "1 league record": the honors besides titles. */
export function playerCardHonors(
  facts: Pick<PlayerCardFacts, "mvps" | "records">,
): string[] {
  const out: string[] = [];
  if (facts.mvps > 0) {
    out.push(`${facts.mvps} Match MVP${facts.mvps === 1 ? "" : "s"}`);
  }
  if (facts.records > 0) {
    out.push(`${facts.records} league record${facts.records === 1 ? "" : "s"}`);
  }
  return out;
}

/** True when the card has anything to show at all. */
export function playerCardHasContent(facts: PlayerCardFacts): boolean {
  return (
    facts.season !== null ||
    facts.rankTier !== null ||
    facts.mmr !== null ||
    facts.heroes.length > 0 ||
    facts.grade !== null ||
    facts.mvps > 0 ||
    facts.records > 0
  );
}
