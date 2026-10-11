import { PrismaClient } from "@prisma/client";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { MID_DB_URL } from "../playwright.midseason.config";
import { serializeInhouseNight } from "../src/lib/inhouse-night";
import {
  expectNoHorizontalOverflow,
  expectNoOverlappingTargets,
  expectTapTargets,
  trackPageErrors,
} from "./helpers";

// The whole inhouse queue on the first screen (Tim, 2026-10-10: "the entire
// queue on the screen when you go to the in-house page, you shouldn't have to
// scroll down", with the little bar where you can opt into a time). On a
// fresh load at scrollY 0, the queue card (status, the join controls or the
// sign-in, every slot, the positions count) sits inside the visible viewport:
// under the 64px header and, below 1024px, above the fixed phone tab bar.
// The bar above the room (the inhouse night's chip and the Play later times)
// shows too whenever there's something on it, one button high, and a row cut
// off at its end carries the edge fade. The "Who's playing" row is one line
// that never spills: a second line there cost a phone its first screen once
// wider type wrapped it.
//
// Every required viewport, signed out, signed in (with and without a league
// signup's MMR) and queued, with 0, 1, 6 and 9 players present, with and
// without an open Play later time and a planned inhouse night. A phone with
// Safari's toolbars showing (390x664: what an iPhone 12 to 15 shows on first
// load; Tim, 2026-10-11, "yes do the phone pass") and laptop browser windows
// (1280x690 and 1366x657: a screen less the tabs, the address bar and the
// dock) are required for every state; 375x667 (an old small phone) for
// signed out, and measured and printed signed in. 1440x790 is measured and
// printed, never asserted. The queue, times, signup and night are written
// straight to the suite's database and removed afterwards. A zz- spec
// because it writes state /inhouse renders.
//
// Type width: CI's Linux runner draws the page in DejaVu Sans, wider than a
// Mac's SF Pro. FIT_FONT=Verdana (a close stand-in for DejaVu's widths) runs
// the spec with the page's body font forced to it, so a Mac sees what CI
// will: `FIT_FONT=Verdana npx playwright test --config
// playwright.midseason.config.ts e2e-mid/zz-inhouse-queue-fit.spec.ts`.

const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });

/** SETTING_KEYS.INHOUSE_NIGHT: src/lib/settings.ts imports the app's Prisma client. */
const NIGHT_KEY = "inhouseNight";

const HEADER_PX = 64;
const BAR_MAX_PX = 64;
const MIN = 60_000;
const QUARTER = 15 * MIN;

/**
 * Each size, and whether the queue must fit there (`required`: for every
 * viewer, for the signed-out viewer only, or for none) or is only measured
 * and printed. Every viewer is loaded at every size.
 */
const VIEWPORTS: {
  width: number;
  height: number;
  required: "all" | "out" | "none";
}[] = [
  { width: 390, height: 844, required: "all" },
  // A 390 phone with Safari's toolbars showing: the header, the bar and
  // the whole card between its 64px header and its tab bar.
  { width: 390, height: 664, required: "all" },
  { width: 430, height: 932, required: "all" },
  { width: 768, height: 1024, required: "all" },
  { width: 1280, height: 800, required: "all" },
  { width: 1440, height: 900, required: "all" },
  { width: 1920, height: 1080, required: "all" },
  { width: 1366, height: 768, required: "all" },
  // A laptop's browser window, not its screen: the tabs, the address bar
  // and the dock take 110px or so (Tim's goal is a real window).
  { width: 1280, height: 690, required: "all" },
  { width: 1366, height: 657, required: "all" },
  // An old small phone: required signed out, printed signed in.
  { width: 375, height: 667, required: "out" },
  // Reported only: a bigger laptop window.
  { width: 1440, height: 790, required: "none" },
];

type Viewer = "out" | "new" | "signup" | "queued";
/** Whether the queue must fit this viewer at this size. */
const requiredFor = (viewport: (typeof VIEWPORTS)[number], viewer: Viewer) =>
  viewport.required === "all" || (viewport.required === "out" && viewer === "out");
