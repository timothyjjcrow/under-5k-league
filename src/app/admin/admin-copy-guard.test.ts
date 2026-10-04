import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  folderSourceFiles,
  haystackOf,
  sourceFiles,
} from "../../../test/support/source-files";
import { START_REGULAR_SEASON } from "../../lib/admin-next-step";
import { adminMatchRowId } from "../../lib/match-anchors";

/**
 * Copy on /admin must not name a control that doesn't exist.
 *
 * The 2026-07-28 audit found this exact class FOUR times, and it is the most
 * expensive kind of wrong copy here because it appears in recovery
 * instructions: "use Detect games to add it back" (the button is
 * "Auto-fetch games"), "paste these into Add game by match ID" (it is a
 * placeholder reading "Match ID or URL" beside a button reading "Add game"),
 * two webhook fields pointing at a "Remove" that only exists on a third one,
 * and a next-step banner naming "Start next season" for a section called
 * "Season handoff". An admin following one of those is hunting for a
 * button that was never there, in the middle of fixing something.
 *
 * A parse test is the only thing that can catch it: tsc is happy, every unit
 * test passes, and a browser spec only reaches the strings currently on screen.
 */
const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Every file that RENDERS an admin control: each page under /admin and the
 * admin components they mount. Globbed rather than listed, so splitting the
 * admin page into card components keeps every string in view; the floor of 5
 * files (three /admin pages, the rank editor, the import controls) fails the
 * run if a pattern stops matching.
 *
 * Only rendering files count here, never the .ts copy that QUOTES a control:
 * copy naming "the Discord reach card" must not be able to satisfy its own
 * check.
 */
const ADMIN_UI = sourceFiles(
  [
    "src/app/admin/**/*.tsx",
    "src/components/admin-*.tsx",
    "src/components/admin/**/*.tsx",
    "src/components/match-import-controls.tsx",
  ],
  5,
);
const renderedAdmin = haystackOf(ADMIN_UI);

/**
 * Every application source file, where the banned phrases must not appear.
 * Admin copy is written in admin pages, server-action toasts, lib copy
 * builders and shared components alike, so the ban covers all of them: a
 * phrase moved to a new file is still caught.
 */
const ALL_SOURCE = sourceFiles("src/**/*.{ts,tsx,mjs}", 300);
const haystack = haystackOf(ALL_SOURCE);

/**
 * Control names that admin copy is allowed to reference, each with the file
 * that actually renders it. If you rename a control, this list is what fails.
 */
const REFERENCED_CONTROLS: Array<{ quoted: string; rendered: string }> = [
  { quoted: "Auto-fetch games", rendered: "Auto-fetch games" },
  { quoted: "Add game", rendered: "Add game" },
  { quoted: "Match ID or URL", rendered: "Match ID or URL" },
  { quoted: "Season handoff", rendered: "Season handoff" },
  // /seasons sends an admin who wants to reactivate an old season to these
  // two folded options under Season handoff.
  {
    quoted: "Archive without opening the next season",
    rendered: "Archive without opening the next season",
  },
  {
    quoted: "Need to cancel this unfinished season?",
    rendered: "Need to cancel this unfinished season?",
  },
  { quoted: "Remove webhook", rendered: "Remove webhook" },
  { quoted: "Use the league channel instead", rendered: "Use the league channel instead" },
  {
    quoted: "Send alerts to the board channel instead",
    rendered: "Send alerts to the board channel instead",
  },
  { quoted: "Abort draft", rendered: "Abort draft" },
  // Needs attention's lost-lease line sends admins to the runner's button.
  { quoted: "Run maintenance now", rendered: "Run maintenance now" },
  { quoted: "Start draft", rendered: "Start draft" },
  // The pre-draft next-step points at the funnel that names the unlinked.
  { quoted: "Discord reach", rendered: "Discord reach" },
  // The couldn't-check line and the signup chip send admins to its checklist.
  { quoted: "Discord notifications", rendered: "Discord notifications" },
  { quoted: "Start playoffs", rendered: "Start playoffs" },
  { quoted: "Reset playoffs", rendered: "Reset playoffs" },
  { quoted: "Move a match night", rendered: "Move a match night" },
  // The match-night poll card sends a poll's winner here. The card title is a
  // prop string, which the poll card's own prose can't satisfy.
  { quoted: "Schedule & results", rendered: 'title="Schedule & results"' },
  // The next step sends recovery work to the phase card's disclosure.
  { quoted: "Fix the phase", rendered: "Fix the phase" },
  // The Playoffs card sends series lengths to the phase card's setup forms.
  { quoted: "Season settings", rendered: "Season settings" },
  // Reset playoffs and Return to regular season live in this disclosure on
  // the Playoffs card, and the phase card's notes send admins there.
  { quoted: "Fix the bracket", rendered: "Fix the bracket" },
  // withdrawTeam's toast points released standin-pool candidates here.
  { quoted: "Roster moves", rendered: "Roster moves" },
  // The soft MMR limit's hint sends admins to the signup review filter.
  { quoted: "Needs review", rendered: "Needs review (" },
  // releasePlayer's quitter note points at the signup remove control's card.
  { quoted: "Captains & draft", rendered: "Captains & draft" },
  // The unverified-captain-MMR confirm and next-step note send the admin to
  // this disclosure. The rendered form is the JSX entity, which the quoting
  // copy (a plain "&") can never satisfy on its own.
  { quoted: "Edit medal & MMR", rendered: "Edit medal &amp; MMR" },
];

