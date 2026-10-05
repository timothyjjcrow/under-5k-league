// The reschedule ready check, pure: what a proposal offers, how each option
// stands, when an option locks in on its own, who may lock one in early, and
// which times to suggest. The service (reschedule-service.ts) stores and
// claims; the loader (reschedule-ready-check-service.ts) reads; this file
// decides, so the card, the home strip and the write path can't disagree.
//
// The flow: a captain offers up to three times. Everyone playing the match
// (loadSidePlayerIds: the roster minus covered seats, plus standins) and both
// captains answer each time ✓ or ✗. An option locks in by itself the moment
// both captains and a full lineup on each side are in. Before that, either
// captain may lock in an option the other captain has said yes to: one flaky
// player must never be able to hold a match hostage.

import { dateAtWallTime, wallTime, zoneFormatter } from "./zoned-time";

/** Most times one proposal may offer. */
export const MAX_RESCHEDULE_OPTIONS = 3;
/** Longest note a proposer may attach. */
export const RESCHEDULE_NOTE_MAX = 140;
/** How far ahead of now a suggested time must be. */
export const SUGGESTION_MIN_LEAD_MS = 2 * 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type ReadyAnswer = "ready" | "out" | null;

/**
 * A request's options, ascending. `options` is null on a proposal made before
 * the ready check, which offers its proposedTime alone; garbage degrades the
 * same way rather than throwing, so one bad row can't take a page down.
 */
export function parseRescheduleOptions(
  options: string | null,
  proposedTime: Date,
): number[] {
  const fallback = [proposedTime.getTime()];
  if (options == null) return fallback;
  let raw: unknown;
  try {
    raw = JSON.parse(options);
  } catch {
    return fallback;
  }
  if (!Array.isArray(raw)) return fallback;
  const times = [
    ...new Set(
      raw.filter(
        (t): t is number => typeof t === "number" && Number.isFinite(t),
      ),
    ),
  ].sort((a, b) => a - b);
  return times.length ? times : fallback;
}

/** The stored form of a proposal's options (parseRescheduleOptions reads it). */
export function serializeRescheduleOptions(times: number[]): string {
  return JSON.stringify(times);
}

/**
 * A proposer's picks as the options to store: unique and ascending. Refuses
 * (never trims) an empty or oversized list, so what was offered is exactly
 * what was picked.
 */
export function normalizeRescheduleOptions(
  times: number[],
): { times: number[] } | { error: string } {
  const valid = times.filter((t) => Number.isFinite(t));
  if (valid.length !== times.length)
    return { error: "Choose a valid proposed time" };
  const unique = [...new Set(valid)].sort((a, b) => a - b);
  if (unique.length === 0) return { error: "Pick at least one time" };
  if (unique.length > MAX_RESCHEDULE_OPTIONS)
    return {
      error: `Offer at most ${MAX_RESCHEDULE_OPTIONS} times — pick the ones that work best`,
    };
  return { times: unique };
}

/**
 * The proposer's note, trimmed, or null when blank. Too long is refused with
 * the limit, never cut: we don't rewrite what someone typed.
 */
export function normalizeRescheduleNote(
  raw: string | null | undefined,
): { note: string | null } | { error: string } {
  const note = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!note) return { note: null };
  if (note.length > RESCHEDULE_NOTE_MAX)
    return {
      error: `Keep the note under ${RESCHEDULE_NOTE_MAX} characters (it has ${note.length})`,
    };
  return { note };
}

export type ReadySide = {
  teamId: string;
  captainId: string;
  /** Who plays for this side tonight, in roster order (loadSidePlayerIds). */
  seatIds: string[];
};

export type ReadyVote = { userId: string; timeMs: number; ready: boolean };

export type SideTally = {
  teamId: string;
  ready: number;
  out: number;
  pending: number;
  /** Players this side needs ready: a full lineup, or every seat when short. */
  need: number;
  /** At least `need` ready (and the side has anyone at all). */
  full: boolean;
  /** Each seat's answer, in seat order. */
  answers: { userId: string; answer: ReadyAnswer }[];
};

export type OptionTally = {
  timeMs: number;
  home: SideTally;
  away: SideTally;
  captains: { home: ReadyAnswer; away: ReadyAnswer };
  /** Both captains said yes to this time. */
  captainsAgree: boolean;
  /** Both captains and a full lineup on each side: the option locks in. */
  everyoneIn: boolean;
  readyTotal: number;
  seatTotal: number;
};

