import Link from "next/link";
import { Suspense } from "react";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { INHOUSE_STATUS } from "@/lib/constants";
import {
  parseInhouseBox,
  type InhouseBoxPlayer as BoxPlayer,
} from "@/lib/inhouse-box";
import {
  PROVISIONAL_GAMES,
  rankInhouse,
  summarizeInhouse,
  type FinishedLobby,
} from "@/lib/inhouse-stats";
import { heroById } from "@/lib/heroes";
import { gameMvp } from "@/lib/achievements";
import { formatMatchTime } from "@/lib/match-time";
import { formatMmrRange, mmrRangeForRankTier, rankMedalName } from "@/lib/rank";
import { InhouseRoom } from "@/components/inhouse-room";
import { HeroVideo } from "@/components/hero-video";
import { LocalTime } from "@/components/local-time";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  FormStrip,
  HeroIcon,
  KDA,
  PageTitle,
  PlayerLink,
  SectionTitle,
} from "@/components/ui";
import { cn, formatNetWorth } from "@/lib/utils";

export const metadata = {
  title: "Inhouse",
  description:
    "Pick-up Dota 2 games, drafted live: queue up, vote captains, draft teams, and play — results auto-record from OpenDota onto the Elo ladder.",
};

export default async function InhousePage() {
  const user = await getSessionUser();

  // Seed the MMR field from the player's most recent league signup, if any,
  // and fetch the medal so the join panel can explain the MMR check (the
  // server clamps implausible values to the medal window's floor on join).
  const [lastReg, dbUser] = user
    ? await Promise.all([
        prisma.registration.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
          select: { mmr: true },
        }),
        prisma.user.findUnique({
          where: { id: user.id },
          select: { rankTier: true },
        }),
      ])
    : [null, null];
  const mmrWindow = mmrRangeForRankTier(dbUser?.rankTier ?? null);
  const mmrHint = mmrWindow
    ? `Your ${rankMedalName(dbUser?.rankTier)} medal puts you around ${formatMmrRange(mmrWindow)} MMR — ${
        mmrWindow.min > 0
          ? `a typed value outside that range is set to ${mmrWindow.min}`
          : "a typed value outside that range is treated as unknown"
      }. League signup MMR, when you have one, is used as-is.`
    : null;

  return (
    <>
      {/* Ambient full-page video background, fixed behind all page content. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      >
        <HeroVideo
          src="/hero-loop.mp4"
          peakOpacity={0.15}
          playbackRate={0.65}
          trimEnd={1}
        />
        {/* Dark tint so the content stays readable over the footage. */}
        <div className="absolute inset-0 bg-bg/40" />
      </div>

      <div className="space-y-8">
        <PageTitle
          title="Inhouse"
          subtitle="Pick-up games, drafted live. Queue up, get captained, and play — no season required."
          action={<Badge tone="accent">Casual mode</Badge>}
        />

        <InhouseRoom defaultMmr={lastReg?.mmr ?? 0} mmrHint={mmrHint} />

        <OpenDotaGuide />

        {/* The room above paints immediately; the history-scanning sections
            stream in behind it (CLAUDE.md in-page streaming convention). */}
        <Suspense fallback={<CardSkeleton rows={5} />}>
          <RecentResults />
        </Suspense>
        <Suspense fallback={<CardSkeleton rows={6} />}>
          <LadderCard meId={user?.id ?? null} />
        </Suspense>
      </div>
    </>
  );
}