const VIEWERS: Record<Exclude<Viewer, "out">, { name: string; steamId: string }> = {
  new: { name: "Fit Newcomer", steamId: "76561190000996101" },
  signup: { name: "Fit Signed Up", steamId: "76561190000996102" },
  queued: { name: "Fit Queued Player", steamId: "76561190000996103" },
};

// Eight other players, names short and long, positions none to all five
// (the last, at #9 with nine present, has all five: the widest slot row).
const OTHERS = [
  { name: "x", roles: "1,2,3,4,5", mmr: 6100 },
  { name: "Roshan Enjoyer Supreme", roles: "4,5", mmr: 3200 },
  { name: "mid or feed", roles: "2", mmr: 5400 },
  { name: "AnAbsurdlyLongDotaNameThatGoesOnAndOn", roles: "5,4,3,2,1", mmr: 0 },
  { name: "Support Andy", roles: "", mmr: 2800 },
  { name: "Carry", roles: "1,3", mmr: 4700 },
  { name: "Offlaner 3000", roles: "3", mmr: 3900 },
  { name: "Ward Bot", roles: "3,1,4,5,2", mmr: 2100 },
].map((p, i) => ({ ...p, steamId: `7656119000099620${i}` }));

/** How many open Play later times, and whether (and when) a night is planned. */
type Plans = { times: 0 | 1 | 3; night: "none" | "later" | "sooner" };
const PLANS: Plans[] = [
  { times: 0, night: "none" },
  { times: 1, night: "none" },
  { times: 0, night: "later" },
  { times: 1, night: "later" },
];

type Row = {
  viewport: string;
  required: boolean;
  viewer: Viewer;
  present: number;
  plans: string;
  cardTop: number;
  cardBottom: number;
  visibleBottom: number;
  spare: number;
  bar: { top: number; bottom: number; height: number } | null;
};
const rows: Row[] = [];

let nightBefore: string | null = null;
let otherIds: string[] = [];
let queuedId = "";
let signupRegistrationId: string | null = null;

test.beforeAll(async () => {
  nightBefore =
    (await db.setting.findUnique({ where: { key: NIGHT_KEY } }))?.value ?? null;
});

test.afterAll(async () => {
  await db.inhouseQueueEntry.deleteMany({
    where: { userId: { in: [...otherIds, queuedId].filter(Boolean) } },
  });
  await db.inhouseTimeRsvp.deleteMany({ where: { userId: { in: otherIds } } });
  if (signupRegistrationId) {
    await db.registration.deleteMany({ where: { id: signupRegistrationId } });
  }
  await db.user.deleteMany({ where: { steamId: { in: OTHERS.map((p) => p.steamId) } } });
  if (nightBefore === null) {
    await db.setting.deleteMany({ where: { key: NIGHT_KEY } });
  } else {
    await db.setting.update({
      where: { key: NIGHT_KEY },
      data: { value: nightBefore },
    });
  }
  await db.$disconnect();
});

/** The next quarter hour two hours out: a Play later time that's upcoming. */
function timeStart(nowMs: number) {
  return Math.ceil((nowMs + 2 * 60 * MIN) / QUARTER) * QUARTER;
}

async function setPlans(plans: Plans, nowMs: number) {
  await db.inhouseTimeRsvp.deleteMany({ where: { userId: { in: otherIds } } });
  const time = timeStart(nowMs);
  // The first two hours out, any others an hour apart after it.
  await db.inhouseTimeRsvp.createMany({
    data: Array.from({ length: plans.times }, (_, i) => ({
      startsAt: new Date(time + i * 60 * MIN),
      userId: otherIds[1],
    })),
  });
  if (plans.night === "none") {
    await db.setting.deleteMany({ where: { key: NIGHT_KEY } });
    return;
  }
  // Later than the time (the time leads the bar), or an hour sooner.
  const startsAtMs = plans.night === "later" ? time + 22 * 60 * MIN : time - 60 * MIN;
  const value = serializeInhouseNight({
    id: "e2e-queue-fit-night",
    startsAtMs,
    note: "",
    createdAtMs: nowMs,
    revision: 1,
    discordEventId: null,
  });
  await db.setting.upsert({
    where: { key: NIGHT_KEY },
    create: { key: NIGHT_KEY, value },
    update: { value },
  });
}

