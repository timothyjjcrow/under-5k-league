import type {
  FeatureAvailability,
  FeatureGate,
} from "@/lib/features-lifecycle";

export type TourFeature = {
  title: string;
  description: string;
  href: string;
  linkLabel: string;
  gate?: FeatureGate;
};

export type TourGroup = {
  id: string;
  label: string;
  features: TourFeature[];
};

export type AvailableTourGroup = Omit<TourGroup, "features"> & {
  features: (TourFeature & { availability: FeatureAvailability })[];
};

// Describe the shipped experience here. Live availability is resolved on the
// server, so searching the directory cannot expose an out-of-season link.
export const TOUR_GROUPS: TourGroup[] = [
  {
    id: "joining",
    label: "Joining & draft",
    features: [
      {
        title: "Steam sign-in & player setup",
        description:
          "Use your Steam account, connect Discord, and keep your league details in one place. Returning players can reuse their saved signup information.",
        href: "/me",
        linkLabel: "Your profile",
      },
      {
        title: "Roles, heroes & captain notes",
        description:
          "Tell captains where you play, which heroes you enjoy, and what you want from the season. Your scouting profile helps them look beyond MMR.",
        href: "/players",
        linkLabel: "Player pool",
      },
      {
        title: "Live auction draft",
        description:
          "Captains nominate players and bid from limited budgets. Follow the clock, the bidding, and each roster as the room fills up.",
        href: "/draft",
        linkLabel: "Draft room",
        gate: "DRAFT_ROOM",
      },
      {
        title: "Captain budgets & team building",
        description:
          "Budgets account for the MMR gap between captains. Search the pool by role, inspect player histories, and decide where to spend.",
        href: "/players",
        linkLabel: "Scout the pool",
      },
      {
        title: "Team pages & draft recap",
        description:
          "Meet each roster, follow its results and power rating, and revisit auction prices. Captains can give their team its own name and logo.",
        href: "/teams",
        linkLabel: "Teams",
        gate: "POST_AUCTION",
      },
      {
        title: "Standin signups",
        description:
          "A full season is not the only way to play. Register as a standin so teams can find cover when a rostered player is unavailable.",
        href: "#join",
        linkLabel: "Joining the league",
      },
    ],
  },
  {
    id: "competition",
    label: "Match night",
    features: [
      {
        title: "Schedule & calendar",
        description:
          "See fixtures in your local time, follow each week's results, and download the active season's calendar feed for your own calendar.",
        href: "/schedule",
        linkLabel: "Schedule",
        gate: "ACTIVE_SEASON",
      },
      {
        title: "Check-ins & roster cover",
        description:
          "Confirm you can play, see who is ready, and arrange eligible standins. Captains can request a new match time with the opposing team.",
        href: "/schedule",
        linkLabel: "Match preparation",
        gate: "ACTIVE_SEASON",
      },
      {
        title: "Dota lobby setup",
        description:
          "The match center brings the roster checklist and lobby controls together. Supported lobbies can be created through the league's Dota bot.",
        href: "/schedule",
        linkLabel: "Find your match",
        gate: "ACTIVE_SEASON",
      },
      {
        title: "Results & game box scores",
        description:
          "Imported Dota games supply heroes, KDA, economy, damage, and game MVPs. A match ID or manual report provides a fallback when an import needs help.",
        href: "/schedule",
        linkLabel: "Match results",
        gate: "REGULAR_RESULTS",
      },
      {
        title: "Standings & head-to-head results",
        description:
          "Follow points, game differential, and the meetings that separate tied teams. The results grid shows every matchup across the season.",
        href: "/schedule",
        linkLabel: "Standings",
        gate: "REGULAR_RESULTS",
      },
      {
        title: "Playoff race & scenarios",
        description:
          "Explore what a win, draw, or loss means for qualification, elimination, and tiebreakers. Scenarios show possible results, not predicted odds.",
        href: "/schedule",
        linkLabel: "Playoff race",
        gate: "REGULAR_ONLY",
      },
      {
        title: "Tiebreakers & playoff bracket",
        description:
          "Follow the matches that settle qualification and seeding, then trace each team's path through the knockout bracket to the grand final.",
        href: "/schedule",
        linkLabel: "Postseason",
        gate: "PLAYOFF_RESULTS",
      },
    ],
  },
  {
    id: "analysis",
    label: "Stats & scouting",
    features: [
      {
        title: "Player careers & achievements",
        description:
          "A player's profile connects seasons, teams, trophies, match history, hero pools, records, and achievements earned in league games.",
        href: "/players",
        linkLabel: "Find a player",
      },
      {
        title: "Opponent scouting",
        description:
          "Study an opponent's comfort heroes, team-wide threats, and game pace before your series. Player profiles add available public-match and inhouse history.",
        href: "/schedule",
        linkLabel: "Match previews",
        gate: "ACTIVE_SEASON",
      },
      {
        title: "Hero report cards",
        description:
          "Available OpenDota benchmarks grade performances from S to D against other games on the same hero, across farming, experience, combat, and more.",
        href: "/leaders",
        linkLabel: "League report card",
        gate: "REGULAR_RESULTS",
      },
      {
        title: "Stat leaders & weekly honors",
        description:
          "Browse total and per-game leaders, compare contributions, and see Player and Team of the Week from regular-season results.",
        href: "/leaders",
        linkLabel: "Leaders",
        gate: "REGULAR_RESULTS",
      },
      {
        title: "Hero meta explorer",
        description:
          "Search the hero pool, compare pick and win rates, find each hero's leading players, and distinguish established results from early samples.",
        href: "/meta",
        linkLabel: "Hero meta",
        gate: "REGULAR_RESULTS",
      },
      {
        title: "Player comparison & rivalries",
        description:
          "Put two careers side by side: results against one another, performance averages, and signature heroes. Profiles also show teammates and rivals.",
        href: "/players/compare",
        linkLabel: "Compare players",
      },
      {
        title: "Team power rankings",
        description:
          "Track Elo ratings and weekly movement alongside the official table, then open a team to see the roster and results behind its form.",
        href: "/teams",
        linkLabel: "Power rankings",
        gate: "REGULAR_RESULTS",
      },
    ],
  },
  {
    id: "more-play",
    label: "More ways to play",
    features: [
      {
        title: "Inhouse queue & captain draft",
        description:
          "Join a ten-player pickup game, accept the ready check, vote on captain selection, and draft sides. Inhouses run independently of the league season.",
        href: "/inhouse",
        linkLabel: "Inhouse queue",
      },
      {
        title: "Inhouse Elo & match history",
        description:
          "Build a record on the pickup ladder. Review results, individual box scores, and rating changes across your inhouse games.",
        href: "/inhouse/history",
        linkLabel: "Inhouse history",
      },
      {
        title: "Inhouse Cred",
        description:
          "Back your own side with inhouse Cred before betting closes. Follow your net winnings on a separate ranking beside the Elo ladder.",
        href: "/inhouse",
        linkLabel: "Elo & Cred ladder",
      },
      {
        title: "Team scrims",
        description:
          "Captains post practice availability and another team claims the slot. Scrims have their own results and statistics, separate from league competition.",
        href: "/scrims",
        linkLabel: "Scrims",
        gate: "POST_AUCTION",
      },
      {
        title: "Scrim coaches & guests",
        description:
          "Bring casual guests into practice and give coaches access to guest setup and result fetching. Captains stay in charge of booking and cancellation.",
        href: "/scrims",
        linkLabel: "Practice setup",
        gate: "POST_AUCTION",
      },
      {
        title: "Fantasy five",
        description:
          "Pick five drafted players under an MMR salary cap. Real games score their combat, wins, and strongest contribution in economy, playmaking, or pressure.",
        href: "/fantasy",
        linkLabel: "Fantasy",
        gate: "POST_AUCTION",
      },
      {
        title: "Pick'em & the oracle board",
        description:
          "Predict series winners before picks lock, compare the community's selections, and follow the prediction leaderboard. Drawn series void the picks.",
        href: "/pickem",
        linkLabel: "Pick'em",
        gate: "POST_AUCTION",
      },
    ],
  },
  {
    id: "legacy",
    label: "History & community",
    features: [
      {
        title: "Season recap",
        description:
          "Look back at the champion's run, season awards, and standout performances in a single account of the season.",
        href: "/recap",
        linkLabel: "Season recap",
        gate: "COMPLETE",
      },
      {
        title: "Season archives",
        description:
          "Revisit past rosters, draft results, standings, playoff brackets, and champions, with archived stats and side-game results available from season history.",
        href: "/seasons",
        linkLabel: "Season history",
      },
      {
        title: "Hall of Fame",
        description:
          "Meet the championship teams and compare careers by titles, series wins, fantasy points, and prediction results across seasons.",
        href: "/hall-of-fame",
        linkLabel: "Hall of Fame",
      },
      {
        title: "The record book",
        description:
          "Find the biggest individual games and remarkable team results, explore records by season, and open the matches where they happened.",
        href: "/records",
        linkLabel: "Record book",
      },
      {
        title: "League news & Discord",
        description:
          "Read organizer announcements on the site. Discord connects the community, with league updates and an inhouse board when configured by organizers.",
        href: "/news",
        linkLabel: "League news",
      },
    ],
  },
];
