import { formatNetWorth, cn } from "@/lib/utils";
import { heroById } from "@/lib/heroes";
import type { PlayerStat } from "@/lib/match-import";
import {
  cardAverage,
  gameReportCard,
  gradeFor,
  gradeTone,
  percentLabel,
  type Grade,
} from "@/lib/benchmarks";
import { Avatar, Badge, HeroIcon, KDA, PlayerLink } from "@/components/ui";

// The recorded team net-worth split from this game's box score, with an
// explicit gold lead. These totals are not a live net-worth timeline.
export function NetWorthAdvantage({
  radiantName,
  direName,
  radiantNet,
  direNet,
}: {
  radiantName: string;
  direName: string;
  radiantNet: number;
  direNet: number;
}) {
  const total = radiantNet + direNet;
  if (total <= 0) return null;
  const radPct = Math.round((radiantNet / total) * 100);
  const lead = radiantNet - direNet;
  const leaderName = lead > 0 ? radiantName : direName;
  return (
    <div className="min-w-0 rounded-xl border border-line bg-bg/35 p-4 md:col-span-2">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-muted">Recorded net worth</span>
        <span className="min-w-0 text-fg [overflow-wrap:anywhere]">
          {lead === 0 ? (
            "Even"
          ) : (
            <>
              {leaderName}{" "}
              <strong className="font-mono text-accent">
                +{formatNetWorth(Math.abs(lead))}
              </strong>
            </>
          )}
        </span>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-4">
        <div className="flex min-w-0 flex-col">
          <p className="text-xs text-emerald-300 [overflow-wrap:anywhere]">
            {radiantName}
          </p>
          <p className="mt-auto pt-1 font-display text-2xl font-semibold tabular-nums">
            {formatNetWorth(radiantNet)}
          </p>
        </div>
        <div className="flex min-w-0 flex-col text-right">
          <p className="text-xs text-rose-300 [overflow-wrap:anywhere]">
            {direName}
          </p>
          <p className="mt-auto pt-1 font-display text-2xl font-semibold tabular-nums">
            {formatNetWorth(direNet)}
          </p>
        </div>
      </div>
      <div
        role="img"
        aria-label={`${radiantName}: ${radiantNet.toLocaleString()} gold. ${direName}: ${direNet.toLocaleString()} gold.`}
        className="relative flex h-3 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div className="bg-emerald-400/80" style={{ width: `${radPct}%` }} />
        <div className="flex-1 bg-rose-400/80" />
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px bg-bg/70"
        />
      </div>
      <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>Radiant</span>
        <span>Dire</span>
      </div>
    </div>
  );
}