function answerOf(
  votes: Map<string, boolean>,
  userId: string,
): ReadyAnswer {
  const vote = votes.get(userId);
  return vote === undefined ? null : vote ? "ready" : "out";
}

function tallySide(
  side: ReadySide,
  votes: Map<string, boolean>,
  teamSize: number,
): SideTally {
  const answers = side.seatIds.map((userId) => ({
    userId,
    answer: answerOf(votes, userId),
  }));
  const ready = answers.filter((a) => a.answer === "ready").length;
  const out = answers.filter((a) => a.answer === "out").length;
  const need = Math.min(Math.max(teamSize, 1), side.seatIds.length);
  return {
    teamId: side.teamId,
    ready,
    out,
    pending: answers.length - ready - out,
    need,
    full: need > 0 && ready >= need,
    answers,
  };
}

/**
 * The proposer is in on every time they offered unless they said otherwise.
 * Implied rather than stored, so a proposal made before the ready check (no
 * votes at all) reads the same as a new one.
 */
export function withProposerYes(
  votes: ReadyVote[],
  proposerId: string,
  options: number[],
): ReadyVote[] {
  const answered = new Set(
    votes.filter((v) => v.userId === proposerId).map((v) => v.timeMs),
  );
  return [
    ...votes,
    ...options
      .filter((timeMs) => !answered.has(timeMs))
      .map((timeMs) => ({ userId: proposerId, timeMs, ready: true })),
  ];
}

/** How one option stands. Votes for other times are ignored. */
export function tallyOption(
  timeMs: number,
  sides: { home: ReadySide; away: ReadySide },
  votes: ReadyVote[],
  teamSize: number,
): OptionTally {
  const byUser = new Map(
    votes.filter((v) => v.timeMs === timeMs).map((v) => [v.userId, v.ready]),
  );
  const home = tallySide(sides.home, byUser, teamSize);
  const away = tallySide(sides.away, byUser, teamSize);
  const captains = {
    home: answerOf(byUser, sides.home.captainId),
    away: answerOf(byUser, sides.away.captainId),
  };
  const captainsAgree = captains.home === "ready" && captains.away === "ready";
  return {
    timeMs,
    home,
    away,
    captains,
    captainsAgree,
    everyoneIn: captainsAgree && home.full && away.full,
    readyTotal: home.ready + away.ready,
    seatTotal: home.answers.length + away.answers.length,
  };
}

/**
 * Why `userId` may not lock this option in now, or null when they may. Only
 * a current captain locks; locking is their own yes, so it needs only the
 * OTHER captain's ✓. The lineup is never required here: that is the whole
 * point of locking early.
 */
export function lockRefusal(
  tally: OptionTally,
  userId: string,
  captains: { homeCaptainId: string; awayCaptainId: string },
): string | null {
  const side =
    userId === captains.homeCaptainId
      ? "home"
      : userId === captains.awayCaptainId
        ? "away"
        : null;
  if (!side) return "Only the two captains can lock a time in";
  const other = side === "home" ? tally.captains.away : tally.captains.home;
  if (other !== "ready")
    return "The other captain hasn't said yes to this time yet";
  return null;
}

/**
 * The option with the most players in, when there is a real choice: more
 * than one option and someone ready. Ties go to the earlier time.
 */
export function leadingOption(tallies: OptionTally[]): number | null {
  if (tallies.length < 2) return null;
  let best: OptionTally | null = null;
  for (const t of tallies) {
    if (t.readyTotal === 0) continue;
    if (
      !best ||
      t.readyTotal > best.readyTotal ||
      (t.readyTotal === best.readyTotal && t.timeMs < best.timeMs)
    )
      best = t;
  }
  return best?.timeMs ?? null;
}

/** One line on where an option stands, for the card and the home strip. */
export function optionStatusLine(
  tally: OptionTally,
  names: { home: string; away: string },
): string {
  if (tally.everyoneIn) return "Everyone's in";
  const waitingCaptains = [
    tally.captains.home !== "ready" ? `the ${names.home} captain` : null,
    tally.captains.away !== "ready" ? `the ${names.away} captain` : null,
  ].filter((x): x is string => x !== null);
  const short = [
    !tally.home.full ? tally.home.need - tally.home.ready : 0,
    !tally.away.full ? tally.away.need - tally.away.ready : 0,
  ].reduce((a, b) => a + b, 0);
  const parts: string[] = [];
  if (waitingCaptains.length === 2) parts.push("Waiting on both captains");
  else if (waitingCaptains.length === 1)
    parts.push(`Waiting on ${waitingCaptains[0]}`);
  else parts.push("Both captains agree");
  if (short > 0)
    parts.push(
      `${short} more player${short === 1 ? "" : "s"} needed for full lineups`,
    );
  return parts.join(" · ");
}

