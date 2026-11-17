import {
  LEAGUE_CONFIG,
  MERCH_SHOP_URLS,
  type MerchShopGroup,
} from "@/lib/league-config";

export type JerseyProduct = {
  player: string;
  position: number;
  url: string;
};

export type TeamJersey = {
  /** The US league's production Team.id this set was made for. */
  teamId: string;
  /** The team as its shop lists it, which a later rename does not follow. */
  teamName: string;
  /** The regular-season group, which is also the shop that sells the set. */
  group: MerchShopGroup;
  /** That group's shop front, for "all of this group's jerseys". */
  shopUrl: string;
  /** One personalized jersey per player, position 1 first. */
  products: readonly JerseyProduct[];
};

/**
 * One team's five player jerseys. Each player is `[name, slug]`, in position
 * order; the shop's product address is
 * `<team>-<player>-position-<n>-ggd2l-season-2-jersey`; a slug that starts
 * with `=` is the product's whole address instead.
 */
function jersey(
  teamId: string,
  teamName: string,
  group: MerchShopGroup,
  teamSlug: string,
  players: readonly (readonly [string, string])[],
): TeamJersey {
  const shopUrl = MERCH_SHOP_URLS[group];
  return {
    teamId,
    teamName,
    group,
    shopUrl,
    products: players.map(([player, slug], index) => ({
      player,
      position: index + 1,
      url: `${shopUrl}products/${
        slug.startsWith("=")
          ? slug.slice(1)
          : `${teamSlug}-${slug}-position-${index + 1}-ggd2l-season-2-jersey`
      }`,
    })),
  };
}

// The US league's Season 2 jerseys: twelve teams, five players each, read
// from the two live shops on 2026-11-16 (every address answered 200). Team
// ids are the production Team rows, read from us.ggd2l.com/teams the same
// day; three teams go by another name on the site than in their shop
// ("冰淇淋", "Stygian charges", "Post Partum Depression"), which is why the id
// links them and the name never does.
const JERSEYS: readonly TeamJersey[] = [
  // Group A
  jersey("cmvolxzl8007464qyut96k9r5", "Melt Mechanics (冰淇淋)", "A", "melt-mechanics", [
    ["Camaro5speed", "camaro5speed"],
    ["Baba Yaga", "baba-yaga"],
    ["KL1", "kl1"],
    ["Chamalightoooo", "chamalightoooo"],
    ["Tallballz", "tallballz"],
  ]),
  jersey("cmvip8vw000c4rw22bf1edzcs", "Heart Made of Steel", "A", "heart-made-of-steel", [
    ["Chande.4Norman", "chande-4norman"],
    ["SUEZO", "suezo"],
    ["Alexkrillex", "alexkrillex"],
    ["USDanny.ttv", "usdanny-ttv"],
    ["GrapeSlice", "grapeslice"],
  ]),
  jersey("cmviip4h4000prw22r26xsbkp", "Stygian Chargers", "A", "stygian-chargers", [
    ["CCM", "ccm"],
    ["Safiro", "safiro"],
    ["Video Game Enjoyer", "video-game-enjoyer"],
    ["Stygian", "stygian"],
    ["Rat Catcher", "rat-catcher"],
  ]),
  jersey("cmvhh7al0004nd489gnq9lfg4", "LD2L Rejects", "A", "ld2l-rejects", [
    ["Winkx", "winkx"],
    ["Bóbr Kurwa", "bobr-kurwa"],
    ["JBay7", "jbay7"],
    ["Slashely", "slashely"],
    ["Coplice", "coplice"],
  ]),
  jersey("cmvhfmpul003sd489vqbz70lu", "Team Solidarity", "A", "team-solidarity", [
    ["chrysanthemums", "chrysanthemums"],
    ["cam", "cam"],
    ["russ", "russ"],
    ["Neraidaphobia", "neraidaphobia"],
    ["Mattykyu", "mattykyu"],
  ]),
  jersey("cmvpy0ejo0052bl0c5wjvee45", "First Blood", "A", "first-blood", [
    ["sheng 盛纯", "sheng"],
    ["Catalyst", "catalyst"],
    ["‹Null›", "null"],
    ["Hashirama", "hashirama"],
    // The one product whose address was never renamed after its team was.
    ["charliehorse", "=charliehorses-team-ggd2l-season-2-jersey"],
  ]),
  // Group B
  jersey("cmvmx8f0400secz1ty2w20rml", "Spicy Tangos", "B", "spicy-tangos", [
    ["Andrey", "andrey"],
    ["Vansetsu", "vansetsu"],
    ["mistakes were made", "mistakes-were-made"],
    ["ajithkumar", "ajithkumar"],
    ["Taxi", "taxi"],
  ]),
  jersey("cmvl5tvno00f8hshges8c8r00", "Bad Boys of Dota", "B", "bad-boys-of-dota", [
    ["Borpo", "borpo"],
    ["Puow", "puow"],
    ["DonV", "donv"],
    ["Wish", "wish"],
    ["ZeroSpacee", "zerospacee"],
  ]),
  jersey("cmviy31gw00kyrw22qbpziq18", "PPD", "B", "ppd", [
    ["pseta", "pseta"],
    ["They not like us", "they-not-like-us"],
    ["Giribaldi@Twitch", "giribaldi-twitch"],
    ["Rada", "rada"],
    ["nobodyz", "nobodyz"],
  ]),
  jersey("cmvhften30041d4892asku0px", "Duality Gaming", "B", "duality-gaming", [
    ["Cool", "cool"],
    ["gorilla see gorilla do", "gorilla-see-gorilla-do"],
    ["is_o", "is-o"],
    ["Crack Addict", "crack-addict"],
    ["Yamii", "yamii"],
  ]),
  jersey("cmvhaas45002cd489e2z2j1q1", "Big Shrimpin’", "B", "big-shrimpin", [
    ["#1 Frozen Fan", "1-frozen-fan"],
    ["it is", "it-is"],
    ["Kenshiro", "kenshiro"],
    ["Brother Barrett", "brother-barrett"],
    ["Radio Star", "radio-star"],
  ]),
  jersey("cmvh95h4q001jd489obr574lh", "Vegan Squadron", "B", "vegan-squadron", [
    ["Everything He Ain’t", "everything-he-aint"],
    ["llIIIIIlllIIIIII", "lliiiiillliiiiii"],
    ["Mambo", "mambo"],
    ["Creamy Doughnut :P", "creamy-doughnut-p"],
    ["Invictus", "invictus"],
  ]),
];