// Latest box-score cards + the link into the full archive.
async function RecentResults() {
  const completed = await prisma.inhouseLobby.findMany({
    where: { status: INHOUSE_STATUS.COMPLETED },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: {
      id: true,
      winnerTeam: true,
      radiantTeam: true,
      dotaMatchId: true,
      durationSecs: true,
      radiantScore: true,
      direScore: true,
      boxScore: true,
      createdAt: true,
    },
  });

  // Recent games that have a fetched box score → rich result cards.
  const results = completed
    .map((l) => ({ lobby: l, players: parseInhouseBox(l.boxScore) }))
    .filter((r) => r.players.length > 0)
    .slice(0, 4);
  if (results.length === 0) return null;

  const avatarIds = [
    ...new Set(
      results.flatMap((r) =>
        r.players.map((p) => p.userId).filter((x): x is string => !!x),
      ),
    ),
  ];
  const avatarUsers = avatarIds.length
    ? await prisma.user.findMany({
        where: { id: { in: avatarIds } },
        select: { id: true, avatar: true },
      })
    : [];
  const avatarMap = new Map(avatarUsers.map((u) => [u.id, u.avatar]));

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle>Recent results</SectionTitle>
        <Link
          href="/inhouse/history"
          className="text-sm text-info hover:underline"
        >
          All results →
        </Link>
      </div>
      {results.map((r) => (
        // Anchor target for the room's result banner ("Box score ↓");
        // scroll-mt clears the sticky header.
        <div key={r.lobby.id} id={`result-${r.lobby.id}`} className="scroll-mt-24">
          <GameResultCard
            lobby={r.lobby}
            players={r.players}
            avatarMap={avatarMap}
          />
        </div>
      ))}
    </div>
  );
}

// The full-history Elo ladder (no take window — Elo accumulates over ALL
// games, per CLAUDE.md).
async function LadderCard({ meId }: { meId: string | null }) {
  const ladderLobbies = await prisma.inhouseLobby.findMany({
    where: { status: INHOUSE_STATUS.COMPLETED },
    select: {
      id: true,
      winnerTeam: true,
      createdAt: true,
      players: {
        select: {
          userId: true,
          team: true,
          user: { select: { name: true, avatar: true } },
        },
      },
    },
  });
  const finished: FinishedLobby[] = ladderLobbies.map((l) => ({
    id: l.id,
    winnerTeam: l.winnerTeam,
    createdAt: l.createdAt,
    players: l.players.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      avatar: p.user.avatar,
      team: p.team,
    })),
  }));
  const leaderboard = summarizeInhouse(finished);

  return (
    // overflow-hidden on the CARD: the table scroller inside must not leak
    // its width into the page scroll area (CLAUDE.md mobile rule).
    <Card className="overflow-hidden">
      <CardHeader
        title="Inhouse ladder"
        subtitle="Personal Elo across completed inhouse games — everyone starts at 1000, wins against stronger lobbies pay more"
      />
      <CardBody className="p-0">
        <YourStanding rows={leaderboard} meId={meId} />
        <Leaderboard rows={leaderboard} meId={meId} />
      </CardBody>
    </Card>
  );
}

// ---------- OpenDota "be findable" guide ----------

function OpenDotaGuide() {
  return (
    <details
      open
      className="group rounded-[var(--radius)] border border-line bg-surface/80 shadow-sm backdrop-blur"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-info/15 text-info">
            🔎
          </span>
          <div>
            <h3 className="text-base font-semibold text-fg">
              Make your games auto-detect
            </h3>
            <p className="mt-0.5 text-sm text-muted">
              Inhouse results are pulled from OpenDota — here&apos;s how to be
              findable.
            </p>
          </div>
        </div>
        <span className="shrink-0 text-muted transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="space-y-3 border-t border-line px-5 py-4 text-sm">
        <ol className="space-y-3">
          <li className="flex gap-3">
            <GuideStep n={1} />
            <span>
              In Dota 2, open <b>Settings → Options</b> and turn on{" "}
              <b>&ldquo;Expose Public Match Data&rdquo;</b>. This lets OpenDota
              (and us) see your match history.
            </span>
          </li>
          <li className="flex gap-3">
            <GuideStep n={2} />
            <span>
              Link your Dota account on your{" "}
              <Link href="/me" className="text-info hover:underline">
                profile
              </Link>{" "}
              so we can match you in games — or we derive it from your Steam ID.
            </span>
          </li>
          <li className="flex gap-3">
            <GuideStep n={3} />
            <span>
              Play your inhouse. When it ends, the result is fetched from OpenDota
              automatically (usually within a few minutes) — or anyone in the game
              can paste the match ID.
            </span>
          </li>
        </ol>
        <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs text-muted">
          Not everyone needs this on — a few players per side is enough — but the
          more the better. It only exposes games played <b>after</b> you enable
          it, and OpenDota can take a few minutes to index a finished game.
        </p>
      </div>
    </details>
  );
}

function GuideStep({ n }: { n: number }) {
  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-xs font-semibold text-accent">
      {n}
    </span>
  );
}

