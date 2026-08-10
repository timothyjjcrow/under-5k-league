import Link from "next/link";
import { Suspense } from "react";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { INHOUSE, INHOUSE_STATUS } from "@/lib/constants";
import {
  parseInhouseBox,
  type InhouseBoxPlayer as BoxPlayer,
} from "@/lib/inhouse-box";
import {
  PROVISIONAL_GAMES,
  rankInhouse,
  summarizeInhouse,
  toFinishedLobby,
  type FinishedLobby,
} from "@/lib/inhouse-stats";
import { heroById } from "@/lib/heroes";
import { gameMvp } from "@/lib/achievements";
import { formatMatchTime } from "@/lib/match-time";
import { formatMmrRange, mmrRangeForRankTier, rankMedalName } from "@/lib/rank";
import { loadBoardStats } from "@/lib/inhouse-board-service";
import { credProfitBoard } from "@/lib/inhouse-bet-service";
import { inhousePlayedAt } from "@/lib/inhouse-history";
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
  StatCell,
  StatStrip,
  textLink,
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
          subtitle="Pick-up games, drafted live. Queue up, get captained, and play — no season required."
          action={<Badge tone="accent">Casual mode</Badge>}
        />

        <InhouseRoom defaultMmr={lastReg?.mmr ?? 0} mmrHint={mmrHint} />

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
        <Suspense fallback={<CardSkeleton rows={6} />}>
          <LadderCard meId={user?.id ?? null} />
        </Suspense>
        <Suspense fallback={<CardSkeleton rows={5} />}>
          <RecentResults />
        </Suspense>

        {/* Open ONLY for the cohort it is about: a player OpenDota reports as
            having public match data switched off. Folding it shut for everyone
            would have hidden it from exactly the people who need it. */}
        <OpenDotaGuide open={dbUser?.fhUnavailable ?? false} />
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
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle aside="· newest game in full, the rest one tap away">
          Recent results
        </SectionTitle>
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
            <GameResultCard
              lobby={r.lobby}
              players={r.players}
              avatarMap={avatarMap}
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
  // Both scans run in parallel inside this card's existing <Suspense>, so the
  // profit roll-up adds no wall-clock time of its own: it is one indexed
  // groupBy against a ledger that grows ~25 rows a game, next to the
  // full-history lobby scan that already dominates this boundary. It does NOT
  // get its own Suspense — a Cred column that streams in after the rows it
  // belongs to would reflow the table under the reader's cursor.
  const [ladderLobbies, credNet] = await Promise.all([
    prisma.inhouseLobby.findMany({
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
    }),
    // NET PROFIT, never balance and never volume: constants.ts explains why in
    // the INHOUSE_CRED_PROFIT_REASONS block — a board that ranked balance would
    // rank the bankruptcy floor, and one that ranked stakes would rank turning
    // up. This ranks what you took off other players.
    credProfitBoard(),
  ]);
  const finished: FinishedLobby[] = ladderLobbies.map(toFinishedLobby);
  const leaderboard = summarizeInhouse(finished);
  const cred = credBoard(leaderboard, credNet);

  return (
    // overflow-hidden on the CARD: the table scroller inside must not leak
    // its width into the page scroll area (CLAUDE.md mobile rule).
    <Card className="overflow-hidden">
      <CardHeader
        title="Inhouse ladder"
        // The subtitle names the Cred column only once that column exists —
        // the admin-copy-guard rule generalised: copy that names something the
        // reader can't see sends them hunting for it.
        subtitle={
          cred.hasBets
            ? "Two ladders, one card. Elo is skill — everyone starts at 1000, wins against stronger lobbies pay more. Cred is nerve — net profit from betting on yourself, so it ranks what you took off other players, never what you were handed."
            : "Personal Elo across completed inhouse games — everyone starts at 1000, wins against stronger lobbies pay more"
        }
      />
      <CardBody className="p-0">
        <YourStanding rows={leaderboard} meId={meId} cred={cred} />
        <Leaderboard rows={leaderboard} meId={meId} cred={cred} />
      </CardBody>
    </Card>
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

function OpenDotaGuide({ open }: { open: boolean }) {
  return (
    // Not unconditionally `open` any more. This is read-once setup copy, and it
    // was costing ~200px on every visit forever — including for signed-out
    // visitors who cannot act on it and veterans who did it two years ago. It
    // still opens by itself for the one cohort it is written for (see the call
    // site), and the summary states what it is, so nothing is hidden.
    <details
      open={open}
      className={cn(
        "group rounded-[var(--radius)] border bg-surface/80 shadow-sm backdrop-blur",
        open ? "border-accent/40" : "border-line",
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
              <b>{INHOUSE.LOBBY_TICKET}</b> ticket in Lobby Settings. Without it,
              the private game will not appear on OpenDota.
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
  const radiantWin =
    lobby.winnerTeam != null && lobby.winnerTeam === lobby.radiantTeam;
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
    // No <Card> here: the scoreline, winner, MVP, duration and time all live in
    // the <details> summary above, and the <details> carries the border. A card
    // inside it would double the frame and repeat the header.
    <div className="grid grid-cols-1 gap-x-4 gap-y-4 p-4 sm:p-5 md:grid-cols-2">
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
      <div className="flex items-center justify-end gap-3 text-xs text-muted md:col-span-2">
        <span className="tabular-nums">Duration {durStr}</span>
        {lobby.dotaMatchId ? (
          <a
            href={`https://www.opendota.com/matches/${lobby.dotaMatchId}`}
            target="_blank"
            rel="noreferrer"
            className={textLink()}
          >
            Full match on OpenDota ↗
          </a>
        ) : null}
      </div>
    </div>
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
          <span className="font-mono text-muted">
            {formatNetWorth(direNet)}
          </span>
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
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              isRadiant ? "bg-success" : "bg-danger",
            )}
          />
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
                      <PlayerLink
                        userId={p.userId}
                        className="truncate text-sm"
                      >
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
  cred,
}: {
  rows: ReturnType<typeof summarizeInhouse>;
  meId: string | null;
  cred: CredBoard;
}) {
  if (!meId) return null;
  const me = rows.find((r) => r.userId === meId);
  if (!me) return null;
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
      {toRank > 0 ? (
        <Badge tone="neutral" className="self-center">
          provisional · {toRank} more {toRank === 1 ? "game" : "games"} to rank
        </Badge>
      ) : null}
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