/**
 * Times worth offering for a match, as quick picks: the same time of day on
 * the coming days (on the league's clock, so "8 PM" survives a clock change),
 * plus an hour either side of the current kickoff. Each one is at least
 * `SUGGESTION_MIN_LEAD_MS` ahead, before the deadline, not the current
 * kickoff, and clear of every busy time by more than the conflict window
 * (the server's own checks still decide). The `count` closest to the current
 * kickoff win (a move is usually a day or an hour either way); with no
 * kickoff ahead, the soonest do. Returned ascending.
 */
export function suggestRescheduleTimes(options: {
  /** The current kickoff; its time of day anchors the suggestions. */
  kickoffMs: number | null;
  /** Time-of-day anchor when there is no kickoff (the league's match night). */
  fallbackAnchorMs: number | null;
  nowMs: number;
  /** Exclusive: suggestions must be before this. */
  deadlineMs: number | null;
  /** Kickoffs of the two teams' other fixtures and scrims. */
  busyMs: number[];
  windowMs: number;
  timeZone: string | null;
  count?: number;
  horizonDays?: number;
}): number[] {
  const anchor = options.kickoffMs ?? options.fallbackAnchorMs;
  if (anchor == null) return [];
  const count = options.count ?? 6;
  const horizonDays = options.horizonDays ?? 10;
  const formatter = options.timeZone ? zoneFormatter(options.timeZone) : null;
  const toWall = (ms: number) =>
    formatter ? wallTime(new Date(ms), formatter) : ms;
  const fromWall = (wall: number) =>
    formatter ? dateAtWallTime(wall, formatter).getTime() : wall;

  const anchorWall = toWall(anchor);
  const minuteOfDay = ((anchorWall % DAY_MS) + DAY_MS) % DAY_MS;
  const todayWall = Math.floor(toWall(options.nowMs) / DAY_MS) * DAY_MS;
  const candidates = new Set<number>();
  for (let day = 0; day <= horizonDays; day++) {
    candidates.add(fromWall(todayWall + day * DAY_MS + minuteOfDay));
  }
  if (options.kickoffMs != null) {
    candidates.add(fromWall(anchorWall - HOUR_MS));
    candidates.add(fromWall(anchorWall + HOUR_MS));
  }
  const earliest = options.nowMs + SUGGESTION_MIN_LEAD_MS;
  const near = Math.max(options.kickoffMs ?? options.nowMs, options.nowMs);
  return [...candidates]
    .filter(
      (t) =>
        t >= earliest &&
        t !== options.kickoffMs &&
        (options.deadlineMs == null || t < options.deadlineMs) &&
        !options.busyMs.some((busy) => Math.abs(busy - t) <= options.windowMs),
    )
    .sort((a, b) => Math.abs(a - near) - Math.abs(b - near) || a - b)
    .slice(0, count)
    .sort((a, b) => a - b);
}

/**
 * Whether an open ready check still asks anything of anyone: at least one of
 * its times hasn't passed. A passed time can't be answered (answers refuse
 * it) or usefully locked, so a check whose every time has gone stops
 * showing on Home and in the captain's "Waiting on you" list instead of
 * asking for answers nobody can give. The card itself still shows it, with
 * Withdraw, so the proposer can clear it.
 */
export function readyCheckLive(view: {
  open: boolean;
  options: readonly { passed: boolean }[];
}): boolean {
  return view.open && view.options.some((o) => !o.passed);
}

/**
 * Whether a captain is offered Lock for a time: it hasn't passed and they
 * may lock it (lockRefusal: the other captain said yes). A time showing
 * "Everyone's in" on a check that is still open is included: the last answer
 * moves the match by itself, so that is a time whose move was refused (a
 * clashing scrim, or a player released mid-check), and Lock is the retry.
 * Hiding Lock there left the card green with nothing to press. The card and
 * the captain's to-do list both read this.
 */
export function lockOffered(option: {
  passed: boolean;
  lockRefusal: string | null;
}): boolean {
  return !option.passed && option.lockRefusal === null;
}

/**
 * What the "Or any time" box starts on: the current kickoff, but only while
 * the box could submit it. The box sits inside the propose form and carries
 * `min` (now, when the page loaded) and `max` (a minute inside the playoff
 * deadline), so a kickoff that has passed (a match that wasn't played, the
 * case the quick picks are built for) or lies past the deadline made the
 * browser refuse "Send ready check" over a box the captain never touched.
 */
