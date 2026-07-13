import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { shareMetadata } from "@/lib/share-metadata";
import { heroById } from "@/lib/heroes";
import {
  Badge,
  Card,
  DiscordButton,
  HeroIcon,
  KDA,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { SeasonStatus } from "@/lib/constants";

export const metadata = shareMetadata(
  "Features",
  "Everything waiting inside the league — auction draft night, hero report cards, scouting dossiers, a playoff scenario engine, fantasy, pick'em, inhouses, and a record book that never forgets.",
);

// The tour is static content. Phases where a feature's page actually has
// something to show are listed so we can mark what's "open now" for the
// current season (an empty list = always available).
type Feature = {
  icon: string;
  title: string;
  desc: string;
  href?: string;
  livePhases?: SeasonStatus[];
};

type Section = {
  id: string;
  kicker: string;
  title: string;
  blurb: string;
  phases: SeasonStatus[]; // which season phases this chapter covers
  features: Feature[];
};

const MID_SEASON: SeasonStatus[] = ["REGULAR_SEASON", "PLAYOFFS"];
const MID_PLUS: SeasonStatus[] = ["REGULAR_SEASON", "PLAYOFFS", "COMPLETE"];
const POST_DRAFT: SeasonStatus[] = [
  "DRAFT",
  "REGULAR_SEASON",
  "PLAYOFFS",
  "COMPLETE",
];

const SECTIONS: Section[] = [
  {
    id: "always-on",
    kicker: "Between seasons",
    title: "The league never goes offline",
    blurb: "No season required — there's always something happening.",
    phases: [],
    features: [
      {
        icon: "⚔️",
        title: "Inhouses",
        desc: "Queue with nine players, vote how captains are chosen, draft, play. Results auto-detect from Dota and the Elo ladder updates itself.",
        href: "/inhouse",
      },
      {
        icon: "🪪",
        title: "Player profiles",
        desc: "Seasons, teams, trophies, achievements, career stats, report card — everything you've ever done in the league, on one page.",
        href: "/players",
      },
      {
        icon: "⚖️",
        title: "Player comparison",
        desc: "Any two players, head to head: rivalry record, career numbers side by side, signature heroes. Settle the argument.",
        href: "/players/compare",
      },
      {
        icon: "🏛️",
        title: "Hall of Fame",
        desc: "Career titles, series wins, all-time fantasy points, the league's best oracle. Legacies, ranked.",
        href: "/hall-of-fame",
      },
      {
        icon: "📜",
        title: "Record book",
        desc: "Most kills in a game. Fastest win. Biggest stomp. Records stand across every season until someone breaks them.",
        href: "/records",
      },
      {
        icon: "📣",
        title: "Discord integration",
        desc: "Signups, draft sales, results, playoffs, champions, league news — announced automatically. No one misses anything.",
      },
    ],
  },
  {
    id: "signups",
    kicker: "1 — Signups",
    title: "Getting in takes about a minute",
    blurb: "No new account. No password. Just sign in with Steam.",
    phases: ["SIGNUPS"],
    features: [
      {
        icon: "🎮",
        title: "Steam login",
        desc: "Your profile, avatar, and ranked medal import automatically.",
      },
      {
        icon: "📝",
        title: "Tell captains about yourself",
        desc: "Preferred roles. Favorite heroes. A note to the drafters. Everything captains see on draft night.",
      },
      {
        icon: "🔁",
        title: "Returning players",
        desc: "Your previous info is already filled in. Update what changed. Done.",
      },
      {
        icon: "🧢",
        title: "Built for Under 4.5K",
        desc: "4.5K is a soft limit, not a hard cap. Over it? We review case by case — the real line is keeping out Immortals and anyone past 5K.",
      },
    ],
  },
  {
    id: "draft",
    kicker: "2 — Draft night",
    title: "Every player is up for auction",
    blurb:
      "Limited budgets. Live bids. Spend too early — or wait too long — and someone steals your player.",
    phases: ["DRAFT"],
    features: [
      {
        icon: "🔨",
        title: "Live bidding",
        desc: "A server-authoritative auction clock. Every nomination matters; every bid changes the room.",
        href: "/draft",
        livePhases: ["DRAFT"],
      },
      {
        icon: "⚖️",
        title: "Balanced budgets",
        desc: "Lower-MMR captains get bigger budgets, scaled to the captain gap. Every team has a real shot.",
      },
      {
        icon: "🔎",
        title: "A scoutable pool",
        desc: "Search, role filters, MMR sorting, ranked medals, and every player's note to captains — right in the draft room.",
      },
      {
        icon: "🧾",
        title: "Draft recap",
        desc: "Biggest spend. Best value steal. Budget disasters. The draft remembers everything.",
        href: "/teams",
        livePhases: POST_DRAFT,
      },
    ],
  },
  {
    id: "season",
    kicker: "3 — Regular season",
    title: "You play Dota. We'll handle the league.",
    blurb:
      "A match ends. Box scores, standings, stats, awards, storylines — everything updates on its own.",
    phases: ["REGULAR_SEASON"],
    features: [
      {
        icon: "📊",
        title: "Automatic box scores",
        desc: "Heroes, KDA, net worth, MVP of every game — pulled straight from Dota. Nobody types in results.",
        href: "/schedule",
        livePhases: MID_PLUS,
      },
      {
        icon: "🎓",
        title: "Hero report cards",
        desc: "Every performance graded S to D against the world's players on that hero. Know exactly what to work on.",
        href: "/leaders",
        livePhases: MID_PLUS,
      },
      {
        icon: "🕵️",
        title: "Scouting reports",
        desc: "Before every match: the enemy's comfort heroes, a ban board, and how fast their games run. Know your enemy.",
        href: "/schedule",
        livePhases: MID_SEASON,
      },
      {
        icon: "🎯",
        title: "The scenario engine",
        desc: "\"Win and you're in.\" Magic numbers, elimination math, and playoff odds computed across every possible remaining outcome.",
        href: "/schedule",
        livePhases: ["REGULAR_SEASON"],
      },
      {
        icon: "🗺️",
        title: "The season grid",
        desc: "Who's played who, at a glance — every meeting's result in one map of the season.",
        href: "/schedule",
        livePhases: MID_PLUS,
      },
      {
        icon: "📈",
        title: "Power rankings",
        desc: "Standings tell you who won. Elo-based power rankings tell everyone who looks dangerous.",
        href: "/teams",
        livePhases: MID_PLUS,
      },
      {
        icon: "🥇",
        title: "Weekly honors & leaders",
        desc: "Player and Team of the Week crowned automatically, plus leaderboards for every stat that matters.",
        href: "/leaders",
        livePhases: MID_PLUS,
      },
      {
        icon: "🧙",
        title: "Fantasy",
        desc: "Draft your fantasy five under an MMR salary cap. Score points from real league games all season.",
        href: "/fantasy",
        livePhases: MID_PLUS,
      },
      {
        icon: "🔮",
        title: "Pick'em",
        desc: "Predict every result, watch the community split, climb the oracle board. Trash talk included.",
        href: "/pickem",
        livePhases: MID_PLUS,
      },
      {
        icon: "🧪",
        title: "Hero meta report",
        desc: "The league's own meta: pick rates, win rates, most-contested heroes, and who owns each one.",
        href: "/meta",
        livePhases: MID_PLUS,
      },
      {
        icon: "✅",
        title: "Match-night logistics",
        desc: "One-click check-ins, standins for no-shows, captain-to-captain rescheduling. The admin never has to chase anyone.",
        href: "/schedule",
        livePhases: MID_SEASON,
      },
      {
        icon: "📅",
        title: "Calendar sync",
        desc: "Subscribe once. Every match lands in your calendar, in your timezone.",
        href: "/schedule",
        livePhases: MID_SEASON,
      },
    ],
  },
  {
    id: "playoffs",
    kicker: "4 — Playoffs",
    title: "Win — or your season is over",
    blurb: "Single elimination. Seeds locked from the final table. No second chances.",
    phases: ["PLAYOFFS", "COMPLETE"],
    features: [
      {
        icon: "🏆",
        title: "The bracket",
        desc: "A classic tournament tree — two wings converging on the grand final, updating live as winners advance. Tap a team to trace its run.",
        href: "/schedule",
        livePhases: ["PLAYOFFS", "COMPLETE"],
      },
      {
        icon: "🎬",
        title: "Season recap",
        desc: "Awards, superlatives, the championship run — one page that tells the season's story.",
        href: "/recap",
        livePhases: ["COMPLETE"],
      },
      {
        icon: "📚",
        title: "Permanent history",
        desc: "The draft, the standings, the bracket, the champion — archived forever, browsable season by season.",
        href: "/seasons",
      },
    ],
  },
];

// The five-step journey strip under the intro.
const JOURNEY: { label: string; phases: SeasonStatus[] }[] = [
  { label: "Sign up", phases: ["SIGNUPS"] },
  { label: "Get drafted", phases: ["DRAFT"] },
  { label: "Play weekly", phases: ["REGULAR_SEASON"] },
  { label: "Make playoffs", phases: ["PLAYOFFS"] },
  { label: "Become league history", phases: ["COMPLETE"] },
];

// "Pick your obsession" — one door per kind of degenerate.
const OBSESSIONS: {
  icon: string;
  title: string;
  desc: string;
  links: { label: string; href: string }[];
}[] = [
  {
    icon: "🏅",
    title: "The competitor",
    desc: "Standings, clinch marks, and exactly what your team needs tonight.",
    links: [
      { label: "Standings", href: "/schedule" },
      { label: "Teams", href: "/teams" },
    ],
  },
  {
    icon: "🤓",
    title: "The stat nerd",
    desc: "Report cards, leaderboards, the league meta, and all-time records.",
    links: [
      { label: "Leaders", href: "/leaders" },
      { label: "Meta", href: "/meta" },
      { label: "Records", href: "/records" },
    ],
  },
  {
    icon: "🔮",
    title: "The oracle",
    desc: "Call every series in pick'em and run a fantasy five on the side.",
    links: [
      { label: "Pick'em", href: "/pickem" },
      { label: "Fantasy", href: "/fantasy" },
    ],
  },
  {
    icon: "🏛️",
    title: "The historian",
    desc: "Champions, careers, and every season preserved exactly as it ended.",
    links: [
      { label: "Hall of Fame", href: "/hall-of-fame" },
      { label: "Past seasons", href: "/seasons" },
    ],
  },
];

export default async function FeaturesPage() {
  const [season, user, players, games, seasonsRun, champions] =
    await Promise.all([
      getActiveSeason(),
      getSessionUser(),
      prisma.user.count(),
      prisma.game.count(),
      prisma.season.count(),
      prisma.season.count({ where: { championTeamId: { not: null } } }),
    ]);
  const phase = (season?.status ?? null) as SeasonStatus | null;

  const isLive = (f: Feature) =>
    !!f.href && (!f.livePhases || (!!phase && f.livePhases.includes(phase)));

  const numbers = [
    { label: "seasons", value: seasonsRun },
    { label: "players", value: players },
    { label: "games on record", value: games },
    { label: "champions crowned", value: champions },
  ].filter((n) => n.value > 0);

  return (
    <div className="mx-auto max-w-4xl">
      {/* Intro — same glow language as a match page hero. */}
      <div className="relative mb-10 overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/60 to-surface/30">
        <div
          aria-hidden
          className="hero-grid pointer-events-none absolute inset-0 opacity-40"
        />
        <div
          aria-hidden
          className="animate-hero-glow pointer-events-none absolute -left-12 -top-12 h-48 w-48 rounded-full bg-accent/20 blur-3xl"
        />
        <div
          aria-hidden
          className="animate-hero-glow-alt pointer-events-none absolute -bottom-16 -right-10 h-56 w-56 rounded-full bg-info/15 blur-3xl"
        />
        <div className="relative px-6 py-10 text-center sm:py-14">
          <Badge tone="brand" className="mb-4">
            The tour
          </Badge>
          <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
            Everything the league offers
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-muted sm:text-lg">
            An auction draft. Weekly matches that grade themselves. Scouting
            dossiers, playoff math, fantasy, pick&apos;em — and a record book
            that never forgets. Here&apos;s the full tour.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {!user ? (
              <Link href="/login" className={buttonClasses("primary")}>
                Sign in with Steam →
              </Link>
            ) : null}
            <Link href="/inhouse" className={buttonClasses("accent")}>
              Play an inhouse
            </Link>
            <DiscordButton />
          </div>
          {numbers.length > 0 ? (
            <dl className="mx-auto mt-8 flex max-w-xl flex-wrap items-center justify-center gap-x-8 gap-y-3">
              {numbers.map((n) => (
                <div key={n.label} className="flex flex-col text-center">
                  <dt className="order-2 text-[11px] font-medium uppercase tracking-wider text-muted">
                    {n.label}
                  </dt>
                  <dd className="order-1 font-display text-2xl font-bold tabular-nums">
                    {n.value.toLocaleString()}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>

      {/* Journey strip — where the current season is on the road map. */}
      <p className="mb-3 text-center text-sm text-muted">
        Every season follows the same journey.
      </p>
      <ol className="mb-12 flex flex-wrap items-center justify-center gap-x-1 gap-y-2 text-xs sm:text-sm">
        {JOURNEY.map((step, i) => {
          const here = !!phase && step.phases.includes(phase);
          return (
            <li key={step.label} className="flex items-center gap-1">
              {i > 0 ? (
                <span aria-hidden className="px-1 text-muted/50">
                  →
                </span>
              ) : null}
              <span
                className={cn(
                  "whitespace-nowrap rounded-full border px-2.5 py-1",
                  here
                    ? "border-accent/40 bg-accent/15 font-medium text-accent"
                    : "border-line bg-surface-2/50 text-muted",
                )}
              >
                {step.label}
                {here ? " · now" : ""}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Show, don't tell — three flagship features as living mockups. */}
      <section aria-labelledby="features-showcase" className="mb-14">
        <div className="mb-4 text-center">
          <h2
            id="features-showcase"
            className="font-display text-2xl font-semibold"
          >
            Not your average league site
          </h2>
          <p className="mt-1 text-sm text-muted">
            A taste of what match night looks like here.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <ShowcaseReportCard />
          <ShowcaseStakes />
          <ShowcaseBracket />
        </div>
      </section>

      {/* Chapters */}
      <div className="space-y-12 pb-4">
        {SECTIONS.map((section) => {
          const current = !!phase && section.phases.includes(phase);
          return (
            <div key={section.id} className="space-y-12">
              {/* The season chapters get their own act break. */}
              {section.id === "signups" ? (
                <div className="pt-2 text-center">
                  <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted">
                    The season
                  </div>
                  <div className="mt-1 font-display text-2xl font-semibold">
                    Four phases. One champion.
                  </div>
                </div>
              ) : null}
              <section aria-labelledby={`features-${section.id}`}>
                <div className="mb-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-accent">
                      {section.kicker}
                    </span>
                    {current ? (
                      <Badge tone="success">Happening now</Badge>
                    ) : null}
                  </div>
                  <h2
                    id={`features-${section.id}`}
                    className="mt-1 font-display text-2xl font-semibold"
                  >
                    {section.title}
                  </h2>
                  <p className="mt-1 text-sm text-muted">{section.blurb}</p>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {section.features.map((f) => (
                    <FeatureCard key={f.title} feature={f} live={isLive(f)} />
                  ))}
                </div>
              </section>
            </div>
          );
        })}
      </div>

      {/* Pick your obsession */}
      <section aria-labelledby="features-obsessions" className="mb-14 mt-2">
        <div className="mb-4 text-center">
          <h2
            id="features-obsessions"
            className="font-display text-2xl font-semibold"
          >
            Pick your obsession
          </h2>
          <p className="mt-1 text-sm text-muted">
            Everyone finds their own corner of the league.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {OBSESSIONS.map((o) => (
            <Card key={o.title} className="min-w-0 p-4">
              <div className="flex items-center gap-2">
                <span aria-hidden className="text-xl">
                  {o.icon}
                </span>
                <h3 className="font-display text-base font-semibold">
                  {o.title}
                </h3>
              </div>
              <p className="mt-1.5 text-sm text-muted">{o.desc}</p>
              <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                {o.links.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="font-medium text-info hover:underline"
                  >
                    {l.label} →
                  </Link>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* Closing CTA */}
      <div className="mb-4 rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/70 to-surface/40 px-6 py-10 text-center">
        <h2 className="font-display text-2xl font-semibold">
          Ready for next season?
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          {phase === "SIGNUPS"
            ? "Signups take a minute. Grab a spot before draft night."
            : "You'll hear it first in the Discord."}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          {phase === "SIGNUPS" ? (
            <Link
              href={user ? "/me" : "/login"}
              className={buttonClasses("primary")}
            >
              {user ? "Join the season →" : "Sign up with Steam →"}
            </Link>
          ) : null}
          <DiscordButton />
        </div>
      </div>
    </div>
  );
}

// ---------- Showcase mockups ----------
// Hand-built stills of real features, drawn with the same components and
// styles the live pages use — static, no client JS, safe on an empty DB.

function ShowcaseFrame({
  title,
  caption,
  href,
  children,
}: {
  title: string;
  caption: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex min-w-0 flex-col p-4">
      <h3 className="font-display text-base font-semibold">{title}</h3>
      <div className="my-3 flex-1 rounded-lg border border-line/70 bg-surface-2/30 p-3">
        {children}
      </div>
      <p className="text-sm text-muted">
        {caption}{" "}
        <Link href={href} className="whitespace-nowrap font-medium text-info hover:underline">
          See yours →
        </Link>
      </p>
    </Card>
  );
}

const DEMO_GRADES: { short: string; grade: string; tone: string }[] = [
  { short: "GPM", grade: "S", tone: "border-success/40 text-success" },
  { short: "XPM", grade: "A", tone: "border-success/40 text-success" },
  { short: "K/min", grade: "B", tone: "border-accent/40 text-accent" },
  { short: "HD/min", grade: "C", tone: "border-line text-fg/80" },
];

function ShowcaseReportCard() {
  const hero = heroById(8); // Juggernaut
  return (
    <ShowcaseFrame
      title="Every game gets graded"
      caption="OpenDota percentiles turn each performance into a report card vs the world."
      href="/leaders"
    >
      <div className="flex items-center gap-2.5">
        {hero ? <HeroIcon hero={hero} size={30} /> : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">You, next season</div>
          <div className="text-[11px] text-muted">Juggernaut</div>
        </div>
        <KDA kills={11} deaths={2} assists={9} className="shrink-0 text-xs" />
      </div>
      <div
        role="img"
        aria-label="Example report card: overall grade A, farming S, experience A, kills B, hero damage C"
        className="mt-2 flex flex-wrap items-center gap-1"
      >
        <span
          aria-hidden
          className="inline-flex items-center rounded border border-success/40 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-success"
        >
          Report A
        </span>
        {DEMO_GRADES.map((g) => (
          <span
            key={g.short}
            aria-hidden
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] tabular-nums",
              g.tone,
            )}
          >
            {g.short} <b>{g.grade}</b>
          </span>
        ))}
      </div>
    </ShowcaseFrame>
  );
}

function ShowcaseStakes() {
  return (
    <ShowcaseFrame
      title="The math of match night"
      caption="An exact scenario engine turns the run-in into stakes everyone can feel."
      href="/schedule"
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">
        Tonight&apos;s stakes
      </div>
      <div className="mt-0.5 text-sm font-medium">
        Everything on the line: win and in, lose and out
      </div>
      <div className="mt-2 space-y-1.5">
        {[
          { name: "Pudge Patrol", note: "Win and they're in" },
          { name: "Techies Anonymous", note: "Lose and they're out" },
        ].map((t) => (
          <div
            key={t.name}
            className="flex min-w-0 items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-1.5"
          >
            <TeamCrest name={t.name} seed={t.name} size={20} className="shrink-0 rounded-md" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{t.name}</span>
              <span className="block text-xs text-muted">{t.note}</span>
            </span>
          </div>
        ))}
      </div>
    </ShowcaseFrame>
  );
}

// A miniature of the real bracket's centered shape: two semis flanking the
// grand final, trophy on top. Decorative — the live one is interactive.
function ShowcaseBracket() {
  const pill = (name: string, win?: boolean) => (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md border bg-surface-2/50 px-2 py-1",
        win ? "border-amber-400/40" : "border-line",
      )}
    >
      <TeamCrest name={name} seed={name} size={16} className="shrink-0 rounded" />
      <span
        className={cn(
          "min-w-0 truncate text-[11px]",
          win ? "font-semibold" : "text-muted",
        )}
      >
        {name}
      </span>
      {win ? (
        <span aria-hidden className="shrink-0 text-[10px]">
          🏆
        </span>
      ) : null}
    </div>
  );
  return (
    <ShowcaseFrame
      title="A bracket worth printing"
      caption="Playoffs draw the classic tree — wings converging on the grand final."
      href="/schedule"
    >
      <div
        role="img"
        aria-label="Miniature playoff bracket: two semifinals converging on a grand final, champion crowned"
        className="flex h-full items-center justify-center"
      >
        {/* minmax(0,1fr): the wing tracks must shrink below pill content on
            phones so the names truncate instead of widening the page. */}
        <div
          aria-hidden
          className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2"
        >
          <div className="space-y-2">
            {pill("Your Team", true)}
            {pill("The Rival")}
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-2xl drop-shadow-[0_0_10px_rgba(251,191,36,0.4)]">
              🏆
            </span>
            {pill("Your Team", true)}
          </div>
          <div className="space-y-2">
            {pill("Dark Horse")}
            {pill("Cinderella")}
          </div>
        </div>
      </div>
    </ShowcaseFrame>
  );
}

function FeatureCard({ feature, live }: { feature: Feature; live: boolean }) {
  const body = (
    <div className="flex h-full min-w-0 items-start gap-3 p-4">
      <span
        aria-hidden
        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-xl"
      >
        {feature.icon}
      </span>
      <div className="min-w-0">
        <h3 className="font-display text-base font-semibold [overflow-wrap:anywhere]">
          {feature.title}
        </h3>
        <p className="mt-1 text-sm text-muted">{feature.desc}</p>
        {live ? (
          <span className="mt-2 inline-block text-sm font-medium text-accent">
            See it live →
          </span>
        ) : null}
      </div>
    </div>
  );

  // Only link the card when the destination actually has something to show
  // for the current phase — a tour full of empty states sells nothing.
  return live && feature.href ? (
    <Link
      href={feature.href}
      className="block min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <Card interactive className="h-full">
        {body}
      </Card>
    </Link>
  ) : (
    <Card className="h-full min-w-0">{body}</Card>
  );
}