/**
 * A team shows a jersey set when at least this many of its current players are
 * players the set was made for. Three of five is a majority, so two teams in
 * one season can never both claim a set (a player is on one roster), and a
 * team keeps its jerseys through one or two roster changes or Steam renames.
 */
const JERSEY_ROSTER_MATCH_MIN = 3;

/** Steam personas as the merch roster spelled them: case, accents and edge
 *  spaces are not identity ("Bóbr Kurwa" still matches "bobr kurwa"). */
function playerKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * The jersey set this team wears, or null.
 *
 * Linked by the team's ID first, never by its name: captains and admins can
 * rename a team at any time, and a name match silently dropped a team's
 * jerseys on the first rename (Season 1's "My Team Sucks" was still called
 * "w4tkins's Team" and needed a hand-written alias). The roster match is the
 * fallback for any environment whose Team rows are not the production ones
 * (fixtures, a restored copy): the set's own products name the five players
 * it was made for, so a majority of them on one roster identifies it.
 * Merchandise belongs to the US league's Season 2 rosters only.
 */
export function getTeamJersey(
  team: { id: string; roster: readonly { name: string }[] },
  region: string = LEAGUE_CONFIG.region,
): TeamJersey | null {
  if (region !== "us") return null;
  const byId = JERSEYS.find((jersey) => jersey.teamId === team.id);
  if (byId) return byId;
  const players = new Set(team.roster.map((player) => playerKey(player.name)));
  return (
    JERSEYS.find(
      (jersey) =>
        jersey.products.filter((product) => players.has(playerKey(product.player)))
          .length >= JERSEY_ROSTER_MATCH_MIN,
    ) ?? null
  );
}
