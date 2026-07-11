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
    "Everything waiting inside the league — auction draft night, automatic match stats, fantasy, pick'em, power rankings, inhouses, and a record book that never forgets.",
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
    kicker: "Between seasons",
    title: "The league never goes offline",
    blurb: "There's always something happening.",
    phases: [],
    features: [
      {
        icon: "⚔️",
        title: "Inhouses",
        desc: "Queue with nine players, draft teams, play. When the Ancient falls, the stats and MVP are already posted.",
        href: "/inhouse",
      },
      {
        icon: "🪪",
        title: "Player profiles",
        desc: "Seasons, teams, awards, badges — all attached to your profile. Your career grows every time you play.",
        href: "/players",
      },
      {
        icon: "🏛️",
        title: "Hall of Fame",
        desc: "Champions. Career leaders. Historic seasons.",
        href: "/hall-of-fame",
      },
      {
        icon: "📣",
        title: "Discord integration",
        desc: "Signups, draft sales, results, playoffs — posted automatically. No one misses anything.",
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
        desc: "Preferred roles. Favorite heroes. Anything you want captains to know before draft night.",
      },
      {
        icon: "🔁",
        title: "Returning players",
        desc: "Your previous info is already there. Update what changed. Done.",
      },
      {
        icon: "🧢",
        title: "Built for Under 4.5K",
        desc: "A hard MMR cap every season. Even footing for everyone.",
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
        desc: "Every nomination matters. Every bid changes the room.",
        href: "/draft",
        livePhases: ["DRAFT"],
      },
      {
        icon: "⚖️",
        title: "Balanced budgets",
        desc: "Lower-MMR captains get bigger budgets. Every team has a real shot.",
      },
      {
        icon: "🧾",
        title: "Draft recap",
        desc: "Steals. Overpays. Budget disasters. The draft remembers everything.",
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
      "A match ends. Standings, stats, awards, history — everything updates on its own.",
    phases: ["REGULAR_SEASON"],
    features: [
      {
        icon: "📊",
        title: "Automatic match pages",
        desc: "Heroes. KDA. Net worth. Every match, straight from the game.",
        href: "/schedule",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "📈",
        title: "Power rankings",
        desc: "Standings tell you who won. Power rankings tell everyone who looks dangerous.",
        href: "/teams",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🥇",
        title: "Weekly awards",
        desc: "Player of the Week. Team of the Week. League leaders. Crowned automatically.",
        href: "/leaders",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🏅",
        title: "Career badges",
        desc: "Milestones. Championships. Perfect games. Your legacy adds up.",
        href: "/leaders",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🧙",
        title: "Fantasy",
        desc: "Draft players under a salary cap. Score points from real league matches.",
        href: "/fantasy",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🔮",
        title: "Pick'em",
        desc: "Predict every result. Climb the leaderboard. Talk trash.",
        href: "/pickem",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "✅",
        title: "Availability check-in",
        desc: "One click says you're in. No last-minute scrambling.",
        href: "/schedule",
        livePhases: MID_SEASON,
      },
      {
        icon: "📅",
        title: "Calendar sync",
        desc: "Subscribe once. Every match lands in your calendar.",
        href: "/schedule",
        livePhases: MID_SEASON,
      },
    ],
  },
  {
    id: "playoffs",
    kicker: "4 — Playoffs",
    title: "Win — or your season is over",
    blurb: "Single elimination. No second chances.",
    phases: ["PLAYOFFS", "COMPLETE"],
    features: [
      {
        icon: "🏆",
        title: "Live bracket",
        desc: "First round to grand final, updating automatically.",
        href: "/schedule",
        livePhases: ["PLAYOFFS", "COMPLETE"],
      },
      {
        icon: "🎬",
        title: "Season recap",
        desc: "Awards. Storylines. The championship run. One page that remembers the season.",
        href: "/recap",
        livePhases: ["COMPLETE"],
      },
      {
        icon: "📜",
        title: "Permanent record book",
        desc: "Nothing disappears. The draft, the standings, the bracket, the champions — still there years from now.",
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
          Everything the league offers
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-muted sm:text-lg">
          Inhouses. Draft night. Weekly matches. Playoffs. A record book that
          never forgets. Here&apos;s the full tour.
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
      <p className="mb-3 text-center text-sm text-muted">
        Every season follows the same journey.
      </p>
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
