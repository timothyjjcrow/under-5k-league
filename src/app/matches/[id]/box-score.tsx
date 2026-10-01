import { formatNetWorth, cn } from "@/lib/utils";
import { heroById } from "@/lib/heroes";
import { teamStripe } from "@/lib/team-tint";
import type { PlayerStat } from "@/lib/match-import";
import {
  cardAverage,
  gameReportCard,
  gradeFor,
  gradeTone,
  percentLabel,
} from "@/lib/benchmarks";
import { Avatar, Badge, HeroIcon, KDA, PlayerLink } from "@/components/ui";
import { BoxScoreLine, type LineReport } from "./box-score-line";

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
  // A phone stacks the two totals over a full-width bar; from sm the bar
  // sits between them, one row (grid placement, so the reading order stays
  // Radiant, bar, Dire).
  return (
    <div className="min-w-0 rounded-xl border border-line bg-bg/35 p-3 sm:px-4 md:col-span-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
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
      <div className="grid grid-cols-2 items-end gap-x-4 gap-y-3 sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)_minmax(0,auto)] sm:items-center sm:gap-x-6">
        <div className="flex min-w-0 flex-col">
          <p className="text-xs text-emerald-300 [overflow-wrap:anywhere]">
            {radiantName}
          </p>
          <p className="mt-auto pt-1 font-display text-2xl font-semibold tabular-nums">
            {formatNetWorth(radiantNet)}
          </p>
        </div>
        <div className="col-span-2 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1">
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
        <div className="flex min-w-0 flex-col text-right sm:col-start-3">
          <p className="text-xs text-rose-300 [overflow-wrap:anywhere]">
            {direName}
          </p>
          <p className="mt-auto pt-1 font-display text-2xl font-semibold tabular-nums">
            {formatNetWorth(direNet)}
          </p>
        </div>
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
  teamId,
}: {
  label: string;
  win: boolean;
  players: PlayerStat[];
  userName: Map<string, string>;
  userAvatar: Map<string, string | null>;
  maxNet: number;
  mvpId?: string | null;
  /** The team that played this side, when the game recorded it: the box
   *  wears its colour stripe. Unknown sides stay plain Radiant and Dire. */
  teamId?: string | null;
}) {
  const hasNet = players.some((p) => p.netWorth != null);
  const hasGpm = players.some((p) => p.gpm != null);
  const hasLh = players.some((p) => p.lastHits != null);
  // Order by farm so the net-worth bars descend, like Dota's post-game screen.
  const ordered = [...players].sort(
    (a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0) || b.kills - a.kills,
  );
  return (
    // An @container: a side wide enough (@lg) sets each player on one line
    // (BoxScoreLine): hero and name, then gpm, lh and net worth, then KDA.
    // Narrower (a phone, a tablet's half) the numbers take a second line.
    <div
      className={cn(
        "@container min-w-0 rounded-xl border p-3",
        win ? "border-success/40 bg-success/5" : "border-line",
      )}
      {...(teamId ? teamStripe(teamId) : {})}
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
            <BoxScoreLine
              key={idx}
              icon={
                hero ? (
                  <HeroIcon hero={hero} size={30} />
                ) : (
                  <span className="text-xs text-muted">#{p.heroId}</span>
                )
              }
              name={
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
              }
              heroName={heroName}
              kda={
                // Fixed width on one line (@lg): each line is its own grid,
                // so a wider KDA would push that line's numbers left.
                <KDA
                  kills={p.kills}
                  deaths={p.deaths}
                  assists={p.assists}
                  className="shrink-0 text-right text-xs @lg:col-start-4 @lg:row-start-1 @lg:w-16"
                />
              }
              stats={
                hasNet || hasGpm || hasLh ? (
                  // Fixed-width gpm, lh and net-worth cells (the has* flags
                  // are per side, so every line has the same cells): the
                  // bars then start at the same x and share one track width
                  // down the side, which is the comparison they exist for.
                  // On one line (@lg) the bar gets a fixed width too: an
                  // auto track sizes to content, and a w-full bar has none.
                  <div className="col-span-full mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-10 text-[11px] tabular-nums text-muted @lg:col-span-1 @lg:col-start-3 @lg:row-start-1 @lg:mt-0 @lg:flex-nowrap @lg:pl-0">
                    {hasGpm ? (
                      <span className="w-14" title="Gold per minute">
                        {p.gpm ?? "—"} gpm
                      </span>
                    ) : null}
                    {hasLh ? (
                      <span className="w-10" title="Last hits">
                        {p.lastHits ?? "—"} lh
                      </span>
                    ) : null}
                    {hasNet ? (
                      <span
                        className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 @lg:flex-none"
                        title="Net worth at game end"
                      >
                        <span
                          aria-hidden
                          className="h-1.5 w-full max-w-24 overflow-hidden rounded-full bg-surface-2 @lg:w-16"
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
                ) : null
              }
              report={lineReport(p)}
            />
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A line's report card (per-metric worldwide percentile grades from
 * OpenDota's benchmarks), graded here for the client line to show. Null for
 * games imported before benchmarks were stored.
 */
function lineReport(line: PlayerStat): LineReport | null {
  const rows = gameReportCard(line);
  const avg = cardAverage(rows);
  if (avg == null) return null;
  const overall = gradeFor(avg);
  return {
    overall,
    tone: gradeTone(overall),
    average: percentLabel(avg),
    rows: rows.map((r) => ({
      key: r.key,
      label: r.label,
      percent: percentLabel(r.pct),
      grade: r.grade,
      tone: gradeTone(r.grade),
    })),
  };
}