export function customTimePrefill(
  kickoffMs: number | null,
  minTs: number,
  maxTs: number | null,
): number | null {
  if (kickoffMs == null || kickoffMs < minTs) return null;
  if (maxTs != null && kickoffMs > maxTs) return null;
  return kickoffMs;
}

export type ReadyCheckSeatView = {
  /** Null on an anonymous seat: only captains and admins see names. */
  userId: string | null;
  name: string | null;
  avatar: string | null;
  answer: ReadyAnswer;
  /** This seat is the viewer's own. */
  me: boolean;
};

export type ReadyCheckSideView = Omit<SideTally, "answers"> & {
  name: string;
  seats: ReadyCheckSeatView[];
};

export type ReadyCheckOptionView = {
  timeMs: number;
  /** Kickoff has come and gone: nobody can answer or lock it any more. */
  passed: boolean;
  home: ReadyCheckSideView;
  away: ReadyCheckSideView;
  captains: { home: ReadyAnswer; away: ReadyAnswer };
  captainsAgree: boolean;
  everyoneIn: boolean;
  readyTotal: number;
  seatTotal: number;
  /** The most-ready option when there's a choice (leadingOption). */
  leading: boolean;
  statusLine: string;
  myAnswer: ReadyAnswer;
  /** Why the viewer can't lock this time in, or null when they can. */
  lockRefusal: string | null;
};

export type ReadyCheckViewerKind = "captain" | "player" | "admin" | "spectator";

export type ReadyCheckView = {
  requestId: string;
  matchId: string;
  proposer: { id: string; name: string };
  createdAtMs: number;
  note: string | null;
  /** The match's current kickoff (null when it has none yet). */
  kickoffMs: number | null;
  teamSize: number;
  home: { teamId: string; name: string; captainId: string };
  away: { teamId: string; name: string; captainId: string };
  /** Seats carry names (captains and admins only). */
  named: boolean;
  /** The match can still move: active season, logistics open, SCHEDULED. */
  open: boolean;
  viewer: {
    id: string | null;
    kind: ReadyCheckViewerKind;
    /** The side the viewer plays or captains for, if any. */
    side: "home" | "away" | null;
    /** The viewer answers this ready check (a seat or a captain). */
    canAnswer: boolean;
    isProposer: boolean;
  };
  options: ReadyCheckOptionView[];
};

export type ReadyCheckPerson = { id: string; name: string; avatar: string | null };

/**
 * The card's whole state for one viewer. Names ride along only when `named`
 * (canViewNamedMatchAvailability: the captains and admins); everyone else
 * gets counts plus their own seat, sorted ready, out, waiting, so a seat's
 * position can't give away whose answer it is.
 */
