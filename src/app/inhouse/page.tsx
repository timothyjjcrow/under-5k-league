import Link from "next/link";
import { Fragment, Suspense } from "react";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  INHOUSE,
  INHOUSE_BET_OUTCOME,
  INHOUSE_BETS,
  INHOUSE_STATUS,
} from "@/lib/constants";
import {
  parseInhouseBox,
  type InhouseBoxPlayer as BoxPlayer,
} from "@/lib/inhouse-box";
import {
  MONTH_MIN_GAMES,
  PROVISIONAL_GAMES,
  rankInhouse,
  summarizeInhouse,
  type InhouseMonthRecord,
} from "@/lib/inhouse-stats";
import { heroById } from "@/lib/heroes";
import { gameMvp } from "@/lib/achievements";
import { formatMatchTime } from "@/lib/match-time";
import { formatMmrRange, mmrRangeForRankTier, rankMedalName } from "@/lib/rank";
import { loadBoardStats } from "@/lib/inhouse-board-service";
import {
  loadInhouseLadderSummary,
  loadInhouseMonthLadder,
  type InhouseMonthLadder,
} from "@/lib/inhouse-ladder";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { singleSearchParam } from "@/lib/search-params";
import { credProfitBoard } from "@/lib/inhouse-bet-service";
import { credBetView } from "@/lib/inhouse-bets";
import {
  loadCredSnapshot,
  type CredSnapshot,
} from "@/lib/inhouse-cred-summary";
import { inhousePlayedAt } from "@/lib/inhouse-history";
import { InhouseBoxScore } from "@/components/inhouse-box-score";
import { InhouseRoom } from "@/components/inhouse-room";
import { DotaLobbyRecovery } from "@/components/dota-lobby-recovery";
import { HeroVideo } from "@/components/hero-video";
import { LocalTime } from "@/components/local-time";
import { SectionNav } from "@/components/section-nav";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardSkeleton,
  EmptyState,
  FormStrip,
  PageTitle,
  PlayerLink,
  SectionTitle,
  StatCell,
  StatStrip,
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Inhouse",
  description:
    "Pick-up Dota 2 games, drafted live: queue up, vote captains, draft teams, and play — results auto-record from OpenDota onto the Elo ladder.",
};

