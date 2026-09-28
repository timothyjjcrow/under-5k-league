import Link from "next/link";
import type { ReactNode } from "react";
import { HeroVideo } from "@/components/hero-video";
import { Badge, LinkArrow, TeamCrest, textLink } from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { GAME_SERVER_REGION } from "@/lib/constants";
import type { DefendingChampion } from "@/lib/official-champion";
import {
  leagueEligibilityLine,
  leaguePitch,
  seasonPhaseLabel,
  seasonPhaseTone,
} from "@/lib/season-copy";
import { cn } from "@/lib/utils";

/**
 * Home's shared hero: the season marquee every phase renders, its step rail,
 * and the lines that sit with it. Each phase fills the hero's slots through a
 * builder in its own view file (signups-view, draft-view, season-view,
 * complete-view); src/app/page.tsx loads the data, picks the phase and draws
 * the one <Hero>.
 */

/** What a phase puts in the hero: its CTA buttons, its counts, its panel. */
export type HeroParts = {
  action?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
};

/** The viewer as the phase builders need them, worked out once by Home. */
export type HomeViewer = {
  user: SessionUser | null;
  /** An ACTIVE signup this season, player or standin. */
  isActiveReg: boolean;
  /** A signup an admin removed. */
  isRemovedReg: boolean;
  /** A designated captain this season. */
  captaining: boolean;
  /** From the draft through the playoffs, with no team and no signup: the
   *  late standin signup is on offer. */
  standinRegistrationOpen: boolean;
};

const PHASE_ORDER = [
  "SIGNUPS",
  "DRAFT",
  "REGULAR_SEASON",
  "PLAYOFFS",
  "COMPLETE",
] as const;

export const PHASE_STEP: Record<string, string> = {
  SIGNUPS: "Signups",
  DRAFT: "Draft",
  REGULAR_SEASON: "Season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Champion",
};

// A single animated hero figure — big count-up number + a muted label, with
// an optional word before the number ("Week 3 of 7").
export function HeroStat({
  value,
  label,
  tone,
  prefix,
}: {
  value: number;
  label: string;
  tone?: "accent";
  prefix?: string;
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      {prefix ? <span className="text-sm text-muted">{prefix}</span> : null}
      <span
        className={cn(
          "font-display text-2xl font-bold tabular-nums sm:text-3xl",
          tone === "accent" ? "text-accent" : "text-fg",
        )}
      >
        {value}
      </span>
      <span className="text-sm text-muted">{label}</span>
    </span>
  );
}

/**
 * The hero is a two-column marquee: the season's identity on the left, and ONE
 * control slot on the right holding whatever this viewer, in this phase, is
 * actually meant to do — the signup CTA, the draft-room door, or (mid-season,
 * where there used to be no call to action at all) their own match check-in.
 *
 * Three things it deliberately keeps from the old centred version: every
 * ambient layer, the phase Badge's exact text node, and the season name as the
 * page's only <h1>. What it drops is 60px of vertical padding and the
 * centre-alignment, which is what made ~250px of prime space carry no action.
 *
 * `aside` is optional — phases without a viewer action let the identity column
 * take the full width. Anything passed as `aside` MUST render something; that
 * is why MyNextMatch has a no-match branch.
 */
