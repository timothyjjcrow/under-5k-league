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
  /** An all-time league record they hold. */
  records: boolean;
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
  /** The "Player profile" band, and its two cards. */
  profile: boolean;
  heroes: boolean;
  records: boolean;
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
  const profile = data.heroes || data.records;
  const inhouseInOverview = !data.leagueGames && data.inhouse;
  const inhouseInCareer = data.inhouse && !inhouseInOverview;
  const career = data.achievements || data.seasons || inhouseInCareer;
  return {
    matches: data.leagueGames,
    performance,
    performanceCard: data.economy,
    reportCard: data.gradedGames,
    profile,
    heroes: data.heroes,
    records: data.records,
    inhouseInOverview,
    inhouseInCareer,
    career,
    nav: [
      { id: "player-overview", label: "Overview" },
      ...(data.leagueGames ? [{ id: "player-matches", label: "Matches" }] : []),
      ...(performance
        ? [{ id: "player-performance", label: "Performance" }]
        : []),
      ...(data.heroes ? [{ id: "player-heroes", label: "Heroes" }] : []),
      // Named for the card it jumps to. "About" is the player's own words
      // under the header, so a tab called that must not land on records.
      ...(data.records ? [{ id: "player-records", label: "Records" }] : []),
      ...(career ? [{ id: "player-career", label: "Career" }] : []),
    ],
  };
}
