import { captainNameRun } from "./captain-mmr";
import { DRAFT_STATUS, SEASON_STATUS, type SeasonStatus } from "./constants";
import { MISSING_LEAGUE_TICKET_WARNING } from "./match-hosting";

/**
 * "What do I do next?" for the admin panel.
 *
 * The panel had exactly ONE next-step banner — draft-complete → Regular season —
 * added because that transition is silent and everything it gates (auto result
 * sync, result reporting, the weekly Discord reminder, the Leaders nav) fails
 * QUIETLY when it is missed. The schedule comes first: the Regular season
 * waits for fixtures, so that step names both, in order. But that is not the only silent
 * transition, it is just the first one anyone got burned by:
 *
 * - A generated schedule with no kickoff times disables auto-sync, week
 *   reminders and pick'em locks for the whole season, and says so only in a
 *   toast that has long since gone.
 * - Nothing whatsoever prompts "start the playoffs" once the last regular
 *   result lands, or "record the final" when the bracket is one match from a
 *   champion.
 * - COMPLETE was a dead end: the control that starts next season sat inside a
 *   collapsed <details> at the bottom of the page. It now leads the page.
 * - A season parked in COMPLETE with an unfinished bracket will never crown
 *   anyone, and every playoff result saves with a success toast regardless.
 *
 * Pure and tested so the wording of each step is checkable without rendering a
 * 3,200-line page. The panel renders exactly what this returns, directly under
 * its title: the line used to sit inside the phase card, some 7,000px down a
 * phone mid-season, so the page's own answer to "what now?" was the last thing
 * an admin reached.
 */
export type AdminPhaseInput = {
  seasonStatus: string;
  /** null when the season has no Draft row at all (never started one). */
  draftStatus: string | null;
  playerCount: number;
  /** Signups needed before the draft can run (capacityInfo.minPlayers). */
  minPlayers: number;
  teamCount: number;
  regularMatchCount: number;
  /**
   * Unplayed regular fixtures (not live) with no kickoff time. Each one gets
   * no check-in, reminder, automatic result import or pick'em lock, so the
   * warning stays up until the last one has a time, not just the first.
   */
  untimedRegularCount: number;
  /** Every unplayed regular fixture, future ones included. */
  pendingRegularResults: number;
  /**
   * Unplayed regular fixtures that are live or past kickoff: the results
   * actually due. Optional; without it every unplayed fixture counts.
   */
  outstandingRegularResults?: number;
  /** The next regular kickoff, already written on the league's clock. */
  nextKickoff?: { week: number; label: string } | null;
  pendingTiebreakerResults?: number;
  /** Already-created tiebreaker fixtures, including completed games. */
  existingTiebreakerCount?: number;
  /** Unresolved ties that still affect playoff qualification or seed order. */
  unresolvedPlayoffTieCount?: number;
  playoffMatchCount: number;
  unfinishedPlayoffCount: number;
  hasChampion: boolean;
  /**
   * ACTIVE player signups whose user never linked Discord. Optional and
   * DB-derived on purpose — this banner renders on the panel's blocking path,
   * so it can never afford a Discord API call; the full in-server funnel
   * lives on the streamed Discord reach card. Linking is the step the
   * league can see for free, and it is also the step that makes the one-click
   * auto-join happen.
   */
  unlinkedDiscordCount?: number;
  /**
   * Captains whose MMR will weight their Start budget without a medal backing
   * it (`unverifiedCaptainMmrs`, captain-mmr.ts). Optional and DB-derived for
   * the same blocking-path reason as the Discord count; empty when the MMR
   * weighting is off, since flat budgets have nothing to verify.
   */
  unverifiedCaptainMmrNames?: readonly string[];
  /**
   * Whether the season has a Valve league ticket (Season.dotaLeagueId).
   * Optional: only an explicit `false` raises the ticket warning, so a caller
   * that doesn't know says nothing rather than crying wolf.
   */
  hasLeagueTicket?: boolean;
};

/** Where the step's control lives: an in-page card anchor or a page. */
export type NextStepJump = { href: string; label: string };

export type AdminNextStep = {
  /** Imperative headline — the one thing to do now. */
  title: string;
  /** What it unlocks, or what stays broken until it happens. */
  detail: string;
  tone: "action" | "waiting" | "warning" | "done";
  /**
   * The card that holds the control the step names. The line renders at the
   * top of the page, away from every control, so it carries the way there.
   * Each `#adm-` anchor must also be in the page's jump bar, which is what
   * opens a folded section on arrival (the admin copy guard checks both).
   */
  jump?: NextStepJump;
  /**
   * Set while the season has no league ticket and is still running. Its own
   * field rather than part of `detail` because it is a standing condition, not
   * this phase's step: it has to show from the first signup (Valve needs about
   * 15 days) through the start of the season, whatever the step is.
   */
  ticketWarning?: string;
};

