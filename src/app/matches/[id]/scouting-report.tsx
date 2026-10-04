import { AutoOpenDetails } from "@/components/auto-open-details";
import { fetchGamesForScouting } from "@/lib/game-participants";
import { decodeGamePlayers, trustedGamePlayers } from "@/lib/player-stats";
import { cn } from "@/lib/utils";
import { heroById } from "@/lib/heroes";
import {
  comfortPicks,
  dossierEmpty,
  playerHeroPool,
  threatBoard,
  threatList,
  type ComfortPicks as ComfortPicksResult,
  type ScoutGame,
  type ScoutThreats,
} from "@/lib/scouting";
import { parsePubStats, pubCheckedAgo } from "@/lib/pub-stats";
import { roleCoverage, type RoleCount } from "@/lib/pool-stats";
import { teamStripe } from "@/lib/team-tint";
import {
  Card,
  CardBody,
  HeroIcon,
  PlayerLink,
  TeamCrest,
} from "@/components/ui";

/**
 * The pre-match dossier: each player's comfort heroes and the team's heroes to
 * ban, from every box score the league has ever stored (both teams visible to
 * everyone; it's all public data). A hero shows only with SCOUT_MIN_GAMES
 * games behind it: at this league's size one game is noise. A player with no
 * such hero shows their stored pub heroes instead, labelled as pubs.
 *
 * Starts folded on phones, where it was about 1,000px, and opens by itself
 * on a wide screen or when the Scouting jump lands on it.
 */
export async function ScoutingReport({
  sides,
}: {
  sides: {
    teamId: string;
    name: string;
    logoUrl: string | null;
    roster: {
      userId: string;
      name: string;
      roles: string;
      pubStats: string | null;
      pubStatsAt: Date | null;
    }[];
  }[];
}) {
  // Uncached on purpose — see fetchAllGamesForScouting in cached-queries.ts:
  // the unstable_cache wrapper hangs inside this nested Suspense boundary.
  const allGames = await fetchGamesForScouting(sides.flatMap((side) => side.roster.map((player) => player.userId)));
  const scoutGames: ScoutGame[] = allGames.map((g) => ({
    radiantWin: g.radiantWin,
    durationSecs: g.durationSecs,
    startTime: g.startTime,
    lines: trustedGamePlayers(decodeGamePlayers(g.players)).map((p) => ({
      userId: p.userId,
      heroId: p.heroId,
      isRadiant: p.isRadiant,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
    })),
  }));
  // Async server component: request time once, for the pub snapshots' age.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  const dossiers = sides.map((side) => {
    const ids = side.roster.map((r) => r.userId);
    const board = threatBoard(ids, scoutGames);
    const pools = side.roster.map((r) => playerHeroPool(r.userId, scoutGames));
    const comfort = side.roster.flatMap((r, i) => {
      const picks = comfortPicks(
        pools[i],
        parsePubStats(r.pubStats)?.topHeroes,
      );
      return picks
        ? [
            {
              userId: r.userId,
              name: r.name,
              picks,
              checked: pubCheckedAgo(r.pubStatsAt?.getTime() ?? null, nowMs),
            },
          ]
        : [];
    });
    return {
      ...side,
      threats: threatList(board),
      threatsFloor: board.minPicks,
      comfort,
      coverage: roleCoverage(side.roster),
      empty: dossierEmpty(pools, board),
    };
  });
  const anyPubs = dossiers.some((d) =>
    d.comfort.some((c) => c.picks.source === "pubs"),
  );

  return (
    <Card className="overflow-hidden">
      <AutoOpenDetails
        id="match-scouting"
        openFromWidth="64rem"
        className="group/scouting scroll-mt-24"
      >
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-2/40 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0 flex-1">
            <h2 className="text-[0.9375rem] font-semibold leading-snug text-fg">
              Scouting report
            </h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
              Heroes played twice or more in league games
            </p>
          </div>
          <span
            aria-hidden
            className="mt-0.5 text-muted transition-transform group-open/scouting:rotate-180 motion-reduce:transition-none"
          >
            ▾
          </span>
        </summary>
        <CardBody className="grid grid-cols-1 gap-4 border-t border-line-soft lg:grid-cols-2">
          {dossiers.map((d) => (
            <div
              key={d.teamId}
              className="min-w-0 rounded-lg border border-line p-3"
              {...teamStripe(d.teamId)}
            >
              <div className="mb-2.5 flex min-w-0 items-center gap-2">
                <TeamCrest
                  name={d.name}
                  seed={d.teamId}
                  logoUrl={d.logoUrl}
                  size={22}
                  className="rounded-md"
                />
                <span className="min-w-0 font-display text-base font-semibold [overflow-wrap:anywhere]">
                  {d.name}
                </span>
              </div>
              {d.threats.rows.length === 0 && d.comfort.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted">
                  {d.empty
                    ? "No league history yet — they're a mystery."
                    : "No hero played twice in league games yet."}
                </p>
              ) : (
                <div className="space-y-3">
                  <ThreatList threats={d.threats} minPicks={d.threatsFloor} />
                  <ComfortPicks players={d.comfort} />
                </div>
              )}
              <RoleGaps coverage={d.coverage} />
            </div>
          ))}
          {anyPubs ? (
            <p className="text-xs text-muted lg:col-span-2">
              <span className="font-medium">pubs</span>: no hero played twice
              in league games yet, so these are the player&apos;s most-played
              heroes in public games, from their last profile sync.
            </p>
          ) : null}
        </CardBody>
      </AutoOpenDetails>
    </Card>
  );
}

