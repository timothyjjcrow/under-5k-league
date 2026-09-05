import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { INHOUSE_STATUS } from "@/lib/constants";
import { parseInhouseBox } from "@/lib/inhouse-box";
import { gameMvp } from "@/lib/achievements";
import { heroById } from "@/lib/heroes";
import { formatMatchTime } from "@/lib/match-time";
import {
  INHOUSE_HISTORY_PAGE_SIZE,
  inhouseHistoryPage,
  inhousePlayedAt,
} from "@/lib/inhouse-history";
import { voidInhouseResult } from "@/app/actions/inhouse-admin";
import { InhouseBoxScore } from "@/components/inhouse-box-score";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Inhouse history",
  description:
    "Every completed inhouse game — scores, MVPs, and box-score links.",
};

const HISTORY_RESULT_SELECT = {
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
} as const;

// The permanent archive behind /inhouse's four recent cards: one compact row
// per completed game, so the ladder's evidence never becomes unreachable.
export default async function InhouseHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[]; game?: string | string[] }>;
}) {
  // Admins get a per-row Void — the durable home for "the scan picked up the
  // wrong game". The room's own void button requires the admin to have PLAYED
  // the game and vanishes 10 minutes after it; this page is where a reported
  // wrong result actually gets fixed.
  const [viewer, total, query] = await Promise.all([
    getSessionUser(),
    prisma.inhouseLobby.count({
      where: { status: INHOUSE_STATUS.COMPLETED },
    }),
    searchParams,
  ]);
  const isAdmin = viewer?.role === "ADMIN";
  const { page, pages, skip } = inhouseHistoryPage(query.page, total);
  const lobbies = await prisma.inhouseLobby.findMany({
    where: { status: INHOUSE_STATUS.COMPLETED },
    // `id` makes page boundaries stable when a fixture/import creates several
    // rows with the same database timestamp.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip,
    take: INHOUSE_HISTORY_PAGE_SIZE,
    select: HISTORY_RESULT_SELECT,
  });

  const expandedId = Array.isArray(query.game) ? query.game[0] : query.game;
  const inPage = lobbies.find((lobby) => lobby.id === expandedId);
  // A shared game link survives new results shifting pagination boundaries.
  // A linked result outside this page is shown once above its usual summaries.
  const expanded =
    inPage ??
    (expandedId && expandedId.length <= 128
      ? await prisma.inhouseLobby.findFirst({
          where: { id: expandedId, status: INHOUSE_STATUS.COMPLETED },
          select: HISTORY_RESULT_SELECT,
        })
      : null);
  const linkedOutsidePage = !!expanded && !inPage;
  const displayedLobbies = linkedOutsidePage
    ? [expanded!, ...lobbies]
    : lobbies;
  const rows = displayedLobbies.map((l) => {
    const players = parseInhouseBox(l.boxScore);
    const radiantWin = l.winnerTeam != null && l.winnerTeam === l.radiantTeam;
    const mvpId = players.length ? gameMvp(players, radiantWin) : null;
    const mvp = mvpId ? players.find((p) => p.userId === mvpId) : null;
    return { lobby: l, players, radiantWin, mvp, playedAt: inhousePlayedAt(l) };
  });
  const first = total === 0 ? 0 : skip + 1;
  const last = skip + lobbies.length;

  // Only the selected match needs roster/avatars. The archive retains its
  // 100-game summaries without sending 1,000 rendered player lines each time.
  const roster = expanded
    ? await prisma.inhouseLobbyPlayer.findMany({
        where: { lobbyId: expanded.id },
        orderBy: [{ team: "asc" }, { userId: "asc" }],
        select: {
          userId: true,
          team: true,
          user: { select: { name: true, avatar: true } },
        },
      })
    : [];
  const avatarMap = new Map(
    roster.map((player) => [player.userId, player.user.avatar]),
  );
  const resultHref = (id?: string) => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (id) params.set("game", id);
    const suffix = params.toString();
    return `/inhouse/history${suffix ? `?${suffix}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <PageTitle
        title="Inhouse history"
        subtitle={`${total} games. Every score, roster, and result.`}
        action={
          <Link href="/inhouse" className={buttonClasses("accent", "md")}>
            ← Back to the room
          </Link>
        }
      />

      {/* Shared, bounded result details stay within the archive card on phones. */}
      <Card className="overflow-hidden">
        <CardHeader
          title="Completed games"
          subtitle={
            total > 0
              ? `${first}–${last} of ${total}, newest first${linkedOutsidePage ? " · linked game shown above" : ""}`
              : "No completed games yet"
          }
        />
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No games recorded yet"
                description="Finish an inhouse and it shows up here."
              />
            </div>
          ) : (
            <>
              <ol
                aria-label="Completed inhouse games"
                className="divide-y divide-line"
              >
                {rows.map(({ lobby, players, radiantWin, mvp, playedAt }) => {
                  const isExpanded = lobby.id === expanded?.id;
                  const duration = lobby.durationSecs;
                  const durationLabel =
                    duration != null && duration > 0
                      ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")}`
                      : null;
                  const mvpHero = mvp ? heroById(mvp.heroId) : null;
                  return (
                    <li
                      key={lobby.id}
                      id={`result-${lobby.id}`}
                      className={cn(
                        "scroll-mt-28",
                        isExpanded && "bg-surface-2/25",
                      )}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            {isExpanded && linkedOutsidePage ? (
                              <Badge tone="info">Linked game</Badge>
                            ) : null}
                            <span
                              aria-label={`Radiant ${lobby.radiantScore ?? "unknown"}, Dire ${lobby.direScore ?? "unknown"}`}
                              className="whitespace-nowrap font-mono text-xl font-semibold tabular-nums"
                            >
                              <span
                                className={
                                  radiantWin ? "text-success" : "text-muted"
                                }
                              >
                                {lobby.radiantScore ?? "—"}
                              </span>
                              <span className="px-1.5 text-muted">–</span>
                              <span
                                className={
                                  !radiantWin ? "text-danger" : "text-muted"
                                }
                              >
                                {lobby.direScore ?? "—"}
                              </span>
                            </span>
                            <Badge tone={radiantWin ? "success" : "danger"}>
                              {radiantWin ? "Radiant" : "Dire"} victory
                            </Badge>
                            <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                              <LocalTime
                                ts={playedAt.getTime()}
                                variant="short"
                                initial={formatMatchTime(playedAt, "short")}
                              />
                              {durationLabel ? (
                                <span className="tabular-nums">
                                  · {durationLabel}
                                </span>
                              ) : null}
                            </span>
                          </div>
                          {mvp?.userId ? (
                            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                              <span className="text-accent">MVP</span>
                              <PlayerLink
                                userId={mvp.userId}
                                className="min-w-0 truncate"
                              >
                                {mvp.name ?? "Unknown"}
                              </PlayerLink>
                              {mvpHero ? (
                                <span className="hidden truncate sm:inline">
                                  · {mvpHero.name}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`${resultHref(isExpanded ? undefined : lobby.id)}#result-${lobby.id}`}
                            scroll={false}
                            prefetch={false}
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? "Close" : "Open"} box score for ${formatMatchTime(playedAt, "short")}${lobby.dotaMatchId ? `, match ${lobby.dotaMatchId}` : ""}`}
                            className={buttonClasses(
                              isExpanded ? "secondary" : "ghost",
                              "sm",
                              "min-h-11",
                            )}
                          >
                            {isExpanded ? "Close ↑" : "Box score ↓"}
                          </Link>
                          {lobby.dotaMatchId ? (
                            <a
                              href={`https://www.opendota.com/matches/${lobby.dotaMatchId}`}
                              target="_blank"
                              rel="noreferrer"
                              className={textLink(
                                "inline-flex min-h-11 items-center text-xs",
                              )}
                            >
                              OpenDota ↗
                            </a>
                          ) : null}
                          {isAdmin ? (
                            <ActionForm
                              action={voidInhouseResult}
                              hidden={{ lobbyId: lobby.id }}
                            >
                              <SubmitButton
                                variant="ghost"
                                size="sm"
                                className="min-h-11 text-danger hover:underline"
                                confirm={`Void the ${formatMatchTime(playedAt, "short")} game (${lobby.radiantScore ?? 0}–${lobby.direScore ?? 0}${lobby.dotaMatchId ? `, match ${lobby.dotaMatchId}` : ""})? It leaves the ladder and history, everyone's Elo recalculates without it, and any Cred payouts reverse to pre-game balances.`}
                              >
                                void
                              </SubmitButton>
                            </ActionForm>
                          ) : null}
                        </div>
                      </div>
                      {isExpanded ? (
                        <div className="border-t border-line/70">
                          <InhouseBoxScore
                            lobby={lobby}
                            players={players}
                            avatarMap={avatarMap}
                            eloDeltas={lobby.eloDeltas}
                            roster={roster}
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              {pages > 1 ? (
                <nav
                  aria-label="Inhouse history pages"
                  className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5"
                >
                  {page > 1 ? (
                    <Link
                      href={
                        page === 2
                          ? "/inhouse/history"
                          : `/inhouse/history?page=${page - 1}`
                      }
                      className={buttonClasses("secondary", "sm")}
                    >
                      ← Newer games
                    </Link>
                  ) : (
                    <span />
                  )}
                  <span
                    className="order-first w-full text-center text-xs text-muted sm:order-none sm:w-auto"
                    aria-current="page"
                  >
                    Page {page} of {pages}
                  </span>
                  {page < pages ? (
                    <Link
                      href={`/inhouse/history?page=${page + 1}`}
                      className={buttonClasses("secondary", "sm")}
                    >
                      Older games →
                    </Link>
                  ) : (
                    <span />
                  )}
                </nav>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