/** `present` players here: the queued viewer first, then the others. */
async function setQueue(present: number, nowMs: number) {
  await db.inhouseQueueEntry.deleteMany();
  const ids = present > 0 ? [queuedId, ...otherIds.slice(0, present - 1)] : [];
  const mmrOf = new Map(OTHERS.map((p, i) => [otherIds[i], p.mmr]));
  await db.inhouseQueueEntry.createMany({
    data: ids.map((userId, i) => ({
      userId,
      mmr: mmrOf.get(userId) ?? 4500,
      joinedAt: new Date(nowMs - (present - i) * MIN),
      lastSeenAt: new Date(nowMs),
      idleExpiresAt: new Date(nowMs + 3 * 60 * MIN),
    })),
  });
}

/**
 * A context for one viewer. With FIT_FONT set, the page's body font is
 * forced to it (a stand-in for CI's wider DejaVu Sans; the display font,
 * Oswald, is a web font that is the same everywhere).
 */
async function viewerContext(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  const font = process.env.FIT_FONT;
  if (font) {
    await context.addInitScript((family: string) => {
      const css = `:root { --font-sans: "${family}", sans-serif !important; }
        body { font-family: "${family}", sans-serif !important; }`;
      const add = () => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
      };
      if (document.head) add();
      else document.addEventListener("DOMContentLoaded", add, { once: true });
    }, font);
  }
  return context;
}

async function signedIn(browser: Browser, baseURL: string, who: Exclude<Viewer, "out">) {
  const context = await viewerContext(browser, baseURL);
  const page = await context.newPage();
  const { name, steamId } = VIEWERS[who];
  await page.goto(
    `/api/auth/dev?name=${encodeURIComponent(name)}&steamId=${steamId}&redirect=%2Fme`,
  );
  return context;
}

type Measure = {
  card: { top: number; bottom: number } | null;
  visibleBottom: number;
  scrollY: number;
  bar: { top: number; bottom: number; height: number } | null;
  times: { top: number; bottom: number; left: number } | null;
  timeChips: number;
  night: { top: number; bottom: number; left: number; right: number } | null;
  firstTimeAction: { top: number; bottom: number; left: number; right: number } | null;
  nightFirst: boolean | null;
  /** The bar's row: cut off at its end, and whether it shows the end fade. */
  row: { right: number; cutOff: boolean; endFade: boolean } | null;
  /** "Who's playing": its height against its heading's, and any spill. */
  whoRow: { height: number; lineHeight: number; spills: boolean } | null;
  spilledSlots: string[];
  innerWidth: number;
};

