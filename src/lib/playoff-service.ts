import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { nextRoundPairings, upcomingMatchNight } from "./schedule";
import { projectPlayoffField } from "./playoff-field";
import {
  playoffSetupRevision,
  type PlayoffCommandIntent,
} from "./playoff-command";
import {
  DOTA_MATCH_KIND,
  MATCH_PHASE,
  MATCH_STATUS,
  SCRIM_STATUS,
  SEASON_STATUS,
} from "./constants";
import { championMessage, getWebhookUrl, sendDiscordMessage } from "./discord";
import { raceHook } from "./race-hook";
import {
  championAnnouncedKey,
  playoffGamesArchiveKey,
  resultAnnouncedKey,
  SETTING_KEYS,
  weekReminderKey,
} from "./settings";
import { regularSeasonStatus } from "./schedule-status";
import { resolveChampionPresentation } from "./champion-presentation";
import {
  announcementDedupeKey,
  claimAnnouncementMarker,
  markAnnouncementFailed,
  markAnnouncementSent,
  releaseAnnouncementClaim,
} from "./announcement-marker";
import { UserFacingError } from "./user-facing-error";
import { hasConfirmedScrimConflict } from "./scrim-schedule-conflict";

/** One deleted playoff game, kept so the postseason can be re-imported. */
type ArchivedGame = { dotaMatchId: string; slot: string | null; week: number };

/** The round-build's inputs stopped being true mid-flight (reset / correction /
 *  close-out) — thrown inside the build transaction so nothing commits. */
class StaleBracketError extends Error {}

/** The bracket-build snapshot lost a race before its guarded phase write. */
class BracketBuildRaceError extends Error {}

/** A dated playoff round would double-book at least one participating team. */
class PlayoffScrimConflictError extends Error {}

const BRACKET_BUILD_RACE_MESSAGE =
  "The season, standings, or playoff bracket changed while it was being built — reload and try again";

const PLAYOFF_SCRIM_CONFLICT_MESSAGE =
  "A playoff team has a booked scrim within four hours of that round's kickoff. Move or cancel the scrim before building the bracket.";

async function assertNoPlayoffScrimConflict(
  tx: Prisma.TransactionClient,
  seasonId: string,
  pairings: Array<{ home: string; away: string }>,
  scheduledAt: Date | null,
): Promise<void> {
  if (!scheduledAt || pairings.length === 0) return;
  if (
    await hasConfirmedScrimConflict(tx, {
      seasonId,
      teamIds: [...new Set(pairings.flatMap((p) => [p.home, p.away]))],
      scheduledAt,
    })
  ) {
    throw new PlayoffScrimConflictError();
  }
}

/**
 * Exactly-once marker for "round N of this season's bracket has been built".
 * Cleared by createPlayoffBracket so Reset playoffs can rebuild from scratch —
 * without that, a reset season could never advance past a round it had already
 * built once.
 */
const playoffRoundKey = (seasonId: string, round: number) =>
  `playoffRoundBuilt:${seasonId}:${round}`;

// Bracket slots are encoded as `R{round}M{match}` e.g. "R0M1".
function parseSlot(slot: string | null): { round: number; match: number } {
  if (!slot) return { round: 0, match: 0 };
  const m = slot.match(/^R(\d+)M(\d+)$/);
  return m
    ? { round: Number(m[1]), match: Number(m[2]) }
    : { round: 0, match: 0 };
}

/**
 * Seed the top teams by regular-season standings into a single-elimination
 * bracket and create the first round of playoff matches. Moves the season to
 * PLAYOFFS. Idempotent-ish: clears any prior bracket first.
 */
/** A cover booking the teardown just deleted — display-ready so the ACTION can
 *  announce the stand-down without a second query. */
export type StandDown = {
  standinName: string;
  discordId: string | null;
  teamId: string;
  homeName: string;
  awayName: string;
  week: number;
};

export type PlayoffBracketClaim = {
  intent: PlayoffCommandIntent;
  expectedSeasonStatus: string;
  expectedRevision: string;
};

type PostseasonRemoval = {
  standDowns: StandDown[];
  removedGameCount: number;
};

/**
 * Remove the current postseason without losing the only durable receipt for
 * imported OpenDota ids. Reset playoffs and Return to regular season share
 * this command so their cascade cleanup cannot drift apart.
 */
