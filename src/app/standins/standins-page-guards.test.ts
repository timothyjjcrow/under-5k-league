import { describe, expect, it } from "vitest";
import {
  homePageSource,
  sourceFile,
  stripLineComments,
} from "../../../test/support/source-files";

/**
 * Source contracts for the Standins page (games that need a standin, and
 * "I can play"). A server component with no render test (no jsdom), so the
 * rules a regression would break silently are pinned here.
 */
const PAGE = stripLineComments(sourceFile("src/app/standins/page.tsx").text);
const LINK = stripLineComments(
  sourceFile("src/components/standin-offer-link.tsx").text,
);
const ACCEPT = stripLineComments(
  sourceFile("src/app/standins/accept-card.tsx").text,
);
const ACTIONS = stripLineComments(
  sourceFile("src/app/actions/standin-offers.ts").text,
);
const POST = stripLineComments(
  sourceFile("src/lib/standin-offer-post.ts").text,
);

describe("standins page", () => {
  // Named check-in answers are for captains and admins. The board says a
  // side needs someone and what the seat counts as, never who is out.
  it("never reads who is out, or a roster", () => {
    expect(PAGE).not.toMatch(/matchAvailability|loadOutUserIds|teamMember/);
    expect(PAGE).toContain("standinNeedLabel(need.seats)");
    expect(PAGE).toContain("standinSeatLine(need.baselineMmr)");
    // The list never names a seat: only the accept card does, below.
    expect(PAGE).not.toMatch(/openSeats|standinOpenSeatLine/);
  });

  it("renders a control only where the offer would be taken", () => {
    // One rule for every card: the service's own standing.
    expect(PAGE).toContain("standing={standingOn(need, offerViewer)}");
    expect(PAGE).toMatch(
      /standing\.kind === "open" \? \([\s\S]*?action=\{offerToStandInAction\}/,
    );
    // Taking it back stays for anyone on the list.
    expect(PAGE).toMatch(
      /standing\.kind === "offered" \? \([\s\S]*?action=\{withdrawStandinOfferAction\}/,
    );
    // The side's own captain picks: their sides are in their team's cover
    // above (TeamCover), never on the list, where they could only offer.
    expect(PAGE).toContain(
      "const others = needs.filter((n) => n.teamId !== myTeam?.id);",
    );
    expect(PAGE).not.toContain("isCaptain");
  });

  // A signed-out visitor's sign-in comes back to the game's own link, so it
  // ends on the game's accept card.
  it("signs in back to the game's link", () => {
    expect(PAGE).toMatch(
      /<SignupStep\s+viewer=\{viewer\}\s+next=\{standinOfferPath\(need\.matchId, need\.teamId\)\}\s+game=\{\{ matchId: need\.matchId, teamId: need\.teamId \}\}/,
    );
    expect(PAGE).toMatch(/<SteamSignInButton next=\{next\}/);
    // One Steam notice a page, on the first game, not one per button.
    expect(PAGE).toContain("{steamNote ? <SteamSignInNote /> : null}");
    expect(PAGE).toContain("steamNote={first}");
    expect(PAGE).toContain("first={index === 0 && !acceptNeed}");
  });

  // Tim, 2026-11-21: opening a shared link adds nobody. It opens the game's
  // accept card, and the standin's own tap on Accept is the offer.
  it("opens a shared link on an accept card that offers only on a tap", () => {
    expect(PAGE).not.toMatch(/StandinOfferOnArrival|standinArrivalAction|params\.play/);
    expect(LINK).not.toContain("offerToStandInAction");
    // Never for a rostered viewer: that side's captain lands on their team's
    // cover, a teammate on the game marked as theirs.
    expect(PAGE).toContain(
      "const acceptAudience = !!linked && !myTeam && !offerViewer?.rostered;",
    );
    expect(PAGE).toContain("const acceptNeed = acceptAudience ? linkedNeed : null;");
    // A game past the board's week still opens, with its kickoff to come.
    expect(PAGE).toMatch(
      /await loadStandinNeed\(season, linked\.matchId, linked\.teamId\)[\s\S]*?need\.scheduledAt\.getTime\(\) > nowMs/,
    );
    // The card's game is on the card only: one Accept button for it.
    expect(PAGE).toMatch(
      /orderStandinBoard\(others, \{ ownTeamId, linked \}\)\.filter\(\s*\(n\) => !acceptNeed \|\| !isLinked\(n\),\s*\)/,
    );
    expect(PAGE).toMatch(
      /<StandinAcceptCard\s+need=\{acceptNeed\}\s+standing=\{standingOn\(acceptNeed, offerViewer\)\}/,
    );
    // Sign-in comes back to the same card, never straight onto the list.
    expect(PAGE).toMatch(
      /next=\{standinOfferPath\(acceptNeed\.matchId, acceptNeed\.teamId\)\}/,
    );
    // The page's one Steam notice moves to the card.
    expect(PAGE).toContain("first={index === 0 && !acceptNeed}");
    // Only a filled seat gets the note, except on the captain's own game.
    expect(PAGE).toMatch(/\{linked && !linkedNeed && !yourTeamsGame \? \(/);
  });

  it("puts the offer behind the card's one Accept button", () => {
    // Accept is the offer form; the button is inside the open branch only.
    expect(ACCEPT).toMatch(
      /standing\.kind === "open" \? \([\s\S]*?<ActionForm action=\{offerToStandInAction\} hidden=\{hidden\}>\s*<SubmitButton variant="accent" size="lg">\s*Accept\s*<\/SubmitButton>/,
    );
    expect(ACCEPT.match(/offerToStandInAction\}/g)).toHaveLength(1);
    // Taking it back stays for anyone on the list.
    expect(ACCEPT).toMatch(
      /standing\.kind === "offered" \? \([\s\S]*?action=\{withdrawStandinOfferAction\}/,
    );
    // Sign in or register for anyone who can't accept yet.
    expect(ACCEPT).toMatch(/standing\.kind === "blocked" \? \([\s\S]*?\) : \(\s*signup\s*\)/);
  });

  // Tim asked for the card to show who the standin replaces and their MMR.
  // Named check-in answers are otherwise for captains and admins, so the
  // names are for a standin who could accept, and only on the card.
  it("names who the standin would replace only to a standin who could accept", () => {
    expect(ACCEPT).toContain("const named = standinAcceptNamesSeats(standing);");
    const names = ACCEPT.indexOf("need.openSeats.map(");
    const gate = ACCEPT.indexOf("{named ? (");
    expect(gate).toBeGreaterThan(-1);
    expect(names).toBeGreaterThan(gate);
    expect(ACCEPT.match(/need\.openSeats/g)).toHaveLength(1);
    expect(ACCEPT).toContain("standinOpenSeatLine(seat)");
    // Everyone sees the count and the seat's MMR.
    expect(ACCEPT).toContain("standinNeedLabel(need.seats)");
    expect(ACCEPT).toContain("standinSeatLine(need.baselineMmr)");
  });

  // Tim, 2026-11-20: any player on a team may share its game's link, as
  // its captain can. Their own side leads the list with the link where a
  // standin would see "I can play", never "you can't stand in".
  it("gives a player their own team's game first, with its share link", () => {
    expect(PAGE).toContain(
      "const ownTeamId = myTeam ? null : (offerViewer?.rosterTeamId ?? null);",
    );
    expect(PAGE).toContain(
      "const ordered = orderStandinBoard(others, { ownTeamId, linked })",
    );
    expect(PAGE).toContain(
      "ownTeam={ownTeamId !== null && need.teamId === ownTeamId}",
    );
    // The own-team branch comes before the standing's, holds the copy
    // button and no offer form.
    const own = PAGE.indexOf("{ownTeam ? (");
    const open = PAGE.indexOf('standing.kind === "open" ? (');
    expect(own).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(own);
    const branch = PAGE.slice(own, open);
    expect(branch).toMatch(
      /<CopyStandinLink\s+matchId=\{need\.matchId\}\s+teamId=\{need\.teamId\}/,
    );
    expect(branch).not.toContain("offerToStandInAction");
  });

  // Every player on a short side is pointed at that game, where the link is;
  // only the captain's line says "Line up cover".
  it("sends a short side's players from the check-in banner to the game", () => {
    const banner = stripLineComments(
      sourceFile("src/components/checkin-banner.tsx").text,
    );
    expect(banner).toMatch(
      /side\.role === "player" && sideNeedsCover\(side\.counts\) \? \(\s*<Link\s+href=\{standinHubPath\(matchId\)\}[\s\S]*?Help find a standin/,
    );
  });

  it("copies the link on the viewer's own origin, and never claims a failed copy", () => {
    expect(LINK).toContain(
      "`${window.location.origin}${standinOfferPath(matchId, teamId)}`",
    );
    expect(LINK).toMatch(/catch \{[\s\S]*?Couldn't copy: the standin link is/);
  });
});

describe("standin offer actions", () => {
  it("require a signed-in player, and act only for them", () => {
    expect(ACTIONS.match(/await requireUser\(\)/g)).toHaveLength(2);
    expect(ACTIONS.match(/userId: user\.id,/g)).toHaveLength(2);
    expect(ACTIONS).not.toMatch(/str\(formData, "userId"\)/);
  });

  // The captain is pinged for the first offer, then at most once a window:
  // the post goes after the offer is stored, through the throttle claim.
  it("pings the captain through the throttle, after the offer is stored", () => {
    const write = ACTIONS.indexOf("await offerToStandIn(");
    const post = ACTIONS.indexOf("await sendStandinOfferPost(res)");
    expect(write).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(write);
    const claim = POST.indexOf("await claimThrottle(");
    const send = POST.indexOf("await sendDiscordMessage(");
    expect(claim).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(claim);
    expect(POST).toContain("STANDIN_OFFER_PING_THROTTLE_SECONDS");
  });
});

describe("home standin callout", () => {
  // Tim, 2026-11-15: a visitor with no team and no signup sees the games
  // that need a standin first, in all three of the hero's branches.
  it("leads the hero's actions for a visitor without a signup", () => {
    const home = stripLineComments(homePageSource());
    expect(home.match(/<>\s*\{standinGames\}/g)).toHaveLength(2);
    // Signed in with no signup: the callout, or the plain signup button when
    // no game needs anyone. Never both.
    expect(home).toMatch(
      /<StandinGamesCallout\s+season=\{season\}\s+whenNone=\{<StandinSignupLink variant="primary" \/>\}/,
    );
    expect(home).toMatch(
      /const standinGames = \(\s*<Suspense fallback=\{null\}>\s*<StandinGamesCallout season=\{season\} \/>/,
    );
    // Every signed-out view of Home renders it, so it reads the cached count.
    const callout = stripLineComments(
      sourceFile("src/components/home/standin-games.tsx").text,
    );
    expect(callout).toContain("await loadStandinBoardSummary(season, Date.now())");
    expect(callout).toContain("if (count === 0 || !first) return whenNone;");
  });
});

describe("standin signup that joins a game", () => {
  const REGISTRATION = stripLineComments(
    sourceFile("src/app/actions/registration.ts").text,
  );

  // "Register as a standin to play" remembers the game; the signup's own
  // submit offers for it, once, after the signup has committed.
  it("offers for the remembered game after a standin signup, and forgets it", () => {
    expect(LINK).toContain(
      "document.cookie = `${STANDIN_GAME_COOKIE}=${value}; path=/; max-age=${STANDIN_GAME_MAX_AGE_SECONDS}; samesite=lax`",
    );
    const saved = REGISTRATION.indexOf("await publishDraftRoomChange();");
    const take = REGISTRATION.indexOf("await takeStandinGame()");
    expect(saved).toBeGreaterThan(-1);
    expect(take).toBeGreaterThan(saved);
    expect(REGISTRATION).toMatch(
      /if \(type === REGISTRATION_TYPE\.STANDIN\) \{\s*const game = await takeStandinGame\(\);/,
    );
    expect(REGISTRATION).toContain(
      "await offerToStandIn({ ...game, userId: user.id })",
    );
    // The refusal is said, never swallowed.
    expect(REGISTRATION).toContain(
      "standinGameNote = ` · ${offer.ok ? offer.message : offer.error}`;",
    );
  });
});

describe("home standin line", () => {
  it("counts the games that need a standin for players who could cover", () => {
    const home = stripLineComments(homePageSource());
    expect(home).toMatch(
      /idle === "standin-list" \|\|\s*\(idle === "no-team" && viewerHasActiveRegistration\)/,
    );
    // The games they already said they can play are read fresh (never from
    // the board's 30-second cache), so Home never asks them to say it again.
    expect(home).toContain("prisma.standinOffer.findMany({");
    expect(home).toContain("standinHomeLine(standinGames ?? 0, offered)");
  });
});