// ---------- Box-score result card ----------

function GameResultCard({
  lobby,
  players,
  avatarMap,
}: {
  lobby: {
    id: string;
    winnerTeam: number | null;
    radiantTeam: number;
    dotaMatchId: string | null;
    durationSecs: number | null;
    radiantScore: number | null;
    direScore: number | null;
    createdAt: Date;
  };
  players: BoxPlayer[];
  avatarMap: Map<string, string | null>;
}) {
  const radiantWin = lobby.winnerTeam != null && lobby.winnerTeam === lobby.radiantTeam;
  const radiant = players.filter((p) => p.isRadiant);
  const dire = players.filter((p) => !p.isRadiant);
  // Best line of the game — same tested MVP math the league box scores use.
  const mvpId = gameMvp(players, radiantWin);
  const dur = lobby.durationSecs ?? 0;
  const durStr = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`;
  const maxNet = Math.max(1, ...players.map((p) => p.netWorth ?? 0));
  const radiantNet = radiant.reduce((s, p) => s + (p.netWorth ?? 0), 0);
  const direNet = dire.reduce((s, p) => s + (p.netWorth ?? 0), 0);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <span className={cn("text-sm font-semibold", radiantWin ? "text-success" : "text-muted")}>
            Radiant
          </span>
          <span className="font-mono text-xl font-bold tabular-nums">
            {lobby.radiantScore ?? 0}
            <span className="px-1.5 text-muted">–</span>
            {lobby.direScore ?? 0}
          </span>
          <span className={cn("text-sm font-semibold", !radiantWin ? "text-danger" : "text-muted")}>
            Dire
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <Badge tone={radiantWin ? "success" : "danger"}>
            {radiantWin ? "Radiant" : "Dire"} victory
          </Badge>
          <LocalTime
            ts={lobby.createdAt.getTime()}
            variant="short"
            initial={formatMatchTime(lobby.createdAt, "short")}
          />
          <span className="tabular-nums">{durStr}</span>
          {lobby.dotaMatchId ? (
            <a
              href={`https://www.opendota.com/matches/${lobby.dotaMatchId}`}
              target="_blank"
              rel="noreferrer"
              className="text-info hover:underline"
            >
              OpenDota ↗
            </a>
          ) : null}
        </div>
      </div>
      <CardBody className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2">
        <InhouseNetWorthBar radiantNet={radiantNet} direNet={direNet} />
        <SideBox
          label="Radiant"
          win={radiantWin}
          players={radiant}
          avatarMap={avatarMap}
          maxNet={maxNet}
          mvpId={mvpId}
        />
        <SideBox
          label="Dire"
          win={!radiantWin}
          players={dire}
          avatarMap={avatarMap}
          maxNet={maxNet}
          mvpId={mvpId}
        />
      </CardBody>
    </Card>
  );
}

// Radiant (green) vs Dire (red) net-worth split — the "who's ahead" summary.
function InhouseNetWorthBar({
  radiantNet,
  direNet,
}: {
  radiantNet: number;
  direNet: number;
}) {
  const total = radiantNet + direNet;
  if (total <= 0) return null;
  const radPct = Math.round((radiantNet / total) * 100);
  const lead = radiantNet - direNet;
  return (
    <div className="md:col-span-2">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-success">
          <span className="h-2 w-2 rounded-full bg-success" />
          Radiant
          <span className="font-mono text-muted">
            {formatNetWorth(radiantNet)}
          </span>
        </span>
        <span className="shrink-0 text-muted">
          {lead === 0
            ? "Even net worth"
            : `${lead > 0 ? "Radiant" : "Dire"} +${formatNetWorth(Math.abs(lead))}`}
        </span>
        <span className="flex items-center gap-1.5 font-medium text-danger">
          <span className="font-mono text-muted">{formatNetWorth(direNet)}</span>
          Dire
          <span className="h-2 w-2 rounded-full bg-danger" />
        </span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="bg-success/70 transition-all"
          style={{ width: `${radPct}%` }}
        />
        <div className="flex-1 bg-danger/70" />
      </div>
    </div>
  );
}

