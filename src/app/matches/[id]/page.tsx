import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { shareMetadata } from "@/lib/share-metadata";
import { getHeroNames } from "@/lib/dota";
import { formatNetWorth, cn } from "@/lib/utils";
import { heroById } from "@/lib/heroes";
import { recentForm, headToHead } from "@/lib/team-matches";
import { gameMvp } from "@/lib/achievements";
import { CheckinBanner } from "@/components/checkin-banner";
import type { PlayerStat } from "@/lib/match-import";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  FormStrip,
  HeroIcon,
  KDA,
  PageTitle,
  PlayerLink,
  RankBadge,
  RoleBadges,
  TeamCrest,
  buttonClasses,
  teamHue,
} from "@/components/ui";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const match = await prisma.match.findUnique({
    where: { id },
    select: {
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
  if (!match) return { title: "Match" };
  const title = `${match.homeTeam.name} vs ${match.awayTeam.name}`;
  return shareMetadata(
    title,
    `${title} — box score and results in the Under 4.5K League.`,
  );
}

export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const match = await prisma.match.findUnique({
    where: { id },
    include: {
      homeTeam: true,
      awayTeam: true,
      games: { orderBy: { startTime: "asc" } },
      standins: { include: { standin: true, replaced: true } },
    },
  });
  if (!match) notFound();

  const heroes = await getHeroNames();
  const games = match.games.map((g) => ({
    ...g,
    parsed: safeParse(g.players),
  }));

  const userIds = [
    ...new Set(
      games.flatMap((g) => g.parsed.map((p) => p.userId).filter(Boolean)),
    ),
  ] as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } } })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userAvatar = new Map(users.map((u) => [u.id, u.avatar]));
  const teamName = new Map([
    [match.homeTeamId, match.homeTeam.name],
    [match.awayTeamId, match.awayTeam.name],
  ]);

  return (
    <div className="space-y-6">
      <PageTitle
        title={`${match.homeTeam.name} vs ${match.awayTeam.name}`}
        subtitle={`Week ${match.week}${match.phase !== "REGULAR" ? ` · ${match.phase}` : ""}`}
        action={
          <Link href="/schedule" className={buttonClasses("secondary", "sm")}>
            ← Schedule
          </Link>
        }
      />

      <Card className="relative overflow-hidden">
        <div
          aria-hidden
          className="hero-grid pointer-events-none absolute inset-0 opacity-40"
        />
        {/* Each side glows with its team's own color identity (home left, away right). */}
        <div
          aria-hidden
          className="animate-hero-glow pointer-events-none absolute -left-10 top-0 h-40 w-40 -translate-y-1/3 rounded-full blur-3xl"
          style={{
            backgroundColor: `hsl(${teamHue(match.homeTeamId)} 70% 50% / 0.24)`,
          }}
        />
        <div
          aria-hidden
          className="animate-hero-glow-alt pointer-events-none absolute -right-10 bottom-0 h-40 w-40 translate-y-1/3 rounded-full blur-3xl"
          style={{
            backgroundColor: `hsl(${teamHue(match.awayTeamId)} 70% 50% / 0.24)`,
          }}
        />
        <CardBody className="relative flex items-center gap-3 py-7 sm:gap-6">
          <TeamSide
            name={match.homeTeam.name}
            teamId={match.homeTeamId}
            score={match.homeScore}
            win={match.winnerTeamId === match.homeTeamId}
          />
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-widest text-muted">
            series
          </span>
          <TeamSide
            name={match.awayTeam.name}
            teamId={match.awayTeamId}
            score={match.awayScore}
            win={match.winnerTeamId === match.awayTeamId}
            right
          />
        </CardBody>
      </Card>

      {games.length === 0 && match.status !== "COMPLETED" ? (
        <MatchPreview match={match} />
      ) : games.length === 0 ? (
        <EmptyState
          title="No games recorded yet"
          description="Games are pulled from Dota (OpenDota) once the match has been played."
        />
      ) : (
        games.map((g, i) => {
          const radiant = g.parsed.filter((p) => p.isRadiant);
          const dire = g.parsed.filter((p) => !p.isRadiant);
          const winnerName = g.winnerTeamId ? teamName.get(g.winnerTeamId) : null;
          const radiantName = g.radiantTeamId
            ? (teamName.get(g.radiantTeamId) ?? "Radiant")
            : "Radiant";
          const direName = g.direTeamId
            ? (teamName.get(g.direTeamId) ?? "Dire")
            : "Dire";
          const maxNet = Math.max(1, ...g.parsed.map((p) => p.netWorth ?? 0));
          const mvpId = gameMvp(g.parsed, g.radiantWin);
          const radiantNet = radiant.reduce((s, p) => s + (p.netWorth ?? 0), 0);
          const direNet = dire.reduce((s, p) => s + (p.netWorth ?? 0), 0);
          return (
            <Card key={g.id}>
              <CardHeader
                title={`Game ${i + 1}`}
                subtitle={`${Math.floor(g.durationSecs / 60)}m ${g.durationSecs % 60}s · ${g.radiantScore}-${g.direScore} kills`}
                action={
                  <div className="flex items-center gap-2">
                    {winnerName ? <Badge tone="success">{winnerName} won</Badge> : null}
                    <a
                      href={`https://www.opendota.com/matches/${g.dotaMatchId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-info hover:underline"
                    >
                      OpenDota ↗
                    </a>
                  </div>
                }
              />
              <CardBody className="grid gap-x-6 gap-y-5 md:grid-cols-2">
                <NetWorthAdvantage
                  radiantName={radiantName}
                  direName={direName}
                  radiantNet={radiantNet}
                  direNet={direNet}
                />
                <SidePlayers
                  label={radiantName}
                  win={g.radiantWin}
                  mvpId={mvpId}
                  players={radiant}
                  heroes={heroes}
                  userName={userName}
                  userAvatar={userAvatar}
                  maxNet={maxNet}
                />
                <SidePlayers
                  label={direName}
                  win={!g.radiantWin}
                  mvpId={mvpId}
                  players={dire}
                  heroes={heroes}
                  userName={userName}
                  userAvatar={userAvatar}
                  maxNet={maxNet}
                />
              </CardBody>
            </Card>
          );
        })
      )}
    </div>
  );
}

// Pre-match scouting: rosters, recent form, prior meetings, and who's
// confirmed for match night — shown until the first game is recorded.
async function MatchPreview({
  match,
}: {
  match: {
    id: string;
    seasonId: string;
    week: number;
    status: string;
    scheduledAt: Date | null;
    homeTeamId: string;
    awayTeamId: string;
    homeTeam: { name: string };
    awayTeam: { name: string };
    standins: {
      id: string;
      teamId: string;
      standin: { id: string; name: string };
      replaced: { id: string; name: string } | null;
    }[];
  };
}) {
  const viewer = await getSessionUser();
  const [members, seasonMatches, rsvps] = await Promise.all([
    prisma.teamMember.findMany({
      where: {
        seasonId: match.seasonId,
        teamId: { in: [match.homeTeamId, match.awayTeamId] },
      },
      include: { user: true },
      orderBy: { price: "desc" },
    }),
    prisma.match.findMany({
      where: { seasonId: match.seasonId },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    prisma.matchAvailability.findMany({ where: { matchId: match.id } }),
  ]);
  const regs = await prisma.registration.findMany({
    where: {
      seasonId: match.seasonId,
      userId: { in: members.map((m) => m.userId) },
    },
    select: { userId: true, roles: true, mmr: true },
  });
  const regByUser = new Map(regs.map((r) => [r.userId, r]));
  const rsvpByUser = new Map(rsvps.map((r) => [r.userId, r.status]));

  const isParticipant =
    !!viewer &&
    (members.some((m) => m.userId === viewer.id) ||
      match.standins.some((s) => s.standin.id === viewer.id));
  const myRsvp = viewer ? (rsvpByUser.get(viewer.id) ?? null) : null;

  const h2hRow = headToHead(match.homeTeamId, seasonMatches).find(
    (h) => h.opponentId === match.awayTeamId,
  );

  const side = (teamId: string, name: string) => {
    const roster = members.filter((m) => m.teamId === teamId);
    const subs = match.standins.filter((s) => s.teamId === teamId);
    const replacedIds = new Set(
      subs.map((s) => s.replaced?.id).filter(Boolean),
    );
    const form = recentForm(
      teamId,
      seasonMatches.filter(
        (m) => m.homeTeamId === teamId || m.awayTeamId === teamId,
      ),
    );
    return { teamId, name, roster, subs, replacedIds, form };
  };
  const sides = [
    side(match.homeTeamId, match.homeTeam.name),
    side(match.awayTeamId, match.awayTeam.name),
  ];

  return (
    <div className="space-y-6">
      {isParticipant ? (
        <CheckinBanner
          matchId={match.id}
          heading="You're playing in this match"
          whenTs={match.scheduledAt?.getTime()}
          myRsvp={myRsvp}
        />
      ) : null}

      <Card>
        <CardHeader
          title="Matchup"
          subtitle={
            h2hRow && h2hRow.wins + h2hRow.losses + h2hRow.draws > 0
              ? `Prior meetings: ${
                  h2hRow.wins > h2hRow.losses
                    ? `${match.homeTeam.name} lead ${h2hRow.wins}–${h2hRow.losses}`
                    : h2hRow.losses > h2hRow.wins
                      ? `${match.awayTeam.name} lead ${h2hRow.losses}–${h2hRow.wins}`
                      : `tied ${h2hRow.wins}–${h2hRow.losses}`
                }${h2hRow.draws ? ` (${h2hRow.draws} drawn)` : ""}`
              : "First meeting this season"
          }
        />
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {sides.map((s) => (
            <div key={s.teamId} className="rounded-lg border border-line p-3">
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <Link
                  href={`/teams/${s.teamId}`}
                  className="flex min-w-0 items-center gap-2 font-display text-base font-semibold hover:text-info"
                >
                  <TeamCrest
                    name={s.name}
                    seed={s.teamId}
                    size={24}
                    className="rounded-md"
                  />
                  <span className="truncate">{s.name}</span>
                </Link>
                {s.form.length > 0 ? <FormStrip form={s.form} /> : null}
              </div>
              <ul className="space-y-1">
                {s.roster.map((m) => {
                  const reg = regByUser.get(m.userId);
                  const rsvp = rsvpByUser.get(m.userId);
                  const replaced = s.replacedIds.has(m.userId);
                  return (
                    <li
                      key={m.id}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm",
                        replaced && "opacity-50",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar name={m.user.name} src={m.user.avatar} size={22} />
                        <PlayerLink userId={m.userId} className="truncate">
                          {m.user.name}
                        </PlayerLink>
                        {m.isCaptain ? <Badge tone="accent">C</Badge> : null}
                        <RankBadge rankTier={m.user.rankTier} />
                        <RoleBadges roles={reg?.roles ?? ""} />
                      </span>
                      <span className="shrink-0 text-xs">
                        {replaced ? (
                          <span className="text-muted">standin covers</span>
                        ) : rsvp === "IN" ? (
                          <span className="text-success">✓ in</span>
                        ) : rsvp === "OUT" ? (
                          <span className="text-danger">✗ out</span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </span>
                    </li>
                  );
                })}
                {s.subs.map((sub) => (
                  <li
                    key={sub.id}
                    className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm"
                  >
                    <span className="text-xs">🔁</span>
                    <PlayerLink userId={sub.standin.id} className="truncate">
                      {sub.standin.name}
                    </PlayerLink>
                    <span className="truncate text-xs text-muted">
                      in for {sub.replaced?.name ?? "?"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardBody>
      </Card>

      <p className="text-center text-xs text-muted">
        The box score appears here once the match is played and imported from
        Dota (OpenDota).
      </p>
    </div>
  );
}

function TeamSide({
  name,
  teamId,
  score,
  win,
  right,
}: {
  name: string;
  teamId: string;
  score: number;
  win: boolean;
  right?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-3",
        right && "flex-row-reverse",
      )}
    >
      <TeamCrest name={name} seed={teamId} size={44} />
      <Link
        href={`/teams/${teamId}`}
        className={cn(
          "min-w-0 flex-1 truncate font-display text-lg font-semibold hover:text-info",
          right && "text-right",
          win ? "text-fg" : "text-muted",
        )}
      >
        {name}
      </Link>
      <span
        className={cn(
          "shrink-0 font-display text-4xl font-bold tabular-nums",
          win ? "text-fg" : "text-muted",
        )}
      >
        {score}
      </span>
    </div>
  );
}

// The team net-worth split — Dota's signature "who's ahead" summary as a
// single bar (Radiant green / Dire red) with the current gold lead.
function NetWorthAdvantage({
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
    <div className="md:col-span-2">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-emerald-300">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
          <span className="truncate">{radiantName}</span>
          <span className="font-mono text-muted">{formatNetWorth(radiantNet)}</span>
        </span>
        <span className="shrink-0 text-muted">
          {lead === 0
            ? "Even net worth"
            : `${leaderName} +${formatNetWorth(Math.abs(lead))}`}
        </span>
        <span className="flex min-w-0 items-center justify-end gap-1.5 font-medium text-rose-300">
          <span className="font-mono text-muted">{formatNetWorth(direNet)}</span>
          <span className="truncate">{direName}</span>
          <span className="h-2 w-2 shrink-0 rounded-full bg-rose-400" />
        </span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="bg-emerald-500/70 transition-all"
          style={{ width: `${radPct}%` }}
        />
        <div className="flex-1 bg-rose-500/70" />
      </div>
    </div>
  );
}

function SidePlayers({
  label,
  win,
  players,
  heroes,
  userName,
  userAvatar,
  maxNet,
  mvpId,
}: {
  label: string;
  win: boolean;
  players: PlayerStat[];
  heroes: Record<number, string>;
  userName: Map<string, string>;
  userAvatar: Map<string, string | null>;
  maxNet: number;
  mvpId?: string | null;
}) {
  const totalNet = players.reduce((s, p) => s + (p.netWorth ?? 0), 0);
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
        "rounded-lg border p-3",
        win ? "border-success/40 bg-success/5" : "border-line",
      )}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="font-display text-base font-semibold">{label}</span>
          {win ? <Badge tone="success">Win</Badge> : <Badge>Loss</Badge>}
        </span>
        {hasNet ? (
          <span className="text-xs text-muted">
            Net worth{" "}
            <span className="font-mono text-accent">
              {formatNetWorth(totalNet)}
            </span>
          </span>
        ) : null}
      </div>
      <ul className="space-y-0.5">
        {ordered.map((p, idx) => {
          const displayName = p.userId
            ? (userName.get(p.userId) ?? p.personaname ?? "Unknown")
            : (p.personaname ?? "Unknown");
          const hero = heroById(p.heroId);
          const heroName = heroes[p.heroId] ?? hero?.name ?? `Hero ${p.heroId}`;
          const nwPct =
            p.netWorth != null ? Math.round((p.netWorth / maxNet) * 100) : 0;
          return (
            <li
              key={idx}
              className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-2/50"
            >
              <div className="flex items-center gap-2.5">
                {hero ? (
                  <HeroIcon hero={hero} size={30} />
                ) : (
                  <span className="h-[30px] w-[30px] shrink-0 rounded-md border border-line/70 bg-surface-2" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {p.userId ? (
                      <Avatar
                        name={displayName}
                        src={userAvatar.get(p.userId) ?? null}
                        size={18}
                      />
                    ) : null}
                    {p.userId ? (
                      <PlayerLink userId={p.userId} className="truncate text-sm">
                        {displayName}
                      </PlayerLink>
                    ) : (
                      <span className="truncate text-sm">{displayName}</span>
                    )}
                    {p.userId && p.userId === mvpId ? (
                      <Badge tone="accent" title="Best line of the game">
                        MVP
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {heroName}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <KDA
                    kills={p.kills}
                    deaths={p.deaths}
                    assists={p.assists}
                    className="block text-xs"
                  />
                  {hasGpm || hasLh ? (
                    <div className="text-[11px] tabular-nums text-muted">
                      {[
                        hasGpm ? `${p.gpm ?? "—"} gpm` : null,
                        hasLh ? `${p.lastHits ?? "—"} lh` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  ) : null}
                </div>
                {hasNet ? (
                  <div className="w-14 shrink-0 text-right">
                    <div className="font-mono text-xs tabular-nums text-accent">
                      {formatNetWorth(p.netWorth)}
                    </div>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-accent/80"
                        style={{ width: `${nwPct}%` }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
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
