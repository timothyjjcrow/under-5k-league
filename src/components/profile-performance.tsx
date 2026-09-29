import Link from "next/link";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  HeroIcon,
  KDA,
  SectionTitle,
  Sparkline,
  Stat,
} from "@/components/ui";
import {
  gradeFor,
  gradeTone,
  percentLabel,
  REPORT_CARD_MIN_GRADED,
  type CareerReport,
  type ReportVerdicts,
} from "@/lib/benchmarks";
import type { Hero } from "@/lib/heroes";
import { cn, formatNetWorth } from "@/lib/utils";

/** Their best game by impact points, ready to render. */
type StandoutGame = {
  matchId: string;
  hero: Hero | null;
  heroId: number;
  won: boolean;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number | null | undefined;
  gpm: number | null | undefined;
  round: string;
  opponent: string;
};

/**
 * The "How they play" band: economy averages, the KDA trend and their
 * standout game, beside a report card against OpenDota's benchmarks. The page
 * renders the band only when at least one of its cards shows.
 */
export function ProfilePerformance({
  showPerformance,
  showReportCard,
  avgNet,
  avgGpm,
  avgLh,
  kdaByGame,
  bestView,
  reportCard,
  verdicts,
}: {
  showPerformance: boolean;
  showReportCard: boolean;
  avgNet: number | null;
  avgGpm: number | null;
  avgLh: number | null;
  /** KDA per game, oldest first. */
  kdaByGame: number[];
  bestView: StandoutGame | null;
  reportCard: CareerReport;
  verdicts: ReportVerdicts;
}) {
  return (
    <section id="player-performance" className="scroll-mt-40 space-y-3">
      <SectionTitle>How they play</SectionTitle>
      {/* An h2 SectionTitle over an auto-fit grid. auto-fit, NEVER
          grid-cols-1 (it silently wins the cascade and collapses the band at
          every width — the dashboard rule): every card here is conditional,
          so an absent one must collapse its track instead of leaving a hole. */}
      <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(20rem,100%),1fr))]">
        {showPerformance ? (
          <Card className="min-w-0">
            <CardHeader
              title="Performance"
              subtitle="Averages across every season's imported games"
            />
            <CardBody className="space-y-4">
              {/* auto-fit, not grid-cols-3: each Stat is individually
                  null-gated (legacy imports lack economy fields), and a
                  fixed 3-track grid holds a hole per missing metric. */}
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(8rem,100%),1fr))]">
                {avgNet != null ? (
                  <Stat label="Avg net worth" value={formatNetWorth(avgNet)} />
                ) : null}
                {avgGpm != null ? (
                  <Stat label="Avg GPM" value={avgGpm} />
                ) : null}
                {avgLh != null ? (
                  <Stat label="Avg last hits" value={avgLh} />
                ) : null}
              </div>
              {kdaByGame.length >= 2 ? (
                /* Full width, like the tiles above and the Standout game
                   below (a max-w-md box left a ragged right edge), with the
                   sparkline beside its label rather than justify-between,
                   which held ~700px of dead middle at desktop. */
                <div className="flex items-center gap-6 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted">
                      KDA by game
                    </div>
                    <div className="text-xs text-muted">
                      last {kdaByGame.length}
                    </div>
                  </div>
                  <Sparkline values={kdaByGame} width={160} height={38} />
                </div>
              ) : null}
              {bestView ? (
                <Link
                  href={`/matches/${bestView.matchId}`}
                  className="block rounded-lg border border-line bg-surface-2/40 p-3 text-sm transition-colors hover:border-muted/60"
                >
                  <span
                    className="block text-[10px] font-medium uppercase tracking-wide text-muted"
                    title="Their best game by impact points, the rating behind Match MVP"
                  >
                    Standout game
                  </span>
                  {/* On a phone the stats take their own line under the
                      hero (basis-full); from sm they sit at the end of
                      the row. Side by side at 390px they crushed the
                      opponent's name to one word per line and printed it
                      over the net worth. */}
                  <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {bestView.hero ? (
                      <HeroIcon hero={bestView.hero} size={30} />
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">
                        {bestView.hero?.name ?? `Hero ${bestView.heroId}`}
                      </span>
                      <span className="block text-xs text-muted [overflow-wrap:anywhere]">
                        vs {bestView.opponent} · {bestView.round}
                      </span>
                    </span>
                    <Badge
                      tone={bestView.won ? "success" : "danger"}
                      className="sm:order-last"
                    >
                      {bestView.won ? "W" : "L"}
                    </Badge>
                    <span className="flex basis-full flex-wrap items-baseline gap-x-2 text-xs sm:block sm:basis-auto sm:text-right">
                      <KDA
                        kills={bestView.kills}
                        deaths={bestView.deaths}
                        assists={bestView.assists}
                        className="sm:block"
                      />
                      <span className="text-muted sm:block">
                        {formatNetWorth(bestView.netWorth)}
                        {bestView.gpm != null ? ` · ${bestView.gpm} GPM` : ""}
                      </span>
                    </span>
                  </span>
                </Link>
              ) : null}
            </CardBody>
          </Card>
        ) : null}
        {showReportCard ? (
          <Card className="min-w-0">
            <CardHeader
              title="Report card"
              subtitle={`How they stack up vs the world on their heroes — OpenDota percentiles over ${reportCard.graded} graded game${reportCard.graded === 1 ? "" : "s"}`}
            />
            <CardBody className="space-y-4">
              {!verdicts.graded ? (
                <p className="text-xs text-muted">
                  Grades appear after {REPORT_CARD_MIN_GRADED} graded games.
                </p>
              ) : verdicts.overall != null && reportCard.avgPct != null ? (
                <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-4 py-3">
                  <span
                    className={cn(
                      "font-display text-4xl font-bold leading-none",
                      gradeTone(verdicts.overall) === "success"
                        ? "text-success"
                        : gradeTone(verdicts.overall) === "accent"
                          ? "text-accent"
                          : gradeTone(verdicts.overall) === "muted"
                            ? "text-muted"
                            : "text-fg/80",
                    )}
                  >
                    {verdicts.overall}
                  </span>
                  <span className="text-sm text-muted">
                    overall — {percentLabel(reportCard.avgPct)} vs the world
                    on their heroes
                  </span>
                </div>
              ) : null}
              <ul className="space-y-2">
                {reportCard.metrics.map((m) => {
                  // Below the minimum the bar stays neutral and no
                  // letter shows: a colour is a verdict too.
                  const grade = verdicts.graded ? gradeFor(m.avgPct) : null;
                  const tone = grade ? gradeTone(grade) : "muted";
                  return (
                    <li key={m.key} className="flex items-center gap-3 text-sm">
                      <span className="w-28 shrink-0 truncate text-xs text-muted sm:w-32">
                        {m.label}
                      </span>
                      <span
                        role="img"
                        aria-label={`${m.label}: ${percentLabel(m.avgPct)}${grade ? `, grade ${grade}` : ""}`}
                        className="min-w-0 flex-1"
                      >
                        <span className="block h-2 w-full overflow-hidden rounded-full bg-surface-2">
                          <span
                            className={cn(
                              "block h-full rounded-full",
                              tone === "success"
                                ? "bg-success/80"
                                : tone === "accent"
                                  ? "bg-accent/80"
                                  : tone === "muted"
                                    ? grade
                                      ? "bg-line"
                                      : "bg-muted/60"
                                    : "bg-fg/40",
                            )}
                            style={{
                              width: `${Math.round(m.avgPct * 100)}%`,
                            }}
                          />
                        </span>
                      </span>
                      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted">
                        {percentLabel(m.avgPct).replace(" percentile", "")}
                        {grade ? (
                          <b
                            className={cn(
                              "ml-1.5 font-semibold",
                              tone === "success"
                                ? "text-success"
                                : tone === "accent"
                                  ? "text-accent"
                                  : "text-fg/80",
                            )}
                          >
                            {grade}
                          </b>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {verdicts.best || verdicts.focus ? (
                // auto-fit: visitors never get "Work on", so a lone
                // Strength callout takes the full width, not half a row.
                <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(14rem,100%),1fr))]">
                  {verdicts.best ? (
                    <div className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-xs">
                      <span aria-hidden>💪</span> <b>Strength:</b>{" "}
                      {verdicts.best.label} —{" "}
                      {percentLabel(verdicts.best.avgPct)}
                    </div>
                  ) : null}
                  {verdicts.focus ? (
                    <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
                      <span aria-hidden>🎯</span> <b>Work on:</b>{" "}
                      {verdicts.focus.label} —{" "}
                      {percentLabel(verdicts.focus.avgPct)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
          </Card>
        ) : null}
      </div>
    </section>
  );
}