export default async function InhousePage({
  searchParams,
}: {
  searchParams: Promise<{ ladder?: string | string[] }>;
}) {
  const user = await getSessionUser();
  // Anything but the one known value is the default board, so a stale or
  // hand-edited link still lands on a ladder rather than an error.
  const ladderView: LadderView =
    singleSearchParam((await searchParams).ladder) === "month"
      ? "month"
      : "all";

  // Seed the MMR field from the player's most recent league signup, if any,
  // and fetch the medal so the join panel can explain the MMR check (the
  // server clamps implausible values to the medal window's floor on join).
  const [lastReg, dbUser] = user
    ? await Promise.all([
        prisma.registration.findFirst({
          // Match joinQueue's trust rule exactly: the newest positive league
          // MMR is the number the server will actually seed with.
          where: { userId: user.id, mmr: { gt: 0 } },
          orderBy: { createdAt: "desc" },
          select: { mmr: true },
        }),
        prisma.user.findUnique({
          where: { id: user.id },
          // fhUnavailable is OpenDota's `profile.fh_unavailable` — true means
          // "Expose Public Match Data" is OFF, the #1 reason auto-import can't
          // see a player. It is the one signal that says who the setup guide is
          // actually for; we already capture it and were not using it here.
          select: { rankTier: true, fhUnavailable: true },
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
          subtitle="Queue together. Draft your sides. Play for the ladder."
          action={
            <Link href="/inhouse/history" className={textLink("text-sm")}>
              Match history ↗
            </Link>
          }
        />

        <SectionNav
          label="Inhouse sections"
          items={[
            { id: "live-room", label: "Live room" },
            { id: "inhouse-ladder", label: "Ladder" },
            { id: "recent-inhouse", label: "Results" },
            { id: "opendota-setup", label: "Setup help" },
          ]}
        />
        <section
          id="live-room"
          className="scroll-mt-28"
          aria-label="Live inhouse room"
        >
          <InhouseRoom defaultMmr={lastReg?.mmr ?? 0} mmrHint={mmrHint} />
          {user?.role === "ADMIN" ? <DotaLobbyRecovery /> : null}
        </section>

        {/* The room above paints immediately; the history-scanning sections
            stream in behind it (CLAUDE.md in-page streaming convention).

            ORDER IS THE POINT. The ladder used to sit last, behind ~2,000px of
            box scores — so the page paid its highest query cost for its least
            reachable content, and a returning player's own standing was the
            hardest thing on it to find. Scene stats → ladder → results → guide
            is the order of how often someone wants each. */}
        <Suspense fallback={null}>
          <SceneStats />
        </Suspense>
        <section
          id="inhouse-ladder"
          className="scroll-mt-28"
          aria-label="Inhouse ladder"
        >
          <Suspense fallback={<CardSkeleton rows={6} />}>
            {ladderView === "month" ? (
              <MonthLadderCard meId={user?.id ?? null} />
            ) : (
              <LadderCard meId={user?.id ?? null} />
            )}
          </Suspense>
        </section>
        <section
          id="recent-inhouse"
          className="scroll-mt-28"
          aria-label="Recent inhouse results"
        >
          <Suspense fallback={<CardSkeleton rows={5} />}>
            <RecentResults />
          </Suspense>
        </section>

        {/* Open ONLY for the cohort it is about: a player OpenDota reports as
            having public match data switched off. Folding it shut for everyone
            would have hidden it from exactly the people who need it. */}
        <section
          id="opendota-setup"
          className="scroll-mt-28"
          aria-label="Inhouse setup help"
        >
          <OpenDotaGuide matchDataPrivate={dbUser?.fhUnavailable === true} />
        </section>
      </div>
    </>
  );
}

/**
 * Proof of life for the ~95% of visits that land on an empty queue.
 *
 * A bare "0 / 10" over ten dashed rows reads as a dead league, which is exactly
 * why the pinned Discord board leads its empty state with these same figures
 * (CLAUDE.md: "The EMPTY state is the product"). This calls the SAME memoised
 * loader the board uses, so the channel and the site can never disagree about
 * when the last game was — and every figure is monotonic or
 * completes-with-a-state-change, never a trailing window that rots in a quiet
 * stretch. Renders nothing at all before the first game: an empty stat row is
 * worse than none.
 */
async function SceneStats() {
  const stats = await loadBoardStats();
  if (stats.lobbiesPlayed === 0) return null;

  return (
    <StatStrip>
      <StatCell
        label="Games played"
        value={stats.lobbiesPlayed}
        hint="all time"
      />
      {stats.lastEndedAtMs != null ? (
        <StatCell
          label="Last game"
          value={
            <LocalTime
              ts={stats.lastEndedAtMs}
              variant="short"
              initial={formatMatchTime(new Date(stats.lastEndedAtMs), "short")}
            />
          }
          hint={
            stats.lastWinnerSide && stats.lastRadiantScore != null
              ? `${stats.lastWinnerSide} ${stats.lastRadiantScore}–${stats.lastDireScore}`
              : undefined
          }
        />
      ) : null}
      {stats.mvpName ? (
        <StatCell
          label="Last MVP"
          value={<span className="truncate">{stats.mvpName}</span>}
          hint={stats.mvpHero ?? undefined}
        />
      ) : null}
      {stats.ladderName ? (
        <StatCell
          label="Top of the ladder"
          tone="accent"
          value={<span className="truncate">{stats.ladderName}</span>}
          hint={
            stats.ladderRating != null ? `${stats.ladderRating} Elo` : undefined
          }
        />
      ) : null}
    </StatStrip>
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
      eloDeltas: true,
      matchStartTime: true,
      startedAt: true,
      createdAt: true,
    },
  });

  // Recent games that have a fetched box score → rich result cards.
  const results = completed
    .map((l) => ({ lobby: l, players: parseInhouseBox(l.boxScore) }))
    .filter((r) => r.players.length > 0)
    .slice(0, 4);
  if (results.length === 0) {
    return (
      <Card>
        <CardHeader
          headingLevel={2}
          title="Recent results"
          action={
            <Link href="/inhouse/history" className={textLink("text-sm")}>
              All results →
            </Link>
          }
        />
        <CardBody>
          <EmptyState
            title="The next game’s story starts here"
            description="Completed games bring scores, MVPs, and player stats to this space."
          />
        </CardBody>
      </Card>
    );
  }

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
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle>Recent results</SectionTitle>
        <Link href="/inhouse/history" className={textLink("shrink-0 text-sm")}>
          All results →
        </Link>
      </div>
      {results.map((r, i) => (
        // Four full box scores were ~2,000px — 45% of the page — for an
        // archive that already exists at /inhouse/history. The newest stays
        // open (it is the one the room's "Box score ↓" banner points at, and
        // the one anyone actually just played); the rest fold down to their
        // scoreline and expand in place, so nothing becomes unreachable.
        //
        // The anchor id lives on the <details> itself so a #result-<id> jump
        // always lands, open or closed.
        <details
          key={r.lobby.id}
          id={`result-${r.lobby.id}`}
          open={i === 0}
          className="group scroll-mt-24 overflow-hidden rounded-[var(--radius)] border border-line bg-surface/80 shadow-sm"
        >
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-surface-2/40 [&::-webkit-details-marker]:hidden">
            <ResultSummaryLine lobby={r.lobby} players={r.players} />
            <span
              aria-hidden
              className="shrink-0 text-muted transition-transform group-open:rotate-180"
            >
              ▾
            </span>
          </summary>
          <div className="border-t border-line">
            <InhouseBoxScore
              lobby={r.lobby}
              players={r.players}
              avatarMap={avatarMap}
              eloDeltas={r.lobby.eloDeltas}
            />
          </div>
        </details>
      ))}
    </div>
  );
}

/** The folded form of a game: who won, by how much, how long, and when. */
function ResultSummaryLine({
  lobby,
  players,
}: {
  lobby: {
    winnerTeam: number | null;
    radiantTeam: number;
    radiantScore: number | null;
    direScore: number | null;
    durationSecs: number | null;
    matchStartTime: Date | null;
    startedAt: Date | null;
    createdAt: Date;
  };
  players: BoxPlayer[];
}) {
  const radiantWin =
    lobby.winnerTeam != null && lobby.winnerTeam === lobby.radiantTeam;
  const mvpId = gameMvp(players, radiantWin);
  const mvp = players.find((p) => p.userId === mvpId);
  const dur = lobby.durationSecs ?? 0;
  const playedAt = inhousePlayedAt(lobby);
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="flex shrink-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            radiantWin ? "bg-success" : "bg-danger",
          )}
        />
        <span className="font-mono text-base font-bold tabular-nums">
          {lobby.radiantScore ?? 0}
          <span className="px-1 text-muted">–</span>
          {lobby.direScore ?? 0}
        </span>
      </span>
      <Badge tone={radiantWin ? "success" : "danger"}>
        {radiantWin ? "Radiant" : "Dire"} victory
      </Badge>
      {mvp?.name ? (
        <span className="min-w-0 truncate text-xs text-muted">
          <span aria-hidden>🏅</span> {mvp.name}
          {mvp.heroId ? ` · ${heroById(mvp.heroId)?.name ?? ""}` : ""}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted">
        {dur > 0 ? (
          <span className="tabular-nums">
            {Math.floor(dur / 60)}:{String(dur % 60).padStart(2, "0")}
          </span>
        ) : null}
        <LocalTime
          ts={playedAt.getTime()}
          variant="short"
          initial={formatMatchTime(playedAt, "short")}
        />
      </span>
    </span>
  );
}