export function SidePlayers({
  label,
  win,
  players,
  userName,
  userAvatar,
  maxNet,
  mvpId,
}: {
  label: string;
  win: boolean;
  players: PlayerStat[];
  userName: Map<string, string>;
  userAvatar: Map<string, string | null>;
  maxNet: number;
  mvpId?: string | null;
}) {
  const hasNet = players.some((p) => p.netWorth != null);
  const hasGpm = players.some((p) => p.gpm != null);
  const hasLh = players.some((p) => p.lastHits != null);
  // Order by farm so the net-worth bars descend, like Dota's post-game screen.
  const ordered = [...players].sort(
    (a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0) || b.kills - a.kills,
  );
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border p-3",
        win ? "border-success/40 bg-success/5" : "border-line",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 font-display text-base font-semibold [overflow-wrap:anywhere]">
            {label}
          </span>
          {win ? (
            <Badge tone="success" className="shrink-0">
              Win
            </Badge>
          ) : (
            <Badge className="shrink-0">Loss</Badge>
          )}
        </span>
        {/* No team net-worth total here: the Recorded net worth panel above
            both sides already prints it. */}
      </div>
      <ul className="space-y-0.5">
        {ordered.map((p, idx) => {
          const displayName = p.userId
            ? (userName.get(p.userId) ?? p.personaname ?? "Unknown")
            : (p.personaname ?? "Unknown");
          const hero = heroById(p.heroId);
          const heroName = hero?.name ?? `Hero ${p.heroId}`;
          const nwPct =
            p.netWorth != null ? Math.round((p.netWorth / maxNet) * 100) : 0;
          return (
            <li
              key={idx}
              className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-2/50"
            >
              <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2">
                {hero ? (
                  <HeroIcon hero={hero} size={30} />
                ) : (
                  <span className="text-xs text-muted">#{p.heroId}</span>
                )}
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                    {p.userId ? (
                      <span className="hidden sm:inline-flex">
                        <Avatar
                          name={displayName}
                          src={userAvatar.get(p.userId) ?? null}
                          size={18}
                        />
                      </span>
                    ) : null}
                    {p.userId ? (
                      <PlayerLink
                        userId={p.userId}
                        className="min-w-6 text-sm [overflow-wrap:anywhere]"
                      >
                        {displayName}
                      </PlayerLink>
                    ) : (
                      <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                        {displayName}
                      </span>
                    )}
                    {p.userId && p.userId === mvpId ? (
                      <Badge tone="accent" title="Best line of the game">
                        MVP
                      </Badge>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-muted [overflow-wrap:anywhere]">
                    {heroName}
                  </div>
                </div>
                <KDA
                  kills={p.kills}
                  deaths={p.deaths}
                  assists={p.assists}
                  className="shrink-0 text-right text-xs"
                />
              </div>
              {hasNet || hasGpm || hasLh ? (
                // Fixed-width gpm, lh and net-worth cells (the has* flags are
                // per side, so every row has the same cells): the bars then
                // start at the same x and share one track width down the
                // side, which is the comparison they exist for.
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-10 text-[11px] tabular-nums text-muted">
                  {hasGpm ? (
                    <span className="w-14" title="Gold per minute">{p.gpm ?? "—"} gpm</span>
                  ) : null}
                  {hasLh ? (
                    <span className="w-10" title="Last hits">{p.lastHits ?? "—"} lh</span>
                  ) : null}
                  {hasNet ? (
                    <span
                      className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2"
                      title="Net worth at game end"
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-full max-w-24 overflow-hidden rounded-full bg-surface-2"
                      >
                        <span
                          className="block h-full rounded-full bg-accent/80"
                          style={{ width: `${nwPct}%` }}
                        />
                      </span>
                      <span className="w-11 shrink-0 text-right font-mono text-accent">
                        {formatNetWorth(p.netWorth)}
                      </span>
                    </span>
                  ) : null}
                </div>
              ) : null}
              <ReportCardStrip line={p} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const GRADE_CHIP: Record<ReturnType<typeof gradeTone>, string> = {
  success: "border-success/40 text-success",
  accent: "border-accent/40 text-accent",
  default: "border-line text-fg/80",
  muted: "border-line text-muted",
};

const GRADE_TEXT: Record<ReturnType<typeof gradeTone>, string> = {
  success: "text-success",
  accent: "text-accent",
  default: "text-fg/80",
  muted: "text-muted",
};

/**
 * The hero report card (per-metric worldwide percentile grades from OpenDota's
 * benchmarks) as ONE overall chip under a player's line; tapping it opens the
 * metrics by name. Seven chips per player was up to 80 per game, with
 * abbreviations like "HD/min" and "TD" explained nowhere, beside the raw
 * numbers they graded. Absent for games imported before benchmarks were
 * stored.
 */
function ReportCardStrip({ line }: { line: PlayerStat }) {
  const rows = gameReportCard(line);
  const avg = cardAverage(rows);
  if (avg == null) return null;
  const overall: Grade = gradeFor(avg);
  return (
    <details className="group/report mt-1.5 pl-10">
      <summary
        title={`vs the world on this hero: ${percentLabel(avg)}`}
        className={cn(
          "inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded border px-1.5 text-xs font-semibold uppercase tracking-wide [&::-webkit-details-marker]:hidden",
          GRADE_CHIP[gradeTone(overall)],
        )}
      >
        Report {overall}
        <span className="sr-only">
          , {percentLabel(avg)} vs the world on this hero
        </span>
        <span
          aria-hidden
          className="text-[10px] transition-transform group-open/report:rotate-180 motion-reduce:transition-none"
        >
          ▾
        </span>
      </summary>
      <ul className="mt-1.5 max-w-xs space-y-0.5 text-xs">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline justify-between gap-3">
            <span className="text-muted">{r.label}</span>
            <span className="shrink-0 tabular-nums">
              {percentLabel(r.pct)}{" "}
              <b className={cn("font-semibold", GRADE_TEXT[gradeTone(r.grade)])}>
                {r.grade}
              </b>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted">
        Percentiles against everyone playing this hero worldwide.
      </p>
    </details>
  );
}