function SideBox({
  label,
  win,
  players,
  avatarMap,
  maxNet,
  mvpId,
}: {
  label: string;
  win: boolean;
  players: BoxPlayer[];
  avatarMap: Map<string, string | null>;
  maxNet: number;
  mvpId: string | null;
}) {
  const isRadiant = label === "Radiant";
  const hasNet = players.some((p) => p.netWorth != null);
  const hasGpm = players.some((p) => p.gpm != null);
  const hasLh = players.some((p) => p.lastHits != null);
  // Sort by farm so the gold bars descend, like Dota's post-game screen.
  const ordered = [...players].sort(
    (a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0) || b.kills - a.kills,
  );
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        win
          ? isRadiant
            ? "border-success/40 bg-success/5"
            : "border-danger/40 bg-danger/5"
          : "border-line",
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span className={cn("h-2.5 w-2.5 rounded-full", isRadiant ? "bg-success" : "bg-danger")} />
          {label}
        </span>
        <Badge tone={win ? "success" : "neutral"}>{win ? "Win" : "Loss"}</Badge>
      </div>
      <ul className="space-y-0.5">
        {ordered.map((p, i) => {
          const hero = heroById(p.heroId);
          const nwPct =
            p.netWorth != null ? Math.round((p.netWorth / maxNet) * 100) : 0;
          return (
            <li
              key={i}
              className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-2/50"
            >
              <div className="flex items-center gap-2.5">
                {hero ? (
                  <HeroIcon hero={hero} size={30} />
                ) : (
                  <span className="h-[30px] w-[30px] shrink-0 rounded-md border border-line/70 bg-surface-2" />
                )}
                <div className="min-w-0 flex-1">
                  {p.userId ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Avatar
                        name={p.name ?? "?"}
                        src={avatarMap.get(p.userId) ?? null}
                        size={18}
                      />
                      <PlayerLink userId={p.userId} className="truncate text-sm">
                        {p.name ?? "Unknown"}
                      </PlayerLink>
                      {p.userId === mvpId ? (
                        <span
                          role="img"
                          aria-label="Match MVP"
                          title="Match MVP — best line of the game"
                          className="shrink-0 text-xs"
                        >
                          🏅
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="truncate text-sm text-muted">
                      {p.name ?? "Unknown"}
                    </span>
                  )}
                  {hero ? (
                    <div className="truncate text-[11px] text-muted">
                      {hero.name}
                    </div>
                  ) : null}
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

// The signed-in player's ladder line at a glance, pinned above the table.
function YourStanding({
  rows,
  meId,
}: {
  rows: ReturnType<typeof summarizeInhouse>;
  meId: string | null;
}) {
  if (!meId) return null;
  const me = rows.find((r) => r.userId === meId);
  if (!me) return null;
  // Rank only counts among established players — provisionals are unranked.
  const { ranked } = rankInhouse(rows);
  const idx = ranked.findIndex((r) => r.userId === meId);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-accent/5 px-5 py-3 text-sm">
      <span className="font-semibold">Your standing</span>
      <span className="text-muted tabular-nums">
        {idx >= 0 ? `#${idx + 1} of ${ranked.length}` : "unranked"}
      </span>
      <span className="tabular-nums">
        <span className="font-semibold">{me.rating}</span>
        <span className="text-muted"> Elo</span>
        {me.lastChange !== 0 ? (
          <span
            className={cn(
              "ml-1 text-xs font-medium",
              me.lastChange > 0 ? "text-success" : "text-danger",
            )}
            title="Elo change from your last game"
          >
            {me.lastChange > 0 ? `+${me.lastChange}` : me.lastChange}
          </span>
        ) : null}
        <span className="ml-1 text-xs text-muted">(peak {me.peak})</span>
      </span>
      <span className="tabular-nums">
        <span className="text-success">{me.wins}W</span>
        <span className="text-muted">–</span>
        <span className="text-danger">{me.losses}L</span>
        <span className="ml-1 text-xs text-muted">
          {Math.round(me.winRate * 100)}%
        </span>
      </span>
      <FormStrip form={me.form} size={4} />
      {me.games < PROVISIONAL_GAMES ? (
        <Badge tone="neutral">
          provisional · {PROVISIONAL_GAMES - me.games} more{" "}
          {PROVISIONAL_GAMES - me.games === 1 ? "game" : "games"} to rank
        </Badge>
      ) : null}
    </div>
  );
}

function Leaderboard({
  rows,
  meId,
}: {
  rows: ReturnType<typeof summarizeInhouse>;
  meId: string | null;
}) {
  if (rows.length === 0) {
    return (
      <div className="p-5">
        <EmptyState
          title="No games played yet"
          description="Win some inhouses to climb the board."
        />
      </div>
    );
  }
  // Medals and ranks belong to established accounts; provisional players list
  // after them, dimmed and unranked, until they've played enough to place.
  const { ranked, provisional } = rankInhouse(rows);
  const ordered = [...ranked, ...provisional];
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line text-left text-xs uppercase text-muted">
          <th className="px-5 py-2.5 font-medium">#</th>
          <th className="px-2 py-2.5 font-medium">Player</th>
          <th className="px-2 py-2.5 text-center font-medium">Elo</th>
          <th className="px-2 py-2.5 text-center font-medium">W</th>
          <th className="px-2 py-2.5 text-center font-medium">L</th>
          <th className="hidden px-2 py-2.5 text-center font-medium sm:table-cell">
            Win%
          </th>
          <th className="hidden px-2 py-2.5 text-center font-medium md:table-cell">
            Form
          </th>
          <th className="hidden px-2 py-2.5 text-center font-medium sm:table-cell">
            Streak
          </th>
          <th className="hidden px-5 py-2.5 text-right font-medium sm:table-cell">
            GP
          </th>
        </tr>
      </thead>
      <tbody>
        {ordered.map((r, i) => (
          <tr
            key={r.userId}
            className={cn(
              "border-b border-line/50 last:border-0",
              r.userId === meId ? "bg-accent/5" : "",
            )}
          >
            <td className="px-5 py-2.5 text-muted tabular-nums">
              {i < ranked.length ? (
                i < 3 ? (
                  <span role="img" aria-label={`Rank ${i + 1}`}>
                    {["🥇", "🥈", "🥉"][i]}
                  </span>
                ) : (
                  i + 1
                )
              ) : (
                <span
                  title={`Provisional — under ${PROVISIONAL_GAMES} games, not ranked yet`}
                  aria-label="Unranked (provisional)"
                >
                  —
                </span>
              )}
            </td>
            <td className="px-2 py-2.5">
              <span className="flex min-w-0 items-center gap-2">
                <Avatar name={r.name} src={r.avatar} size={24} />
                <PlayerLink userId={r.userId} className="min-w-0 truncate font-medium">
                  {r.name}
                </PlayerLink>
              </span>
            </td>
            <td className="px-2 py-2.5 text-center">
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  r.games < PROVISIONAL_GAMES ? "text-muted" : "",
                )}
                title={
                  r.games < PROVISIONAL_GAMES
                    ? `Provisional — under ${PROVISIONAL_GAMES} games (peak ${r.peak})`
                    : `Peak ${r.peak}`
                }
              >
                {r.rating}
              </span>
              {r.lastChange !== 0 ? (
                <span
                  className={cn(
                    "ml-1 text-[10px] font-medium tabular-nums",
                    r.lastChange > 0 ? "text-success" : "text-danger",
                  )}
                  title="Elo change from their last game"
                >
                  {r.lastChange > 0 ? `+${r.lastChange}` : r.lastChange}
                </span>
              ) : null}
            </td>
            <td className="px-2 py-2.5 text-center text-success">{r.wins}</td>
            <td className="px-2 py-2.5 text-center text-muted">{r.losses}</td>
            <td className="hidden px-2 py-2.5 text-center tabular-nums sm:table-cell">
              {Math.round(r.winRate * 100)}%
            </td>
            <td className="hidden px-2 py-2.5 md:table-cell">
              <span className="flex justify-center">
                <FormStrip form={r.form} size={4} />
              </span>
            </td>
            <td className="hidden px-2 py-2.5 text-center sm:table-cell">
              {r.streak !== 0 ? (
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    r.streak > 0 ? "text-success" : "text-danger",
                  )}
                >
                  {r.streak > 0 ? `W${r.streak}` : `L${-r.streak}`}
                </span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
            <td className="hidden px-5 py-2.5 text-right tabular-nums sm:table-cell">
              {r.games}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