function ThreatList({
  threats,
  minPicks,
}: {
  threats: ScoutThreats;
  minPicks: number;
}) {
  if (threats.rows.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        {threats.ranked ? `Ban board (${minPicks}+ picks)` : "Most picked"}
      </div>
      <ul className="space-y-1">
        {threats.rows.map((r) => {
          const hero = heroById(r.heroId);
          return (
            <li key={r.heroId} className="flex items-center gap-2 text-sm">
              {hero ? (
                <HeroIcon hero={hero} size={22} />
              ) : (
                <span className="h-[22px] w-[22px] shrink-0 rounded border border-line/70 bg-surface-2" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {hero?.name ?? `Hero ${r.heroId}`}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {r.wins}–{r.picks - r.wins}
                <span
                  className={cn(
                    "ml-2 font-medium",
                    r.winRate >= 60
                      ? "text-success"
                      : r.winRate < 40
                        ? "text-danger"
                        : "text-fg/80",
                  )}
                >
                  {r.winRate}%
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ComfortPicks({
  players,
}: {
  players: {
    userId: string;
    name: string;
    picks: ComfortPicksResult;
    /** How old the player's pub snapshot is ("3d ago"), when known. */
    checked: string | null;
  }[];
}) {
  if (players.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted">
        Comfort picks
      </div>
      <ul className="space-y-1">
        {players.map((p) => {
          const pubs = p.picks.source === "pubs";
          return (
            <li key={p.userId} className="flex items-center gap-2 text-sm">
              <PlayerLink
                userId={p.userId}
                className="w-28 shrink-0 truncate text-xs"
              >
                {p.name}
              </PlayerLink>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {p.picks.heroes.map((h) => {
                  const hero = heroById(h.heroId);
                  const name = hero?.name ?? `Hero ${h.heroId}`;
                  const winRate = Math.round((h.wins / h.games) * 100);
                  const where = pubs ? "pub games" : "league games";
                  return (
                    <span
                      key={h.heroId}
                      role="img"
                      aria-label={`${name}: ${h.games} ${where}, ${winRate}% wins`}
                      title={`${name} — ${h.wins}–${h.games - h.wins} in ${where} (${winRate}%)${pubs && p.checked ? `, checked ${p.checked}` : ""}`}
                      className="inline-flex items-center gap-1 rounded border border-line bg-surface-2/50 px-1 py-px text-[11px]"
                    >
                      {hero ? <HeroIcon hero={hero} size={16} /> : null}
                      <span aria-hidden className="tabular-nums text-muted">
                        ×{h.games}
                      </span>
                    </span>
                  );
                })}
                {pubs ? (
                  <span className="text-xs text-muted">
                    pubs
                    {p.checked ? (
                      <span className="sr-only">, checked {p.checked}</span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Roles nobody on the roster declared, from their signups. */
function RoleGaps({ coverage }: { coverage: RoleCount[] }) {
  const gaps = coverage.filter((c) => c.count === 0);
  if (gaps.length === 0 || gaps.length >= 5) return null;
  return (
    <p className="mt-3 border-t border-line/70 pt-2 text-xs text-muted">
      No declared{" "}
      {gaps.map((g) => `${g.label.toLowerCase()} (${g.key})`).join(", ")} —
      somebody&apos;s flexing.
    </p>
  );
}
