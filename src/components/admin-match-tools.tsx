import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import {
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { matchCoverIssues } from "@/lib/admin-sections";
import {
  matchCorrectionContext,
  matchLogisticsOpen,
  matchResultsOpen,
  postAuctionWorkOpen,
  standinAssignmentOpen,
} from "@/lib/league-lifecycle";
import { MATCH_ANCHOR, adminMatchRowId } from "@/lib/match-anchors";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { getSeasonDraftStatus } from "@/lib/queries";
import { type AutoCheck, autoCheckCopy, autoCheckStatus } from "@/lib/result-sync";
import {
  type StandinBooking,
  coverChoices,
  seatValue,
  standinPickerBlock,
} from "@/lib/standin";
import {
  parseSingleTiebreakerSlot,
  parseTiebreakerStage,
} from "@/lib/tiebreaker-format";
import { cn } from "@/lib/utils";
import { assignStandin, removeStandin } from "@/app/actions/admin-roster";
import {
  autoDetectAction,
  importGameAction,
  recordResult,
  removeGame,
  reopenMatch,
  setMatchTime,
} from "@/app/actions/admin-schedule-results";
import { cancelReschedule } from "@/app/actions/reschedule";
import { parseRescheduleOptions } from "@/lib/reschedule-ready-check";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AutoOpenDetails } from "@/components/auto-open-details";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { LocalTime } from "@/components/local-time";
import { MatchImportControls } from "@/components/match-import-controls";
import { Badge, Button, Card, LinkArrow, textLink } from "@/components/ui";

/**
 * One match's admin controls, shared by /admin and the match page.
 *
 * /admin's Needs attention list used to link each item to the public match
 * page, which had no admin controls, so fixing "result overdue" or "no kickoff
 * set" meant going back to /admin and hunting for the same fixture in a very
 * long page. The row and the standin block below are the SAME components on
 * both pages: same server actions, same confirms, same capability gates. Only
 * where they render differs.
 */

/** The fields a result row reads from a fixture. */
export type AdminResultRowMatch = {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  phase: string;
  status: string;
  bestOf: number;
  bracketSlot: string | null;
  forfeit: boolean;
  winnerTeamId: string | null;
  homeScore: number;
  awayScore: number;
  scheduledAt: Date | null;
  /** The automatic result check's clock (autoCheckStatus). */
  autoSyncedAt: Date | null;
  autoSyncAttempts: number;
  games: {
    id: string;
    dotaMatchId: string;
    winnerTeamId: string | null;
    durationSecs: number;
  }[];
};

type StandinBlockTeam = {
  id: string;
  name: string;
  members: { userId: string; user: { name: string } }[];
};

type StandinBlockAssignment = {
  id: string;
  matchId: string;
  teamId: string;
  standinUserId: string;
  replacingUserId: string | null;
  standin: { name: string };
  replaced: { name: string } | null;
};

/**
 * Who an admin can slot in as cover: registered standins PLUS undrafted full
 * players. A pool-dry draft leaves ACTIVE PLAYER signups unrostered, and
 * assignStandinGuarded accepts them, so an admin with two undrafted players
 * and an OUT on match night has cover to offer. Rostered players play for
 * their own team.
 */
export function adminStandinPoolWhere(
  seasonId: string,
): Prisma.RegistrationWhereInput {
  return {
    seasonId,
    status: REGISTRATION_STATUS.ACTIVE,
    OR: [
      { type: REGISTRATION_TYPE.STANDIN },
      {
        type: REGISTRATION_TYPE.PLAYER,
        user: { teamMemberships: { none: { seasonId } } },
      },
    ],
  };
}

// min-w-0 + max-w-full are load-bearing: a <select> sizes itself to its widest
// <option>, and as a flex item it refuses to shrink below that. Options here
// carry player names, so one 32-char Steam name would widen the page on a
// phone. Same class as /admin's other selects.
const selectCls =
  "h-9 min-w-0 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60";

/**
 * When the scheduled worker next looks for this match's games, or why it
 * won't, so an admin can tell "it's coming in 3 minutes" from "it will never
 * run" before pressing Auto-fetch games.
 */
export function AutoCheckLine({
  check,
  className = "",
}: {
  check: AutoCheck;
  className?: string;
}) {
  const copy = autoCheckCopy(check);
  return (
    <p
      data-testid="auto-check"
      className={`text-xs ${copy.problem ? "text-danger" : "text-muted"} ${className}`}
    >
      {copy.lead}
      {copy.at != null ? (
        <LocalTime
          ts={copy.at}
          variant="short"
          initial={formatLeagueMatchTime(new Date(copy.at), "short")}
        />
      ) : null}
      {copy.tail}
    </p>
  );
}

/** Why a decided playoff series is read-only, said once where a card lists
 *  several (the rows then print the short form). */
export const LATER_ROUND_NOTE =
  "A series that already advanced a later playoff round is read-only, because changing its winner would strand the teams downstream. Use Reset playoffs under “Fix the bracket” to reseed the full bracket before correcting one.";