async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    const dock = document.querySelector('nav[aria-label="Quick navigation"]');
    const dockShown = !!dock && getComputedStyle(dock).display !== "none";
    const bar = document.getElementById("inhouse-plans");
    const times = document.getElementById("play-later-next");
    const night = bar?.querySelector('section[aria-label="Inhouse night"]') ?? null;
    // The first time's "I'm in" (a button, or a sign-in link signed out).
    const firstTime = times?.querySelector("li");
    const action =
      firstTime?.querySelector("button, a[href^='/login']") ?? firstTime?.querySelector("a") ?? null;
    const card = document.querySelector('section[aria-label="Inhouse queue"]');
    const spilledSlots = [...(card?.querySelectorAll("ul > li") ?? [])]
      .filter((li) => li.scrollWidth > li.clientWidth + 1)
      .map((li) => (li.textContent ?? "").trim().slice(0, 30));
    // The bar's swipeable row is its one child (PlansRow); at load it sits
    // at its start, so anything past its width is cut off at the end.
    const rowEl = bar?.firstElementChild as HTMLElement | null | undefined;
    const who = card?.querySelector<HTMLElement>("[data-who-row]") ?? null;
    const barBox = box(bar);
    const nightBox = box(night);
    const timesBox = box(times);
    return {
      card: box(card),
      visibleBottom: dockShown ? dock!.getBoundingClientRect().top : window.innerHeight,
      scrollY: window.scrollY,
      bar: barBox ? { top: barBox.top, bottom: barBox.bottom, height: barBox.height } : null,
      times: timesBox ? { top: timesBox.top, bottom: timesBox.bottom, left: timesBox.left } : null,
      timeChips: times?.querySelectorAll("li").length ?? 0,
      night: nightBox,
      firstTimeAction: box(action),
      nightFirst: nightBox && timesBox ? nightBox.left < timesBox.left : null,
      row: rowEl
        ? {
            right: rowEl.getBoundingClientRect().right,
            cutOff: rowEl.scrollWidth > rowEl.clientWidth + 1,
            endFade: (rowEl.dataset.edges ?? "").split(" ").includes("end"),
          }
        : null,
      whoRow: who
        ? {
            height: who.getBoundingClientRect().height,
            lineHeight: who.querySelector("h3")!.getBoundingClientRect().height,
            spills: who.scrollWidth > who.clientWidth + 1,
          }
        : null,
      spilledSlots,
      innerWidth: window.innerWidth,
    };
  });
}

/**
 * One fresh load at one viewport: wait for the card, the bar when one is
 * expected and the fonts, then check the first screen. Returns the failures.
 */
