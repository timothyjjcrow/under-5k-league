import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { shareMetadata } from "@/lib/share-metadata";
import { LocalTime } from "@/components/local-time";
import { computeStandings } from "@/lib/standings";
import { seasonScenarioReport } from "@/lib/stakes";
import type { TeamScenario } from "@/lib/scenarios";
import { headToHead, recentForm } from "@/lib/team-matches";
import { matchPhaseLabel } from "@/lib/schedule";
import { roleCoverage } from "@/lib/pool-stats";
import {
  summarizePlayerGames,
  type PlayerGameLine,
} from "@/lib/player-stats";
import type { PlayerStat } from "@/lib/match-import";
import { getHeroNames } from "@/lib/dota";
import { heroById, heroPortrait, parseHeroList } from "@/lib/heroes";
import { cn } from "@/lib/utils";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FormStrip,
  HeroPool,
  PlayerLink,
  RankBadge,
  RoleBadges,
  Sparkline,
  Stat,
  TeamCrest,
  teamHue,
} from "@/components/ui";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const team = await prisma.team.findUnique({
    where: { id },
    select: { name: true },
  });
  // Metadata resolves BEFORE the body streams — a notFound() here is the
  // only way an unknown id yields a real 404 status (the root loading.tsx
  // otherwise commits a 200 shell before the page's own notFound throws).
  if (!team) notFound();
  return shareMetadata(
    team.name,
    `${team.name} — roster, results, and stats in the Under 4.5K League.`,
  );
}

function fmtDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function TeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const team = await prisma.team.findUnique({
    where: { id },
    include: {
      season: true,
      captain: true,
      members: { include: { user: true }, orderBy: { price: "desc" } },
    },
  });
  if (!team) notFound();

  const memberIds = team.members.map((m) => m.userId);
  const [allTeams, allMatches, myMatches, rosterRegs, seasonGames] =
    await Promise.all([
      prisma.team.findMany({ where: { seasonId: team.seasonId } }),
      prisma.match.findMany({ where: { seasonId: team.seasonId } }),
      prisma.match.findMany({
        where: {
          seasonId: team.seasonId,
          OR: [{ homeTeamId: id }, { awayTeamId: id }],
        },
        orderBy: [{ week: "asc" }, { createdAt: "asc" }],
      }),
      memberIds.length
        ? prisma.registration.findMany({
            where: { seasonId: team.seasonId, userId: { in: memberIds } },
            select: { userId: true, roles: true, favoriteHeroes: true, mmr: true },
          })
        : Promise.resolve([]),
      memberIds.length
        ? prisma.game.findMany({
            where: { match: { seasonId: team.seasonId } },
            select: { players: true, radiantWin: true },
          })
        : Promise.resolve([]),
    ]);

  // Aggregate every rostered player's game lines into the team's hero pool.
  const memberIdSet = new Set(memberIds);
  const teamLines: PlayerGameLine[] = [];
  for (const g of seasonGames) {
    for (const pl of safeParse(g.players)) {
      if (pl.userId && memberIdSet.has(pl.userId)) {
        teamLines.push({
          isRadiant: pl.isRadiant,
          radiantWin: g.radiantWin,
          kills: pl.kills,
          deaths: pl.deaths,
          assists: pl.assists,
          heroId: pl.heroId,
          netWorth: pl.netWorth,
          gpm: pl.gpm,
        });
      }
    }
  }
  const teamHeroes = summarizePlayerGames(teamLines).topHeroes;
  const heroNames = teamHeroes.length ? await getHeroNames() : {};

  const standings = computeStandings(
    allTeams.map((t) => t.id),
    allMatches,
  );
  const rank = standings.findIndex((s) => s.teamId === id) + 1;
  const row = standings.find((s) => s.teamId === id);
  const teamName = new Map(allTeams.map((t) => [t.id, t.name]));
  // "What we need": this team's playoff scenario, from the exact engine.
  const stakesReport =
    team.season.status === "REGULAR_SEASON"
      ? seasonScenarioReport(standings, allMatches, allTeams.length)
      : null;
  const myScenario = stakesReport?.teams.get(id) ?? null;

  const form = recentForm(id, myMatches);
  // Game differential per completed match (chronological) → a form trend.
  const diffTrend = myMatches
    .filter((m) => m.status === "COMPLETED")
    .map((m) => {
      const isHome = m.homeTeamId === id;
      const myS = isHome ? m.homeScore : m.awayScore;
      const oppS = isHome ? m.awayScore : m.homeScore;
      return myS - oppS;
    });
  const h2h = headToHead(id, myMatches).sort(
    (a, b) => b.wins - a.wins || a.losses - b.losses,
  );
  const spent = team.members.reduce((sum, m) => sum + m.price, 0);
  // Before any result exists, record/points/rank are noise (and the "rank"
  // is just draft order) — show draft-shaped tiles instead.
  const played = allMatches.some((m) => m.status === "COMPLETED");
  const knownMmrs = rosterRegs.map((r) => r.mmr).filter((v) => v > 0);
  const avgMmr = knownMmrs.length
    ? Math.round(knownMmrs.reduce((s, v) => s + v, 0) / knownMmrs.length)
    : null;
  const coverage = roleCoverage(rosterRegs);
  const hasRoleData = coverage.some((r) => r.count > 0);
  // Which player prefers which roles → per-row badges in the roster card.
  const rolesByUser = new Map(rosterRegs.map((r) => [r.userId, r.roles]));
  const hue = teamHue(team.id);
  // The roster's most-commonly listed hero → a faint banner backdrop. Kept
  // subtle so the team's color identity (crest + glow) stays dominant.
  const heroCounts = new Map<number, number>();
  for (const r of rosterRegs) {
    for (const h of parseHeroList(r.favoriteHeroes).matched) {
      heroCounts.set(h.id, (heroCounts.get(h.id) ?? 0) + 1);
    }
  }
  let teamHeroId: number | null = null;
  let bestCount = 0;
  for (const [hid, count] of heroCounts) {
    if (count > bestCount) {
      bestCount = count;
      teamHeroId = hid;
    }
  }
  const teamHero = teamHeroId != null ? heroById(teamHeroId) : null;

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex items-center justify-between">
          {/* An archived team belongs to its season's archive — /teams and
              /schedule only know the ACTIVE season. */}
          <Link
            href={team.season.isActive ? "/teams" : `/seasons/${team.seasonId}`}
            className="text-sm text-info hover:underline"
          >
            {team.season.isActive ? "← All teams" : "← Season archive"}
          </Link>
          <span className="flex items-center gap-4">
            {team.season.isActive &&
            (team.season.status === "REGULAR_SEASON" ||
              team.season.status === "PLAYOFFS") ? (
              <a
                href={`/api/calendar?team=${team.id}`}
                className="text-xs text-muted hover:text-info"
                title="This team's scheduled matches as an .ics calendar"
              >
                📅 Calendar
              </a>
            ) : null}
            {team.season.isActive && team.season.status === "DRAFT" ? (
              <Link href="/draft" className="text-sm text-info hover:underline">
                Draft room →
              </Link>
            ) : team.season.isActive ? (
              <Link
                href="/schedule"
                className="text-sm text-info hover:underline"
              >
                Standings →
              </Link>
            ) : (
              <Link
                href={`/seasons/${team.seasonId}`}
                className="text-sm text-info hover:underline"
              >
                Final standings →
              </Link>
            )}
          </span>
        </div>
        <div className="relative overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-br from-surface-2/70 via-surface/50 to-surface/30 shadow-sm">
          {/* The roster's signature hero, very faint on the right. */}
          {teamHero ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-2/3 sm:w-1/2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={heroPortrait(teamHero)}
                alt=""
                className="profile-hero-bg h-full w-full object-cover object-center opacity-20"
              />
            </div>
          ) : null}
          {/* Ambient graphics tinted with the team's own color identity. */}
          <div
            aria-hidden
            className="hero-grid pointer-events-none absolute inset-0 opacity-50"
          />
          <div
            aria-hidden
            className="animate-hero-glow pointer-events-none absolute -left-8 top-0 h-40 w-40 -translate-y-1/3 rounded-full blur-3xl"
            style={{ backgroundColor: `hsl(${hue} 70% 50% / 0.22)` }}
          />
          <div
            aria-hidden
            className="animate-hero-glow-alt pointer-events-none absolute -right-8 bottom-0 h-40 w-40 translate-y-1/3 rounded-full bg-accent/15 blur-3xl"
          />
          <div className="relative flex flex-wrap items-center gap-5 p-6">
            <TeamCrest
              name={team.name}
              seed={team.id}
              size={80}
              className="rounded-2xl shadow-lg"
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="font-display text-3xl font-bold tracking-tight [overflow-wrap:anywhere] sm:text-4xl">
                  {team.name}
                </h1>
                {played && rank > 0 ? (
                  <Badge tone="accent">
                    #{rank} of {allTeams.length}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-1 text-sm text-muted">{team.season.name}</div>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
                <span className="flex items-center gap-1.5 text-muted">
                  Captain
                  <PlayerLink
                    userId={team.captainId}
                    className="flex items-center gap-1.5 text-fg hover:no-underline"
                  >
                    <Avatar
                      name={team.captain.name}
                      src={team.captain.avatar}
                      size={20}
                    />
                    <span className="font-medium">{team.captain.name}</span>
                  </PlayerLink>
                </span>
                {form.length > 0 ? (
                  <span className="flex items-center gap-2">
                    <span className="text-xs uppercase tracking-wide text-muted">
                      Form
                    </span>
                    <FormStrip form={form} />
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {played ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Record"
            value={`${row?.wins ?? 0}–${row?.losses ?? 0}${
              (row?.draws ?? 0) > 0 ? `–${row?.draws}` : ""
            }`}
          />
          <Stat label="Points" value={row?.points ?? 0} />
          <Stat
            label="Rank"
            value={rank > 0 ? `#${rank}` : "—"}
            hint={`of ${allTeams.length}`}
          />
          <Stat
            label="Roster"
            value={`${team.members.length}/${team.season.teamSize}`}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Budget left" value={`$${team.budget}`} />
          <Stat label="Spent" value={`$${spent}`} />
          <Stat
            label="Roster"
            value={`${team.members.length}/${team.season.teamSize}`}
          />
          <Stat label="Avg MMR" value={avgMmr ?? "—"} />
        </div>
      )}

      {myScenario && stakesReport && played ? (
        <WhatWeNeed scenario={myScenario} cut={stakesReport.cut} />
      ) : null}

      {diffTrend.length >= 2 ? (
        <Card>
          <CardBody className="flex items-center justify-between gap-4 py-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted">
                Game diff by match
              </div>
              <div className="text-xs text-muted">
                last {diffTrend.length} played
              </div>
            </div>
            <Sparkline values={diffTrend} width={180} height={40} />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Roster"
          subtitle={
            spent > 0
              ? `Spent $${spent} · $${team.budget} left`
              : undefined
          }
        />
        <CardBody className="space-y-1.5">
          {team.members.length === 0 ? (
            <p className="text-sm text-muted">No players yet.</p>
          ) : (
            team.members.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-md border border-line/60 px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar name={m.user.name} src={m.user.avatar} size={26} />
                  <PlayerLink userId={m.userId}>{m.user.name}</PlayerLink>
                  {m.isCaptain ? <Badge tone="accent">Captain</Badge> : null}
                  <RankBadge rankTier={m.user.rankTier} />
                  <RoleBadges
                    roles={rolesByUser.get(m.userId)}
                    className="hidden sm:inline-flex"
                  />
                </span>
                <span className="text-muted">
                  {m.isCaptain ? "—" : `$${m.price}`}
                </span>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      {hasRoleData ? (
        <Card>
          <CardHeader
            title="Role coverage"
            subtitle="Positions the roster prefers to play"
          />
          <CardBody>
            <div className="grid grid-cols-5 gap-2">
              {coverage.map((r) => (
                <div
                  key={r.key}
                  className={cn(
                    "rounded-lg border px-2 py-3 text-center",
                    r.count > 0
                      ? "border-line bg-surface-2/40"
                      : "border-dashed border-danger/40 bg-danger/5",
                  )}
                  title={r.label}
                >
                  <div className="text-xs font-medium text-muted">{r.short}</div>
                  <div
                    className={cn(
                      "mt-1 text-lg font-semibold tabular-nums",
                      r.count === 0 ? "text-danger" : "text-fg",
                    )}
                  >
                    {r.count}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted">
                    {r.count === 0 ? "gap" : r.count === 1 ? "player" : "players"}
                  </div>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {teamHeroes.length > 0 ? (
        <Card>
          <CardHeader
            title="Team hero pool"
            subtitle="Most-played heroes across the roster, with win rate"
          />
          <CardBody>
            <HeroPool heroes={teamHeroes} heroNames={heroNames} />
          </CardBody>
        </Card>
      ) : null}

      {h2h.length > 0 ? (
        <Card>
          <CardHeader title="Head-to-head" subtitle="Completed series by opponent" />
          <CardBody className="p-0">
            <ul className="divide-y divide-line/60">
              {h2h.map((r) => {
                const record = `${r.wins}–${r.losses}${r.draws > 0 ? `–${r.draws}` : ""}`;
                const edge =
                  r.wins > r.losses ? "success" : r.losses > r.wins ? "danger" : "neutral";
                return (
                  <li
                    key={r.opponentId}
                    className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm transition-colors hover:bg-surface-2/40"
                  >
                    <Link
                      href={`/teams/${r.opponentId}`}
                      className="flex min-w-0 flex-1 items-center gap-2 font-medium hover:text-info"
                    >
                      <TeamCrest
                        name={teamName.get(r.opponentId) ?? "?"}
                        seed={r.opponentId}
                        size={20}
                        className="shrink-0 rounded"
                      />
                      <span className="truncate">
                        {teamName.get(r.opponentId) ?? "?"}
                      </span>
                    </Link>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-muted">
                        {r.gamesFor}–{r.gamesAgainst} games
                      </span>
                      <Badge tone={edge}>{record}</Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Matches" />
        <CardBody className="p-0">
          {myMatches.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No matches scheduled yet" />
            </div>
          ) : (
            <ul className="divide-y divide-line/60">
              {myMatches.map((m) => {
                const isHome = m.homeTeamId === id;
                const oppId = isHome ? m.awayTeamId : m.homeTeamId;
                const myScore = isHome ? m.homeScore : m.awayScore;
                const oppScore = isHome ? m.awayScore : m.homeScore;
                const won = m.winnerTeamId === id;
                const when = fmtDate(m.scheduledAt);
                return (
                  <li key={m.id}>
                    <Link
                      href={`/matches/${m.id}`}
                      className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-surface-2/40"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-3">
                        {m.phase !== "REGULAR" ? (
                          <Badge tone="accent" className="shrink-0">
                            {matchPhaseLabel(m.phase, m.week)}
                          </Badge>
                        ) : (
                          <span className="w-12 shrink-0 text-xs text-muted">
                            Wk {m.week}
                          </span>
                        )}
                        <TeamCrest
                          name={teamName.get(oppId) ?? "?"}
                          seed={oppId}
                          size={20}
                          className="shrink-0 rounded"
                        />
                        <span className="min-w-0 truncate">
                          <span className="text-muted">vs </span>
                          <span className="font-medium">
                            {teamName.get(oppId) ?? "?"}
                          </span>
                          {when && m.scheduledAt ? (
                            <LocalTime
                              ts={m.scheduledAt.getTime()}
                              variant="full"
                              initial={when}
                              className="ml-2 text-xs text-muted"
                            />
                          ) : null}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {m.status === "COMPLETED" ? (
                          <>
                            <Badge tone={won ? "success" : "danger"}>
                              {won ? "W" : oppScore === myScore ? "T" : "L"}
                            </Badge>
                            <span className="font-mono">
                              {myScore}–{oppScore}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-muted">upcoming</span>
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * "What we need": the team's live playoff scenario from the exact engine —
 * win-and-in / lose-and-out, magic number, scenario odds, and the possible
 * finishing range. Regular season only; conservative on ties throughout.
 */
function WhatWeNeed({ scenario, cut }: { scenario: TeamScenario; cut: number }) {
  const s = scenario;
  const odds =
    s.exact && s.madeCount != null && s.leafCount
      ? Math.round((s.madeCount / s.leafCount) * 100)
      : null;

  const facts: { icon: string; text: string }[] = [];
  const nothingLeft = s.nextMatchId === null;
  if (s.status === null) {
    if (nothingLeft) {
      // Fate open with nothing left to play: the rest of the league (and
      // possibly the tiebreakers) decides — the scenario line below still
      // carries the real odds, so don't editorialize beyond that.
      facts.push({
        icon: "⏳",
        text: "Their matches are done — the rest of the league decides it from here.",
      });
    } else {
      if (s.winAndIn && s.loseAndOut) {
        facts.push({
          icon: "⚡",
          text: "Win the next series and they're in — lose it and they're out.",
        });
      } else if (s.winAndIn) {
        facts.push({
          icon: "🎯",
          text: "Win the next series and a playoff spot is locked, whatever else happens.",
        });
      } else if (s.loseAndOut) {
        facts.push({
          icon: "⚠️",
          text: "Lose the next series and the playoffs are gone, whatever else happens.",
        });
      }
      // The magic number comes from the conservative bounds layer, which
      // can't see head-to-head — when the exact engine already proved
      // win-next-and-in, a bounds "can't lock it alone" line would flatly
      // contradict it. Same guard as the schedule page's race notes.
      if (!s.winAndIn) {
        if (s.magicNumber != null && s.magicNumber > 0) {
          facts.push({
            icon: "🔢",
            text: `Magic number ${s.magicNumber}: that many more series wins guarantee a top-${cut} finish.`,
          });
        } else if (s.magicNumber == null) {
          facts.push({
            icon: "🤝",
            text: "Winning out alone can't lock it — they'll need results elsewhere too.",
          });
        }
      }
      if (s.eliminationLosses != null && s.eliminationLosses > 0) {
        facts.push({
          icon: "🧮",
          text: `${s.eliminationLosses} more series ${s.eliminationLosses === 1 ? "loss" : "losses"} would guarantee missing the cut.`,
        });
      }
    }
    if (s.exact && s.madeCount != null && s.leafCount) {
      if (s.madeCount > 0) {
        // Guard on madeCount, not the rounded percent — 1 leaf in 243 is a
        // real points-only path, not "no scenario".
        facts.push({
          icon: "📊",
          text: `Safely top-${cut} in ${odds && odds > 0 ? `${odds}%` : "<1%"} of the ${s.leafCount.toLocaleString()} remaining scenarios (ties counted against them).`,
        });
      } else {
        facts.push({
          icon: "🎲",
          text: "No remaining result locks it on points alone — they'd need tiebreakers to fall right.",
        });
      }
    }
  }
  facts.push({
    icon: "📈",
    text:
      s.bestRank === s.worstRank
        ? `Locked into finishing #${s.bestRank}.`
        : `Could still finish anywhere from #${s.bestRank} to #${s.worstRank}.`,
  });

  const title =
    s.status === "CLINCHED"
      ? "✓ Playoff spot locked"
      : s.status === "ELIMINATED"
        ? "Out of the playoff race"
        : "What we need";
  const subtitle =
    s.status === "CLINCHED"
      ? "Now it's about seeding"
      : s.status === "ELIMINATED"
        ? "Playing for pride — and next season"
        : `The road to a top-${cut} finish${s.exact ? "" : " (points bounds — race too big to enumerate)"}`;

  return (
    <Card
      className={cn(
        s.status === "CLINCHED" && "border-success/30",
        s.status === null && "border-accent/30",
      )}
    >
      <CardHeader title={title} subtitle={subtitle} />
      <CardBody>
        <ul className="space-y-1.5 text-sm">
          {facts.map((f) => (
            <li key={f.text} className="flex items-start gap-2">
              <span aria-hidden className="shrink-0">
                {f.icon}
              </span>
              <span className="min-w-0">{f.text}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function safeParse(json: string): PlayerStat[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