/**
 * The pre-draft Discord chase line, appended to every "Next step: Start
 * draft" variant — the last cheap moment to get players linked is before the
 * draft locks them onto rosters, and that transition is otherwise silent.
 */
function discordChaseNote(i: AdminPhaseInput): string {
  const unlinked = i.unlinkedDiscordCount ?? 0;
  if (unlinked === 0) return "";
  return ` Also: ${unlinked} signed-up player${unlinked === 1 ? " hasn't" : "s haven't"} linked Discord — chase that before draft night so captains can reach their rosters (the Discord reach card names them).`;
}

/**
 * The pre-draft captain MMR line, on the same two "Next step: Start draft"
 * variants as the Discord note: Start is where captain MMR turns into budget
 * money, so this is the moment it is still free to check. Warn-and-name only;
 * Start stays available.
 */
function captainMmrNote(i: AdminPhaseInput): string {
  const names = i.unverifiedCaptainMmrNames ?? [];
  if (names.length === 0) return "";
  return ` Also: ${captainNameRun(names)} ${names.length === 1 ? "has" : "have"} unverified MMR that sets draft budgets. Check ${names.length === 1 ? "it" : "each"} with Edit medal & MMR on the Captains & draft card first; a medal that matches the MMR marks it verified.`;
}

const JUMP = {
  captains: { href: "#adm-captains", label: "Go to Captains & draft" },
  draftRoom: { href: "/draft", label: "Open the draft room" },
  schedule: { href: "#adm-schedule", label: "Go to Schedule & results" },
  phase: { href: "#adm-season", label: "Go to phase control" },
  playoffs: { href: "#adm-playoffs", label: "Go to Playoffs" },
  tiebreakers: { href: "#adm-tiebreakers", label: "Go to Tiebreakers" },
} as const satisfies Record<string, NextStepJump>;

/** The phase card's forward button into the Regular season. The draft room
 * offers the same move under the same name once the auction is finished. */
export const START_REGULAR_SEASON = "Start the Regular season";

export type PhaseAdvance = {
  target: SeasonStatus;
  /** What the button does, not the phase it lands in. */
  label: string;
  /** One line under the button. */
  hint: string;
};

/**
 * The phase card's one forward button, named by what it does. Only two
 * forward moves are plain phase changes. The others belong to commands that
 * change related data in the same step (Start draft runs the auction, Start
 * playoffs seeds the bracket, the grand final crowns the champion), so those
 * buttons live in their own cards and this returns null.
 *
 * The phase card used to show five buttons named after phases. "Draft" read
 * as "run the draft" but only closed signups, and "Regular season" gave no
 * hint that it switched on sync, reminders and a Discord post.
 */
export function phaseAdvance(seasonStatus: string): PhaseAdvance | null {
  if (seasonStatus === SEASON_STATUS.SIGNUPS) {
    return {
      target: SEASON_STATUS.DRAFT,
      label: "Close signups",
      hint: "Opens the draft room for players to wait in, without starting the auction. Start draft closes signups too, so you only need this to open the room early.",
    };
  }
  if (seasonStatus === SEASON_STATUS.DRAFT) {
    return {
      target: SEASON_STATUS.REGULAR_SEASON,
      label: START_REGULAR_SEASON,
      hint: "Turns on automatic result sync, result reporting and the weekly Discord reminder, and posts week 1's fixtures to Discord.",
    };
  }
  return null;
}

/** Phases in which a missing league ticket still costs results. */
const TICKET_PHASES: ReadonlySet<string> = new Set([
  SEASON_STATUS.SIGNUPS,
  SEASON_STATUS.DRAFT,
  SEASON_STATUS.REGULAR_SEASON,
  SEASON_STATUS.PLAYOFFS,
]);

function resultCount(n: number): string {
  return `${n} result${n === 1 ? "" : "s"}`;
}

/**
 * Fixtures with no kickoff: the step names how many are left, and still
 * mentions results that are due, since this step outranks that one.
 */
function untimedStep(count: number, outstanding = 0): AdminNextStep {
  const fixtures = count === 1 ? "1 fixture still has" : `${count} fixtures still have`;
  const due =
    outstanding > 0
      ? ` Also: ${resultCount(outstanding)} past kickoff ${outstanding === 1 ? "is" : "are"} still missing.`
      : "";
  return {
    title: "Next step: give every fixture a kickoff time.",
    detail: `${fixtures} no kickoff time, so ${count === 1 ? "it gets" : "they get"} no check-in, no weekly Discord reminder, no automatic result import and no pick'em lock. Set each week's time with “Move a match night”, or, before any result is in, regenerate the schedule with a first match night.${due}`,
    tone: "warning",
    jump: JUMP.schedule,
  };
}