export function Hero({
  phase,
  phaseLabel,
  active,
  title,
  subtitle,
  pitch,
  action,
  meta,
  aside,
  rail,
}: {
  phase: string | null;
  phaseLabel?: string;
  active?: boolean;
  title: string;
  /** The phase in one sentence; "" renders nothing. */
  subtitle: string;
  /** What the league is, for a signed-out visitor (see LeaguePitch). */
  pitch?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  rail?: ReactNode;
}) {
  const live = active ?? (!!phase && phase !== "COMPLETE");
  const leagueDashboard = phase === "REGULAR_SEASON";
  const control =
    aside ?? (action ? <HeroActions>{action}</HeroActions> : null);
  return (
    <section className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/70 to-surface/40">
      {/* Looping background video — fades in/out at the loop seam to hide the jump. */}
      <HeroVideo />
      {/* Themed tint over the video for contrast + palette cohesion. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-surface/40 via-bg/45 to-surface/75"
      />
      {/* Layered ambient background: masked grid + dual neon glows. Cropping
          them into a shorter box makes them read MORE, not less. */}
      <div
        aria-hidden
        className="hero-grid pointer-events-none absolute inset-0 opacity-20"
      />
      <div
        aria-hidden
        className="animate-hero-glow pointer-events-none absolute left-1/3 top-0 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/25 blur-3xl"
      />
      <div
        aria-hidden
        className="animate-hero-glow-alt pointer-events-none absolute -right-12 bottom-0 h-48 w-48 translate-y-1/3 rounded-full bg-accent/20 blur-3xl"
      />
      <div
        className={cn(
          "relative grid gap-6 p-5 sm:p-8",
          leagueDashboard
            ? "grid-cols-1 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-x-12"
            : control
              ? "lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-center lg:gap-10"
              : "text-center",
        )}
      >
        <div
          className={cn(
            "min-w-0",
            control || leagueDashboard ? "" : "mx-auto max-w-2xl",
          )}
        >
          <div
            className={cn(
              "flex flex-wrap items-center gap-2",
              control || leagueDashboard ? "" : "justify-center",
            )}
          >
            {phase ? (
              <Badge tone={seasonPhaseTone(phase)}>
                {live ? (
                  <span
                    aria-hidden
                    className="animate-live-pulse mr-0.5 inline-block h-1.5 w-1.5 rounded-full bg-current"
                  />
                ) : null}
                {phaseLabel ?? seasonPhaseLabel(phase)}
              </Badge>
            ) : null}
            {/* Persistent league fact: the Dota region every game is played on.
                It rode its own centred row before, costing a whole line for a
                value that never changes. */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs font-medium text-muted">
              <span aria-hidden>🌐</span>
              Game servers:{" "}
              <span className="font-semibold text-fg">
                {GAME_SERVER_REGION}
              </span>
            </span>
          </div>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            {title}
          </h1>
          {!leagueDashboard && subtitle ? (
            <p className="mt-2 max-w-xl text-muted sm:text-lg">{subtitle}</p>
          ) : null}
          {!leagueDashboard ? pitch : null}
          {leagueDashboard && action ? (
            <div className="mt-5 flex flex-wrap gap-2 [&>a]:min-h-11 [&>a]:px-4 [&>a]:py-2 [&>a]:text-sm">
              {action}
            </div>
          ) : null}
          {meta && !leagueDashboard ? (
            <div
              className={cn(
                "mt-5 flex flex-wrap items-center gap-x-6 gap-y-2",
                control ? "" : "justify-center",
              )}
            >
              {meta}
            </div>
          ) : null}
        </div>
        {leagueDashboard ? (
          <div className="min-w-0">{meta}</div>
        ) : control ? (
          <div className="min-w-0">{control}</div>
        ) : null}
        {leagueDashboard && aside ? (
          <div className="min-w-0 lg:col-span-2">{aside}</div>
        ) : null}
      </div>
      {/* The season stepper used to be its own full-width band restating the
          phase badge two rows above it. As the hero's footer rail it costs no
          extra band and reads as part of the same object. */}
      {rail ? (
        <div className="relative border-t border-line/70 bg-bg/30 px-4 py-3 sm:px-8">
          {rail}
        </div>
      ) : null}
    </section>
  );
}

/** CTA buttons in the control slot: full-width and stacked, so a two-button
 *  phase reads as a primary + a secondary rather than two equal halves. */
function HeroActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 [&>a]:w-full [&>a]:justify-center">
      {children}
    </div>
  );
}