async function check(
  page: Page,
  viewport: (typeof VIEWPORTS)[number],
  viewer: Viewer,
  present: number,
  plans: Plans,
): Promise<string[]> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto("/inhouse");
  const card = page.locator('section[aria-label="Inhouse queue"]');
  // A room poll that loses SQLite's write lock answers 500 (production is
  // Postgres); the room retries by itself, so give it the time to.
  await expect(card).toBeVisible({ timeout: 30_000 });
  const expectBar = plans.times > 0 || plans.night !== "none";
  if (expectBar) {
    await expect(page.locator("#inhouse-plans")).toBeVisible();
    // The row has measured its edges (PlansRow, once hydrated).
    await expect(page.locator("#inhouse-plans > [data-edges]")).toHaveCount(1);
  } else await expect(page.locator("#inhouse-plans")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const m = await measure(page);
  const timesText = plans.times === 0 ? "no time" : plans.times === 1 ? "a time" : `${plans.times} times`;
  const label = `${viewport.width}x${viewport.height} ${viewer} ${present} present, ${timesText}, ${
    plans.night === "none" ? "no night" : `night ${plans.night}`
  }`;
  const required = requiredFor(viewport, viewer);
  rows.push({
    viewport: `${viewport.width}x${viewport.height}`,
    required,
    viewer,
    present,
    plans: `${plans.times}/${plans.night}`,
    cardTop: Math.round(m.card!.top),
    cardBottom: Math.round(m.card!.bottom),
    visibleBottom: Math.round(m.visibleBottom),
    spare: Math.round(m.visibleBottom - m.card!.bottom),
    bar: m.bar && {
      top: Math.round(m.bar.top),
      bottom: Math.round(m.bar.bottom),
      height: Math.round(m.bar.height),
    },
  });
  // Reported only: printed in the table, never asserted.
  if (!required) {
    await page.goto("about:blank");
    return [];
  }
  await expectNoHorizontalOverflow(page, label);
  const failures: string[] = [];
  const fail = (what: string) => failures.push(`${label}: ${what}`);
  if (m.scrollY !== 0) fail(`opened scrolled to ${m.scrollY}`);
  if (m.spilledSlots.length > 0) fail(`slot rows spill: ${m.spilledSlots.join(" | ")}`);
  if (m.card!.top < HEADER_PX) fail(`card top ${m.card!.top} is under the header`);
  if (m.card!.bottom > m.visibleBottom + 0.5) {
    fail(`card bottom ${Math.round(m.card!.bottom)} is past the visible bottom ${m.visibleBottom}`);
  }
  // One line, nothing spilling out of it (the filled card only).
  if (m.whoRow && (m.whoRow.height > m.whoRow.lineHeight + 4 || m.whoRow.spills)) {
    fail(
      `"Who's playing" row is ${Math.round(m.whoRow.height)}px for a ${Math.round(m.whoRow.lineHeight)}px line${
        m.whoRow.spills ? ", and spills" : ""
      }`,
    );
  }
  if (expectBar) {
    const bar = m.bar!;
    if (bar.height > BAR_MAX_PX) fail(`bar is ${bar.height}px tall`);
    if (bar.top < HEADER_PX || bar.bottom > m.visibleBottom) fail(`bar off screen (${bar.top}-${bar.bottom})`);
    // Cut off at its end, the row says so with the edge fade.
    if (m.row?.cutOff && !m.row.endFade) fail("the bar's row is cut off with no edge fade");
    if (plans.times > 0) {
      const times = m.times!;
      if (times.top < HEADER_PX || times.bottom > m.visibleBottom) fail("times off screen");
    }
    const inView = (b: { left: number; right: number; top: number; bottom: number } | null) =>
      !!b && b.left >= 0 && b.right <= m.innerWidth + 0.5 && b.top >= HEADER_PX && b.bottom <= m.visibleBottom;
    const timeLeads = plans.times > 0 && plans.night !== "sooner";
    if (plans.times > 0 && plans.night !== "none") {
      if (m.nightFirst !== !timeLeads) fail(`the ${timeLeads ? "time" : "night"} doesn't lead the bar`);
      // Beside the night, two times at most (the link down counts the rest).
      if (m.timeChips > 2) fail(`${m.timeChips} times beside the night`);
      // On a laptop the night's chip, "I'm in" and all, is whole in the bar
      // behind the times.
      if (viewport.width >= 1280 && !(m.night && m.row && m.night.right <= m.row.right + 0.5)) {
        fail("the night chip is cut off at the bar's end");
      }
    }
    if (timeLeads) {
      if (!inView(m.firstTimeAction)) fail("the first time's I'm in isn't fully on screen");
    } else if (plans.night !== "none") {
      if (!inView(m.night)) fail("the night chip isn't fully on screen");
      if (plans.times > 0 && !(m.times && m.times.left < m.innerWidth)) {
        fail("the times don't start on screen");
      }
    }
  }
  if (viewport.width === 390) {
    await expectTapTargets(page, label);
    await expectNoOverlappingTargets(page, label, 'section[aria-label="Inhouse queue"]');
  }
  // Stop this tab's room polling while the other viewers' tabs load.
  await page.goto("about:blank");
  return failures;
}

test.describe.configure({ mode: "serial" });

