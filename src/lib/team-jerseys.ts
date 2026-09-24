import { LEAGUE_CONFIG } from "@/lib/league-config";

export type JerseyProduct = {
  player: string;
  position: number;
  url: string;
};

export type TeamJersey = {
  teamName: string;
  frontImage: string;
  backImage: string;
  products: readonly JerseyProduct[];
};

const shop = "https://ggd2l-shop.fourthwall.com/products/";

function jersey(
  teamName: string,
  slug: string,
  products: readonly (readonly [string, string])[],
): TeamJersey {
  return {
    teamName,
    // These are unaltered 800 × 800 Fourthwall flat mockups from the verified
    // position-1 product, not the print panels or the editor's 3D preview.
    frontImage: `/merch/jerseys/${slug}-front.png`,
    backImage: `/merch/jerseys/${slug}-back.png`,
    products: products.map(([player, productSlug], index) => ({
      player,
      position: index + 1,
      url: `${shop}${productSlug}`,
    })),
  };
}

// Product names and URLs match the verified 25-player Fourthwall roster plan.
// The image pair for each team depicts its position-1 product; all five player
// links remain available because their backs are personalized.
const JERSEYS: readonly TeamJersey[] = [
  jersey("Bad Boys of Dota", "bad-boys-of-dota", [
    ["Borpo", "bad-boys-of-dota-jersey-borpo-1"],
    ["Puow", "bad-boys-of-dota-jersey-puow-2"],
    ["DonV", "bad-boys-of-dota-jersey-donv-3"],
    ["invisibilty=invincibility", "bad-boys-of-dota-jersey-invisibilty-invincibility-4"],
    ["Wish", "bad-boys-of-dota-jersey-wish-5"],
  ]),
  jersey("Bleeding Heart Dota", "bleeding-heart-dota", [
    ["Power", "bleeding-heart-dota-jersey-power-1"],
    ["Bóbr Kurwa", "bleeding-heart-dota-jersey-bobr-kurwa-2"],
    ["CTE(Z)", "bleeding-heart-dota-jersey-cte-z-3"],
    ["GrapeSlice", "bleeding-heart-dota-jersey-grapeslice-4"],
    ["KM", "bleeding-heart-dota-jersey-km-5"],
  ]),
  jersey("My Team Sucks", "my-team-sucks", [
    ["Big Dawg SaMy", "my-team-sucks-jersey-big-dawg-samy-1"],
    ["USDanny.ttv", "my-team-sucks-jersey-usdanny-ttv-2"],
    ["Video Game Enjoyer", "my-team-sucks-jersey-video-game-enjoyer-3"],
    ["Neraidaphobia", "my-team-sucks-jersey-neraidaphobia-4"],
    ["w4tkins", "my-team-sucks-jersey-w4tkins-5"],
  ]),
  jersey("Sisters of the Veil", "sisters-of-the-veil", [
    ["saukko", "sisters-of-the-veil-jersey-saukko-1"],
    ["Evil Papich", "sisters-of-the-veil-jersey-evil-papich-2"],
    ["AMMAR THE FAT", "sisters-of-the-veil-jersey-ammar-the-fat-3"],
    ["JBay7", "sisters-of-the-veil-jersey-jbay7-4"],
    ["EpiPen", "sisters-of-the-veil-jersey-epipen-5"],
  ]),
  jersey("Vegan Squadron", "vegan-squadron", [
    ["llIIIIIlllIIIIII", "vegan-squadron-jersey-lliiiiillliiiiii-1"],
    ["EnderWiggin", "vegan-squadron-jersey-enderwiggin-2"],
    ["Slashely", "vegan-squadron-jersey-slashely-3"],
    ["Brother Barrett", "vegan-squadron-jersey-brother-barrett-4"],
    ["Rada", "vegan-squadron-jersey-rada-5"],
  ]),
];

const byTeamName = new Map(
  JERSEYS.map((item) => [item.teamName.toLowerCase(), item]),
);

// The verified roster plan records this current league name for My Team Sucks.
const leagueTeamAliases = new Map([["w4tkins's team", "my team sucks"]]);

/** Merchandise currently belongs to the US league's verified 2026 roster. */
export function getTeamJersey(teamName: string): TeamJersey | null {
  if (LEAGUE_CONFIG.region !== "us") return null;
  const normalizedName = teamName.trim().toLowerCase();
  const alias = leagueTeamAliases.get(normalizedName);
  const jersey = byTeamName.get(alias ?? normalizedName);
  return jersey ? { ...jersey, teamName: alias ? jersey.teamName : teamName } : null;
}