export function adminNextStep(i: AdminPhaseInput): AdminNextStep {
  const step = phaseStep(i);
  return i.hasLeagueTicket === false && TICKET_PHASES.has(i.seasonStatus)
    ? { ...step, ticketWarning: MISSING_LEAGUE_TICKET_WARNING }
    : step;
}

function phaseStep(i: AdminPhaseInput): AdminNextStep {
  const {
    seasonStatus,
    draftStatus,
    playerCount,
    minPlayers,
    teamCount,
    regularMatchCount,
    untimedRegularCount,
    pendingRegularResults,
    outstandingRegularResults = pendingRegularResults,
    nextKickoff = null,
    pendingTiebreakerResults = 0,
    existingTiebreakerCount = 0,
    unresolvedPlayoffTieCount = 0,
    playoffMatchCount,
    unfinishedPlayoffCount,
    hasChampion,
  } = i;

  if (seasonStatus === SEASON_STATUS.SIGNUPS) {
    if (playerCount < minPlayers) {
      return {
        title: `Waiting on signups — ${minPlayers - playerCount} more to go.`,
        detail: `${playerCount} of ${minPlayers} players registered. Share the signup link; you can designate captains at any time.`,
        tone: "waiting",
      };
    }
    if (teamCount < 2) {
      return {
        title: "Next step: designate captains.",
        detail:
          "Enough players have signed up. Use “make captain” in the Eligible players list on the Captains & draft card. Each captain becomes a team.",
        tone: "action",
        jump: JUMP.captains,
      };
    }
    return {
      title: "Next step: Start draft.",
      detail:
        `${teamCount} captain(s) ready. Set the draft night and randomize the order first if you want to — starting the auction locks captain changes until it finishes (Abort draft is the way back).` +
        captainMmrNote(i) +
        discordChaseNote(i),
      tone: "action",
      jump: JUMP.captains,
    };
  }

  if (seasonStatus === SEASON_STATUS.DRAFT) {
    if (draftStatus === DRAFT_STATUS.IN_PROGRESS) {
      return {
        title: "The auction is live.",
        detail:
          "Open the draft room to follow it. Pause parks the clocks if a dispute needs settling; Undo last sale reverts the most recent purchase.",
        tone: "waiting",
        jump: JUMP.draftRoom,
      };
    }
    if (draftStatus === DRAFT_STATUS.PAUSED) {
      return {
        title: "The auction is PAUSED — nothing can sell.",
        detail:
          "Clocks are parked and every captain is waiting. Press Resume on the Captains & draft card when the dispute is settled.",
        tone: "warning",
        jump: JUMP.captains,
      };
    }
    if (draftStatus === DRAFT_STATUS.COMPLETE) {
      // Two steps in a fixed order: the Regular season refuses to start
      // without fixtures, and its Discord post lists week 1.
      if (regularMatchCount === 0) {
        return {
          title:
            "Next step: generate the schedule (with a first match night), then start the Regular season.",
          detail: `The auction is finished. Generate the round robin in Schedule & results; players can check in as soon as fixtures have match nights. Then use “${START_REGULAR_SEASON}” in phase control: it switches on automatic result sync and the weekly Discord reminder and posts week 1's fixtures to Discord.`,
          tone: "action",
          jump: JUMP.schedule,
        };
      }
      if (untimedRegularCount > 0) return untimedStep(untimedRegularCount);
      return {
        title: "Next step: start the Regular season.",
        detail: `The schedule is ready. Until you press “${START_REGULAR_SEASON}” in phase control, automatic result sync, the weekly Discord reminder and result reporting stay off, and Discord hasn't been told the season has started.`,
        tone: "action",
        jump: JUMP.phase,
      };
    }
    return {
      title: "Next step: Start draft.",
      detail:
        "The season is in the Draft phase but the auction hasn't been started yet — nothing happens until you press Start draft." +
        // Same notes as the SIGNUPS start-draft step: the auction hasn't run,
        // so checking captain MMR and chasing joins is exactly as cheap here —
        // dropping them just because the admin clicked the phase button early
        // would be arbitrary.
        captainMmrNote(i) +
        discordChaseNote(i),
      tone: "action",
      jump: JUMP.captains,
    };
  }

  if (seasonStatus === SEASON_STATUS.REGULAR_SEASON) {
    if (regularMatchCount === 0) {
      return {
        title: "Next step: generate the schedule.",
        detail:
          "There are no fixtures yet, so there is nothing for players to check in to and nothing for results to attach to.",
        tone: "action",
        jump: JUMP.schedule,
      };
    }
    if (untimedRegularCount > 0) {
      return untimedStep(untimedRegularCount, outstandingRegularResults);
    }
    // Outstanding means past kickoff: a fixture weeks away is still to play,
    // and calling it a missing result read as "enter scores for games nobody
    // has played" and buried the ones that are really missing.
    if (outstandingRegularResults > 0) {
      return {
        title: `Season running: ${resultCount(outstandingRegularResults)} outstanding.`,
        detail:
          "These fixtures are live or past kickoff. Results import themselves from OpenDota; enter any that can't be found by hand in Schedule & results.",
        tone: "waiting",
        jump: JUMP.schedule,
      };
    }
    if (pendingRegularResults > 0) {
      const toPlay = `${pendingRegularResults} fixture${pendingRegularResults === 1 ? "" : "s"} still to play.`;
      return {
        title: nextKickoff
          ? `Season running. Week ${nextKickoff.week} kicks off ${nextKickoff.label}.`
          : "Season running.",
        detail: `${toPlay} Nothing to enter before kickoff: results import themselves from OpenDota after each match.`,
        tone: "waiting",
        jump: JUMP.schedule,
      };
    }
    if (pendingTiebreakerResults > 0) {
      return {
        title: "Tiebreaker bracket in progress.",
        detail:
          "Enter the current game in Tiebreakers. For three-team ties, each confirmed result creates the next required game automatically. Keep the season in Regular season until every required tie is resolved.",
        tone: "waiting",
        jump: JUMP.tiebreakers,
      };
    }
    if (unresolvedPlayoffTieCount > 0) {
      if (existingTiebreakerCount > 0) {
        return {
          title: "Next step: continue the tiebreaker bracket.",
          detail:
            "Review Tiebreakers, then use “Create next tiebreaker match” in the Playoffs controls, or schedule the next round if one is required. Keep the season in Regular season until every required tie is resolved.",
          tone: "action",
          jump: JUMP.playoffs,
        };
      }
      return {
        title: "Next step: schedule a tiebreaker week.",
        detail:
          "Teams remain tied for playoff qualification or seeding. Schedule the tiebreaker week before starting the playoffs.",
        tone: "action",
        jump: JUMP.playoffs,
      };
    }
    return {
      title: "Next step: Start playoffs.",
      detail:
        "Every regular-season result is in. Starting the playoffs seeds the bracket from the standings and moves the season to the Playoffs phase.",
      tone: "action",
      jump: JUMP.playoffs,
    };
  }

  if (seasonStatus === SEASON_STATUS.PLAYOFFS) {
    if (playoffMatchCount === 0) {
      return {
        title: "Next step: seed the bracket.",
        detail:
          "The season is in the Playoffs phase but no bracket exists. Move it back to Regular season with “Fix the phase” in phase control, verify the final standings, then use Start playoffs to seed the bracket and enter Playoffs atomically.",
        tone: "warning",
        jump: JUMP.phase,
      };
    }
    if (unfinishedPlayoffCount > 0) {
      return {
        title: `Playoffs underway — ${unfinishedPlayoffCount} bracket match(es) left.`,
        detail:
          "Results import themselves; enter any that can't be found in the Playoffs card. Each result advances the bracket, and the final crowns the champion and completes the season. Keep the season in Playoffs until then.",
        tone: "waiting",
        jump: JUMP.playoffs,
      };
    }
    return {
      title: "The bracket is finished but no champion is recorded.",
      detail:
        "Result sync normally reconciles this automatically. Reload once; if it remains, inspect the grand final in the Playoffs card and correct or reopen that result without resetting earlier rounds.",
      tone: "warning",
      jump: JUMP.playoffs,
    };
  }

  if (seasonStatus === SEASON_STATUS.COMPLETE) {
    if (!hasChampion) {
      return {
        title: "Complete is missing its champion.",
        detail:
          playoffMatchCount === 0
            ? "No postseason fixtures exist. Move the season to Regular season with “Fix the phase” in phase control, verify the final standings, then use Start playoffs to seed a bracket; a raw phase change cannot safely invent one."
            : unfinishedPlayoffCount > 0
              ? "This is a legacy close-out state. Move the season back to Playoffs with “Fix the phase” in phase control and finish the remaining bracket; new phase controls no longer create Complete without a champion."
              : "This is a recovery state, not a finished season. Move back to Playoffs with “Fix the phase” in phase control and inspect the grand final so result reconciliation can crown the authoritative winner.",
        tone: "warning",
        jump: JUMP.phase,
      };
    }
    return {
      title: "Season complete. Open the next season when you're ready.",
      detail:
        "Use “Season handoff” at the top of this page. Until then the league stays in Complete, with the champion and bracket on the home page, and inhouse keeps running. The finished season's results, rosters and champion stay under Season history after the handoff.",
      tone: "done",
    };
  }

  return {
    title: "Season in progress.",
    detail: "",
    tone: "waiting",
  };
}