// A slim stepper showing where the season is in its lifecycle. Real list
// semantics: a screen reader hears "Season progress, list, 5 items" and the
// active phase is announced via aria-current — the ticks/digits/connectors
// are purely visual (aria-hidden) with sr-only state text on each label.
export function SeasonTimeline({ phase }: { phase: string }) {
  const current = PHASE_ORDER.findIndex((p) => p === phase);
  const next = current >= 0 ? PHASE_ORDER[current + 1] : undefined;
  return (
    // No frame of its own: it renders inside the hero's footer rail, which owns
    // the border and the background.
    <div>
      {/* Phones show the current step only: five steps across 390px pushed
          the page down for what the phase badge already says. The full list
          stays for screen readers, so this line is hidden from them. */}
      {current >= 0 ? (
        <p
          aria-hidden
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:hidden"
        >
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent bg-accent/15 text-[11px] font-semibold text-accent">
            {current + 1}
          </span>
          <span className="font-medium text-fg">{PHASE_STEP[phase]}</span>
          <span className="text-muted">
            Step {current + 1} of {PHASE_ORDER.length}
            {next ? ` · Next: ${PHASE_STEP[next]}` : ""}
          </span>
        </p>
      ) : null}
      <ol
        aria-label="Season progress"
        className={cn("flex items-start", current >= 0 && "max-sm:sr-only")}
      >
        {PHASE_ORDER.map((p, i) => {
          const done = current >= 0 && i < current;
          const isCurrent = i === current;
          return (
            <li
              key={p}
              aria-current={isCurrent ? "step" : undefined}
              className="flex flex-1 flex-col items-center gap-1.5"
            >
              <div aria-hidden className="flex w-full items-center">
                <div
                  className={cn(
                    "h-0.5 flex-1 rounded",
                    i === 0
                      ? "opacity-0"
                      : current >= 0 && i <= current
                        ? "bg-success/50"
                        : "bg-line",
                  )}
                />
                <div
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold",
                    isCurrent
                      ? "border-accent bg-accent/15 text-accent"
                      : done
                        ? "border-success/50 bg-success/10 text-success"
                        : "border-line bg-surface-2 text-muted",
                  )}
                >
                  {done ? "✓" : i + 1}
                </div>
                <div
                  className={cn(
                    "h-0.5 flex-1 rounded",
                    i === PHASE_ORDER.length - 1
                      ? "opacity-0"
                      : current >= 0 && i < current
                        ? "bg-success/50"
                        : "bg-line",
                  )}
                />
              </div>
              <span
                className={cn(
                  "text-center text-[11px] leading-tight",
                  isCurrent ? "font-medium text-fg" : "text-muted",
                )}
              >
                {PHASE_STEP[p]}
                {done ? (
                  <span className="sr-only"> (done)</span>
                ) : isCurrent ? (
                  <span className="sr-only"> (current)</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * "Defending champions: Radiant Raccoons (Season 9) →", one line under the
 * hero from the offseason until the next season crowns someone. The link goes
 * to that season's page, where the final and the rosters are.
 */
export function DefendingChampionLine({
  champion,
  className,
}: {
  champion: DefendingChampion;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted",
        className,
      )}
    >
      <TeamCrest
        name={champion.teamName}
        seed={champion.teamId}
        logoUrl={champion.logoUrl}
        size={20}
        className="rounded"
      />
      <span>Defending champions:</span>
      <Link
        href={`/seasons/${champion.seasonId}`}
        className={cn(textLink(), "min-w-0 font-medium [overflow-wrap:anywhere]")}
      >
        {champion.teamName} ({champion.seasonName}) <LinkArrow />
      </Link>
    </p>
  );
}

/**
 * The league in one sentence plus who can join and when games are, for a
 * signed-out visitor on Home (signups and the offseason). Nothing else above
 * the fold said what the league is. No step strip: the hero's season
 * timeline already shows the steps.
 */
export function LeaguePitch({ matchNight }: { matchNight: string | null }) {
  return (
    <>
      <p className="mt-2 max-w-xl text-muted sm:text-lg">{leaguePitch()}</p>
      <p className="mt-2 max-w-xl text-sm text-muted">
        {leagueEligibilityLine(matchNight)}
      </p>
    </>
  );
}
