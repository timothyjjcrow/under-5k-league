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
    title: "What you can do today",
    blurb: "You don't have to wait for the next season to get involved.",
    phases: [],
    features: [
      {
        icon: "⚔️",
        title: "Inhouse pick-up games",
        desc: "Queue with nine other players, vote on the draft format, build teams, and jump into a real match. When it ends, the stats, MVP, and box score are already waiting.",
        href: "/inhouse",
      },
      {
        icon: "🏛️",
        title: "Hall of Fame",
        desc: "Championships, career records, fantasy legends, and the players who backed up the trash talk. Every season adds to it.",
        href: "/hall-of-fame",
      },
      {
        icon: "🪪",
        title: "Player profiles",
        desc: "Every player has a career — heroes, seasons, teams, awards, badges. Whether you're scouting a teammate or proving you're better than your friends, it's all there.",
        href: "/players",
      },
      {
        icon: "📣",
        title: "Live Discord updates",
        desc: "Signups, draft picks, match results, playoff drama — it all lands in the Discord as it happens, so nobody misses anything.",
      },
    ],
  },
  {
    id: "signups",
    kicker: "Step 1 — Signups",
    title: "Getting in takes about a minute",
    blurb: "No account to create, no password to forget.",
    phases: ["SIGNUPS"],
    features: [
      {
        icon: "🎮",
        title: "Sign in with Steam",
        desc: "No new account, no password — your Steam profile, avatar, and ranked medal are imported automatically.",
      },
      {
        icon: "📝",
        title: "Tell captains who you are",
        desc: "Pick your positions, list your favorite heroes, leave a note — it's all on screen while captains decide whether to spend their budget on you.",
      },
      {
        icon: "🔁",
        title: "Returning players",
        desc: "Played before? Your form arrives pre-filled from last season. Update what changed and you're in.",
      },
      {
        icon: "🧢",
        title: "Built for Under 4.5K",
        desc: "Every season can set a hard MMR cap, so the league starts from a level playing field.",
      },
    ],
  },
  {
    id: "draft",
    kicker: "Step 2 — Draft night",
    title: "A live auction, not a spreadsheet",
    blurb:
      "Captains nominate, fight over bids, and try to build the best roster before the clock runs out.",
    phases: ["DRAFT"],
    features: [
      {
        icon: "🔨",
        title: "Live bidding, real clock",
        desc: "Every bid changes the room. Run out of money too early and you'll regret it; wait too long and your favorite player is gone.",
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
        title: "Every pick has receipts",
        desc: "Biggest steal, worst overpay, fastest budget collapse — the draft recap remembers everything.",
        href: "/teams",
        livePhases: POST_DRAFT,
      },
    ],
  },
  {
    id: "season",
    kicker: "Step 3 — Regular season",
    title: "You play Dota. The site handles everything else.",
    blurb:
      "Your matches are pulled straight from the game and turned into box scores, standings, and arguments.",
    phases: ["REGULAR_SEASON"],
    features: [
      {
        icon: "📊",
        title: "Automatic match stats",
        desc: "As soon as your match finishes, the site pulls the data — heroes, KDA, net worth, gold. Everything you'd expect from a professional league.",
        href: "/schedule",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "📈",
        title: "Power rankings",
        desc: "Standings only tell part of the story. Power rankings move every week and give everyone something to argue about.",
        href: "/teams",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🥇",
        title: "Weekly awards",
        desc: "Player of the Week, Team of the Week, league leaders — every week gives you something new to chase.",
        href: "/leaders",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🏅",
        title: "Career badges",
        desc: "Deathless wins, kill streaks, milestones, championships — every season adds to your legacy.",
        href: "/leaders",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🧙",
        title: "Fantasy league",
        desc: "Build a roster under a salary cap and score points off real league matches. Suddenly you're cheering for players you'd normally want to beat.",
        href: "/fantasy",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "🔮",
        title: "Pick'em",
        desc: "Predict every match and climb the oracle board — then watch everyone discover how hard predicting Dota really is.",
        href: "/pickem",
        livePhases: MID_SEASON.concat("COMPLETE"),
      },
      {
        icon: "✅",
        title: "Match check-in",
        desc: "One tap tells your captain you're available, so standins get arranged early instead of five minutes before game time.",
        href: "/schedule",
        livePhases: MID_SEASON,
      },
      {
        icon: "📅",
        title: "Calendar sync",
        desc: "Subscribe once and every scheduled match appears in your own calendar. No screenshots, no forgotten game nights.",
        href: "/schedule",
        livePhases: MID_SEASON,
      },
    ],
  },
  {
    id: "playoffs",
    kicker: "Step 4 — Playoffs & legacy",
    title: "This is what the regular season was for",
    blurb:
      "One bad night and you're done. Win it all and your team becomes league history.",
    phases: ["PLAYOFFS", "COMPLETE"],
    features: [
      {
        icon: "🏆",
        title: "Live bracket",
        desc: "Follow every playoff series from the first round to the grand final as results fill in automatically.",
        href: "/schedule",
        livePhases: ["PLAYOFFS", "COMPLETE"],
      },
      {
        icon: "🎬",
        title: "Season recap",
        desc: "When it's over, the site writes it up — the champion's run, the awards, the moments everyone will remember.",
        href: "/recap",
        livePhases: ["COMPLETE"],
      },
      {
        icon: "📜",
        title: "The record book",
        desc: "Every season stays online forever — standings, drafts, rosters, playoffs. Years later, you settle arguments with proof instead of memory.",
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
          You&apos;re only seeing half the league
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-muted sm:text-lg">
          Most people land here, see the inhouses, and think that&apos;s all
          there is. It isn&apos;t — inhouses are just what happens between
          seasons. The real league starts when signups open.
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
      <ol className="mb-4 flex flex-wrap items-center justify-center gap-x-1 gap-y-2 text-xs sm:text-sm">
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
      <p className="mb-10 text-center text-sm text-muted">
        Every season writes its own story — rivalries, upsets, breakout
        players, championship runs. None of it disappears.
      </p>

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