describe("admin copy names only controls that exist", () => {
  it.each(REFERENCED_CONTROLS)(
    "$quoted is rendered somewhere",
    ({ rendered }) => {
      expect(
        renderedAdmin.includes(rendered),
        `Admin copy references “${rendered}”, but no admin page or admin component renders that string. Either the control was renamed and the copy is now lying, or the copy invented a name.`,
      ).toBe(true);
    },
  );

  // The literals that were actually wrong. Named individually so a
  // regression says which one came back rather than "some string matched".
  const BANNED = [
    {
      text: "Detect games",
      why: 'the control is called "Auto-fetch games"',
    },
    {
      text: "Add game by match ID",
      why: 'the control is a "Match ID or URL" box beside an "Add game" button',
    },
    {
      text: "Start next season",
      why: 'the section is called "Season handoff"',
    },
    {
      text: "or use Remove.",
      why: 'only the league webhook has a "Remove webhook" button; the inhouse ones clear via differently-labelled buttons',
    },
    {
      text: "Finish the draft again",
      why: "no control finishes a draft; a reopened auction completes itself when its seats fill or the pool runs out",
    },
  ];

  it.each(BANNED)("does not say “$text” ($why)", ({ text }) => {
    expect(haystack).not.toContain(text);
  });

  // The other repeat offender: copy that asserts something the code contradicts.
  it("never claims starting the draft is irreversible — abortDraft undoes it", () => {
    const draftService = read("src/lib/draft-service.ts");
    expect(
      draftService.includes("NOT_STARTED"),
      "abortDraft should still return a draft to NOT_STARTED",
    ).toBe(true);
    // Scoped to the DRAFT claim on purpose: "This can't be undone" is true of
    // deleting a news post, and a blanket ban would just train people to
    // reword it. These three are the exact strings that were wrong.
    for (const claim of [
      "This can't be undone — captains are locked",
      "ONE-WAY DOOR",
      "create a new season to redraft",
    ]) {
      expect(haystack).not.toContain(claim);
    }
  });

  // maxMmr is a REVIEW threshold, not a block (registration.ts says so in two
  // places). Copy has been wrong in both directions here.
  it("does not claim the soft MMR limit refuses signups", () => {
    const registration = read("src/lib/registration.ts");
    expect(registration).toContain("review threshold, not a block");
    expect(haystack).not.toContain("MMR are refused");
    expect(haystack).not.toContain("are reviewed before joining");
  });

  // The soft limit's review tool: the "over soft limit" chip and the Needs
  // review filter both read Season.maxMmr. signupFlags is unit-tested; this
  // pins that the signup list actually hands it the season's limit, or the
  // flag silently never fires and the hint points at an empty review.
  it("the signup review reads the season's soft MMR limit", () => {
    const page = read("src/app/admin/page.tsx");
    expect(page).toContain("regSignupFlags(p, season.maxMmr)");
    expect(page).toContain("<AdminSignupReview");
    expect(page.match(/maxMmr=\{season\.maxMmr\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  // withdrawGateError refuses a rostered signup and one owing cover on an
  // unplayed match. Both lists used to render "remove" on every such row
  // (mid-season, every drafted player) and every press ended in the refusal.
  // signupRemovalBlockers is unit-tested; this pins that both remove forms
  // sit behind it, and that the confirms no longer describe the refusal.
  it("the signup lists offer remove only where withdrawSignup can take it", () => {
    const page = read("src/app/admin/page.tsx");
    const card = page.slice(page.indexOf("function CaptainControls("));
    expect(card).toMatch(
      /const removalBlockers = signupRemovalBlockers\(\{\s*teams: data\.teams,\s*assignments: data\.assignments,\s*matches: data\.matches,\s*\}\)/,
    );
    let from = 0;
    let forms = 0;
    for (;;) {
      const at = card.indexOf("action={withdrawSignup}", from);
      if (at < 0) break;
      expect(card.slice(Math.max(0, at - 500), at)).toMatch(
        /removalBlockers\.has\([ps]\.userId\) \? \(/,
      );
      from = at + 1;
      forms += 1;
    }
    expect(forms).toBe(2);
    expect(card).not.toContain("Rostered players must be released first");
    expect(card).not.toContain("are refused (remove the assignment first)");
  });

  // The Standins card opens on cover problems only, but the admin's any-team
  // booking (the path for a match whose captains aren't around) must stay
  // one click away: every other open match's assign form lives under this
  // disclosure, and both lists render through the same StandinMatchBlock
  // the match page's Admin tools card uses (admin-match-tools.tsx).
  it("the any-team standin booking stays reachable from the Standins card", () => {
    const page = read("src/app/admin/page.tsx");
    const card = page.slice(
      page.indexOf("function StandinControls("),
      page.indexOf("function AutomationTimestamp("),
    );
    expect(card).toContain('"Assign any match"');
    expect(card).toContain("{problems.map(block)}");
    expect(card).toContain("{wkMatches.map(block)}");
    expect(card).toContain("{playoffRest.map(block)}");
    expect(card).toContain("<StandinMatchBlock");
    const tools = read("src/components/admin-match-tools.tsx");
    expect(
      tools.slice(tools.indexOf("export function StandinMatchBlock(")),
    ).toContain("action={assignStandin}");
  });

  // The REFERENCED_CONTROLS check once read the quoting copy too, and
  // admin-next-step.ts QUOTES "the Discord reach card", so that entry
  // satisfied itself (verified by mutation). It now reads rendering files
  // only, but the words can still appear in rendered prose, so pin the cards'
  // TITLES directly.
  it("the card the pre-draft chase note points at is actually titled that", () => {
    expect(read("src/lib/admin-next-step.ts")).toContain(
      "the Discord reach card names them",
    );
    expect(
      renderedAdmin.includes('title="Discord reach"'),
      'admin-next-step copy points at "the Discord reach card" — if the card was renamed, update the note (and this test), or the admin hunts for a card that is not there',
    ).toBe(true);
    expect(
      renderedAdmin.includes('title="Discord notifications"'),
      'the reach card and signup chips point at the checklist "under Discord notifications" — if that AdminSection was renamed, update them',
    ).toBe(true);
  });

  // The funnel names people and builds the chase post. It must stay out of
  // the collapsed settings section (a weekly people task, not configuration)
  // and render only inside its own streamed card.
  it("the reach funnel renders in its own card, not the Discord settings", () => {
    const page = read("src/app/admin/page.tsx");
    const controls = page.slice(
      page.indexOf("function DiscordControls("),
      page.indexOf("\n}\n", page.indexOf("function DiscordControls(")),
    );
    expect(controls).not.toContain("DiscordReachLine");
    expect(controls).not.toContain("ChaseCopy");
    expect(page).toContain("<DiscordReachCard\n          seasonId={season.id}");
    expect(page).toContain('<AdminAnchor id="adm-reach">');
  });

  // Needs attention's Discord line counts the rostered players and booked
  // standins pings go to, and links here. The card names that same list
  // (it also lists every other unlinked signup), so the admin can find the
  // people the count is about.
  it("the reach card names the people Needs attention counts", () => {
    const page = read("src/app/admin/page.tsx");
    expect(page).toContain(
      "rosterUnlinked={data ? unlinkedRosterFor(season, data) : null}",
    );
    expect(page).toContain(
      "unlinkedRostered: unlinkedRosterFor(season, data)?.length ?? 0",
    );
  });

  // The house rule the Start-draft confirm upgrade exists for: state the real
  // reachability numbers BEFORE the click. discordReachWarning is unit-tested,
  // but nothing behavioural reaches a native confirm dialog — deleting the
  // append would fail no test while silently reverting the feature.
  it("the Start-draft confirm actually carries the Discord reachability line", () => {
    expect(
      renderedAdmin.includes("confirmBase + discordReachWarning(reach)"),
      "StartDraftControl must append discordReachWarning to the confirm — the warning copy is tested, this is the line that makes it reach the admin",
    ).toBe(true);
  });

  // Same shape for the unverified-captain-MMR line, which is DB-only and so is
  // appended to the BASE confirm (both the Suspense fallback and the upgraded
  // button carry it). captainMmrWarning is unit-tested; these pin that it, the
  // per-captain flag and the next-step input actually reach the admin.
  it("the Start-draft confirm, captain rows and next-step banner carry the unverified-MMR check", () => {
    expect(
      renderedAdmin.includes("captainMmrWarning(unverifiedMmr)"),
      "startConfirm must append captainMmrWarning, or the confirm stops naming unverified captains",
    ).toBe(true);
    expect(
      renderedAdmin.includes("unverifiedMmrByTeam.get(t.id)!.reason"),
      "each captain row must render its unverified-MMR reason",
    ).toBe(true);
    expect(
      renderedAdmin.includes("unverifiedCaptainMmrNames: unverifiedCaptainMmrsFor("),
      "adminNextStep must receive the unverified captain names",
    ).toBe(true);
  });

  // The fix the copy prescribes is saving a matching medal in this editor.
  // Pin that the editor still offers a manual medal and still renders on the
  // captain rows, or the copy points at a control that cannot clear the flag.
  it("the Edit medal & MMR editor can still set a manual medal on captain rows", () => {
    const editor = read("src/components/admin-player-rank-editor.tsx");
    expect(editor).toContain('<option value="manual">Manual correction</option>');
    expect(renderedAdmin).toContain(
      "registrationId={captainReg.get(t.captainId)!.id}",
    );
  });

  // In-page links ("Set the league id →") point at collapsed sections. A
  // plain hash only OPENS a collapsed section when the jump bar lists that id
  // (SectionNav reveals on hashchange for its own items), so a link needs both
  // the anchor and the jump-bar entry — otherwise it scrolls to a shut
  // disclosure, or nowhere.
  it("every in-page #adm- link lands on a section the jump bar can open", () => {
    const page = read("src/app/admin/page.tsx");
    const targets = [
      ...new Set([...page.matchAll(/href="#(adm-[a-z-]+)"/g)].map((m) => m[1])),
    ];
    expect(targets).toContain("adm-league");
    for (const id of targets) {
      expect(page.includes(`id="${id}"`), `no element renders id="${id}"`).toBe(true);
      expect(
        page.includes(`id: "${id}"`),
        `#${id} is linked but missing from the jump bar, so the hash cannot open it`,
      ).toBe(true);
    }
  });

  // The next-step line sits under the page title, far from every control, so
  // each step links to the card it names. Same rule as the page's own links:
  // the anchor must exist and be in the jump bar, or the hash lands on a shut
  // section or nowhere.
  it("every next-step link lands on a section the jump bar can open", () => {
    const page = read("src/app/admin/page.tsx");
    const nextStep = read("src/lib/admin-next-step.ts");
    const targets = [
      ...new Set(
        [...nextStep.matchAll(/href: "#(adm-[a-z-]+)"/g)].map((m) => m[1]),
      ),
    ];
    expect(targets).toContain("adm-schedule");
    for (const id of targets) {
      expect(page.includes(`id="${id}"`), `no element renders id="${id}"`).toBe(true);
      expect(
        page.includes(`id: "${id}"`),
        `#${id} is linked from the next step but missing from the jump bar`,
      ).toBe(true);
    }
    expect(page).toContain("href={nextStep.jump.href}");
  });

  // Needs attention links every line to the section that fixes it. The page
  // drops the link when that section is not in this render's jump bar, so a
  // target that is NEVER in it would read as a line with no way to act.
  it("every Needs attention link lands on a section the jump bar can open", () => {
    const page = read("src/app/admin/page.tsx");
    const attention = read("src/lib/admin-attention.ts");
    const targets = [
      ...new Set(
        [...attention.matchAll(/href: "#(adm-[a-z-]+)"/g)].map((m) => m[1]),
      ),
    ];
    expect(targets).toEqual(
      expect.arrayContaining(["adm-automation", "adm-standins", "adm-reach"]),
    );
    for (const id of targets) {
      expect(page.includes(`id="${id}"`), `no element renders id="${id}"`).toBe(true);
      expect(
        page.includes(`id: "${id}"`),
        `#${id} is linked from Needs attention but missing from the jump bar`,
      ).toBe(true);
    }
    expect(page).toContain("<a href={item.href} className={textLink()}>");
  });

  // A jump (chip, next-step link, Needs attention link, news pager) opens
  // the card it lands on. Opening the card's FIRST nested disclosure, the
  // default elsewhere, unfolded Fix the phase, Fix the bracket's reset
  // buttons, Assign any match and a news post's Edit form. On /admin only a
  // folded AdminSection opens with a jump.
  it("a jump opens only a folded section, never a card's own disclosures", () => {
    const page = read("src/app/admin/page.tsx");
    const nav = read("src/components/section-nav.tsx");
    expect(page).toContain('openNested="marked"');
    expect(nav).toContain('"details[data-section-jump]"');
    const adminSection = page.slice(page.indexOf("function AdminSection("));
    expect(adminSection.slice(0, adminSection.indexOf("\n}\n"))).toContain(
      "data-section-jump",
    );
    // AdminSection is the only element that carries the attribute.
    expect(page.match(/^\s*data-section-jump$/gm)).toHaveLength(1);
  });

  // The sticky bar highlights the section in view. When the chips and the
  // cards disagree on order, that highlight jumps backwards while the admin
  // scrolls down, and the bar misdescribes the page.
  it("the jump bar lists sections in the order the page renders them", () => {
    const page = read("src/app/admin/page.tsx");
    const barStart = page.indexOf("const jumpItems");
    const bar = page.slice(barStart, page.indexOf("\n  ];\n", barStart));
    const body = page.slice(page.indexOf("return (", barStart));
    // The in-season branches (the season-record branch comes first in both).
    const seasonBar = bar.slice(bar.indexOf("...(tonight.length > 0"));
    const season = body.slice(body.indexOf(") : season && data ? ("));
    const inOrder = (hay: string, ...needles: string[]) => {
      const at = needles.map((n) => hay.indexOf(n));
      expect(at.every((i) => i >= 0), needles.join(" | ")).toBe(true);
      expect(at, needles.join(" < ")).toEqual([...at].sort((a, b) => a - b));
    };
    // Signups and the draft phase lead with setting up; later phases put
    // it after the season's working cards. Chips and cards branch on the
    // same flag.
    inOrder(seasonBar, "...(setupFirst ? [...setupItems, reachItem] : [])", 'id: "adm-schedule"', 'id: "adm-standins"', "...(setupFirst ? [] : [reachItem])", 'id: "adm-sync"', "...(setupFirst ? [] : setupItems)", 'id: "adm-league"');
    inOrder(season, "{setupFirst ? (", "{setupControls}", "{reachCard}", '<AdminAnchor id="adm-schedule">', '<AdminAnchor id="adm-standins">', "{setupFirst ? null : reachCard}", "{syncCards}", "{setupFirst ? null : setupControls}", "<LeagueControls");
    // The evergreen sections after the season's own.
    inOrder(bar, 'id: "adm-history"', 'id: "adm-automation"', 'id: "adm-discord"', 'id: "adm-activity"', 'id: "adm-poll"', 'id: "adm-news"', 'id: "adm-security"');
    inOrder(body, '<AdminAnchor id="adm-history">', '<AdminAnchor id="adm-automation">', "<DiscordSection />", "<AdminActivity />", "<AdminMatchNightPoll", "<AdminNews ", "<SecurityControls />");
  });

  // Two admin links once sent the admin to /matches/<id>#admin-tools, an id
  // the match page never rendered: they landed at the top of a public page
  // with no admin controls. A link into a match page must name an anchor it
  // renders; a match's own admin row (#adm-match-<id>) must exist here.
  it("admin links into a match land on an anchor that exists", () => {
    // The page and every card file beside it.
    const matchPage = haystackOf(folderSourceFiles("src/app/matches/[id]", 12));
    const anchors = [
      ...new Set(
        [...renderedAdmin.matchAll(/\/matches\/\$\{[^}]+\}#([a-z-]+)/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    for (const id of anchors) {
      expect(matchPage.includes(`id="${id}"`), `/matches/…#${id} has no target`).toBe(
        true,
      );
    }
    const page = read("src/app/admin/page.tsx");
    expect(page).toContain("href={`#adm-match-${item.id}`}");
    // The row takes its id as a prop (the match page renders the same row
    // without one), and adminMatchRowId is the one place the prefix lives.
    expect(page).toContain("id={adminMatchRowId(m.id)}");
    expect(read("src/components/admin-match-tools.tsx")).toMatch(/^\s*id=\{id\}$/m);
    expect(adminMatchRowId("x")).toBe("adm-match-x");
  });

  // The start-of-season step quotes the phase button by name. The label is
  // phaseAdvance's, so the check is that both pages render that name.
  it("the start-of-season step names the button the phase card and draft room render", () => {
    expect(read("src/app/admin/page.tsx")).toContain("{advance.label}");
    expect(read("src/app/draft/page.tsx")).toContain(START_REGULAR_SEASON);
  });

  // The missing-ticket warning is only worth anything if the page wires it.
  it("the page renders the missing-ticket warning from the next step", () => {
    const page = read("src/app/admin/page.tsx");
    expect(page).toContain("hasLeagueTicket: !!season.dotaLeagueId");
    expect(page).toContain("nextStep.ticketWarning");
  });

  // The next step, the Schedule card and the Playoffs card all name how many
  // regular results are missing. Only fixtures past kickoff count; the
  // Playoffs card once printed every unplayed fixture ("3 still needed")
  // beside the others' "1 outstanding".
  it("the Playoffs card counts missing results from kickoff, like the others", () => {
    const page = read("src/app/admin/page.tsx");
    const card = page.slice(page.indexOf("function PlayoffControls("));
    expect(card).toContain(
      "const dueRegular = regularSeasonStatus(regularResultsDue(data.matches, nowMs));",
    );
    const box = card.slice(card.indexOf("dueRegular.pending > 0 ? ("));
    expect(box.slice(0, 900)).toMatch(/⚠ \{dueRegular\.pending\} regular-season result/);
    expect(page).toContain(
      "const due = regularSeasonStatus(regularResultsDue(data.matches, nowMs));",
    );
    expect(page).toContain(
      "outstandingRegularResults: regularResultsDue(data.matches, nowMs).length,",
    );
  });

  // Needs attention links "N rostered players and standins haven't linked
  // Discord" to this card. With rosters but no active signups the card used
  // to answer "Nobody has signed up" and never name them.
  it("the Discord reach card names the unlinked roster Needs attention counts", () => {
    const page = read("src/app/admin/page.tsx");
    const card = page.slice(
      page.indexOf("async function DiscordReachCard("),
      page.indexOf("function DiscordReachLine("),
    );
    const noSignups = card.indexOf("Nobody has signed up for this season yet.");
    const rosterBranch = card.indexOf("rosterUnlinked && rosterUnlinked.length > 0 ? (");
    expect(rosterBranch).toBeGreaterThan(-1);
    expect(rosterBranch).toBeLessThan(noSignups);
    expect(card.slice(rosterBranch, noSignups)).toContain("{cappedNames(rosterUnlinked)}");
  });
});