/** Why a phase's results can't be corrected right now, or null if they can. */
export function resultsLockNote(seasonStatus: string, phase: string): string | null {
  if (matchResultsOpen(seasonStatus, phase)) return null;
  if (phase === MATCH_PHASE.REGULAR)
    return "Regular-season results are read-only outside the Regular season phase. Move the phase back and reseed before correcting one.";
  if (phase === MATCH_PHASE.TIEBREAKER)
    return "Tiebreaker results are read-only once playoffs begin. Return to Regular season before correcting one.";
  return "Playoff results are read-only unless the season is in Playoffs.";
}

/**
 * The help every result row used to repeat, printed ONCE above a card's
 * match rows. Each row's match-id field points aria-describedby at `id`, so
 * a screen reader still hears the import hint on every field.
 */
export function MatchRowsHelp({
  id,
  seasonStatus,
  draftStatus,
  canImport,
  hasScheduled,
  notes = [],
}: {
  id: string;
  seasonStatus: string;
  draftStatus: string | null;
  /** Some row below shows the Auto-fetch / Add game controls. */
  canImport: boolean;
  /** Some row below is still SCHEDULED, so its kickoff matters. */
  hasScheduled: boolean;
  /** Card-wide reasons rows are read-only, said once instead of per row. */
  notes?: (string | null)[];
}) {
  const kickoffOpen = postAuctionWorkOpen(seasonStatus, draftStatus);
  const kickoffNote = !hasScheduled
    ? null
    : kickoffOpen
      ? "Changing or clearing a kickoff resets that match’s check-ins, cancels its open reschedule proposals, and reopens the week’s Discord reminder."
      : seasonStatus === SEASON_STATUS.COMPLETE
        ? "Kickoff times are locked because the completed season is read-only."
        : seasonStatus === SEASON_STATUS.SIGNUPS ||
            seasonStatus === SEASON_STATUS.DRAFT
          ? "Kickoff times can be edited once the auction is complete."
          : "Kickoff times are locked in the current league phase.";
  const lines = [...new Set(notes.filter((n): n is string => !!n))];
  return (
    <div className="space-y-1 text-xs text-muted">
      {canImport ? (
        <p id={id}>
          Enter a score by hand, or bring in the real games: Auto-fetch games
          looks them up on OpenDota (players need &ldquo;Expose Public Match
          Data&rdquo; on), and Add game takes a numeric Dota match ID or an
          OpenDota/Dotabuff match URL.
        </p>
      ) : null}
      {kickoffNote ? <p>{kickoffNote}</p> : null}
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}

// One match's result + scheduling + imported-games controls. /admin renders
// one per fixture (Schedule & results, Tiebreakers); the match page renders
// the same row inside its Admin tools card.
export function MatchResultRow({
  m,
  teams,
  label,
  expectedActiveSeasonId,
  seasonStatus,
  leagueId,
  nowMs,
  draftStatus,
  championTeamId,
  correctionBlockedByLaterRound,
  isSoleLatestPlayoffSeries,
  laterRoundNote = "full",
  importHelpId,
  id,
  idPrefix = "",
  captainImportOnPage = false,
}: {
  m: AdminResultRowMatch;
  teams: { id: string; name: string }[];
  label: React.ReactNode;
  expectedActiveSeasonId: string;
  seasonStatus: string;
  /** The season's Valve league id: its feed runs before player-account scans. */
  leagueId: string | null;
  nowMs: number;
  draftStatus: string | null;
  championTeamId: string | null;
  correctionBlockedByLaterRound: boolean;
  isSoleLatestPlayoffSeries: boolean;
  /**
   * How much of the "a later round depends on this" explanation the ROW
   * prints: "full" when it is the only place it appears, "short" when the
   * card has printed the full version once above, "none" when every row in
   * the card shares it (the card's note says it for all of them).
   */
  laterRoundNote?: "full" | "short" | "none";
  /** The card's <MatchRowsHelp> id, which the match-id field points at. */
  importHelpId?: string;
  /** The row's anchor on /admin (adminMatchRowId), so a link can land on it. */
  id?: string;
  /** Prefixes the row's input ids where another copy of a control may share
   *  the page (the match page's captain card for an admin who captains). */
  idPrefix?: string;
  /** The viewer captains this match and the page already shows their own
   *  Auto-fetch games / Add game in Captain tools: point there instead of a
   *  second, identically named form (one control, one name). */
  captainImportOnPage?: boolean;
}) {
  const home = teams.find((t) => t.id === m.homeTeamId);
  const away = teams.find((t) => t.id === m.awayTeamId);
  const resultOpen = matchResultsOpen(seasonStatus, m.phase);
  const resultCorrectionOpen = resultOpen && !correctionBlockedByLaterRound;
  const importedFinal =
    m.games.length > 0 && m.status === MATCH_STATUS.COMPLETED && !m.forfeit;
  const championIsFinalParticipant =
    seasonStatus === SEASON_STATUS.COMPLETE &&
    m.phase === MATCH_PHASE.FINAL &&
    m.status === MATCH_STATUS.COMPLETED &&
    championTeamId != null &&
    (championTeamId === m.homeTeamId || championTeamId === m.awayTeamId);
  const championshipFinalCorrection =
    championIsFinalParticipant && isSoleLatestPlayoffSeries;
  const crownedGrandFinal =
    championshipFinalCorrection && m.winnerTeamId === championTeamId;
  const conflictingChampionFinal =
    championshipFinalCorrection && m.winnerTeamId !== championTeamId;
  const unresolvedCompletedFinal =
    seasonStatus === SEASON_STATUS.COMPLETE &&
    m.phase === MATCH_PHASE.FINAL &&
    m.status === MATCH_STATUS.COMPLETED &&
    !championshipFinalCorrection;
  const canReopenManual =
    m.games.length === 0 &&
    (resultCorrectionOpen || championshipFinalCorrection);
  const canCorrectImported =
    resultCorrectionOpen || championshipFinalCorrection;
  const logisticsOpen = matchLogisticsOpen(seasonStatus, draftStatus, m.status);
  // Phase-wide reasons ("until the Regular season starts") would repeat on
  // every row of a freshly generated schedule; only per-match ones show here.
  const autoCheck = autoCheckStatus(
    m,
    { status: seasonStatus, dotaLeagueId: leagueId },
    nowMs,
  );
  const rowAutoCheck =
    autoCheck &&
    !(autoCheck.kind === "none" && autoCheck.reason !== "no-kickoff")
      ? autoCheck
      : null;
  // Only what is true of THIS row. The phase-wide "results are read-only"
  // reasons are printed once by the card (<MatchRowsHelp>): on a finished
  // season every regular row used to repeat the same paragraph.
  const rowNote = correctionBlockedByLaterRound
    ? laterRoundNote === "none"
      ? null
      : laterRoundNote === "short"
        ? "Read-only: a later round depends on this result."
        : m.phase === MATCH_PHASE.REGULAR ||
            m.phase === MATCH_PHASE.TIEBREAKER
          ? "Tiebreaker fixtures depend on this result. Use Reset tiebreaker week in the Playoffs controls before correcting it."
          : LATER_ROUND_NOTE
    : !resultOpen
      ? m.phase !== MATCH_PHASE.FINAL
        ? null
        : crownedGrandFinal
          ? "This result crowned the champion. Use the grand-final correction below to retract the title and reopen only this series."
          : conflictingChampionFinal
            ? "The stored champion conflicts with this completed final. Use the correction below to retract the inconsistent title and reconcile only this series."
            : unresolvedCompletedFinal
              ? championTeamId == null
                ? "This completed grand final has no authoritative champion. Move the season back to Playoffs with the phase control, then reconcile this result; title-retraction controls stay hidden because no title exists."
                : !championIsFinalParticipant
                  ? "The recorded champion is not a participant in this completed grand final. Use the dedicated playoff recovery controls to restore a consistent bracket and title; targeted title-retraction controls stay hidden because this final cannot safely retract that team."
                  : "The bracket does not have one sole authoritative latest final. Use the dedicated playoff recovery controls to restore a single consistent final before targeted title correction is available."
              : null
      : `Score derived from ${m.games.length} imported game${m.games.length === 1 ? "" : "s"}. Remove the incorrect game below; the series recomputes automatically.`;
  return (
    <div
      id={id}
      className={cn(
        "space-y-2 rounded-lg border border-line px-3 py-2.5",
        // /admin's wrapped sticky jump bar is taller at lg (see AdminJump).
        id && "scroll-mt-40 lg:scroll-mt-56",
      )}
    >
      {!resultCorrectionOpen || importedFinal ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {label}
          <span className="min-w-0 flex-1 text-right">{home?.name ?? "?"}</span>
          <strong className="tabular-nums">
            {m.homeScore}–{m.awayScore}
          </strong>
          <span className="min-w-0 flex-1">{away?.name ?? "?"}</span>
          {m.status === MATCH_STATUS.COMPLETED ? (
            <Badge tone="success">
              {m.forfeit ? "final · forfeit" : "final"}
            </Badge>
          ) : null}
          {rowNote ? (
            <span className="w-full text-xs text-muted">{rowNote}</span>
          ) : null}
        </div>
      ) : (
        <ActionForm
          action={recordResult}
          className="flex flex-wrap items-center gap-2 text-sm"
          hidden={{ matchId: m.id, expectedActiveSeasonId }}
        >
          {label}
          {/* Keep each team name with its input. Letting two independent
              flex-1 labels absorb the whole phone-width shortfall squeezed
              them to 9px; a single long word then widened /admin itself. */}
          <div className="grid min-w-0 basis-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 sm:basis-auto sm:flex-1">
            <label className="min-w-0 text-right">
              <span className="mb-1 block break-words leading-tight [overflow-wrap:anywhere]">
                {home?.name ?? "?"}
              </span>
              <input
                id={`${idPrefix}home-score-${m.id}`}
                aria-label={`${home?.name ?? "Home team"} series score`}
                name="homeScore"
                type="number"
                min={0}
                max={m.bestOf}
                required
                defaultValue={m.homeScore}
                className="ml-auto block h-8 w-14 rounded-md border border-line bg-surface-2/50 px-2 text-center"
              />
            </label>
            <span className="pb-2 text-muted">–</span>
            <label className="min-w-0">
              <span className="mb-1 block break-words leading-tight [overflow-wrap:anywhere]">
                {away?.name ?? "?"}
              </span>
              <input
                id={`${idPrefix}away-score-${m.id}`}
                aria-label={`${away?.name ?? "Away team"} series score`}
                name="awayScore"
                type="number"
                min={0}
                max={m.bestOf}
                required
                defaultValue={m.awayScore}
                className="block h-8 w-14 rounded-md border border-line bg-surface-2/50 px-2 text-center"
              />
            </label>
          </div>
          {/* The recorded score stays official for standings/gameDiff. The flag
            badges the ruling and keeps it out of performance-only power
            rankings. Re-saving with the box unchecked un-rules it. */}
          <label className="flex items-center gap-1 text-xs text-muted">
            <input
              type="checkbox"
              name="forfeit"
              required={m.games.length > 0}
              defaultChecked={m.forfeit}
              className="h-3.5 w-3.5 accent-[var(--color-brand)]"
            />
            forfeit / ruling
          </label>
          {m.status === "COMPLETED" ? (
            <Badge tone="success">
              {m.forfeit ? "final · forfeit" : "final"}
            </Badge>
          ) : null}
          {/* This button had NO confirm, and the score boxes default to the
            current score — 0–0 on an unplayed match — with Enter submitting
            from either field. Every match row on the page carries one, so a
            stray Enter while reading marked a series FINAL at 0–0: it stops
            auto-sync for that fixture, posts the wrong score to Discord, and
            on a PLAYOFF row feeds advancePlayoffBracket, which is how a wrong
            team reaches the next round. Name the teams and the score so the
            dialog is about THIS row, and say what marking it final does. */}
          <SubmitButton
            variant="secondary"
            size="sm"
            /* Deliberately does NOT quote the score: these inputs are
             uncontrolled, so a server-rendered string would state the STORED
             score while the admin has typed a different one — a confirm that
             lies about its own effect is worse than none. Name the fixture,
             point at the boxes, and state what "final" costs. */
            confirm={`Record the score in the boxes as the FINAL result for ${home?.name ?? "home"} v ${away?.name ?? "away"}?\n\nCheck the two score boxes first. A played series must reach its real finish; use the forfeit / ruling box only when an admin is ending it early. Marking a match final stops automatic result import for it${
              m.phase === "PLAYOFF" || m.phase === "FINAL"
                ? " and advances the playoff bracket"
                : m.phase === "TIEBREAKER" && (parseTiebreakerStage(m.bracketSlot) || parseSingleTiebreakerSlot(m.bracketSlot))
                  ? " and creates the next tiebreaker game when needed; this result locks once that dependent game exists"
                : ""
            }, and "Reopen for import" only undoes it while no games are attached.`}
          >
            {m.games.length > 0 ? "Save ruling" : "Save as final"}
          </SubmitButton>
          {m.games.length > 0 ? (
            <span className="w-full text-xs text-muted">
              The imported games currently account for {m.homeScore}–
              {m.awayScore}. A ruling may add awarded wins, but cannot erase a
              played win.
            </span>
          ) : null}
        </ActionForm>
      )}

      {/* A hand-entered score marks the match COMPLETED with zero games, and
          every import path then refuses it forever — so a stray Save (these
          boxes default to 0 and Enter submits) used to cost the series its box
          score permanently. This is the way back. */}
      {canReopenManual && m.status === "COMPLETED" ? (
        <ActionForm
          action={reopenMatch}
          className="flex flex-wrap items-center gap-2 text-xs text-muted"
          hidden={{ matchId: m.id, expectedActiveSeasonId }}
        >
          <span>
            {championshipFinalCorrection
              ? conflictingChampionFinal
                ? "Recorded by hand — the stored champion conflicts with this winner."
                : "Recorded by hand — this result crowned the champion."
              : "Recorded by hand — no games imported."}
          </span>
          <SubmitButton
            variant="ghost"
            size="sm"
            confirm={
              championshipFinalCorrection
                ? `${conflictingChampionFinal ? "Retract the inconsistent champion" : "Retract the champion"} and reopen only the grand final? The hand-entered score is cleared; earlier playoff rounds stay intact.`
                : "Reopen this match so its real games can be imported? The hand-entered score is cleared."
            }
          >
            {championshipFinalCorrection
              ? conflictingChampionFinal
                ? "Reopen final & retract title"
                : "Reopen grand final"
              : "Reopen for import"}
          </SubmitButton>
        </ActionForm>
      ) : null}

      {logisticsOpen ? (
        <ActionForm
          action={setMatchTime}
          className="flex flex-wrap items-center gap-2 text-xs text-muted"
          hidden={{ matchId: m.id, expectedActiveSeasonId }}
        >
          {/* The label sits BESIDE the field, not around it: the field now
              carries its zone name and "your time" hint, and a wrapping label
              folds both into the box's accessible name ("Kickoff time Pacific
              time = 9:57 AM your time"). They are its description instead.
              Beside it on the same line, too: above it, it cost each row a
              line. */}
          <label htmlFor={`${idPrefix}scheduledAt-${m.id}`}>Kickoff time</label>
          <LocalDatetimeField
            id={`${idPrefix}scheduledAt-${m.id}`}
            name="scheduledAt"
            tsName="scheduledAtTs"
            defaultTs={m.scheduledAt?.getTime()}
            timeZone={LEAGUE_CONFIG.timeZone}
            className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
          />
          <SubmitButton variant="secondary" size="sm">
            {m.scheduledAt ? "Update time" : "Set time"}
          </SubmitButton>
        </ActionForm>
      ) : (
        <p className="text-xs text-muted">
          Kickoff:{" "}
          {m.scheduledAt ? (
            <LocalTime
              ts={m.scheduledAt.getTime()}
              variant="full"
              initial={formatLeagueMatchTime(m.scheduledAt, "full")}
            />
          ) : (
            "not set"
          )}
          {/* A finished match needs no reason, and the season-wide ones are
              printed once by the card. Only a live series says why here. */}
          {m.status === MATCH_STATUS.LIVE
            ? " · the time is locked while the series is live."
            : null}
        </p>
      )}

      {m.games.length > 0 ? (
        <ul className="space-y-1 border-t border-line/60 pt-2 text-xs">
          {m.games.map((g) => {
            const winner = teams.find((t) => t.id === g.winnerTeamId);
            return (
              <li key={g.id} className="flex items-center justify-between">
                <a
                  href={`https://www.opendota.com/matches/${g.dotaMatchId}`}
                  target="_blank"
                  rel="noreferrer"
                  className={textLink()}
                >
                  Game {g.dotaMatchId} · {winner ? `${winner.name} won` : "tie"}{" "}
                  · {Math.floor(g.durationSecs / 60)}m
                </a>
                {canCorrectImported ? (
                  <ActionForm action={removeGame}>
                    <input type="hidden" name="gameId" value={g.id} />
                    <SubmitButton
                      variant="ghost"
                      size="sm"
                      className="text-danger-soft hover:underline"
                      confirm={
                        championshipFinalCorrection
                          ? `${conflictingChampionFinal ? "Retract the inconsistent champion" : "Retract the champion"}, remove this imported game, and recompute only the grand final? Earlier rounds stay intact.`
                          : "Remove this imported game and recompute the series?"
                      }
                    >
                      remove
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <span className="text-muted">read-only</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {rowAutoCheck ? <AutoCheckLine check={rowAutoCheck} /> : null}

      {resultCorrectionOpen &&
      m.status !== MATCH_STATUS.COMPLETED &&
      captainImportOnPage ? (
        <p className="text-xs text-muted">
          You captain this match, so add its games in{" "}
          <a href={`#${MATCH_ANCHOR.report}`} className={textLink()}>
            Captain tools
          </a>{" "}
          below. The admin import, which skips the captain checks, is in the
          admin panel.
        </p>
      ) : resultCorrectionOpen && m.status !== MATCH_STATUS.COMPLETED ? (
        <MatchImportControls
          matchId={m.id}
          importAction={importGameAction}
          detectAction={autoDetectAction}
          idPrefix={idPrefix}
          describedBy={importHelpId}
        />
      ) : m.status === MATCH_STATUS.COMPLETED &&
        (resultCorrectionOpen || championshipFinalCorrection) ? (
        <p className="text-xs text-muted">
          This series is final. Reopen a hand-entered result or remove an
          incorrect imported game before adding another.
        </p>
      ) : null}
    </div>
  );
}

// One match's any-team standin controls: an OUT-players alert, current
// assignments, and the assign form. /admin's Standin assignments card renders
// one per upcoming fixture; the match page's Admin tools render the same block.
export function StandinMatchBlock({
  m,
  teams,
  pool,
  bookings,
  outRsvps,
  assignments,
  teamName,
  label,
  teamSize,
  assignOpen,
}: {
  /** `games` decides the lock: once one is imported, removeStandinGuarded
   *  refuses every removal (it would strip the standin from the rest of the
   *  series), so the block says so instead of offering "remove". The kickoff
   *  and week feed the same-night check (standinPickerBlock). */
  m: {
    id: string;
    homeTeamId: string;
    awayTeamId: string;
    scheduledAt: Date | null;
    week: number;
    games: unknown[];
  };
  teams: StandinBlockTeam[];
  /** Who can cover: adminStandinPoolWhere's registrations, MMR first. */
  pool: { userId: string; mmr: number; user: { name: string } }[];
  /** The season's bookings on unplayed fixtures, this one included — the
   *  same list the captain's picker checks, so both pickers grey out and
   *  explain the standins the server would refuse. */
  bookings: readonly StandinBooking[];
  /** OUT answers for the fixture's current schedule revision. */
  outRsvps: { matchId: string; userId: string; user: { name: string } }[];
  assignments: StandinBlockAssignment[];
  teamName: Map<string, string>;
  label: React.ReactNode;
  teamSize: number;
  /** The card-level phase gate — the assign form hides where the service
   *  would refuse; removal stays rendered (cleanup is legal everywhere). */
  assignOpen: boolean;
}) {
  const home = teams.find((t) => t.id === m.homeTeamId);
  const away = teams.find((t) => t.id === m.awayTeamId);
  const asg = assignments;
  const seriesStarted = m.games.length > 0;
  // A player already covered can't be covered again (the service refuses a
  // second cover for one seat), so don't offer them — the captain-facing card
  // has always filtered these and the admin one didn't.
  const coveredIds = new Set(
    asg.map((a) => a.replacingUserId).filter(Boolean) as string[],
  );
  // The captain picker's rules, not a second copy of them: a standin already
  // booked in this match or on another fixture that night is listed last,
  // disabled, with the reason (standinPickerBlock), and each Covers group
  // leads with the players who said they can't make it (coverChoices). The
  // server still refuses both at submit.
  const target = { matchId: m.id, scheduledAt: m.scheduledAt, week: m.week };
  const poolChoices = pool.map((s) => ({
    reg: s,
    blocked: standinPickerBlock(s.userId, target, bookings),
  }));
  const pickerOptions = [
    ...poolChoices.filter((c) => !c.blocked),
    ...poolChoices.filter((c) => c.blocked),
  ];
  const outIds = new Set(
    outRsvps.filter((r) => r.matchId === m.id).map((r) => r.userId),
  );
  const homeCover = coverChoices(home?.members ?? [], outIds, coveredIds);
  const awayCover = coverChoices(away?.members ?? [], outIds, coveredIds);
  // Pre-select only when exactly one uncovered player is out across BOTH
  // sides, so the form never guesses between two.
  const outChoices = [...homeCover.choices, ...awayCover.choices].filter(
    (c) => c.out,
  );
  const preselect = outChoices.length === 1 ? outChoices[0].member.userId : "";
  // OPEN SEATS. A short roster is filled by a standin who replaces NOBODY, so
  // it needs its own option — this is the case that had no UI at all, which is
  // why a 4-of-5 team simply could not be covered. One entry per still-open
  // seat, already-filled ones subtracted.
  const openSeats = [home, away].flatMap((t) => {
    if (!t) return [];
    const filled = asg.filter(
      (a) => a.teamId === t.id && a.replacingUserId == null,
    ).length;
    const open = teamSize - t.members.length - filled;
    return open > 0 ? [{ team: t, open }] : [];
  });
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="text-sm font-medium">
        {label}: {home?.name ?? "?"} vs {away?.name ?? "?"}
      </div>
      {(() => {
        // Only current roster members can need cover, and the OTHER
        // direction, an assigned STANDIN who has declared OUT, gets distinct
        // copy because the fix differs (remove/replace, not add). The same
        // matchCoverIssues decides which matches open /admin's card at the top.
        const { uncovered: needing, standinsOut: standinOut } =
          matchCoverIssues(m, teams, asg, outRsvps);
        return (
          <>
            {needing.length > 0 ? (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs">
                ✗ Can&apos;t make it:{" "}
                <b>{needing.map((r) => r.user.name).join(", ")}</b> — assign a
                standin below.
              </div>
            ) : null}
            {standinOut.length > 0 ? (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs">
                ✗ Assigned standin{" "}
                <b>{standinOut.map((r) => r.user.name).join(", ")}</b> has
                declared OUT —{" "}
                {seriesStarted
                  ? "the series has started, so the booking stays; the remaining games record whoever actually plays."
                  : "remove that assignment and arrange other cover."}
              </div>
            ) : null}
          </>
        );
      })()}
      {asg.length > 0 ? (
        <ul className="space-y-1">
          {asg.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-x-2 text-xs text-muted"
            >
              <span>
                {/* A null `replaced` is an EMPTY-SEAT cover, not missing data —
                    it used to render as "in for ?". */}
                {a.replaced
                  ? `${a.standin.name} in for ${a.replaced.name}`
                  : `${a.standin.name} filling an open seat`}{" "}
                · {teamName.get(a.teamId)}
              </span>
              {seriesStarted ? (
                // The same note as the captain's card: removal mid-series is
                // refused by the service, so offer no button that can only fail.
                <span className="ml-auto text-xs text-muted">
                  Locked: series already started
                </span>
              ) : (
                <ActionForm action={removeStandin}>
                  <input type="hidden" name="assignmentId" value={a.id} />
                  <SubmitButton
                    variant="ghost"
                    size="sm"
                    className="text-xs text-danger-soft hover:underline"
                    confirm={`Remove ${a.standin.name} from this match? They are told to stand down in Discord — if this was a mis-click they will have been pinged twice for nothing.`}
                  >
                    remove
                  </SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {!assignOpen ? null : (
        <ActionForm
          action={assignStandin}
          className="flex flex-wrap items-center gap-2"
        >
          <input type="hidden" name="matchId" value={m.id} />
          <select
            name="standinUserId"
            required
            defaultValue=""
            aria-label="Standin"
            className={selectCls}
          >
            <option value="" disabled>
              Standin…
            </option>
            {/* MMR rides in the option text — the captain picker has always
              shown it, and the any-team admin override was choosing blind. */}
            {pickerOptions.map(({ reg: s, blocked }) => (
              <option key={s.userId} value={s.userId} disabled={!!blocked}>
                {blocked
                  ? `${s.user.name} (${blocked})`
                  : `${s.user.name} (${s.mmr} MMR)`}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">replaces</span>
          {/* Keyed on the pre-selection: an uncontrolled select keeps its
              first defaultValue, so a new "can't make it" needs a remount. */}
          <select
            key={preselect}
            name="replacingUserId"
            required
            defaultValue={preselect}
            aria-label="Player being replaced"
            className={selectCls}
          >
            <option value="" disabled>
              Player…
            </option>
            {/* Open seats first: on a short roster this is the thing the admin
              came here to do, and it used to be impossible. The `seat:` prefix
              is unpacked by the action into a null replacingUserId + teamId. */}
            {openSeats.length > 0 ? (
              <optgroup label="Open roster seat">
                {openSeats.map(({ team, open }) => (
                  <option key={`seat-${team.id}`} value={seatValue(team.id)}>
                    {team.name} — empty seat ({open} of {teamSize} unfilled)
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label={home?.name ?? "Home"}>
              {homeCover.choices.map(({ member: mm, out }) => (
                <option key={mm.userId} value={mm.userId}>
                  {out ? `${mm.user.name} (can't make it)` : mm.user.name}
                </option>
              ))}
            </optgroup>
            <optgroup label={away?.name ?? "Away"}>
              {awayCover.choices.map(({ member: mm, out }) => (
                <option key={mm.userId} value={mm.userId}>
                  {out ? `${mm.user.name} (can't make it)` : mm.user.name}
                </option>
              ))}
            </optgroup>
          </select>
          <Button type="submit" variant="secondary" size="sm">
            Assign
          </Button>
        </ActionForm>
      )}
    </div>
  );
}

/**
 * The match page's Admin tools card: this fixture's /admin controls, folded
 * shut, for admins only. /admin's Needs attention items link here
 * (`#match-admin`), and AutoOpenDetails opens the card on that jump, so a
 * phone on match night goes straight from the checklist to the fix.
 *
 * Active season only: /admin manages the active season, and every action
 * below refuses an archived one.
 *
 * The season comes with the page's match (load.ts reads it once) and the
 * draft status from the request-cached getSeasonDraftStatus that load.ts's
 * loadDraftStatus wraps, so the card re-reads neither. Its other reads are
 * its own: the /admin shapes of both rosters, the standin pool and bookings,
 * the named OUT check-ins and the open reschedule.
 */
export async function AdminMatchTools({
  match,
  label,
  viewerHasCaptainTools = false,
}: {
  match: AdminResultRowMatch & {
    seasonId: string;
    week: number;
    scheduleRevision: number;
    standins: StandinBlockAssignment[];
    season: {
      isActive: boolean;
      status: string;
      teamSize: number;
      championTeamId: string | null;
      dotaLeagueId: string | null;
    };
  };
  /** The fixture's round, e.g. "Week 3" or "Semifinal". */
  label: string;
  /** The admin also captains this match and the page shows their Captain
   *  tools, whose import form this card then points at instead of repeating. */
  viewerHasCaptainTools?: boolean;
}) {
  const season = { ...match.season, id: match.seasonId };
  if (!season.isActive) return null;
  const [draftStatus, fixtures, teams, pool, bookingRows, outRsvps, pending] =
    await Promise.all([
      getSeasonDraftStatus(match.seasonId),
      // The season's fixtures decide whether a later round already depends
      // on this result (matchCorrectionContext), exactly as on /admin.
      prisma.match.findMany({
        where: { seasonId: match.seasonId },
        select: { id: true, phase: true, week: true, bracketSlot: true },
      }),
      prisma.team.findMany({
        where: { id: { in: [match.homeTeamId, match.awayTeamId] } },
        select: {
          id: true,
          name: true,
          members: {
            select: { userId: true, user: { select: { name: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      prisma.registration.findMany({
        where: adminStandinPoolWhere(match.seasonId),
        select: { userId: true, mmr: true, user: { select: { name: true } } },
        orderBy: { mmr: "desc" },
      }),
      // The season's bookings on unplayed fixtures, for the picker's
      // already-booked / same-night check (the captain's picker reads the same).
      prisma.standinAssignment.findMany({
        where: {
          match: {
            seasonId: match.seasonId,
            status: { not: MATCH_STATUS.COMPLETED },
          },
        },
        select: {
          standinUserId: true,
          matchId: true,
          replaced: { select: { name: true } },
          match: {
            select: {
              scheduledAt: true,
              week: true,
              homeTeam: { select: { name: true } },
              awayTeam: { select: { name: true } },
            },
          },
        },
      }),
      prisma.matchAvailability.findMany({
        where: {
          matchId: match.id,
          status: "OUT",
          scheduleRevision: match.scheduleRevision,
        },
        select: {
          matchId: true,
          userId: true,
          user: { select: { name: true } },
        },
      }),
      prisma.rescheduleRequest.findFirst({
        where: { matchId: match.id, status: "PENDING" },
        select: {
          id: true,
          proposedTime: true,
          options: true,
          proposedBy: { select: { name: true } },
        },
      }),
    ]);
  const bookings: StandinBooking[] = bookingRows.map((b) => ({
    standinUserId: b.standinUserId,
    matchId: b.matchId,
    replacedName: b.replaced?.name ?? null,
    homeName: b.match.homeTeam.name,
    awayName: b.match.awayTeam.name,
    scheduledAt: b.match.scheduledAt,
    week: b.match.week,
  }));
  const correction = matchCorrectionContext(match, fixtures);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  // The same gate as the captain's card and the service: open from the end of
  // the auction until the series is decided. Existing bookings still show, so
  // they can be removed.
  const assignOpen = standinAssignmentOpen(
    season.status,
    draftStatus,
    match.status,
  );
  const showStandins =
    match.status !== MATCH_STATUS.COMPLETED &&
    (assignOpen || match.standins.length > 0);
  // A server component renders once per request; the auto-check line is a
  // snapshot, like the same line on /admin.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const importHelpId = `admin-import-help-${match.id}`;
  // The row's import controls render exactly when this is true, so the help
  // they point at is printed only for them.
  const rowImports =
    matchResultsOpen(season.status, match.phase) &&
    !correction.correctionBlockedByLaterRound &&
    match.status !== MATCH_STATUS.COMPLETED &&
    !viewerHasCaptainTools;
  return (
    <Card className="overflow-hidden">
      <AutoOpenDetails
        id={MATCH_ANCHOR.admin}
        className="group/admin scroll-mt-24"
      >
        {/* Set like CardHeader, as the match page's other cards are. */}
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-2/40 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0 flex-1">
            <h2 className="text-[0.9375rem] font-semibold leading-snug text-fg">
              Admin tools
            </h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
              Kickoff, result, games and standins for this match. Only admins
              see this.
            </p>
          </div>
          <span
            aria-hidden
            className="text-muted transition-transform group-open/admin:rotate-180 motion-reduce:transition-none"
          >
            ▾
          </span>
        </summary>
        <div className="space-y-3 border-t border-line-soft p-4">
          <MatchRowsHelp
            id={importHelpId}
            seasonStatus={season.status}
            draftStatus={draftStatus}
            canImport={rowImports}
            hasScheduled={match.status === MATCH_STATUS.SCHEDULED}
            notes={[resultsLockNote(season.status, match.phase)]}
          />
          <MatchResultRow
            m={match}
            teams={teams}
            expectedActiveSeasonId={season.id}
            seasonStatus={season.status}
            leagueId={season.dotaLeagueId}
            nowMs={nowMs}
            importHelpId={importHelpId}
            draftStatus={draftStatus}
            championTeamId={season.championTeamId}
            correctionBlockedByLaterRound={
              correction.correctionBlockedByLaterRound
            }
            isSoleLatestPlayoffSeries={correction.isSoleLatestPlayoffSeries}
            idPrefix="admin-"
            captainImportOnPage={viewerHasCaptainTools}
            label={
              <span className="shrink-0 text-xs font-medium text-fg">
                {label}
              </span>
            }
          />
          {pending ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 p-3 text-xs">
              <span className="min-w-0 flex-1">
                ⏳ <strong>{pending.proposedBy.name}</strong> proposes{" "}
                {parseRescheduleOptions(pending.options, pending.proposedTime).map(
                  (ts, i, all) => (
                    <span key={ts}>
                      {i > 0 ? (i === all.length - 1 ? " or " : ", ") : null}
                      <LocalTime
                        ts={ts}
                        variant="full"
                        initial={formatLeagueMatchTime(new Date(ts), "full")}
                      />
                    </span>
                  ),
                )}{" "}
                — a ready check is under way on the match page.
              </span>
              <ActionForm
                action={cancelReschedule}
                hidden={{ requestId: pending.id }}
              >
                <SubmitButton variant="secondary" size="sm">
                  Clear
                </SubmitButton>
              </ActionForm>
            </div>
          ) : null}
          {showStandins ? (
            <StandinMatchBlock
              m={match}
              teams={teams}
              pool={pool}
              bookings={bookings}
              outRsvps={outRsvps}
              assignments={match.standins}
              teamName={teamName}
              teamSize={season.teamSize}
              assignOpen={assignOpen}
              label="Standins"
            />
          ) : null}
          <p className="text-xs">
            <Link
              href={`/admin#${adminMatchRowId(match.id)}`}
              className={textLink()}
            >
              Open this match in the admin panel <LinkArrow />
            </Link>
          </p>
        </div>
      </AutoOpenDetails>
    </Card>
  );
}
