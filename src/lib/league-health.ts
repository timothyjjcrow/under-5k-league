// League health: the pure half of the admin page /admin/health. The service
// (league-health-service.ts) reads ids, statuses and timestamps for one
// season; everything here turns them into counts, rates and buckets. Nothing
// here sees a name or a contact detail, so the page can only ever count.
//
// "Unknown" is its own answer: a figure the records can't support says so
// instead of reading as zero (CLAUDE.md, "Render unknown as unknown").

import {
  DRAFT_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "./constants";
import { AVAILABILITY } from "./availability";
import { capacityInfo } from "./capacity";
import { wallTime, zoneFormatter } from "./zoned-time";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The most recent weeks the new-accounts list shows; older ones fold into a
 *  single line, so a season left open through a long break stays readable. */
const MAX_WEEKS_SHOWN = 26;

export type HealthSeason = {
  id: string;
  status: string;
  isActive: boolean;
  teamSize: number;
  minTeams: number;
  createdAt: Date;
};

type TenureRow = {
  userId: string | null;
  teamId: string | null;
  endReason: string | null;
  acquisitionKind: string;
};

/** What the service reads for one season: ids, statuses, counts and
 *  timestamps, never a name. */
export type LeagueHealthRows = {
  season: HealthSeason;
  /** The season created after this one, which closes its date window; null
   *  for the newest season, whose window runs to `now`. */
  nextSeason: { name: string; createdAt: Date } | null;
  now: Date;
  /** Signups grouped by type and status. */
  registrations: readonly { type: string; status: string; count: number }[];
  /** Teams grouped by whether they withdrew. */
  teams: readonly { withdrawn: boolean; count: number }[];
  /** The season's auction, or null when it never had one. */
  draftStatus: string | null;
  /** User ids of the ACTIVE player signups. */
  activePlayerIds: readonly string[];
  /** ACTIVE player signups who signed up for a season created earlier. */
  returningPlayers: number;
  tenures: readonly TenureRow[];
  /** User ids on a roster now. */
  rosterUserIds: readonly string[];
  /** Of those, how many have linked a Discord account. */
  rosteredWithDiscord: number;
  /** Accounts created inside the window. */
  accountsCreatedAt: readonly Date[];
  matches: readonly {
    id: string;
    scheduledAt: Date | null;
    scheduleRevision: number;
    forfeit: boolean;
  }[];
  /** Check-in rows grouped by match, kickoff revision and answer. */
  checkins: readonly {
    matchId: string;
    scheduleRevision: number;
    status: string;
    count: number;
  }[];
  /** Standin bookings on the season's matches. */
  bookings: readonly { matchId: string; createdAt: Date }[];
  /** Dedupe keys of the league posts sent inside the window. */
  postKeys: readonly (string | null)[];
};

export type SignupCounts = { active: number; withdrawn: number; removed: number };

export type NeverDrafted =
  /** Active player signups never on a team this season. */
  | { state: "counted"; count: number }
  /** The auction hasn't finished yet. */
  | { state: "before-draft" }
  /** An archived season that ended before any auction. */
  | { state: "no-draft" }
  /** The records can't say (see neverDrafted): no finished auction on
   *  record, or a roster history that doesn't cover the whole season. */
  | { state: "unknown"; reason: "no-auction" | "partial-history" };

export type CheckinSummary = {
  /** Series whose kickoff has passed, forfeits left out. */
  matches: number;
  /** Full sides for those series, plus each standin booked on them. */
  seats: number;
  /** Answers at each series' current kickoff, at most one per seat. */
  answered: number;
  in: number;
  out: number;
};

export type LabelledCount = { key: string; label: string; count: number };

export type WeekCount = {
  /** The Monday that starts the week, on the league's clock (YYYY-MM-DD). */
  weekOf: string;
  count: number;
};

export type HealthWindow = {
  start: Date;
  end: Date;
  /** The season the window closes on; null when it runs to now. */
  next: { name: string } | null;
};

export type LeagueHealth = {
  window: HealthWindow;
  signups: {
    players: SignupCounts;
    standins: SignupCounts;
    teams: number;
    withdrawnTeams: number;
    /** Every team's full roster, withdrawn teams included. */
    seats: number;
    targetTeams: number;
    targetSeats: number;
    neverDrafted: NeverDrafted;
    returning: number;
  };
  checkins: CheckinSummary;
  bookings: { total: number; lead: LabelledCount[] };
  discord: {
    rostered: number;
    linked: number;
    posts: LabelledCount[];
    postsTotal: number;
  };
  accounts: {
    total: number;
    weeks: WeekCount[];
    /** Weeks folded out of `weeks`, oldest first; null when none were. */
    earlier: { weeks: number; count: number } | null;
  };
};

/** "62%", or null when there is nothing to divide by. */
export function percent(part: number, whole: number): string | null {
  if (!(whole > 0)) return null;
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * The dates a season's undated records are counted between. Discord posts
 * and accounts carry no season, so a season owns everything from its own
 * creation until the next season's (or now, for the newest).
 */
export function healthWindow(
  season: { createdAt: Date },
  nextSeason: { name: string; createdAt: Date } | null,
  now: Date,
): HealthWindow {
  const start = season.createdAt;
  const close = nextSeason ? nextSeason.createdAt : now;
  return {
    start,
    end: close.getTime() < start.getTime() ? start : close,
    next: nextSeason ? { name: nextSeason.name } : null,
  };
}

function signupCounts(
  rows: LeagueHealthRows["registrations"],
  type: string,
): SignupCounts {
  const of = (status: string) =>
    rows
      .filter((row) => row.type === type && row.status === status)
      .reduce((total, row) => total + row.count, 0);
  return {
    active: of(REGISTRATION_STATUS.ACTIVE),
    withdrawn: of(REGISTRATION_STATUS.WITHDRAWN),
    removed: of(REGISTRATION_STATUS.REMOVED),
  };
}

/**
 * Tenures that never made a real season with the team: the sale was undone,
 * the draft was aborted and re-run, the team was dissolved before the draft,
 * or its captain was swapped before it. The same four as the profile's
 * Seasons card (profile-seasons.ts); league-health.test.ts keeps them equal.
 */
const VOID_TENURE_ENDS = new Set([
  "DRAFT_UNDO",
  "DRAFT_ABORT",
  "PRE_DRAFT_TEAM_REMOVED",
  "PRE_DRAFT_CAPTAIN_CHANGED",
]);

/** A membership recorded from the surviving rows of an older season, after
 *  the fact (roster-history.ts): whoever left before then left no record. */
const LEGACY_CAPTURE = "LEGACY_CAPTURE";

function realTenure(tenure: TenureRow): boolean {
  return (
    tenure.userId !== null &&
    tenure.teamId !== null &&
    !(tenure.endReason !== null && VOID_TENURE_ENDS.has(tenure.endReason))
  );
}

/**
 * Active player signups who were never on a team this season: not a captain,
 * not bought in the auction and not signed later.
 *
 * Counted only once the auction is complete, and only when the roster
 * history covers the whole season. It doesn't when any membership was
 * captured after the fact (LEGACY_CAPTURE), or when someone on a roster has
 * no history at all: a player released before the history began left no
 * trace, and would wrongly count as never drafted. Those seasons are
 * unknown, and so is a season past its draft with no finished auction on
 * record.
 */
export function neverDrafted(input: {
  season: { status: string; isActive: boolean };
  draftStatus: string | null;
  activePlayerIds: readonly string[];
  tenures: readonly TenureRow[];
  rosterUserIds: readonly string[];
}): NeverDrafted {
  if (input.draftStatus !== DRAFT_STATUS.COMPLETE) {
    const beforeDraft =
      input.season.status === SEASON_STATUS.SIGNUPS ||
      input.season.status === SEASON_STATUS.DRAFT;
    if (!beforeDraft) return { state: "unknown", reason: "no-auction" };
    return input.season.isActive ? { state: "before-draft" } : { state: "no-draft" };
  }
  const partial = { state: "unknown", reason: "partial-history" } as const;
  if (input.tenures.some((tenure) => tenure.acquisitionKind === LEGACY_CAPTURE)) {
    return partial;
  }
  const onTeam = new Set(
    input.tenures.filter(realTenure).map((tenure) => tenure.userId as string),
  );
  if (input.rosterUserIds.some((userId) => !onTeam.has(userId))) return partial;
  const never = new Set(input.activePlayerIds.filter((id) => !onTeam.has(id)));
  return { state: "counted", count: never.size };
}

/**
 * Check-ins for the series whose kickoff has passed, forfeits left out. The
 * answers that count are the ones at the series' current kickoff (a new time
 * clears them), against the season's full sides, the same "out of" the match
 * page uses (expectedSideSize), plus one seat for each standin booked, whose
 * own answer is the one that matters for that night. A series never counts
 * more answers than seats.
 */
export function checkinSummary(input: {
  matches: LeagueHealthRows["matches"];
  checkins: LeagueHealthRows["checkins"];
  bookings: readonly { matchId: string }[];
  teamSize: number;
  now: Date;
}): CheckinSummary {
  const due = input.matches.filter(
    (match) =>
      match.scheduledAt !== null &&
      match.scheduledAt.getTime() <= input.now.getTime() &&
      !match.forfeit,
  );
  const booked = new Map<string, number>();
  for (const booking of input.bookings) {
    booked.set(booking.matchId, (booked.get(booking.matchId) ?? 0) + 1);
  }
  const answers = new Map<string, { in: number; out: number }>();
  for (const row of input.checkins) {
    const key = `${row.matchId}\u0000${row.scheduleRevision}`;
    const tally = answers.get(key) ?? { in: 0, out: 0 };
    if (row.status === AVAILABILITY.IN) tally.in += row.count;
    else if (row.status === AVAILABILITY.OUT) tally.out += row.count;
    answers.set(key, tally);
  }
  const summary: CheckinSummary = { matches: due.length, seats: 0, answered: 0, in: 0, out: 0 };
  for (const match of due) {
    const tally = answers.get(`${match.id}\u0000${match.scheduleRevision}`) ?? {
      in: 0,
      out: 0,
    };
    const seats = 2 * input.teamSize + (booked.get(match.id) ?? 0);
    summary.seats += seats;
    summary.answered += Math.min(tally.in + tally.out, seats);
    summary.in += tally.in;
    summary.out += tally.out;
  }
  return summary;
}

/** How far ahead of kickoff a standin was booked, longest first. A booking
 *  falls in the first bucket it reaches. */
const LEAD_BUCKETS: readonly { key: string; label: string; fromMs: number }[] = [
  { key: "3d", label: "3 days or more before kickoff", fromMs: 3 * DAY_MS },
  { key: "1d", label: "1–3 days before", fromMs: DAY_MS },
  { key: "6h", label: "6–24 hours before", fromMs: 6 * HOUR_MS },
  { key: "1h", label: "1–6 hours before", fromMs: HOUR_MS },
  { key: "0h", label: "Under an hour before", fromMs: 0 },
  { key: "after", label: "After kickoff", fromMs: -Infinity },
];
const NO_KICKOFF = { key: "none", label: "Match has no kickoff, so unknown" };

/**
 * Standin bookings by how long before the match's current kickoff they were
 * made. Every bucket is listed, zeros included; a booking on a match with no
 * kickoff can't be placed and gets its own line, never a guess.
 */
export function bookingLeadTimes(
  bookings: LeagueHealthRows["bookings"],
  matches: LeagueHealthRows["matches"],
): LabelledCount[] {
  const kickoff = new Map(matches.map((match) => [match.id, match.scheduledAt]));
  const counts = new Map<string, number>();
  for (const booking of bookings) {
    const at = kickoff.get(booking.matchId) ?? null;
    const key =
      at === null
        ? NO_KICKOFF.key
        : LEAD_BUCKETS.find(
            (bucket) => at.getTime() - booking.createdAt.getTime() >= bucket.fromMs,
          )!.key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unknown = counts.get(NO_KICKOFF.key) ?? 0;
  return [
    ...LEAD_BUCKETS.map(({ key, label }) => ({ key, label, count: counts.get(key) ?? 0 })),
    ...(unknown > 0 ? [{ ...NO_KICKOFF, count: unknown }] : []),
  ];
}

/**
 * League posts by kind, read from the first segment of the outbox's dedupe
 * key: announcementDedupeKey's kinds (announcement-marker.ts) and the two
 * expiry groups (checkinNudgeAnnouncementGroup, draftLiveAnnouncementGroup).
 * One-off posts carry no key. league-health.test.ts pins the list.
 */
const POST_KINDS: readonly { key: string; label: string }[] = [
  { key: "series", label: "Series results" },
  { key: "round", label: "Playoff rounds" },
  { key: "champion", label: "Champion" },
  { key: "honors", label: "Weekly honors" },
  { key: "reminder", label: "Week and draft-night reminders" },
  { key: "checkin-nudge", label: "Check-in reminders" },
  { key: "nudge", label: "Missing-result reminders" },
  { key: "signups", label: "Signups open" },
  { key: "draft-live", label: "Live draft" },
];
const OTHER_POSTS = {
  key: "other",
  label: "Other posts (roster moves, standins, new times and the like)",
};

/** The kind a sent post is counted under. */
export function postKind(dedupeKey: string | null): string {
  if (!dedupeKey) return OTHER_POSTS.key;
  const prefix = dedupeKey.split(":", 1)[0];
  return POST_KINDS.some((kind) => kind.key === prefix) ? prefix : OTHER_POSTS.key;
}

/** Sent posts by kind, in a fixed order, kinds with none left out. */
export function postsByKind(keys: readonly (string | null)[]): LabelledCount[] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const kind = postKind(key);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...POST_KINDS, OTHER_POSTS]
    .map(({ key, label }) => ({ key, label, count: counts.get(key) ?? 0 }))
    .filter((row) => row.count > 0);
}

/**
 * Timestamps counted into calendar weeks on the league's clock: weeks start
 * Monday at midnight in `timeZone`, so a Sunday-evening match night stays in
 * its own week whatever the server's zone, across daylight-saving changes
 * too. Every week the window touches is listed, empty ones included; dates
 * outside the window are left out.
 */
export function weeklyCounts(
  dates: readonly Date[],
  window: { start: Date; end: Date },
  timeZone: string,
): WeekCount[] {
  const start = window.start.getTime();
  const end = window.end.getTime();
  if (!(end > start)) return [];
  const formatter = zoneFormatter(timeZone);
  // Days since the epoch on the zone's wall clock; Monday-based weeks.
  const mondayOf = (ms: number) => {
    const day = Math.floor(wallTime(new Date(ms), formatter) / DAY_MS);
    const weekday = new Date(day * DAY_MS).getUTCDay();
    return day - ((weekday + 6) % 7);
  };
  const counts = new Map<number, number>();
  for (const date of dates) {
    const at = date.getTime();
    if (at < start || at >= end) continue;
    const monday = mondayOf(at);
    counts.set(monday, (counts.get(monday) ?? 0) + 1);
  }
  const weeks: WeekCount[] = [];
  for (let monday = mondayOf(start); monday <= mondayOf(end - 1); monday += 7) {
    weeks.push({
      weekOf: new Date(monday * DAY_MS).toISOString().slice(0, 10),
      count: counts.get(monday) ?? 0,
    });
  }
  return weeks;
}

/** "Sep 7": a week's Monday, as the new-accounts list labels it. */
export function weekLabel(weekOf: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(`${weekOf}T00:00:00Z`));
}

