// Which bands a player profile renders, decided once from what the player has
// on record. Everything gates on data presence, never season phase, so a
// SectionTitle can never render above an empty band and the tab bar can never
// offer a jump to a band that isn't there.

export type ProfileData = {
  /** At least one trusted imported league game. */
  leagueGames: boolean;
  /** An economy average (net worth or GPM) from those games. */
  economy: boolean;
  /** At least one game graded against OpenDota's benchmarks. */
  gradedGames: boolean;
  /** League heroes, pub most-played heroes, or self-picked favorites. */
  heroes: boolean;
  /** A pub snapshot with a scouting read (`pubScoutHasReads`), shown for an
   *  active signup. */
  pubScouting: boolean;
  /** An all-time league record they hold. */
  records: boolean;
  /** A league record within reach (`recordWatchFor`): the records card
   *  shows for it even when they hold none. */
  recordWatch: boolean;
  achievements: boolean;
  /** A season they played in, were rostered in, or stood in for. */
  seasons: boolean;
  /** A completed inhouse game. */
  inhouse: boolean;
};

type ProfileSections = {
  matches: boolean;
  /** The "How they play" band, and its two cards. */
  performance: boolean;
  performanceCard: boolean;
  reportCard: boolean;
  /** The "Player profile" band, and its three cards. */
  profile: boolean;
  scouting: boolean;
  heroes: boolean;
  records: boolean;
  /** With no league games the band joins the main column, so a new player's
   *  page never leaves its left column empty beside a full rail. */
  profileInMain: boolean;
  /** With no league games the inhouse card leads the page (it is their one
   *  real record); otherwise it sits with the rest of their career. */
  inhouseInOverview: boolean;
  inhouseInCareer: boolean;
  career: boolean;
  /** The tab bar, in page order: one entry per band that renders. */
  nav: { id: string; label: string }[];
};

export function profileSections(data: ProfileData): ProfileSections {
  const performance = data.economy || data.gradedGames;
  const records = data.records || data.recordWatch;
  const profile = data.pubScouting || data.heroes || records;
  const inhouseInOverview = !data.leagueGames && data.inhouse;
  const inhouseInCareer = data.inhouse && !inhouseInOverview;
  const career = data.achievements || data.seasons || inhouseInCareer;
  return {
    matches: data.leagueGames,
    performance,
    performanceCard: data.economy,
    reportCard: data.gradedGames,
    profile,
    scouting: data.pubScouting,
    heroes: data.heroes,
    records,
    profileInMain: profile && !data.leagueGames,
    inhouseInOverview,
    inhouseInCareer,
    career,
    nav: [
      { id: "player-overview", label: "Overview" },
      ...(data.leagueGames ? [{ id: "player-matches", label: "Matches" }] : []),
      ...(performance
        ? [{ id: "player-performance", label: "Performance" }]
        : []),
      ...(data.pubScouting
        ? [{ id: "player-scouting", label: "Scouting" }]
        : []),
      ...(data.heroes ? [{ id: "player-heroes", label: "Heroes" }] : []),
      // Named for the card it jumps to. "About" is the player's own words
      // under the header, so a tab called that must not land on records.
      ...(records ? [{ id: "player-records", label: "Records" }] : []),
      ...(career ? [{ id: "player-career", label: "Career" }] : []),
    ],
  };
}
