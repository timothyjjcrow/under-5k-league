import { describe, expect, it } from "vitest";
import {
  folderSourceFiles,
  haystackOf,
  sourceFile,
  stripLineComments,
} from "../../../test/support/source-files";

/**
 * Source contracts for the captain's cover card on the Standins page
 * (`StandinCoverCard`), the one place a captain books, asks for and removes
 * standins (Tim, 2026-11-17). The page is a server component with no render
 * test (no jsdom), so the rules that keep a captain from pressing a control
 * that can only error are pinned here. They moved with the card from the
 * match page.
 */
const DIR = "src/app/standins";
const FOLDER = stripLineComments(haystackOf(folderSourceFiles(DIR, 4)));
const COVER = stripLineComments(sourceFile(`${DIR}/cover-card.tsx`).text);
/** The captain's assign form, a client component the card mounts. */
const STANDIN_PICKER = stripLineComments(
  sourceFile("src/components/standin-picker.tsx").text,
);

describe("the captain's cover card on the Standins page", () => {
  // The standin MMR rule: Agree books the standin, so it renders only where a
  // booking would be accepted; Decline and Withdraw are cleanup and always
  // render. Only the other captain answers, only the asking side withdraws.
  it("answers a standin request only where the server would take the answer", () => {
    const card = COVER;
    expect(card).toMatch(
      /\{mine \? \([\s\S]*?captainCancelStandinRequest[\s\S]*?\) : \([\s\S]*?\{assignOpen \? \([\s\S]*?captainApproveStandinRequest[\s\S]*?\) : null\}[\s\S]*?captainDeclineStandinRequest/,
    );
    expect(card).toContain("const mine = r.teamId === myTeamId;");
    // A request on a played match is moot: the card drops it.
    expect(card).toMatch(
      /const requests =\s*match\.status === MATCH_STATUS\.COMPLETED \? \[\] : match\.standinRequests;/,
    );
    // Captain to-dos (the match page's list, Home's captain line and
    // the Captains page all read captainTodos) point the other captain at
    // the card.
    expect(sourceFile("src/lib/captain-todos.ts").text).toMatch(
      /match\.standinRequests\.filter\(\(r\) => r\.teamId !== myTeamId\)/,
    );
    expect(sourceFile("src/app/matches/[id]/captain-todos.tsx").text).toContain(
      "captainTodos({",
    );
  });

  it("offers Remove only before the series has a game", () => {
    // removeStandinGuarded refuses once games are imported, so the button
    // would only ever open a confirm and then fail.
    expect(FOLDER).toContain("seriesStarted={match.games.length > 0}");
    expect(COVER).toMatch(
      /a\.teamId !== myTeamId \? null : seriesStarted \? \([\s\S]*?Locked: series already started[\s\S]*?captainRemoveStandin/,
    );
  });

  it("keeps standins the server would refuse out of reach, with the reason", () => {
    // Same bookings the server checks: this season's unplayed fixtures.
    expect(COVER).toMatch(
      /standinUserId: \{ in: pool\.map\(\(r\) => r\.userId\) \},\s*match: \{\s*seasonId: match\.seasonId,\s*status: \{ not: MATCH_STATUS\.COMPLETED \},/,
    );
    // Bookings plus this match's requests waiting for the other captain:
    // the server refuses a standin held by either.
    expect(COVER).toMatch(
      /blocked: standinPickerBlock\(r\.userId, pickerTarget, \[\s*\.\.\.bookingRows,\s*\.\.\.requestRows,\s*\]\)/,
    );
    expect(COVER).toMatch(/const requestRows = requests\.map\(/);
    // …and a standin declined for this team here: the server refuses
    // booking or asking for them again.
    expect(COVER).toContain("loadDeclinedStandinIds(match, myTeamId)");
    expect(COVER).toMatch(/\}\)\)\.concat\(declinedRows\);/);
    // The picker lists them last, disabled, with the reason.
    expect(COVER).toMatch(/blocked,\s*detail: /);
    expect(STANDIN_PICKER).toMatch(
      /<option key=\{s\.userId\} value=\{s\.userId\} disabled=\{!!s\.blocked\}>/,
    );
    expect(STANDIN_PICKER).toContain("{groups.blocked.map(option)}");
  });

  // Standin offers ("I can play"): the list above the form books through the
  // captain's own action, for a seat that needs cover, and only standins the
  // form could still pick.
  it("lists who said they can play, and books them the way the form does", () => {
    const card = COVER;
    // My side's offers only.
    expect(card).toMatch(
      /prisma\.standinOffer\.findMany\(\{\s*where: \{ matchId: match\.id, teamId: myTeamId \},/,
    );
    // Only while booking is open and a seat needs cover, and only standins
    // the picker hasn't blocked (booked here or that night, declined).
    expect(card).toMatch(
      /const pickable = new Map\(\s*poolChoices\.filter\(\(c\) => !c\.blocked\)/,
    );
    expect(card).toMatch(
      /const offers =\s*assignOpen && needSeat\s*\? sortStandinOffers\(offerRows\)/,
    );
    // One tap is the form's own submit: same action, same three fields, so
    // the MMR rule and every booking check decide.
    expect(card).toMatch(
      /action=\{captainAssignStandin\}\s*hidden=\{\{\s*matchId: match\.id,\s*standinUserId: reg\.userId,\s*replacingUserId: needSeat\.value,\s*\}\}/,
    );
    // The button says which of the two a tap does, from the server's rule.
    expect(card).toContain(
      "const outcome = standinPickOutcome(reg.mmr, needSeat);",
    );
    expect(card).toMatch(
      /outcome\.kind === "ask"\s*\? "Ask the other captain"\s*: `Book \$\{reg\.user\.name\}`/,
    );
    // The form marks them too, and sorts them first (standinPickerGroups).
    expect(card).toContain("offered: offeredIds.has(r.userId),");
    expect(STANDIN_PICKER).toContain('s.offered ? " · said they can play" : ""');
    // The share link renders where an offer could be taken: up top while
    // nobody has offered, at the foot once someone has.
    expect(card).toMatch(
      /\{assignOpen && needSeat && offers\.length === 0 \? \([\s\S]*?<CopyStandinLink/,
    );
    expect(card).toMatch(
      /\{assignOpen && needSeat && offers\.length > 0 \? \([\s\S]*?<CopyStandinLink/,
    );
  });

  // Finding out from the toast which kind of pick it was is too late: the
  // form says it first, from the server's own rule.
  it("says what a pick does before it is sent, from the server's rule", () => {
    expect(STANDIN_PICKER).toContain("standinPickerGroups(standins, cover)");
    expect(STANDIN_PICKER).toMatch(
      /cover && standin \? standinPickOutcome\(standin\.mmr, cover\) : null/,
    );
    expect(STANDIN_PICKER).toContain('<optgroup label="Books straight away">');
    expect(STANDIN_PICKER).toContain(
      "<optgroup label={`Needs the ${otherTeamName} captain's OK`}>",
    );
    // Both lists carry a visible label, not only an aria-label.
    expect(STANDIN_PICKER.match(/<label htmlFor=/g)).toHaveLength(2);
    expect(STANDIN_PICKER).not.toContain("aria-label=");
    // Each seat hands the picker the baseline the server will judge by.
    const card = COVER;
    expect(card).toMatch(
      /const \{ baselineMmr, lowerOut \} = baselineOf\(m\.userId\);/,
    );
    expect(card).toMatch(/baselineMmr: seatBaseline,\s*emptySeat: true,/);
  });

  it("gives a booked standin's row what the captain needs to reach them", () => {
    const card = COVER;
    expect(card).toContain("<PlayerLink userId={a.standin.id}");
    // The handle only on the captain's own bookings, through the policy.
    expect(card).toMatch(
      /a\.teamId === myTeamId &&\s*canViewLeagueContact\(viewer, a\.standin\.id, true\) \? \(\s*a\.standin\.discordName \? \(\s*<DiscordTag/,
    );
    expect(card).toContain('href="/players?status=standin"');
  });

  // A request is not cover: "counts as N MMR" takes a lower absentee out of
  // the baseline only once a booking covers them, as coverBaseline does on
  // the server. A waiting request still takes them off the Covers list.
  it("judges 'counts as' by bookings only, never a waiting request", () => {
    const card = COVER;
    expect(card).toMatch(
      /const bookedIds = new Set\(\s*assignments\.flatMap\(\(a\) => \(a\.replaced \? \[a\.replaced\.id\] : \[\]\)\),\s*\);/,
    );
    expect(card).toMatch(
      /namedCoverBaseline\(\{\s*replaced: [^\n]*\n\s*teammates,\s*outUserIds: outIds,\s*coveredUserIds: bookedIds,\s*\}\)/,
    );
    expect(card).toMatch(
      /const coveredIds = new Set\(\[\s*\.\.\.bookedIds,\s*\.\.\.requests\.flatMap/,
    );
  });

  it("leads the Covers list with uncovered out players, pre-selecting a lone one", () => {
    expect(COVER).toMatch(/const cover = coverChoices\(\s*roster,/);
    // Out players, then an empty seat, then the rest of the roster.
    expect(COVER).toMatch(
      /const coverOptions: StandinPickerCoverOption\[\] = \[\s*\.\.\.cover\.choices\.filter\(\(c\) => c\.out\)[\s\S]*?value: seatValue\(myTeamId\),[\s\S]*?\.filter\(\(c\) => !c\.out\)/,
    );
    // Remounted when the pre-selection changes: the picker keeps its first
    // choice otherwise.
    expect(COVER).toMatch(
      /<StandinPicker\s+key=\{cover\.preselect \?\? ""\}[\s\S]*?preselect=\{cover\.preselect\}/,
    );
    expect(STANDIN_PICKER).toContain("useState(preselect ?? \"\")");
    expect(COVER).toContain(`out ? " · can't make it" : ""`);
  });
});

describe("the Standins page's sections", () => {
  it("gives a captain their team's cover and never lists their sides twice", () => {
    expect(FOLDER).toContain("getCaptainTeam(season.id, viewer.id)");
    expect(FOLDER).toContain("<TeamCover");
    expect(FOLDER).toMatch(
      /const others = needs\.filter\(\(n\) => n\.teamId !== myTeam\?\.id\);/,
    );
    // The next fixture always, later ones once something is happening.
    expect(FOLDER).toMatch(
      /\(m, i\) =>\s*i === 0 \|\|\s*m\.id === focusMatchId \|\|\s*busy\.has\(m\.id\) \|\|\s*needs\.has\(/,
    );
  });

  it("gives a standin their own games, with the check-in that gives a seat back", () => {
    expect(FOLDER).toContain("<MyStandinGames");
    expect(FOLDER).toMatch(/standinViewer =\s*!!offerViewer && offerViewer\.activeSignup && !offerViewer\.rostered/);
    expect(FOLDER).toContain("<CheckinBanner");
    // The banner asks before a standin's "Can't make it" gives the seat back.
    expect(
      stripLineComments(sourceFile("src/components/checkin-banner.tsx").text),
    ).toMatch(
      /side\?\.role === "standin" && !remainingGames && myRsvp !== "OUT"\s*\? standinGiveUpConfirm\(side\.teamName\)/,
    );
  });

  it("shows contact only through the shared policy", () => {
    // The booked standin's row and each standin who said they can play.
    expect(COVER.match(/<DiscordTag\b/g)).toHaveLength(2);
    expect(COVER).toMatch(
      /canViewLeagueContact\(viewer, reg\.userId, true\) &&\s*reg\.user\.discordName \? \(\s*<DiscordTag/,
    );
  });
});