test("the whole inhouse queue is on the first screen, with the plans bar, at every size", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(30 * 60_000);

  // The players: eight others with their positions, and the three viewers
  // (signed in once, each in their own context). The newcomer and the queued
  // player have a medal, so their MMR note shows; the signup has a league
  // signup's MMR, which replaces the MMR box.
  for (const p of OTHERS) {
    await db.user.upsert({
      where: { steamId: p.steamId },
      create: { steamId: p.steamId, name: p.name, inhouseRoles: p.roles },
      update: { name: p.name, inhouseRoles: p.roles },
    });
  }
  otherIds = (
    await db.user.findMany({
      where: { steamId: { in: OTHERS.map((p) => p.steamId) } },
      select: { id: true, steamId: true },
    })
  )
    .sort((a, b) => a.steamId.localeCompare(b.steamId))
    .map((u) => u.id);
  const contexts: Record<Viewer, BrowserContext> = {
    out: await viewerContext(browser, baseURL!),
    new: await signedIn(browser, baseURL!, "new"),
    signup: await signedIn(browser, baseURL!, "signup"),
    queued: await signedIn(browser, baseURL!, "queued"),
  };
  const ids = Object.fromEntries(
    (
      await db.user.findMany({
        where: { steamId: { in: Object.values(VIEWERS).map((v) => v.steamId) } },
        select: { id: true, steamId: true },
      })
    ).map((u) => [u.steamId, u.id]),
  );
  queuedId = ids[VIEWERS.queued.steamId];
  await db.user.updateMany({
    where: { id: { in: [ids[VIEWERS.new.steamId], queuedId] } },
    data: { rankTier: 45 },
  });
  // The fullest own row: "You" and all five positions.
  await db.user.update({ where: { id: queuedId }, data: { inhouseRoles: "2,1,3,4,5" } });
  const season = await db.season.findFirstOrThrow({ where: { isActive: true }, select: { id: true } });
  signupRegistrationId = (
    await db.registration.upsert({
      where: { seasonId_userId: { seasonId: season.id, userId: ids[VIEWERS.signup.steamId] } },
      create: { seasonId: season.id, userId: ids[VIEWERS.signup.steamId], mmr: 4350, roles: "2,3" },
      update: { mmr: 4350 },
      select: { id: true },
    })
  ).id;

  const pages = Object.fromEntries(
    await Promise.all(
      (Object.keys(contexts) as Viewer[]).map(async (viewer) => {
        const page = await contexts[viewer].newPage();
        return [viewer, { page, errors: trackPageErrors(page) }] as const;
      }),
    ),
  ) as Record<Viewer, { page: Page; errors: () => void }>;

  const failures: string[] = [];
  for (const plans of PLANS) {
    for (const present of [0, 1, 6, 9]) {
      const nowMs = Date.now();
      await setPlans(plans, nowMs);
      await setQueue(present, nowMs);
      // The queued player is the one present at 1 (with nobody here there is
      // no one queued to view it as).
      const viewers: Viewer[] =
        present === 0
          ? ["out", "new", "signup"]
          : present === 1
            ? ["queued"]
            : ["out", "new", "signup", "queued"];
      // One load at a time: the dev server and its one SQLite file are the
      // bottleneck, and tabs loading side by side stalled a room's poll.
      for (const viewer of viewers) {
        for (const viewport of VIEWPORTS) {
          failures.push(...(await check(pages[viewer].page, viewport, viewer, present, plans)));
        }
      }
    }
  }

  // The night sooner than the time: it leads the bar, whole on screen, and
  // the time starts beside it (a phone swipes to it). Then three times and
  // a later night: two times lead, the link counts the third, and on a
  // laptop the night's chip is whole behind them (a phone swipes, the fade
  // saying there's more).
  for (const plans of [
    { times: 1, night: "sooner" },
    { times: 3, night: "later" },
  ] satisfies Plans[]) {
    const nowMs = Date.now();
    await setPlans(plans, nowMs);
    await setQueue(6, nowMs);
    for (const viewer of ["out", "queued"] as const) {
      for (const viewport of VIEWPORTS) {
        failures.push(...(await check(pages[viewer].page, viewport, viewer, 6, plans)));
      }
    }
  }

  // The measured first screen, for the record: the card's bottom against the
  // visible bottom (negative spare would be a scroll; "report" rows are
  // measured, never asserted).
  console.log(
    [
      `type: ${process.env.FIT_FONT ? `body font forced to ${process.env.FIT_FONT}` : "the browser's own"}`,
      "viewport | | viewer | present | times/night | card top-bottom | visible bottom | spare | bar",
      ...rows.map(
        (r) =>
          `${r.viewport} | ${r.required ? "required" : "report"} | ${r.viewer} | ${r.present} | ${r.plans} | ${r.cardTop}-${r.cardBottom} | ${r.visibleBottom} | ${r.spare} | ${
            r.bar ? `${r.bar.top}-${r.bar.bottom} (${r.bar.height})` : "-"
          }`,
      ),
    ].join("\n"),
  );
  expect(failures).toEqual([]);
  for (const { errors } of Object.values(pages)) errors();
  for (const context of Object.values(contexts)) await context.close();
});
