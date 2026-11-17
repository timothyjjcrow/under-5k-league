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
    // The side's own captain picks; they don't offer for their own team.
    expect(PAGE).toMatch(
      /\{isCaptain \? \([\s\S]*?matchAnchorPath\(need\.matchId, MATCH_ANCHOR\.standins\)/,
    );
  });

  // A signed-out visitor's sign-in comes back to the game's own link, so
  // their first click ends with them on the list.
  it("signs in back to the game's link", () => {
    expect(PAGE).toMatch(
      /<SignupStep\s+viewer=\{viewer\}\s+next=\{standinOfferPath\(need\.matchId, need\.teamId\)\}\s+game=\{\{ matchId: need\.matchId, teamId: need\.teamId \}\}/,
    );
    expect(PAGE).toMatch(/<SteamSignInButton next=\{next\}/);
    // One Steam notice a page, on the first game, not one per button.
    expect(PAGE).toContain("{steamNote ? <SteamSignInNote /> : null}");
    expect(PAGE).toContain("steamNote={first}");
    expect(PAGE).toContain("first={index === 0}");
  });

  it("answers a shared link once, from the server's rule", () => {
    expect(PAGE).toContain(
      "const arrival = standinArrivalAction(play, arrivalStanding);",
    );
    // Only for a game the board lists: a filled seat gets the note instead.
    expect(PAGE).toMatch(/\{linked && linkedNeed \? \(\s*<StandinOfferOnArrival/);
    expect(PAGE).toMatch(/\{linked && !linkedNeed \? \(/);
    // The address loses `play` before anything is sent, so a refresh or a
    // copied tab never offers again.
    const scrub = LINK.indexOf('url.searchParams.delete("play")');
    const send = LINK.indexOf("offerToStandInAction(null, form)");
    expect(scrub).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(scrub);
    expect(LINK).toMatch(/if \(action !== "offer"\) return;/);
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
    expect(home).toContain("...standinHomeLine(standinGames ?? 0),");
  });
});
