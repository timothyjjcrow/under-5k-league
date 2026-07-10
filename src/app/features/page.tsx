import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import {
  Badge,
  Card,
  DiscordButton,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { SeasonStatus } from "@/lib/constants";

export const metadata = {
  title: "Features",
  description:
    "Everything waiting inside the league — auction draft night, real box scores, fantasy, pick'em, power rankings, inhouses, and a record book that never forgets.",
};

// The whole tour is static content. Phases where a feature's page is actually
// reachable are listed so we can mark what's "open now" for the current season
// (an empty list = always available).
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
const POST_DRAFT: SeasonStatus[] = [
  "DRAFT",
  "REGULAR_SEASON",
  "PLAYOFFS",
  "COMPLETE",
];

const SECTIONS: Section[] = [
  {
    id: "always-on",
    kicker: "Always on",
    title: "Things you can do right now",
    blurb: "These don't wait for a season.",
    phases: [],
    features: [
      {
        icon: "⚔️",
        title: "Inhouse pick-up games",
        desc: "Ten people queue, the lobby votes how captains get picked, teams draft, you play. The box score posts itself before anyone's typed \"gg\".",
        href: "/inhouse",
      },
      {
        icon: "🏛️",
        title: "Hall of Fame",
        desc: "Titles, series wins, career fantasy points, and who calls their shots. Get your name in here and it stays.",
        href: "/hall-of-fame",
      },
      {
        icon: "🪪",
        title: "Player profiles",
        desc: "Click any name, anywhere — what they play, how their career's gone, every team they've been on. Great for scouting. Also for gloating.",
        href: "/players",
      },
      {
        icon: "📣",
        title: "Discord announcements",
        desc: "Signups, draft sales, results, playoff drama — it all lands in the Discord as it happens.",
      },
    ],
  },
  {
    id: "signups",
    kicker: "Step 1 — Signups",
    title: "Getting in is the easy part",
    blurb: "No account to create, no password to forget.",
    phases: ["SIGNUPS"],
    features: [
      {
        icon: "🎮",
        title: "Sign in with Steam",
        desc: "One click and you're you — Steam name, avatar, and your real ranked medal everywhere.",
      },
      {
        icon: "📝",
        title: "Tell captains who you are",
        desc: "Your positions, favorite heroes, and a note to captains — on screen in the draft room when you're on the block.",
      },
      {
        icon: "🔁",
        title: "Welcome back",
        desc: "Played before? Your form arrives pre-filled from last season.",
      },
      {
        icon: "🧢",
        title: "The cap is the point",
        desc: "Under 4.5K means under 4.5K — seasons can set a hard MMR ceiling.",
      },
    ],
  },
  {
    id: "draft",
    kicker: "Step 2 — Draft night",
    title: "A live auction, not a spreadsheet",
    blurb:
      "Captains fight over you and pay real (fake) money for your services.",
    phases: ["DRAFT"],
    features: [
      {
        icon: "🔨",
        title: "Live bidding, real clock",
        desc: "Nominate, bid, win — against a ticking clock. If a captain falls asleep on their turn, the draft moves on without them.",
        href: "/draft",
        livePhases: ["DRAFT"],
      },
      {
        icon: "⚖️",
        title: "Underdogs get bigger wallets",
        desc: "Lower-MMR captains start with more budget, so it's not the same two stacked teams every season.",
      },
      {
        icon: "🧾",
        title: "The receipts are public",
        desc: "Who overpaid, who got the steal, who went home broke — the recap keeps score.",
        href: "/teams",
        livePhases: POST_DRAFT,
      },
    ],
  },
  {
    id: "season",
    kicker: "Step 3 — Regular season",
    title: "You play. The site keeps score.",
    blurb:
      "Show up and play Dota — the site turns your matches into box scores, standings, and arguments.",
    phases: ["REGULAR_SEASON"],
    features: [
      {
        icon: "📊",
        title: "Real box scores",
        desc: "Heroes, KDA, net worth for every match, pulled straight from the game — usually found before anyone pastes an ID.",
        href: "/schedule",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "📈",
        title: "Power rankings with receipts",
        desc: "A rating that moves every game, with weekly arrows. \"We're better than our record\" is now checkable.",
        href: "/teams",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🥇",
        title: "Leaders & weekly honors",
        desc: "Leaderboards for everything, plus an automatic Player and Team of the Week. There will be discourse.",
        href: "/leaders",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🏅",
        title: "MVPs & badges",
        desc: "Every game crowns an MVP; careers collect badges — deathless games, 15-kill sprees, 100 career kills.",
        href: "/leaders",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🧙",
        title: "Fantasy league",
        desc: "Draft a fantasy five under a salary cap, then sweat everyone else's games all season.",
        href: "/fantasy",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🔮",
        title: "Pick'em",
        desc: "Call every match, watch the community split, climb the oracle board. Being wrong is public.",
        href: "/pickem",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "✅",
        title: "One-tap check-in",
        desc: "One tap to confirm match night. Captains see who's in; admins line up standins early.",
        href: "/schedule",
        livePhases: MID_SEASON,
      },
      {
        icon: "📅",
        title: "Matches in your calendar",
        desc: "Subscribe once and your games appear in your own calendar. \"I forgot\" retires as an excuse.",
        href: "/schedule",
        livePhases: MID_SEASON,
      },
    ],
  },
  {
    id: "playoffs",
    kicker: "Step 4 — Playoffs & legacy",
    title: "Your wins follow you",
    blurb: "Seasons end. The record book doesn't.",
    phases: ["PLAYOFFS", "COMPLETE"],
    features: [
      {
        icon: "🏆",
        title: "The bracket",
        desc: "Finish high in the table and you're seeded into a live bracket that fills itself in, all the way to a champion.",
        href: "/schedule",
        livePhases: ["PLAYOFFS", "COMPLETE"],
      },
      {
        icon: "🎬",
        title: "The season gets a yearbook",
        desc: "When the season wraps, the site writes it up — the champion's run, the awards, the numbers behind them.",
        href: "/recap",
        livePhases: ["COMPLETE"],
      },
      {
        icon: "📜",
        title: "Nothing gets forgotten",
        desc: "Every season stays browsable forever — standings, brackets, rosters, results. \"Remember season 2?\" Here's proof.",
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
  { label: "Enter the record book", phases: ["COMPLETE"] },
];

export default async function FeaturesPage() {
  const [season, user] = await Promise.all([
    getActiveSeason(),
    getSessionUser(),
  ]);
  const phase = (season?.status ?? null) as SeasonStatus | null;

  const isLive = (f: Feature) =>
    !!f.href && (!f.livePhases || (!!phase && f.livePhases.includes(phase)));

  return (
    <div className="mx-auto max-w-4xl">
      {/* Intro */}
      <div className="py-6 text-center sm:py-10">
        <Badge tone="brand" className="mb-4">
          The tour
        </Badge>
        <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
          You&apos;re only seeing half of it
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-muted sm:text-lg">
          The site only shows what&apos;s happening right now — so most people
          never find draft night, fantasy, or the record book. Here&apos;s the
          whole thing.
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
      </div>

      {/* Journey strip — where the current season is on the road map. */}
      <ol className="mb-10 flex flex-wrap items-center justify-center gap-x-1 gap-y-2 text-xs sm:text-sm">
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

      {/* Chapters */}
      <div className="space-y-12 pb-4">
        {SECTIONS.map((section) => {
          const current = !!phase && section.phases.includes(phase);
          return (
            <section key={section.id} aria-labelledby={`features-${section.id}`}>
              <div className="mb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-accent">
                    {section.kicker}
                  </span>
                  {current ? <Badge tone="success">Happening now</Badge> : null}
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
          );
        })}
      </div>

      {/* Closing CTA */}
      <div className="mb-4 rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/70 to-surface/40 px-6 py-10 text-center">
        <h2 className="font-display text-2xl font-semibold">
          Sound like your kind of league?
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          {phase === "SIGNUPS"
            ? "Signups are open right now — grab a spot before draft night."
            : "Hop in the Discord — you'll hear it first when the next season opens."}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          {phase === "SIGNUPS" ? (
            <Link href={user ? "/me" : "/login"} className={buttonClasses("primary")}>
              Join the season →
            </Link>
          ) : null}
          <DiscordButton />
        </div>
      </div>
    </div>
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