/**
 * The two ladders, side by side: Elo (skill) and net Cred (nerve).
 *
 * Cred lives as a COLUMN on this card rather than a card of its own, and the
 * reason is the page order litigated in CLAUDE.md — a new card above the Elo
 * ladder is the exact mistake that pass fixed, and one below it would separate
 * the two numbers that are only interesting when read against each other.
 * Being #8 in Elo and #1 in Cred is the story; two cards 600px apart is not.
 */
type CredBoard = {
  /**
   * userId → net Cred profit. ABSENCE means "has never bet", which is NOT the
   * same as 0 (bet and broke even) and must not render as it — a column of
   * zeroes would say the whole league played and nobody won anything.
   */
  net: Map<string, number>;
  /** userId → rank by profit. Established players only (see `credBoard`). */
  rank: Map<string, number>;
  /** The size of the field that rank is out of. */
  ranked: number;
  /**
   * Has anyone in this league ever bet? ONE copy of the predicate, because the
   * column, the viewer's own cell and the card's subtitle must appear and
   * disappear together — a subtitle promising a Cred board above a table with
   * no Cred column is the copy-names-a-control defect the admin guard exists
   * to catch, and three inlined `size > 0`s is how it would arrive.
   */
  hasBets: boolean;
};

/**
 * Rank the profit board, over the SAME established/provisional split the Elo
 * ladder uses.
 *
 * Provisionals keep their figure (a Cred number is exact from the first bet —
 * unlike a rating, it isn't an estimate that settles down) but are never given
 * a rank: one lucky COVER on one game must not out-rank a season of nerve, for
 * the same reason `rankInhouse` exists at all. Ties break on userId ascending,
 * the repo's total-order convention — without it two players on +120 swap
 * places between renders.
 */
function credBoard(
  rows: ReturnType<typeof summarizeInhouse>,
  net: Map<string, number>,
): CredBoard {
  const { ranked } = rankInhouse(rows);
  const field = ranked
    .filter((r) => net.has(r.userId))
    .sort(
      (a, b) =>
        (net.get(b.userId) ?? 0) - (net.get(a.userId) ?? 0) ||
        (a.userId < b.userId ? -1 : 1),
    );
  return {
    net,
    rank: new Map(field.map((r, i) => [r.userId, i + 1])),
    ranked: field.length,
    hasBets: net.size > 0,
  };
}

// The full-history Elo ladder (no take window — Elo accumulates over ALL
// games, per CLAUDE.md).
async function LadderCard({ meId }: { meId: string | null }) {
  // Shares the complete-history snapshot with the Discord board and room;
  // the ledger aggregate stays parallel and retains its independent meaning.
  const [summary, credNet, mine] = await Promise.all([
    loadInhouseLadderSummary(),
    credProfitBoard(),
    meId ? loadCredSnapshot(meId) : Promise.resolve(null),
  ]);
  const leaderboard = summary.records;
  const cred = credBoard(leaderboard, credNet);

  return (
    // overflow-hidden on the CARD: the table scroller inside must not leak
    // its width into the page scroll area (CLAUDE.md mobile rule).
    <Card className="overflow-hidden">
      <CardHeader
        headingLevel={2}
        title="Inhouse ladder"
        subtitle={`${leaderboard.length} players · ${rankInhouse(leaderboard).ranked.length} ranked`}
        action={
          <Badge tone="accent">{summary.completedCount} games played</Badge>
        }
      />
      <CardBody className="p-0">
        <LadderViewSwitch view="all" />
        <YourStanding
          rows={leaderboard}
          meId={meId}
          cred={cred}
          wallet={mine}
        />
        <LadderLeaders rows={leaderboard} />
        <Leaderboard rows={leaderboard} meId={meId} cred={cred} />
        <LadderKey rows={leaderboard} cred={cred} />
        {/* The table's marks are explained in the visible key above (see
            LadderKey); this fold is only the "why" behind the numbers. */}
        <details className="border-t border-line px-4 py-2 text-xs text-muted sm:px-5">
          <summary className="inline-flex min-h-10 cursor-pointer items-center rounded hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            How {cred.hasBets ? "Elo & Cred" : "Elo"} work
          </summary>
          <p className="max-w-3xl pb-3 leading-relaxed">
            Elo starts at 1000 and moves after every game: beating stronger
            opponents earns more, and losing to weaker ones costs more. Your
            rank appears after {PROVISIONAL_GAMES} games.
            {cred.hasBets
              ? " Cred's rank is separate from Elo and counts betting results only, never starting balances or grants."
              : ""}
          </p>
        </details>
      </CardBody>
    </Card>
  );
}