export function buildReadyCheckView(input: {
  request: {
    id: string;
    matchId: string;
    proposedById: string;
    createdAtMs: number;
    note: string | null;
    options: number[];
  };
  proposerName: string;
  kickoffMs: number | null;
  teamSize: number;
  home: ReadySide & { name: string };
  away: ReadySide & { name: string };
  votes: ReadyVote[];
  people: Map<string, ReadyCheckPerson>;
  viewer: { id: string; isAdmin: boolean } | null;
  named: boolean;
  open: boolean;
  nowMs: number;
}): ReadyCheckView {
  const { request, home, away, viewer } = input;
  const viewerId = viewer?.id ?? null;
  const isCaptain =
    viewerId != null &&
    (viewerId === home.captainId || viewerId === away.captainId);
  const side: "home" | "away" | null =
    viewerId == null
      ? null
      : viewerId === home.captainId || home.seatIds.includes(viewerId)
        ? "home"
        : viewerId === away.captainId || away.seatIds.includes(viewerId)
          ? "away"
          : null;
  const kind: ReadyCheckViewerKind = isCaptain
    ? "captain"
    : side
      ? "player"
      : viewer?.isAdmin
        ? "admin"
        : "spectator";
  const canAnswer = input.open && side !== null;
  const votes = withProposerYes(
    input.votes,
    request.proposedById,
    request.options,
  );
  const tallies = request.options.map((timeMs) =>
    tallyOption(timeMs, { home, away }, votes, input.teamSize),
  );
  const leading = leadingOption(tallies);
  const names = { home: home.name, away: away.name };

  const sideView = (
    tally: SideTally,
    name: string,
  ): ReadyCheckSideView => {
    const seats = tally.answers.map(({ userId, answer }) => {
      const me = userId === viewerId;
      const person = input.people.get(userId);
      return input.named || me
        ? {
            userId,
            name: person?.name ?? "Player",
            avatar: person?.avatar ?? null,
            answer,
            me,
          }
        : { userId: null, name: null, avatar: null, answer, me };
    });
    const order = { ready: 0, out: 1, waiting: 2 } as const;
    if (!input.named)
      seats.sort(
        (a, b) =>
          order[a.answer ?? "waiting"] - order[b.answer ?? "waiting"],
      );
    const { answers: _answers, ...counts } = tally;
    void _answers;
    return { ...counts, name, seats };
  };

  return {
    requestId: request.id,
    matchId: request.matchId,
    proposer: { id: request.proposedById, name: input.proposerName },
    createdAtMs: request.createdAtMs,
    note: request.note,
    kickoffMs: input.kickoffMs,
    teamSize: input.teamSize,
    home: { teamId: home.teamId, name: home.name, captainId: home.captainId },
    away: { teamId: away.teamId, name: away.name, captainId: away.captainId },
    named: input.named,
    open: input.open,
    viewer: {
      id: viewerId,
      kind,
      side,
      canAnswer,
      isProposer: viewerId === request.proposedById,
    },
    options: tallies.map((tally) => {
      const passed = tally.timeMs <= input.nowMs;
      const mine = viewerId
        ? (votes.find(
            (v) => v.userId === viewerId && v.timeMs === tally.timeMs,
          ) ?? null)
        : null;
      return {
        timeMs: tally.timeMs,
        passed,
        home: sideView(tally.home, home.name),
        away: sideView(tally.away, away.name),
        captains: tally.captains,
        captainsAgree: tally.captainsAgree,
        everyoneIn: tally.everyoneIn,
        readyTotal: tally.readyTotal,
        seatTotal: tally.seatTotal,
        leading: leading === tally.timeMs,
        statusLine: optionStatusLine(tally, names),
        myAnswer: mine ? (mine.ready ? "ready" : "out") : null,
        lockRefusal:
          !input.open || passed
            ? "This time can't be locked in any more"
            : viewerId == null
              ? "Only the two captains can lock a time in"
              : lockRefusal(
                  // The viewer's lock is their own yes.
                  tallyOption(
                    tally.timeMs,
                    { home, away },
                    [
                      ...votes.filter((v) => v.userId !== viewerId),
                      { userId: viewerId, timeMs: tally.timeMs, ready: true },
                    ],
                    input.teamSize,
                  ),
                  viewerId,
                  {
                    homeCaptainId: home.captainId,
                    awayCaptainId: away.captainId,
                  },
                ),
      };
    }),
  };
}

/**
 * The card as it will look once the viewer's answer lands: their own seat,
 * their side's counts and (for a captain) the captain chip. Optimistic only,
 * for the instant between the tap and the server's fresh view; the totals
 * that decide anything (full lineups, everyone-in) wait for the server.
 */
export function withMyAnswer(
  view: ReadyCheckView,
  timeMs: number,
  answer: Exclude<ReadyAnswer, null>,
): ReadyCheckView {
  const side = view.viewer.side;
  if (!side || view.viewer.id == null) return view;
  const isCaptain = view[side].captainId === view.viewer.id;
  return {
    ...view,
    options: view.options.map((option) => {
      if (option.timeMs !== timeMs) return option;
      const before = option.myAnswer;
      const sideView = option[side];
      const seats = sideView.seats.map((seat) =>
        seat.me ? { ...seat, answer } : seat,
      );
      const hasSeat = sideView.seats.some((seat) => seat.me);
      const count = (a: ReadyAnswer) => (hasSeat && before === a ? 1 : 0);
      const add = (a: ReadyAnswer) => (hasSeat && answer === a ? 1 : 0);
      const ready = sideView.ready - count("ready") + add("ready");
      const updatedSide = {
        ...sideView,
        seats,
        ready,
        out: sideView.out - count("out") + add("out"),
        pending: sideView.pending - count(null) + add(null),
        full: sideView.need > 0 && ready >= sideView.need,
      };
      return {
        ...option,
        myAnswer: answer,
        [side]: updatedSide,
        captains: isCaptain
          ? { ...option.captains, [side]: answer }
          : option.captains,
        readyTotal: option.readyTotal - count("ready") + add("ready"),
      };
    }),
  };
}