async function removePostseason(
  tx: Prisma.TransactionClient,
  seasonId: string,
  matches: { id: string; phase: string; week: number }[],
): Promise<PostseasonRemoval> {
  const postseasonMatches = matches.filter(
    (match) => match.phase !== MATCH_PHASE.REGULAR,
  );
  const archiveKey = playoffGamesArchiveKey(seasonId);
  const [doomedGames, priorRaw, doomedCover] = await Promise.all([
    tx.game.findMany({
      where: {
        match: {
          seasonId,
          phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
        },
      },
      select: {
        dotaMatchId: true,
        match: { select: { bracketSlot: true, week: true } },
      },
    }),
    tx.setting.findUnique({ where: { key: archiveKey } }),
    tx.standinAssignment.findMany({
      where: {
        match: {
          seasonId,
          phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
        },
      },
      select: {
        teamId: true,
        standin: { select: { name: true, discordId: true } },
        match: {
          select: {
            week: true,
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  // Test-only deterministic seam: every recovery/stand-down dependency has
  // been snapshotted, but no teardown write has begun. A child row committed
  // here must make this Serializable transaction lose rather than disappear
  // through the Match cascade without appearing in the snapshot above.
  await raceHook("playoffs.removePostseason.afterSnapshot");

  let prior: ArchivedGame[] = [];
  try {
    const parsed = JSON.parse(priorRaw?.value ?? "[]");
    if (Array.isArray(parsed)) prior = parsed as ArchivedGame[];
  } catch {
    // A corrupt prior receipt must not cost the ids being removed now.
  }
  const merged = [
    ...prior,
    ...doomedGames.map((game) => ({
      dotaMatchId: game.dotaMatchId,
      slot: game.match.bracketSlot,
      week: game.match.week,
    })),
  ];
  const archiveValue = JSON.stringify([
    ...new Map(merged.map((game) => [game.dotaMatchId, game])).values(),
  ]);

  await tx.setting.deleteMany({
    where: { key: { startsWith: `playoffRoundBuilt:${seasonId}:` } },
  });
  await tx.setting.deleteMany({
    where: { key: championAnnouncedKey(seasonId) },
  });
  if (postseasonMatches.length > 0) {
    await tx.setting.deleteMany({
      where: {
        key: {
          in: postseasonMatches.map((match) => resultAnnouncedKey(match.id)),
        },
      },
    });
    const postseasonWeeks = [
      ...new Set(postseasonMatches.map((match) => match.week)),
    ];
    await tx.setting.deleteMany({
      where: {
        OR: postseasonWeeks.map((week) => ({
          key: { startsWith: `${weekReminderKey(seasonId, week)}:` },
        })),
      },
    });
  }
  if (doomedGames.length > 0) {
    await tx.setting.upsert({
      where: { key: archiveKey },
      create: { key: archiveKey, value: archiveValue },
      update: { value: archiveValue },
    });
    // The archive exists specifically so these games can be re-imported onto
    // the rebuilt bracket. Release their cross-mode claims in the same commit
    // that deletes the old playoff fixtures; otherwise the new global registry
    // would turn the recovery receipt into unusable IDs.
    await tx.dotaMatchClaim.deleteMany({
      where: {
        dotaMatchId: {
          in: doomedGames.map((game) => game.dotaMatchId),
        },
        kind: DOTA_MATCH_KIND.LEAGUE,
      },
    });
  }
  await tx.match.deleteMany({
    where: {
      seasonId,
      phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
    },
  });

  return {
    removedGameCount: doomedGames.length,
    standDowns: doomedCover.map((assignment) => ({
      standinName: assignment.standin.name,
      discordId: assignment.standin.discordId,
      teamId: assignment.teamId,
      homeName: assignment.match.homeTeam.name,
      awayName: assignment.match.awayTeam.name,
      week: assignment.match.week,
    })),
  };
}

export async function createPlayoffBracket(
  seasonId: string,
  claim?: PlayoffBracketClaim,
): Promise<{ standDowns: StandDown[]; removedGameCount: number }> {
  // Test seam immediately before the authoritative snapshot. Every input used
  // below is read after this point, so a result, withdrawal, game import or
  // phase change that lands while an admin is looking at a stale page is either
  // included in the new bracket or refused — never silently overwritten.
  await raceHook("playoffs.create.beforeTx");

  try {
    return await prisma.$transaction(
      async (tx) => {
        const season = await tx.season.findUnique({ where: { id: seasonId } });
        if (!season) throw new UserFacingError("No season");
        if (!season.isActive) {
          throw new UserFacingError(
            "Only the active season can start or reset playoffs",
          );
        }

        const teams = await tx.team.findMany({ where: { seasonId } });
        if (
          season.status !== SEASON_STATUS.REGULAR_SEASON &&
          season.status !== SEASON_STATUS.PLAYOFFS &&
          season.status !== SEASON_STATUS.COMPLETE
        ) {
          throw new UserFacingError(
            "Playoffs can only start after the regular season or be reset from Playoffs/Complete",
          );
        }

        const matches = await tx.match.findMany({
          where: { seasonId },
          include: {
            games: { select: { id: true, dotaMatchId: true } },
            availability: { select: { id: true, userId: true, status: true } },
            standins: {
              select: {
                id: true,
                teamId: true,
                standinUserId: true,
                replacingUserId: true,
              },
            },
            predictions: {
              select: { id: true, userId: true, pickedTeamId: true },
            },
            reschedules: {
              select: {
                id: true,
                proposedById: true,
                proposedTime: true,
                status: true,
              },
            },
          },
        });
        const hasPostseason = matches.some(
          (match) => match.phase !== MATCH_PHASE.REGULAR,
        );
        if (claim) {
          if (season.status !== claim.expectedSeasonStatus) {
            throw new UserFacingError(
              "The season phase changed while this playoff control was open — reload and try again",
            );
          }
          const currentRevision = playoffSetupRevision({
            season,
            teams,
            matches,
          });
          if (currentRevision !== claim.expectedRevision) {
            throw new UserFacingError(
              "The standings, playoff bracket, imported games, or playoff activity changed while this control was open — reload before trying again",
            );
          }
          if (claim.intent === "start") {
            if (hasPostseason) {
              throw new UserFacingError(
                "The playoff bracket already exists — reload before using the separate Reset playoffs control",
              );
            }
            if (season.status !== SEASON_STATUS.REGULAR_SEASON) {
              throw new UserFacingError(
                "A new playoff bracket can only start from the Regular season phase",
              );
            }
          } else {
            if (!hasPostseason) {
              throw new UserFacingError(
                "There is no playoff bracket to reset — reload before starting it",
              );
            }
            if (
              season.status !== SEASON_STATUS.PLAYOFFS &&
              season.status !== SEASON_STATUS.COMPLETE
            ) {
              throw new UserFacingError(
                "A playoff bracket can only reset from Playoffs or Complete",
              );
            }
          }
        }
        const playoffField = projectPlayoffField(teams, matches);
        if (playoffField.eligibleTeamIds.length < 2) {
          throw new UserFacingError(
            "Need at least 2 eligible teams for playoffs",
          );
        }

        const regular = regularSeasonStatus(matches);
        if (!regular.allComplete) {
          if (regular.total === 0) {
            throw new UserFacingError(
              "Generate and complete the regular-season schedule before starting playoffs",
            );
          }
          throw new UserFacingError(
            `${regular.pending} regular-season result${regular.pending === 1 ? " is" : "s are"} still outstanding`,
          );
        }

        const pairings = playoffField.pairings;
        const lastRegularWeek = matches
          .filter((match) => match.phase === MATCH_PHASE.REGULAR)
          .reduce((max, match) => Math.max(max, match.week), 0);
        const phase =
          pairings.length === 1 ? MATCH_PHASE.FINAL : MATCH_PHASE.PLAYOFF;
        const bestOf =
          phase === MATCH_PHASE.FINAL
            ? season.finalBestOf
            : season.playoffBestOf;
        const playoffScheduledAt = season.firstMatchNight
          ? upcomingMatchNight(
              season.firstMatchNight,
              lastRegularWeek + 1,
              Date.now(),
            )
          : null;
        // Do this before teardown. The transaction would roll a teardown back
        // on failure, but checking first also keeps the intent explicit: reset
        // never destroys the current bracket merely to discover the replacement
        // round would collide with a confirmed casual booking.
        await assertNoPlayoffScrimConflict(
          tx,
          seasonId,
          pairings,
          playoffScheduledAt,
        );
        // These teardown reads and deletes share this Serializable snapshot
        // with the fresh bracket creation. A late game import or standin claim
        // therefore conflicts instead of disappearing through a cascade.
        const removed = await removePostseason(tx, seasonId, matches);
        await tx.match.createMany({
          data: pairings.map((pairing, index) => ({
            seasonId,
            week: lastRegularWeek + 1,
            phase,
            homeTeamId: pairing.home,
            awayTeamId: pairing.away,
            bracketSlot: `R0M${index}`,
            bestOf,
            scheduledAt: playoffScheduledAt,
          })),
        });
        const phaseClaim = await tx.season.updateMany({
          where: {
            id: seasonId,
            isActive: true,
            status: season.status,
          },
          data: { status: SEASON_STATUS.PLAYOFFS, championTeamId: null },
        });
        if (phaseClaim.count === 0) throw new BracketBuildRaceError();
        const changedAt = new Date().toISOString();
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
          create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value: changedAt },
          update: { value: changedAt },
        });

        return {
          ...removed,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof PlayoffScrimConflictError) {
      throw new UserFacingError(PLAYOFF_SCRIM_CONFLICT_MESSAGE);
    }
    if (
      error instanceof BracketBuildRaceError ||
      (error as { code?: string }).code === "P2034"
    ) {
      throw new UserFacingError(BRACKET_BUILD_RACE_MESSAGE);
    }
    throw error;
  }
}

/**
 * Deliberately tear down the postseason and reopen the existing regular
 * season for result correction. This is the only supported backward phase
 * transition once a bracket exists: a raw status flip would leave stale
 * playoff winners and a champion attached to a mutable table.
 */
export async function returnToRegularSeason(
  seasonId: string,
  claim: Pick<PlayoffBracketClaim, "expectedSeasonStatus" | "expectedRevision">,
): Promise<PostseasonRemoval> {
  await raceHook("playoffs.returnToRegular.beforeTx");
  try {
    return await prisma.$transaction(
      async (tx) => {
        const season = await tx.season.findUnique({ where: { id: seasonId } });
        if (!season?.isActive) {
          throw new UserFacingError(
            "Only the active season can return to the regular season",
          );
        }
        if (
          season.status !== SEASON_STATUS.PLAYOFFS &&
          season.status !== SEASON_STATUS.COMPLETE
        ) {
          throw new UserFacingError(
            "Only a Playoffs or Complete season can return to the regular season",
          );
        }
        const [teams, matches] = await Promise.all([
          tx.team.findMany({ where: { seasonId } }),
          tx.match.findMany({
            where: { seasonId },
            include: {
              games: { select: { id: true, dotaMatchId: true } },
              availability: {
                select: { id: true, userId: true, status: true },
              },
              standins: {
                select: {
                  id: true,
                  teamId: true,
                  standinUserId: true,
                  replacingUserId: true,
                },
              },
              predictions: {
                select: { id: true, userId: true, pickedTeamId: true },
              },
              reschedules: {
                select: {
                  id: true,
                  proposedById: true,
                  proposedTime: true,
                  status: true,
                },
              },
            },
          }),
        ]);
        if (season.status !== claim.expectedSeasonStatus) {
          throw new UserFacingError(
            "The season phase changed while this recovery control was open — reload and try again",
          );
        }
        if (
          playoffSetupRevision({ season, teams, matches }) !==
          claim.expectedRevision
        ) {
          throw new UserFacingError(
            "The standings, playoff bracket, imported games, or playoff activity changed while this recovery control was open — reload before trying again",
          );
        }
        if (!matches.some((match) => match.phase !== MATCH_PHASE.REGULAR)) {
          throw new UserFacingError("There is no playoff bracket to remove");
        }

        const removed = await removePostseason(tx, seasonId, matches);
        const moved = await tx.season.updateMany({
          where: {
            id: seasonId,
            isActive: true,
            status: season.status,
          },
          data: {
            status: SEASON_STATUS.REGULAR_SEASON,
            championTeamId: null,
          },
        });
        if (moved.count !== 1) throw new BracketBuildRaceError();
        const changedAt = new Date().toISOString();
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
          create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value: changedAt },
          update: { value: changedAt },
        });
        return removed;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof BracketBuildRaceError ||
      (error as { code?: string }).code === "P2034"
    ) {
      throw new UserFacingError(BRACKET_BUILD_RACE_MESSAGE);
    }
    throw error;
  }
}

/**
 * After a playoff result is entered, advance the bracket: if the current
 * (latest) round is fully decided, either create the next round from its
 * winners or — if that round was the final — crown the champion and complete
 * the season. Safe to call after every result; no-ops until a round finishes.
 */
/**
 * Crown the champion in Discord exactly once, RETRYABLY.
 *
 * Unlike a series result this has exactly one natural trigger, ever:
 * advancePlayoffBracket early-returns unless the season is PLAYOFFS, and the
 * crowning claim has just set it COMPLETE — so nothing ever calls the path
 * again and a single failed send ate the message of the season permanently.
 * Same marker/`failed:` contract as announceSeriesResultOnce, so
 * retryFailedAnnouncements re-claims it.
 */
export async function announceChampionOnce(seasonId: string): Promise<boolean> {
  // No webhook ⇒ never burn the once-only marker (the announceSeriesResultOnce
  // rule: a league that wires Discord up later must still get its champion).
  if (!(await getWebhookUrl())) return false;
  const marker = championAnnouncedKey(seasonId);
  const claim = await claimAnnouncementMarker(marker);
  if (!claim) return false;
  const [season, matches] = await Promise.all([
    prisma.season.findUnique({
      where: { id: seasonId },
      select: { name: true, status: true, championTeamId: true },
    }),
    prisma.match.findMany({
      where: { seasonId },
      select: {
        id: true,
        phase: true,
        bracketSlot: true,
        status: true,
        winnerTeamId: true,
        homeTeamId: true,
        awayTeamId: true,
      },
    }),
  ]);
  const presentedChampionTeamId = season
    ? resolveChampionPresentation(season, matches).championTeamId
    : null;
  const champion = presentedChampionTeamId
    ? await prisma.team.findFirst({
        where: { id: presentedChampionTeamId, seasonId },
        select: { name: true },
      })
    : null;
  // Un-crowned since (Reset playoffs) or the season is gone: there is nothing
  // to announce and never will be for THIS crowning. Drop the marker rather
  // than stamping `failed:`, which would make the sweep retry it forever and
  // starve real failures out of its take-window — the orphan lesson already
  // learned in retryFailedAnnouncements.
  if (!season || !champion) {
    await releaseAnnouncementClaim(claim);
    return false;
  }
  const sent = await sendDiscordMessage(
    championMessage(season.name, champion.name, seasonId),
    undefined,
    {
      dedupeKey: announcementDedupeKey("champion", claim),
      marker: { key: claim.key, eventId: claim.eventId },
    },
  );
  if (!sent) {
    await markAnnouncementFailed(claim);
    return false;
  }
  return markAnnouncementSent(claim);
}

/** Returns true only when this caller committed a new round or champion. */
export async function advancePlayoffBracket(
  seasonId: string,
): Promise<boolean> {
  const season = await prisma.season.findUnique({ where: { id: seasonId } });
  if (!season?.isActive || season.status !== SEASON_STATUS.PLAYOFFS)
    return false;

  const playoff = await prisma.match.findMany({
    where: {
      seasonId,
      phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
    },
  });
  if (playoff.length === 0) return false;

  const maxRound = Math.max(
    ...playoff.map((m) => parseSlot(m.bracketSlot).round),
  );
  const current = playoff
    .filter((m) => parseSlot(m.bracketSlot).round === maxRound)
    .sort(
      (a, b) => parseSlot(a.bracketSlot).match - parseSlot(b.bracketSlot).match,
    );

  const allDecided = current.every(
    (m) => m.status === MATCH_STATUS.COMPLETED && m.winnerTeamId,
  );
  if (!allDecided) return false;

  // A sole latest row is a crown only when bracket construction explicitly
  // labelled it FINAL. Treating any lone PLAYOFF as a final let the writer
  // create a COMPLETE state every public reader immediately rejected.
  if (current.length === 1 && current[0]?.phase !== MATCH_PHASE.FINAL) {
    return false;
  }

  if (current.length === 1) {
    // The final is decided — crown the champion. Everything above is a cheap
    // preflight; the transaction below re-proves that this exact final is still
    // the sole latest round, is still completed, and still names the same
    // winner. A remove/reopen/correction changes the Match row, while crowning
    // changes the Season row, so a season-only CAS cannot detect that race.
    await raceHook("playoffs.advance.beforeCrown");
    const expectedFinal = current[0];
    let championTeamId: string | null = null;
    try {
      championTeamId = await prisma.$transaction(
        async (tx) => {
          const [seasonNow, playoffNow] = await Promise.all([
            tx.season.findUnique({
              where: { id: seasonId },
              select: { isActive: true, status: true },
            }),
            tx.match.findMany({
              where: {
                seasonId,
                phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
              },
              select: {
                id: true,
                phase: true,
                bracketSlot: true,
                status: true,
                winnerTeamId: true,
                homeTeamId: true,
                awayTeamId: true,
              },
            }),
          ]);
          if (
            !seasonNow?.isActive ||
            seasonNow.status !== SEASON_STATUS.PLAYOFFS
          )
            return null;

          const latestRound = Math.max(
            ...playoffNow.map((match) => parseSlot(match.bracketSlot).round),
          );
          const latest = playoffNow.filter(
            (match) => parseSlot(match.bracketSlot).round === latestRound,
          );
          const finalNow = latest.length === 1 ? latest[0] : null;
          const winnerStillValid =
            finalNow?.id === expectedFinal.id &&
            finalNow.phase === MATCH_PHASE.FINAL &&
            finalNow.status === MATCH_STATUS.COMPLETED &&
            finalNow.winnerTeamId === expectedFinal.winnerTeamId &&
            (finalNow.winnerTeamId === finalNow.homeTeamId ||
              finalNow.winnerTeamId === finalNow.awayTeamId);
          if (!winnerStillValid) return null;

          const crowned = await tx.season.updateMany({
            where: {
              id: seasonId,
              isActive: true,
              status: SEASON_STATUS.PLAYOFFS,
            },
            data: {
              championTeamId: finalNow.winnerTeamId,
              status: SEASON_STATUS.COMPLETE,
            },
          });
          if (crowned.count !== 1) return null;
          // The league is over: unstarted practice offers should not remain
          // actionable in the archive. Preserve LIVE scrims so an in-progress
          // series can still record its remaining games.
          await tx.scrim.updateMany({
            where: {
              seasonId,
              status: { in: [SCRIM_STATUS.OPEN, SCRIM_STATUS.SCHEDULED] },
            },
            data: { status: SCRIM_STATUS.CANCELLED },
          });
          const changedAt = new Date().toISOString();
          await tx.setting.upsert({
            where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
            create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value: changedAt },
            update: { value: changedAt },
          });
          return finalNow.winnerTeamId;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      // A concurrent correction/crown/reset won the Serializable ordering. Its
      // own caller either advances the fresh state or leaves it for the next
      // idempotent sync pass; this stale caller must not surface a false error.
      if ((error as { code?: string }).code !== "P2034") throw error;
      return false;
    }
    if (!championTeamId) return false;
    // Best-effort AND retryable: the `crowned` claim above is still the
    // single-winner gate; the marker only adds a way back from a Discord blip.
    // The database crown is already committed, so even an unexpected marker or
    // transport exception must not erase this caller's truthful mutation signal.
    try {
      await announceChampionOnce(seasonId);
    } catch {
      // The crown is already durable. Log only a stable code: transport and
      // database exceptions can embed webhook URLs or player-controlled text,
      // while the persisted automation/outbox state is the operator detail.
      console.error("[playoffs] CHAMPION_ANNOUNCEMENT_FAILED");
    }
    return true;
  }

  const winners = current.map((m) => m.winnerTeamId as string);
  const pairings = nextRoundPairings(winners);
  const nextRound = maxRound + 1;
  const phase = pairings.length === 1 ? MATCH_PHASE.FINAL : MATCH_PHASE.PLAYOFF;

  // Two imports can decide the round's last two series near-simultaneously —
  // both reach here with allDecided true.
  //
  // A findFirst-then-createMany inside a transaction does NOT make that safe,
  // whatever the old comment here claimed: a read matching ZERO rows takes no
  // predicate lock, so on Postgres READ COMMITTED each caller is blind to the
  // other's uncommitted insert and BOTH build the round. Nothing else stops
  // them — Match has no unique constraint on bracketSlot. The damage is worst
  // at the final: two R{n}M0 rows make `current.length === 2`, so the
  // `current.length === 1` crowning branch above becomes unreachable and the
  // season NEVER gets a champion.
  //
  // The fix is the atomic Setting-row CREATE this codebase already uses for
  // exactly-once work (`weekReminder:`, `honorsAnnounced:`, `resultAnnounced:`).
  // It lives in the SAME transaction as the createMany, so a failed insert
  // rolls the marker back too, and P2002 — the only way a second caller can
  // lose — is caught OUTSIDE the callback, because a query error poisons a
  // Postgres transaction and the commit would fail if we swallowed it inside.
  const exists = await prisma.match.findFirst({
    where: { seasonId, bracketSlot: { startsWith: `R${nextRound}M` } },
    select: { id: true },
  });
  if (exists) return false; // cheap fast path; the claim below is the real guard
  await raceHook("playoffs.advance.beforeBuild");
  try {
    await prisma.$transaction(
      async (tx) => {
        // Re-assert the build's INPUTS inside the transaction — everything
        // above was read at default isolation, several round trips ago. The
        // rival that made this real is Reset playoffs: its teardown deletes
        // the round markers FIRST, so a stale advance's marker create
        // SUCCEEDS and it would pair pre-reset winners into the brand-new
        // bracket — a phantom R{n} that is never COMPLETED, which makes
        // maxRound point at it forever: the rebuilt bracket can finish but
        // never advance, no champion, and the only repair is ANOTHER reset.
        // Re-reading the current round catches it (the reset deleted those
        // match rows); re-reading the winners catches a removeGame /
        // recordResult correction landing mid-build; re-reading Season catches
        // both a close-out phase flip and an explicit unfinished-season
        // cancellation racing the import (a round must not be built into a
        // COMPLETE or inactive season).
        const [seasonNow, currentNow] = await Promise.all([
          tx.season.findUnique({
            where: { id: seasonId },
            select: {
              isActive: true,
              status: true,
              playoffBestOf: true,
              finalBestOf: true,
              firstMatchNight: true,
            },
          }),
          tx.match.findMany({
            where: { id: { in: current.map((m) => m.id) } },
            select: {
              id: true,
              week: true,
              status: true,
              winnerTeamId: true,
            },
          }),
        ]);
        if (
          !seasonNow?.isActive ||
          seasonNow.status !== SEASON_STATUS.PLAYOFFS
        ) {
          throw new StaleBracketError();
        }
        const winnerById = new Map(current.map((m) => [m.id, m.winnerTeamId]));
        const inputsHold =
          currentNow.length === current.length &&
          currentNow.every(
            (m) =>
              m.status === MATCH_STATUS.COMPLETED &&
              m.winnerTeamId &&
              m.winnerTeamId === winnerById.get(m.id),
          );
        if (!inputsHold) throw new StaleBracketError();
        await tx.setting.create({
          data: {
            key: playoffRoundKey(seasonId, nextRound),
            value: new Date().toISOString(),
          },
        });
        const week = Math.max(...currentNow.map((match) => match.week)) + 1;
        const bestOf =
          phase === MATCH_PHASE.FINAL
            ? seasonNow.finalBestOf
            : seasonNow.playoffBestOf;
        const scheduledAt = seasonNow.firstMatchNight
          ? upcomingMatchNight(seasonNow.firstMatchNight, week, Date.now())
          : null;
        // Leave the build marker unclaimed while a casual booking blocks this
        // round. Reconciliation can retry the same winners after that scrim is
        // completed or cancelled; no result needs to be replayed.
        await assertNoPlayoffScrimConflict(
          tx,
          seasonId,
          pairings,
          scheduledAt,
        );
        await tx.match.createMany({
          data: pairings.map((p, i) => ({
            seasonId,
            week,
            phase,
            homeTeamId: p.home,
            awayTeamId: p.away,
            bracketSlot: `R${nextRound}M${i}`,
            bestOf,
            // Same guard as the first round: a round created after its arithmetic
            // date has passed must roll forward, not be born already stale.
            scheduledAt,
          })),
        });
        const changedAt = new Date().toISOString();
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
          create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value: changedAt },
          update: { value: changedAt },
        });
      },
      // Serializable so the reset (also Serializable, touching the same
      // marker/match/season rows) and this build are guaranteed to serialize —
      // one of them aborts with P2034 instead of interleaving.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return true;
  } catch (e) {
    // Someone else is building (or already built) this exact round.
    if ((e as { code?: string }).code === "P2002") return false;
    // SSI loser — a rival build or a reset serialized ahead of us.
    if ((e as { code?: string }).code === "P2034") return false;
    // The bracket we computed from no longer exists as we read it.
    if (e instanceof StaleBracketError) return false;
    // A confirmed scrim owns this time for now. Do not turn a successfully
    // recorded series result into a failed request; the scheduled reconciler
    // calls this idempotent advance again after the conflict is cleared.
    if (e instanceof PlayoffScrimConflictError) return false;
    throw e;
  }
}