/** Established leaders only: a provisional first win never becomes a podium. */
function LadderLeaders({
  rows,
}: {
  rows: ReturnType<typeof summarizeInhouse>;
}) {
  const leaders = rankInhouse(rows).ranked.slice(0, 3);
  if (leaders.length === 0) return null;
  return (
    <ol
      aria-label="Ladder leaders"
      className="grid grid-cols-2 gap-3 border-b border-line p-4 sm:grid-cols-3 sm:p-5"
    >
      {leaders.map((player, i) => (
        <li
          key={player.userId}
          className={cn(
            "min-w-0 rounded-xl border p-3 sm:p-4",
            i === 0
              ? "col-span-2 border-accent/35 bg-gradient-to-br from-accent/10 to-surface sm:col-span-1"
              : "border-line bg-surface-2/35",
          )}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-wider",
                i === 0 ? "text-accent" : "text-muted",
              )}
            >
              {i === 0 ? "League leader" : `Rank ${i + 1}`}
            </span>
            <span className="font-mono text-xs text-muted">0{i + 1}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Avatar name={player.name} src={player.avatar} size={30} />
            <PlayerLink
              userId={player.userId}
              className="min-w-0 truncate text-sm font-semibold"
            >
              {player.name}
            </PlayerLink>
          </div>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <span className="font-display text-3xl font-bold tabular-nums">
                {player.rating}
              </span>
              <span className="ml-1 text-[10px] text-muted">Elo</span>
            </div>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums",
                player.lastChange > 0
                  ? "bg-success/10 text-success"
                  : player.lastChange < 0
                    ? "bg-danger/10 text-danger"
                    : "bg-surface-2 text-muted",
              )}
            >
              {player.lastChange > 0 ? "+" : ""}
              {player.lastChange} last game
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-3">
            <span className="text-xs tabular-nums text-muted">
              {player.wins}W · {player.losses}L
            </span>
            <FormStrip form={player.form} size={4} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * A net-Cred figure. Signed and coloured, because the sign IS the story — a
 * bare "120" is unreadable next to a "-120" without it.
 *
 * `null` means the player has never bet, rendered as an em dash rather than 0:
 * the two are different facts and only one of them is a result.
 */
function CredFigure({
  net,
  className,
}: {
  net: number | null;
  className?: string;
}) {
  if (net == null) {
    return (
      <span className={cn("text-muted", className)} title="No bets placed yet">
        —
      </span>
    );
  }
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        net > 0 ? "text-success" : net < 0 ? "text-danger" : "text-muted",
        className,
      )}
    >
      {net > 0 ? `+${net}` : net}
    </span>
  );
}

// ---------- OpenDota "be findable" guide ----------