/** "Sep 7, 2026": a date on the league's clock. */
export function dayLabel(date: Date, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/** Every figure on /admin/health, from the service's rows. */
export function buildLeagueHealth(
  rows: LeagueHealthRows,
  timeZone: string,
): LeagueHealth {
  const { season } = rows;
  const range = healthWindow(season, rows.nextSeason, rows.now);
  const teams = rows.teams.reduce((total, row) => total + row.count, 0);
  const players = signupCounts(rows.registrations, REGISTRATION_TYPE.PLAYER);
  const weeks = weeklyCounts(rows.accountsCreatedAt, range, timeZone);
  const folded = weeks.slice(0, Math.max(0, weeks.length - MAX_WEEKS_SHOWN));
  const posts = postsByKind(rows.postKeys);
  return {
    window: range,
    signups: {
      players,
      standins: signupCounts(rows.registrations, REGISTRATION_TYPE.STANDIN),
      teams,
      withdrawnTeams: rows.teams
        .filter((row) => row.withdrawn)
        .reduce((total, row) => total + row.count, 0),
      seats: teams * season.teamSize,
      targetTeams: season.minTeams,
      targetSeats: capacityInfo(season, players.active).minPlayers,
      neverDrafted: neverDrafted({
        season,
        draftStatus: rows.draftStatus,
        activePlayerIds: rows.activePlayerIds,
        tenures: rows.tenures,
        rosterUserIds: rows.rosterUserIds,
      }),
      returning: rows.returningPlayers,
    },
    checkins: checkinSummary({
      matches: rows.matches,
      checkins: rows.checkins,
      bookings: rows.bookings,
      teamSize: season.teamSize,
      now: rows.now,
    }),
    bookings: {
      total: rows.bookings.length,
      lead: bookingLeadTimes(rows.bookings, rows.matches),
    },
    discord: {
      rostered: rows.rosterUserIds.length,
      linked: rows.rosteredWithDiscord,
      posts,
      postsTotal: posts.reduce((total, row) => total + row.count, 0),
    },
    accounts: {
      total: weeks.reduce((total, week) => total + week.count, 0),
      weeks: weeks.slice(folded.length),
      earlier: folded.length
        ? {
            weeks: folded.length,
            count: folded.reduce((total, week) => total + week.count, 0),
          }
        : null,
    },
  };
}