function OpenDotaGuide({ matchDataPrivate }: { matchDataPrivate: boolean }) {
  return (
    // Not unconditionally `open` any more. This is read-once setup copy, and it
    // was costing ~200px on every visit forever — including for signed-out
    // visitors who cannot act on it and veterans who did it two years ago. It
    // still opens by itself for the one cohort it is written for (see the call
    // site), and the summary states what it is, so nothing is hidden.
    //
    // For that cohort the summary also SAYS why it opened. Opening silently
    // left the one player whose games can't auto-record reading generic setup
    // copy, with nothing telling them it was about them.
    <details
      open={matchDataPrivate}
      className={cn(
        "group rounded-[var(--radius)] border bg-surface/80 shadow-sm backdrop-blur",
        matchDataPrivate ? "border-accent/40" : "border-line",
      )}
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
            {matchDataPrivate ? (
              <p className="mt-0.5 text-sm text-danger">
                OpenDota reports your match data as private, so your games
                can&apos;t record automatically.
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-muted">
                Public match data, your account, and the league ticket.
              </p>
            )}
          </div>
        </div>
        <span className="shrink-0 text-muted transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="space-y-3 border-t border-line px-5 py-4 text-sm">
        {matchDataPrivate ? (
          <p className="text-muted">
            Step 1 fixes it. Once it&apos;s on, refresh your medal on{" "}
            <Link href="/me#profile-dota" className={textLink()}>
              your profile
            </Link>{" "}
            so this note clears.
          </p>
        ) : null}
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
              Your Steam sign-in verifies the Dota account shown on your{" "}
              <Link href="/me" className={textLink()}>
                profile
              </Link>
              . Check it once so we can match you in games.
            </span>
          </li>
          <li className="flex gap-3">
            <GuideStep n={3} />
            <span>
              When teams lock, the host must select the{" "}
              <b>{INHOUSE.LOBBY_TICKET}</b> ticket in Lobby Settings. Without
              it, the private game will not appear on OpenDota.
            </span>
          </li>
          <li className="flex gap-3">
            <GuideStep n={4} />
            <span>
              Play your inhouse. When it ends, the result is fetched from
              OpenDota automatically (usually within a few minutes) — or anyone
              in the game can paste the match ID.
            </span>
          </li>
        </ol>
        <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs text-muted">
          Not everyone needs this on — a few players per side is enough — but
          the more the better. It only exposes games played <b>after</b> you
          enable it, and OpenDota can take a few minutes to index a finished
          game.
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

// The signed-in player's ladder line at a glance, pinned above the table.
function YourStanding({
  rows,
  meId,
  cred,
  wallet,
}: {
  rows: ReturnType<typeof summarizeInhouse>;
  meId: string | null;
  cred: CredBoard;
  wallet: CredSnapshot | null;
}) {
  if (!meId) return null;
  const me = rows.find((r) => r.userId === meId);
  // No completed game yet: the one place on the page addressed to this viewer
  // tells them how to get onto the board instead of saying nothing.
  if (!me) return <FirstGameStrip balance={wallet?.balance ?? null} />;
  // Rank only counts among established players — provisionals are unranked.
  const { ranked } = rankInhouse(rows);
  const idx = ranked.findIndex((r) => r.userId === meId);
  const toRank = PROVISIONAL_GAMES - me.games;
  const myCred = cred.net.get(meId) ?? null;
  const myCredRank = cred.rank.get(meId);
  return (
    // This is the only thing on the page addressed to the signed-in viewer, and
    // it used to be six equal-weight text spans in a flex row — six semantic
    // units separated by nothing but word order, ragged-wrapping to four lines
    // on a phone. Same figures, now as discrete labelled cells.
    <div className="flex flex-wrap items-center gap-x-7 gap-y-3 border-b border-line bg-accent/5 px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-accent/90">
          Your standing
        </div>
        <div className="mt-0.5 font-display text-xl font-bold leading-none tabular-nums">
          {idx >= 0 ? `#${idx + 1}` : "—"}
          <span className="ml-1 font-sans text-xs font-normal text-muted">
            {idx >= 0 ? `of ${ranked.length}` : "unranked"}
          </span>
        </div>
      </div>
      <StatCell
        label="Elo"
        value={
          <>
            {me.rating}
            {me.lastChange !== 0 ? (
              <span
                className={cn(
                  "font-sans text-xs font-medium",
                  me.lastChange > 0 ? "text-success" : "text-danger",
                )}
                title="Elo change from your last game"
              >
                {me.lastChange > 0 ? `+${me.lastChange}` : me.lastChange}
              </span>
            ) : null}
          </>
        }
        hint={`peak ${me.peak}`}
      />
      {/* Directly beside Elo, because the pair is the point: these are the
          viewer's two standings in the same room, and a nerve figure parked
          after Record and Form reads as a footnote to the skill one. Shown as
          soon as ANYONE has bet, so a player who hasn't yet learns the second
          board exists — the em dash is an invitation, not a gap. */}
      {cred.hasBets ? (
        <StatCell
          label="Cred"
          value={<CredFigure net={myCred} />}
          hint={
            myCredRank
              ? `#${myCredRank} of ${cred.ranked}`
              : myCred != null
                ? "provisional"
                : "net profit"
          }
        />
      ) : null}
      <StatCell
        label="Record"
        value={
          <>
            <span className="text-success">{me.wins}</span>
            <span className="text-muted">–</span>
            <span className="text-danger">{me.losses}</span>
          </>
        }
        hint={`${Math.round(me.winRate * 100)}%`}
      />
      {me.form.length > 0 ? (
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Form
          </div>
          <div className="mt-1">
            <FormStrip form={me.form} size={5} />
          </div>
        </div>
      ) : null}
      {wallet ? (
        // The spendable figure, which appeared nowhere outside a live lobby.
        // Kept apart from the Cred cell above: that one is net profit (the
        // ladder), this one is what the bet chips can actually spend.
        <StatCell label="Cred balance" value={wallet.balance} hint="to bet" />
      ) : null}
      {toRank > 0 ? (
        <Badge tone="neutral" className="self-center">
          provisional · {toRank} more {toRank === 1 ? "game" : "games"} to rank
        </Badge>
      ) : null}
      {wallet && wallet.bets.length > 0 ? (
        <RecentBets bets={wallet.bets} />
      ) : null}
    </div>
  );
}

/**
 * The viewer's last few bets, folded under their standing. Every refund names
 * its reason (see `credBetView`), because a bare 0 beside a bet someone
 * remembers placing reads as lost Cred.
 */
function RecentBets({ bets }: { bets: CredSnapshot["bets"] }) {
  // Only a game that completed has a box score in the archive to open.
  const archived = new Set<string>([
    INHOUSE_BET_OUTCOME.WON,
    INHOUSE_BET_OUTCOME.LOST,
    INHOUSE_BET_OUTCOME.VOID_LINEUP,
    INHOUSE_BET_OUTCOME.VOID_LATE,
  ]);
  return (
    <details className="w-full text-sm">
      <summary className="inline-flex min-h-10 cursor-pointer items-center rounded text-xs font-medium text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
        Your last {bets.length === 1 ? "bet" : `${bets.length} bets`}
      </summary>
      <ol className="divide-y divide-line-soft pb-1">
        {bets.map((bet) => {
          const view = credBetView(bet);
          return (
            <li
              key={bet.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2"
            >
              <span className="min-w-0">
                <span className="block text-xs text-muted">
                  <LocalTime
                    ts={bet.playedAt.getTime()}
                    variant="short"
                    initial={formatMatchTime(bet.playedAt, "short")}
                  />
                </span>
                {bet.outcome && archived.has(bet.outcome) ? (
                  <Link
                    href={`/inhouse/history?game=${bet.lobbyId}#result-${bet.lobbyId}`}
                    className={textLink()}
                  >
                    {view.label}
                  </Link>
                ) : (
                  view.label
                )}
                <span className="ml-2 text-xs text-muted tabular-nums">
                  {bet.stake} staked
                </span>
              </span>
              {view.delta != null ? (
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    view.tone === "success"
                      ? "text-success"
                      : view.tone === "danger"
                        ? "text-danger"
                        : "text-muted",
                  )}
                >
                  {view.delta > 0 ? `+${view.delta}` : view.delta}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/**
 * For a signed-in player with no completed inhouse yet. The room above already
 * explains the current phase; this is the whole path in one glance, because a
 * first-timer can't see what "queue" leads to until they are ten minutes in.
 */
function FirstGameStrip({ balance }: { balance: number | null }) {
  const steps: React.ReactNode[] = [
    <>
      <a href="#live-room" className={textLink()}>
        Join the queue
      </a>{" "}
      above
    </>,
    "Accept when ten players are in",
    "Vote on captains, then get drafted",
    <>
      Play in Dota with the league ticket (
      <a href="#opendota-setup" className={textLink()}>
        setup help
      </a>
      )
    </>,
  ];
  return (
    <div className="border-b border-line bg-accent/5 px-4 py-3.5 sm:px-5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-accent/90">
        Your first game
      </div>
      <ol className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, i) => (
          <li key={i} className="flex min-w-0 items-baseline gap-2">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-[11px] font-semibold text-accent">
              {i + 1}
            </span>
            <span className="min-w-0">{step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2.5 text-xs text-muted">
        Your Elo starts at 1000 and you get a rank after {PROVISIONAL_GAMES}{" "}
        games. You also have {balance ?? INHOUSE_BETS.START_BALANCE} Cred to bet
        on your own team once the teams lock.
      </p>
    </div>
  );
}

function Leaderboard({
  rows,
  meId,
  cred,
}: {
  rows: ReturnType<typeof summarizeInhouse>;
  meId: string | null;
  cred: CredBoard;
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
  // A league that has never bet gets no Cred column at all, rather than a
  // column of em dashes. Same rule as SceneStats: anything missing is omitted,
  // never faked — an empty column is a promise the page can't keep.
  const showCred = cred.hasBets;
  // Each row's two Cred lookups resolved once, up here, so the row stays an
  // expression: the Cred figure appears in three places per row (the column,
  // its rank chip, and the phone's stacked line) and three inline
  // `cred.net.get(...)`s is the drift the CredBoard type exists to prevent.
  const rowsView = ordered.map((r) => ({
    r,
    net: cred.net.get(r.userId) ?? null,
    credRank: cred.rank.get(r.userId),
  }));
  return (
    <div className="overflow-x-auto">
      {/* table-fixed + widths on <col>, per CLAUDE.md's StandingsTable rule: with
        fixed layout a `hidden` column STILL takes an equal share of the leftover
        width unless its <col> is w-0 until the breakpoint that shows it. Without
        this the nine mostly-1-character columns starved the Player name. */}
      <table className="w-full table-fixed text-sm">
        <caption className="sr-only">
          Inhouse player ratings, records, recent form
          {showCred ? ", and net Cred profit" : ""}. Provisional players are
          listed without a rank.
        </caption>
        <colgroup>
          <col className="w-11" />
          <col />
          {/* Wide enough for "1045" plus its "+18" delta on ONE line — at 4.5rem
            the delta wrapped and every top row rendered two lines tall. */}
          <col className="w-[5.75rem]" />
          {/* Cred sits immediately beside Elo — skill then nerve, read as a
            pair. It is the FIRST thing a phone gives up (w-0 until sm): six
            fixed columns at 390px starve the Player name to a couple of
            characters, which is the trap the widths above already document.
            Phones get the figure under the name instead, so the second board
            is never invisible on the majority device. */}
          {showCred ? <col className="w-0 sm:w-[5.5rem]" /> : null}
          <col className="w-9" />
          <col className="w-9" />
          {/* Form moved ahead of Win%/Streak/GP: it is the one at-a-glance signal
            in the table, so it is the first extra column a wider screen buys. */}
          <col className="w-0 sm:w-[6.5rem]" />
          <col className="w-0 md:w-14" />
          <col className="w-0 md:w-16" />
          <col className="w-0 lg:w-14" />
        </colgroup>
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase text-muted">
            <th className="px-4 py-2.5 font-medium sm:px-5">#</th>
            <th className="px-2 py-2.5 font-medium">Player</th>
            <th className="px-2 py-2.5 text-right font-medium">Elo</th>
            {showCred ? (
              <th
                className="hidden px-2 py-2.5 text-right font-medium sm:table-cell"
                title="Net Cred won or lost betting on your own games — never your balance"
              >
                Cred
              </th>
            ) : null}
            <th className="px-2 py-2.5 text-center font-medium">W</th>
            <th className="px-2 py-2.5 text-center font-medium">L</th>
            <th className="hidden px-2 py-2.5 text-center font-medium sm:table-cell">
              Form
            </th>
            <th className="hidden px-2 py-2.5 text-center font-medium md:table-cell">
              Win%
            </th>
            <th className="hidden px-2 py-2.5 text-center font-medium md:table-cell">
              Streak
            </th>
            <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell sm:px-5">
              GP
            </th>
          </tr>
        </thead>
        <tbody>
          {rowsView.map(({ r, net, credRank }, i) => (
            <tr
              key={r.userId}
              className={cn(
                "border-b border-line/50 last:border-0",
                r.userId === meId ? "bg-accent/5" : "",
              )}
            >
              <td className="px-4 py-2.5 text-muted tabular-nums sm:px-5">
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
                  <PlayerLink
                    userId={r.userId}
                    className="min-w-6 truncate font-medium"
                  >
                    {r.name}
                  </PlayerLink>
                </span>
                {/* The phone's Cred column, stacked under the name because there
                  is no width for a sixth track (see the colgroup). Rendered
                  ONLY for players who have actually bet, so it costs nothing
                  until the economy is used and never grows a row to two lines
                  to say "—". pl-8 = avatar + gap, so it hangs under the name. */}
                {showCred && net != null ? (
                  <span className="mt-0.5 block pl-8 text-[11px] sm:hidden">
                    <span className="text-muted">Cred </span>
                    <CredFigure net={net} />
                    {credRank && credRank <= 3 ? (
                      <span className="ml-1 text-accent">#{credRank}</span>
                    ) : null}
                  </span>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-2 py-2.5 text-right">
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
              {showCred ? (
                <td className="hidden whitespace-nowrap px-2 py-2.5 text-right sm:table-cell">
                  <CredFigure net={net} />
                  {/* The divergence chip, and the whole reason Cred is a column
                    on this table rather than a board of its own: a plain "8" in
                    the rank column beside a "#1" here is a player who is
                    mid-table at Dota and top of the league at nerve, legible in
                    one glance. Top three only — a chip on every row is
                    wallpaper. `cred.rank` holds established players alone, so
                    a number built out of one game is never medalled. */}
                  {credRank && credRank <= 3 ? (
                    <span
                      className="ml-1 text-[10px] font-semibold tabular-nums text-accent"
                      title={`#${credRank} of ${cred.ranked} by net Cred profit — ranked separately from Elo`}
                    >
                      #{credRank}
                    </span>
                  ) : null}
                </td>
              ) : null}
              <td className="px-2 py-2.5 text-center text-success">{r.wins}</td>
              <td className="px-2 py-2.5 text-center text-muted">{r.losses}</td>
              <td className="hidden px-2 py-2.5 sm:table-cell">
                <span className="flex justify-center">
                  <FormStrip form={r.form} size={4} />
                </span>
              </td>
              <td className="hidden px-2 py-2.5 text-center tabular-nums md:table-cell">
                {Math.round(r.winRate * 100)}%
              </td>
              <td className="hidden px-2 py-2.5 text-center md:table-cell">
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
              <td className="hidden px-4 py-2.5 text-right tabular-nums lg:table-cell sm:px-5">
                {r.games}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The table's key, printed under it. Each mark used to be explained only by a
 * `title` tooltip, which a phone never shows and a mouse finds by accident:
 * a player with 3 games saw a dash where their rank should be and no reason
 * why. The tooltips stay for desktop; this is what everyone else reads. Each
 * clause renders only when the table actually shows that mark.
 */
function LadderKey({
  rows,
  cred,
}: {
  rows: ReturnType<typeof summarizeInhouse>;
  cred: CredBoard;
}) {
  if (rows.length === 0) return null;
  const clauses: React.ReactNode[] = [];
  if (rows.some((r) => r.games < PROVISIONAL_GAMES)) {
    clauses.push(
      `A dash instead of a rank means provisional: under ${PROVISIONAL_GAMES} games, listed after the ranked players with a dimmed Elo.`,
    );
  }
  if (rows.some((r) => r.lastChange !== 0)) {
    clauses.push(
      "The signed figure beside Elo is the swing from their last game.",
    );
  }
  if (cred.hasBets) {
    clauses.push(
      <>
        Cred is the net won or lost betting on their own games, never a balance.
        {/* The Cred column (its dashes and #1 to #3 marks) is hidden on phones. */}
        <span className="hidden sm:inline">
          {" "}A dash there means no bets yet, and #1 to #3 mark the top three by Cred, ranked separately from Elo.
        </span>
      </>,
    );
  }
  if (clauses.length === 0) return null;
  return (
    <div className="border-t border-line px-4 py-3 sm:px-5">
      <p className="max-w-3xl text-xs leading-relaxed text-muted">
        {clauses.map((clause, i) => (
          <Fragment key={i}>
            {i > 0 ? " " : null}
            {clause}
          </Fragment>
        ))}
      </p>
    </div>
  );
}

// ---------- This month ----------

type LadderView = "all" | "month";

/**
 * All time vs this month. Plain links to a query param: the page stays
 * server-rendered with no client JS, the choice survives a reload or a shared
 * URL, and the hash brings a full-page load back to the ladder instead of the
 * top of the room.
 */
function LadderViewSwitch({ view }: { view: LadderView }) {
  const items: { key: LadderView; href: string; label: string }[] = [
    { key: "all", href: "/inhouse#inhouse-ladder", label: "All time" },
    {
      key: "month",
      href: "/inhouse?ladder=month#inhouse-ladder",
      label: "This month",
    },
  ];
  return (
    <nav
      aria-label="Ladder period"
      className="border-b border-line px-4 py-3 sm:px-5"
    >
      <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-surface p-1 sm:inline-grid">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            aria-current={item.key === view ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 sm:min-h-10",
              item.key === view
                ? "bg-surface-3 text-fg shadow-sm ring-1 ring-inset ring-accent/50"
                : "text-muted hover:bg-surface-2/70 hover:text-fg",
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/**
 * The monthly form race: record over games that finished this calendar month,
 * on the league's clock. Career Elo is path-dependent from game one, so a
 * newcomer can never catch a veteran on it; this board resets on the 1st.
 *
 * It never touches the full-history scan: the loader is windowed on
 * `completedAt` and the Elo figure is the SUM of swings each game already
 * stamped, so no Cred or career data is loaded for this view either.
 */
async function MonthLadderCard({ meId }: { meId: string | null }) {
  const month = await loadInhouseMonthLadder();
  const players = month.ranked.length + month.unranked.length;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        headingLevel={2}
        title="Inhouse ladder"
        subtitle={
          players > 0
            ? `${month.label} · ${players} ${players === 1 ? "player" : "players"} · ${month.ranked.length} ranked`
            : month.label
        }
        action={
          month.games > 0 ? (
            <Badge tone="accent">
              {month.games} {month.games === 1 ? "game" : "games"} this month
            </Badge>
          ) : undefined
        }
      />
      <CardBody className="p-0">
        <LadderViewSwitch view="month" />
        {players === 0 ? (
          // One quiet line, not an empty table: the first game of the month
          // is a normal state on the 1st, not a failure.
          <p className="px-4 py-5 text-sm text-muted sm:px-5">
            No games yet this month.
          </p>
        ) : (
          <>
            <YourMonth month={month} meId={meId} />
            <MonthBoard month={month} meId={meId} />
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** A month's summed Elo swing; null (a game with no recorded swing) is a dash. */
function EloNet({ net, dim = false }: { net: number | null; dim?: boolean }) {
  if (net == null) {
    return (
      <span className="text-muted" aria-label="Not recorded">
        —
      </span>
    );
  }
  return (
    <span
      className={cn(
        "font-semibold tabular-nums",
        dim || net === 0
          ? "text-muted"
          : net > 0
            ? "text-success"
            : "text-danger",
      )}
    >
      {net > 0 ? `+${net}` : net}
    </span>
  );
}

// The signed-in player's month at a glance, or the way onto the board.
function YourMonth({
  month,
  meId,
}: {
  month: InhouseMonthLadder;
  meId: string | null;
}) {
  if (!meId) return null;
  const idx = month.ranked.findIndex((r) => r.userId === meId);
  const me =
    idx >= 0
      ? month.ranked[idx]
      : month.unranked.find((r) => r.userId === meId);
  if (!me) {
    return (
      <p className="border-b border-line bg-accent/5 px-4 py-3 text-sm text-muted sm:px-5">
        You haven&apos;t played an inhouse this month yet.{" "}
        {MONTH_MIN_GAMES} games gets you a rank.{" "}
        <a href="#live-room" className={textLink()}>
          Join the queue
        </a>
      </p>
    );
  }
  const toRank = MONTH_MIN_GAMES - me.games;
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-3 border-b border-line bg-accent/5 px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide text-accent/90">
          Your month
        </div>
        <div className="mt-0.5 font-display text-xl font-bold leading-none tabular-nums">
          {idx >= 0 ? `#${idx + 1}` : "—"}
          <span className="ml-1 font-sans text-xs font-normal text-muted">
            {idx >= 0 ? `of ${month.ranked.length}` : "unranked"}
          </span>
        </div>
      </div>
      <StatCell
        label="Record"
        value={
          <>
            <span className="text-success">{me.wins}</span>
            <span className="text-muted">–</span>
            <span className="text-danger">{me.losses}</span>
          </>
        }
        hint={`${Math.round(me.winRate * 100)}%`}
      />
      <StatCell label="Elo this month" value={<EloNet net={me.eloNet} />} />
      {toRank > 0 ? (
        <Badge tone="neutral" className="self-center">
          {toRank} more {toRank === 1 ? "game" : "games"} to rank this month
        </Badge>
      ) : null}
    </div>
  );
}

function MonthBoard({
  month,
  meId,
}: {
  month: InhouseMonthLadder;
  meId: string | null;
}) {
  const rows: { r: InhouseMonthRecord; rank: number | null }[] = [
    ...month.ranked.map((r, i) => ({ r, rank: i + 1 })),
    ...month.unranked.map((r) => ({ r, rank: null })),
  ];
  const legend = [
    `Ranked by wins, then win rate, once a player has ${MONTH_MIN_GAMES} games this month. Anyone under that is listed after, without a rank.`,
    "Elo ± adds up the swing each game recorded when it finished.",
    rows.some(({ r }) => r.eloNet == null)
      ? "A dash there means one of their games has no swing recorded."
      : null,
    `The month runs on ${LEAGUE_CONFIG.matchSchedule.timezone} time and starts fresh on the 1st.`,
  ].filter(Boolean);
  return (
    <>
      <div className="overflow-x-auto">
        {/* The career table's colgroup rule: widths live on <col>, and a
          column hidden on phones is w-0 until the breakpoint that shows it,
          or fixed layout hands it a share of the Player column. */}
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">
            Inhouse records for {month.label}: wins, losses, games, win rate
            and net Elo change. Players under {MONTH_MIN_GAMES} games this
            month are listed without a rank.
          </caption>
          <colgroup>
            <col className="w-11" />
            <col />
            <col className="w-9" />
            <col className="w-9" />
            <col className="w-0 sm:w-12" />
            <col className="w-0 sm:w-14" />
            <col className="w-[4.75rem]" />
          </colgroup>
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase text-muted">
              <th className="px-4 py-2.5 font-medium sm:px-5">#</th>
              <th className="px-2 py-2.5 font-medium">Player</th>
              <th className="px-2 py-2.5 text-center font-medium">W</th>
              <th className="px-2 py-2.5 text-center font-medium">L</th>
              <th className="hidden px-2 py-2.5 text-center font-medium sm:table-cell">
                GP
              </th>
              <th className="hidden px-2 py-2.5 text-center font-medium sm:table-cell">
                Win%
              </th>
              <th className="py-2.5 pl-2 pr-4 text-right font-medium sm:pr-5">
                <span aria-hidden className="whitespace-nowrap">
                  Elo ±
                </span>
                <span className="sr-only">Elo change this month</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, rank }) => (
              <tr
                key={r.userId}
                className={cn(
                  "border-b border-line/50 last:border-0",
                  r.userId === meId ? "bg-accent/5" : "",
                )}
              >
                <td className="px-4 py-2.5 text-muted tabular-nums sm:px-5">
                  {rank == null ? (
                    <span aria-label="Unranked this month">—</span>
                  ) : rank <= 3 ? (
                    <span role="img" aria-label={`Rank ${rank}`}>
                      {["🥇", "🥈", "🥉"][rank - 1]}
                    </span>
                  ) : (
                    rank
                  )}
                </td>
                <td className="px-2 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar name={r.name} src={r.avatar} size={24} />
                    <PlayerLink
                      userId={r.userId}
                      className="min-w-6 truncate font-medium"
                    >
                      {r.name}
                    </PlayerLink>
                  </span>
                </td>
                <td
                  className={cn(
                    "px-2 py-2.5 text-center tabular-nums",
                    rank == null ? "text-muted" : "text-success",
                  )}
                >
                  {r.wins}
                </td>
                <td className="px-2 py-2.5 text-center tabular-nums text-muted">
                  {r.losses}
                </td>
                <td className="hidden px-2 py-2.5 text-center tabular-nums sm:table-cell">
                  {r.games}
                </td>
                <td className="hidden px-2 py-2.5 text-center tabular-nums sm:table-cell">
                  {Math.round(r.winRate * 100)}%
                </td>
                <td className="whitespace-nowrap py-2.5 pl-2 pr-4 text-right sm:pr-5">
                  <EloNet net={r.eloNet} dim={rank == null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line px-4 py-3 sm:px-5">
        <p className="max-w-3xl text-xs leading-relaxed text-muted">
          {legend.join(" ")}
        </p>
      </div>
    </>
  );
}
